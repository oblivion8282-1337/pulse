/**
 * Client-seitige Speaking-Detection für Remote-Participants. Pro subscribed
 * RemoteAudio-Track läuft ein eigener AnalyserNode in einem geteilten
 * AudioContext; der RMS-Wert wird in einen SpeakingDetector gefüttert. Der
 * Sinn ist: der Ring leuchtet exakt wenn aus der Pipeline auch wirklich Ton
 * rauskommt — nicht wenn LiveKits Server-Active-Speaker-Detection das raten
 * möchte (die ist mit AGC-off + RNNoise-Gate löchrig, weil der reine RMS auf
 * dem RTP-Audio-Level-Header während Wort-Lücken einbricht).
 *
 * Identity ist der LiveKit-Identity-String — derselbe Key wie in
 * VoiceParticipant.identity, damit die Verdrahtung in livekit.svelte.ts trivial bleibt.
 */
import { SpeakingDetector } from './speakingDetector';

/** Min. interval between RMS samples. RAF runs at ~60 Hz but a "is this person
 *  talking" boolean needs far less — SpeakingDetector does its own hold/decay.
 *  Sampling at ~30 Hz halves the per-frame O(participants) Float32Array scan. */
const REMOTE_SAMPLE_INTERVAL_MS = 33;

type Entry = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  raf: number | null;
  detector: SpeakingDetector;
  speaking: boolean;
};

export class RemoteSpeakingTracker {
  #ctx: AudioContext | null = null;
  #entries = new Map<string, Entry>();
  #onChange: (identity: string, speaking: boolean) => void;
  #raf: number | null = null;
  #lastSample = 0;

  constructor(onChange: (identity: string, speaking: boolean) => void) {
    this.#onChange = onChange;
  }

  /** Close and drop the shared AudioContext if one is open. attach() lazily
   *  recreates it on the next subscribed track. */
  #closeContext(): void {
    if (this.#ctx && this.#ctx.state !== 'closed') {
      void this.#ctx.close().catch(() => {
        /* ignore */
      });
    }
    this.#ctx = null;
  }

  attach(identity: string, track: MediaStreamTrack): void {
    this.detach(identity);
    try {
      if (!this.#ctx) {
        const Ctx: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.#ctx = new Ctx();
      }
      const ctx = this.#ctx;
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      const buf = new Float32Array(
        new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT)
      );
      const entry: Entry = {
        source,
        analyser,
        buf,
        raf: null,
        detector: new SpeakingDetector((s) => {
          entry.speaking = s;
          this.#onChange(identity, s);
        }),
        speaking: false
      };
      this.#entries.set(identity, entry);
      // Start the shared RAF loop if not already running
      if (!this.#raf) {
        this.#startLoop();
      }
    } catch {
      // AudioContext-ctor kann vor User-Gesture/in Headless werfen — Track
      // bleibt halt "nicht sprechend", kein Crash.
      this.#entries.delete(identity);
    }
  }

  #startLoop = (): void => {
    // RAF ticks at ~60 Hz; only run the per-participant RMS scan at ~30 Hz —
    // enough for a speaking boolean, half the CPU in large rooms.
    const now = performance.now();
    if (now - this.#lastSample >= REMOTE_SAMPLE_INTERVAL_MS) {
      this.#lastSample = now;
      for (const entry of this.#entries.values()) {
        entry.analyser.getFloatTimeDomainData(entry.buf);
        let sum = 0;
        for (let i = 0; i < entry.buf.length; i++) sum += entry.buf[i] * entry.buf[i];
        entry.detector.feed(Math.sqrt(sum / entry.buf.length));
      }
    }
    this.#raf = requestAnimationFrame(this.#startLoop);
  };

  detach(identity: string): void {
    const e = this.#entries.get(identity);
    if (!e) return;
    try {
      e.source.disconnect();
    } catch {
      /* ignore */
    }
    try {
      e.analyser.disconnect();
    } catch {
      /* ignore */
    }
    const wasSpeaking = e.speaking;
    this.#entries.delete(identity);
    if (wasSpeaking) this.#onChange(identity, false);
    // No more tracked speakers: stop the shared RAF loop and release the
    // AudioContext so it doesn't sit open holding audio resources.
    if (this.#entries.size === 0) {
      if (this.#raf !== null) {
        cancelAnimationFrame(this.#raf);
        this.#raf = null;
      }
      this.#closeContext();
    }
  }

  isSpeaking(identity: string): boolean {
    return this.#entries.get(identity)?.speaking ?? false;
  }

  clear(): void {
    for (const id of [...this.#entries.keys()]) this.detach(id);
    this.#closeContext();
  }
}
