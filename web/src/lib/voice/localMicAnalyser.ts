/**
 * Local microphone level meter via Web Audio's AnalyserNode.
 *
 * LiveKit's `Participant.audioLevel` is driven by the server's active-speaker
 * detection (RTP audio-level extension + threshold + hold). For the local
 * participant that means the value only moves when we cross the server's
 * "speaker" threshold — useless as a real-time input meter, and totally
 * silent if AGC is off / the mic is quiet. This computes RMS directly off
 * the published MediaStreamTrack at ~60 fps so the settings meter actually
 * reflects what the mic is picking up.
 */
import { SpeakingDetector } from './speakingDetector';

/** Linear peak threshold ≈ -1 dBFS — anything above is "clipping" for the lamp. */
const CLIP_PEAK_THRESHOLD = 0.891;
/** Hold the clip indicator on for at least this long after the last over-peak, so
 *  a single crackle stays visible long enough for the eye to register it. */
const CLIP_HOLD_MS = 300;

export class LocalMicAnalyser {
  #ctx: AudioContext | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #analyser: AnalyserNode | null = null;
  #buf: Float32Array<ArrayBuffer> | null = null;
  #raf: number | null = null;
  #track: MediaStreamTrack | null = null;
  #onLevel: (n: number) => void;
  #onClip: ((c: boolean) => void) | undefined;
  #onPeak: ((p: number) => void) | undefined;
  #speakingDetector: SpeakingDetector | null;
  #displayLevel = 0;
  #displayPeak = 0;
  #clipping = false;
  #clipUntilMs = 0;

  constructor(
    onLevel: (n: number) => void,
    onSpeaking?: (s: boolean) => void,
    onClip?: (c: boolean) => void,
    onPeak?: (p: number) => void
  ) {
    this.#onLevel = onLevel;
    this.#onClip = onClip;
    this.#onPeak = onPeak;
    this.#speakingDetector = onSpeaking ? new SpeakingDetector(onSpeaking) : null;
  }

  /** Attach to (or re-attach to a different) MediaStreamTrack. No-op if same track.
   *
   *  When the AudioContext is already running (e.g. a processor swap replaced
   *  the published track) the existing context is reused: only the source node
   *  is swapped. A fresh AudioContext is only created when none exists yet or
   *  the existing one is closed, avoiding gratuitous OS audio-resource churn. */
  attach(track: MediaStreamTrack | null): void {
    if (track === this.#track && this.#analyser) return;
    if (!track) { this.detach(); return; }
    try {
      const ctx = this.#ctx && this.#ctx.state !== 'closed' ? this.#ctx : null;
      if (ctx && this.#analyser && this.#source) {
        // Reuse existing context + analyser — only swap the source node.
        try { this.#source.disconnect(); } catch { /* already detached */ }
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        source.connect(this.#analyser);
        this.#source = source;
        this.#track = track;
        // RAF loop is already running — no need to restart it.
        return;
      }
      // No reusable context — full teardown then fresh setup.
      this.detach();
      const Ctx: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const newCtx = new Ctx();
      const source = newCtx.createMediaStreamSource(new MediaStream([track]));
      const analyser = newCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      this.#ctx = newCtx;
      this.#source = source;
      this.#analyser = analyser;
      this.#buf = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
      this.#track = track;
      this.#loop();
    } catch {
      // AudioContext can throw before a user gesture, on permission edge cases,
      // or in headless test envs without WebAudio. Meter just stays at 0.
      this.detach();
    }
  }

  detach(): void {
    if (this.#raf !== null) {
      cancelAnimationFrame(this.#raf);
      this.#raf = null;
    }
    try { this.#source?.disconnect(); } catch { /* ignore */ }
    try { this.#analyser?.disconnect(); } catch { /* ignore */ }
    if (this.#ctx && this.#ctx.state !== 'closed') {
      void this.#ctx.close().catch(() => { /* ignore */ });
    }
    this.#source = null;
    this.#analyser = null;
    this.#ctx = null;
    this.#buf = null;
    this.#track = null;
    this.#displayLevel = 0;
    this.#displayPeak = 0;
    this.#onLevel(0);
    this.#onPeak?.(0);
    this.#speakingDetector?.reset();
    if (this.#clipping) {
      this.#clipping = false;
      this.#onClip?.(false);
    }
  }

  #loop = (): void => {
    const a = this.#analyser;
    const buf = this.#buf;
    if (!a || !buf) return;
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sum / buf.length);
    // Clip detection on the raw peak: anything above -1 dBFS lights the lamp,
    // 300ms hold so a single crackle stays visible.
    if (this.#onClip) {
      const nowC = performance.now();
      if (peak >= CLIP_PEAK_THRESHOLD) {
        this.#clipUntilMs = nowC + CLIP_HOLD_MS;
        if (!this.#clipping) { this.#clipping = true; this.#onClip(true); }
      } else if (this.#clipping && nowC >= this.#clipUntilMs) {
        this.#clipping = false;
        this.#onClip(false);
      }
    }
    // Peak-hold display: same dBFS scaling as RMS so the peak line sits on the
    // same axis as the bar. Instant attack, slow decay (~97%/frame ≈ 800ms
    // half-life) so the user can read where the loudest sample was.
    let peakDisplay = 0;
    if (peak > 0.0005) {
      const pdb = 20 * Math.log10(peak);
      peakDisplay = Math.max(0, Math.min(1, (pdb + 50) / 45));
    }
    if (peakDisplay > this.#displayPeak) this.#displayPeak = peakDisplay;
    else this.#displayPeak = this.#displayPeak * 0.97 + peakDisplay * 0.03;
    this.#onPeak?.(this.#displayPeak);
    // dBFS scaling — mic levels are perceived logarithmically. Map -50 dB
    // (deep silence) through -5 dB (very loud) onto 0..1 so a normally-spoken
    // voice at ~-20 dB sits at ~0.67, where it should be on a Discord-style
    // meter. Linear rms*N kept everything bunched at the low end.
    let level = 0;
    if (rms > 0.0005) {
      const db = 20 * Math.log10(rms);
      level = Math.max(0, Math.min(1, (db + 50) / 45));
    }
    // Peak-meter ballistics: instant attack so speech onset shows up, smooth
    // decay (~250ms half-life @ 60fps) so the bar doesn't strobe between
    // syllables.
    if (level > this.#displayLevel) this.#displayLevel = level;
    else this.#displayLevel = this.#displayLevel * 0.85 + level * 0.15;
    this.#onLevel(this.#displayLevel);
    // Speaking detection: feed raw RMS into the shared detector — only
    // meaningful when no send-processor is installed (raw mic IS the
    // published track then). With a processor present, livekit.svelte.ts
    // drives speaking off the post-processor tap instead, and this
    // detector's callback is gated out at the call site.
    this.#speakingDetector?.feed(rms);
    this.#raf = requestAnimationFrame(this.#loop);
  };
}
