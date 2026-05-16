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
export class LocalMicAnalyser {
  #ctx: AudioContext | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #analyser: AnalyserNode | null = null;
  #buf: Float32Array<ArrayBuffer> | null = null;
  #raf: number | null = null;
  #track: MediaStreamTrack | null = null;
  #onLevel: (n: number) => void;
  #onSpeaking: ((s: boolean) => void) | undefined;
  #speaking = false;
  #lastAboveMs = 0;
  #displayLevel = 0;

  constructor(onLevel: (n: number) => void, onSpeaking?: (s: boolean) => void) {
    this.#onLevel = onLevel;
    this.#onSpeaking = onSpeaking;
  }

  /** Attach to (or re-attach to a different) MediaStreamTrack. No-op if same track. */
  attach(track: MediaStreamTrack | null): void {
    if (track === this.#track && this.#analyser) return;
    this.detach();
    if (!track) return;
    try {
      const Ctx: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      this.#ctx = ctx;
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
    this.#onLevel(0);
    if (this.#speaking) {
      this.#speaking = false;
      this.#onSpeaking?.(false);
    }
  }

  #loop = (): void => {
    const a = this.#analyser;
    const buf = this.#buf;
    if (!a || !buf) return;
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
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
    // Speaking detection on the raw (un-decayed) level with asymmetric
    // thresholds + 300ms hold so brief inter-word gaps don't flicker the ring.
    if (this.#onSpeaking) {
      const now = performance.now();
      if (this.#speaking) {
        if (level >= 0.25) {
          this.#lastAboveMs = now;
        } else if (now - this.#lastAboveMs > 300) {
          this.#speaking = false;
          this.#onSpeaking(false);
        }
      } else if (level >= 0.4) {
        this.#speaking = true;
        this.#lastAboveMs = now;
        this.#onSpeaking(true);
      }
    }
    this.#raf = requestAnimationFrame(this.#loop);
  };
}
