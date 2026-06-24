/**
 * Standalone microphone test for the settings panel — works WITHOUT being in a
 * voice channel. Opens its own getUserMedia stream and runs the SAME send-side
 * processor the real voice path uses (RNNoise + noise-gate + makeup-gain), so:
 *   - raw input meter   (what the mic picks up, pre-processing)
 *   - send meter        (post RNNoise + gate + gain — exactly what listeners get)
 *   - "hear yourself"   (loopback of that processed signal to the output device,
 *                        so gate + gain + noise suppression are all audible)
 *
 * Only runs while the audio settings tab is open and the user is NOT connected
 * to a voice channel — once in a channel, `voice.localMic*`/`localSend*` are the
 * live sources and this stays torn down (never two mic streams at once).
 */
import { Track } from 'livekit-client';
import { createSendProcessor, type SendProcessorHandle } from './noiseFilter';
import { LocalMicAnalyser } from './localMicAnalyser';
import { settings } from '$lib/stores/settings.svelte';

/** dBFS bar mapping + ballistics, identical to LocalMicAnalyser / the live send
 *  meter so the test meter looks the same as in-channel. */
function ballistics(raw: number, current: number, decay: number): number {
  let level = 0;
  if (raw > 0.0005) {
    const db = 20 * Math.log10(raw);
    level = Math.max(0, Math.min(1, (db + 50) / 45));
  }
  return level > current ? level : current * decay + level * (1 - decay);
}

class MicTest {
  level = $state(0);
  peak = $state(0);
  clip = $state(false);
  sendLevel = $state(0);
  sendPeak = $state(0);
  sendClip = $state(false);
  /** True while the loopback is audible. Off by default — feedback risk on speakers. */
  monitor = $state(false);
  active = $state(false);

  #raw = new LocalMicAnalyser(
    (n) => (this.level = n),
    undefined,
    (c) => (this.clip = c),
    (p) => (this.peak = p)
  );
  #stream: MediaStream | null = null;
  #proc: SendProcessorHandle | null = null;
  #audio: HTMLAudioElement | null = null;
  #sendClipping = false;
  #sendClipUntilMs = 0;
  /** Invalidates an in-flight async start() when a newer start/stop supersedes it. */
  #gen = 0;

  /** (Re)acquire the mic on `deviceId` and start metering. Tears down any prior
   *  graph first, so it doubles as "switch device" / "switch mode". */
  async start(deviceId: string, outputId: string): Promise<void> {
    this.stop();
    const gen = ++this.#gen;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // `ideal` (bare string), not `exact` — a stale persisted id then falls
          // back to the default mic instead of throwing OverconstrainedError.
          deviceId: deviceId || undefined,
          echoCancellation: settings.audio.echoCancellation,
          autoGainControl: false, // Pulse regelt den Pegel selbst (Eingabe-Verstärker).
          noiseSuppression: false // the send processor does RNNoise itself.
        }
      });
    } catch {
      return; // permission denied / device gone — meters stay at 0.
    }
    if (gen !== this.#gen) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.#stream = stream;
    this.active = true;
    const track = stream.getAudioTracks()[0] ?? null;
    this.#raw.attach(track);
    if (!track) return;

    try {
      const mode = settings.audio.noiseSuppression !== 'off' ? 'rnnoise_gated' : 'gain_only';
      const proc = createSendProcessor(mode, settings.audio.noiseGateThresholdDb, settings.audio.inputMakeupGain);
      await proc.processor.init({ kind: Track.Kind.Audio, track });
      if (gen !== this.#gen) { void proc.processor.destroy(); return; }
      proc.setLevelTap((rms, peak) => this.#onSend(rms, peak));
      this.#proc = proc;

      // Always (re)start muted — the user opts into loopback explicitly each time
      // so reopening the panel never blasts unexpected feedback at them.
      this.monitor = false;
      const processed = proc.processor.processedTrack;
      this.#audio = new Audio();
      this.#audio.srcObject = new MediaStream(processed ? [processed] : []);
      this.#audio.muted = true;
      await this.#setSink(outputId);
      void this.#audio.play().catch(() => { /* autoplay edge — ignore */ });
    } catch {
      // Worklet/WASM load failed — raw input meter still works, no send path.
    }
  }

  /** Live-apply the mic makeup gain (slider drag). */
  setMakeup(v: number): void {
    this.#proc?.setMakeupGain(v);
  }

  /** Live-apply the noise-gate open threshold (slider drag). No-op in gain-only mode. */
  setGateThreshold(db: number): void {
    this.#proc?.setGateThreshold(db);
  }

  async setMonitor(on: boolean, outputId: string): Promise<void> {
    this.monitor = on;
    if (this.#audio) {
      this.#audio.muted = !on;
      await this.#setSink(outputId);
      void this.#audio.play().catch(() => { /* ignore */ });
    }
  }

  async setOutput(outputId: string): Promise<void> {
    await this.#setSink(outputId);
  }

  /** Same ballistics + clip logic as the live send meter (livekit #onSendLevel). */
  #onSend(rms: number, peak: number): void {
    this.sendLevel = ballistics(rms, this.sendLevel, 0.85);
    this.sendPeak = ballistics(peak, this.sendPeak, 0.97);
    if (peak >= 0.891 || this.#sendClipping) {
      const now = performance.now();
      if (peak >= 0.891) {
        this.#sendClipUntilMs = now + 300;
        if (!this.#sendClipping) { this.#sendClipping = true; this.sendClip = true; }
      } else if (now >= this.#sendClipUntilMs) {
        this.#sendClipping = false;
        this.sendClip = false;
      }
    }
  }

  async #setSink(outputId: string): Promise<void> {
    const el = this.#audio as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (el?.setSinkId && outputId) {
      try { await el.setSinkId(outputId); } catch { /* unsupported — default sink */ }
    }
  }

  stop(): void {
    this.#gen++; // invalidate any in-flight start()
    this.active = false;
    this.monitor = false;
    this.#raw.detach();
    if (this.#proc) {
      void this.#proc.processor.destroy();
      this.#proc = null;
    }
    if (this.#audio) {
      this.#audio.pause();
      this.#audio.srcObject = null;
      this.#audio = null;
    }
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#sendClipping = false;
    this.level = 0;
    this.peak = 0;
    this.clip = false;
    this.sendLevel = 0;
    this.sendPeak = 0;
    this.sendClip = false;
  }
}

export const micTest = new MicTest();
