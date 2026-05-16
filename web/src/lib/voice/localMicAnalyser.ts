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

  constructor(onLevel: (n: number) => void) {
    this.#onLevel = onLevel;
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
    this.#onLevel(0);
  }

  #loop = (): void => {
    const a = this.#analyser;
    const buf = this.#buf;
    if (!a || !buf) return;
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // Speech RMS sits around 0.05–0.2 — scale so normal speech fills the bar
    // without clipping. The settings meter additionally multiplies by 140 for
    // the visual; keep this raw so the API stays 0..1.
    const level = Math.min(1, rms * 4);
    this.#onLevel(level);
    this.#raf = requestAnimationFrame(this.#loop);
  };
}
