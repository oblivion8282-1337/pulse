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

  constructor(onChange: (identity: string, speaking: boolean) => void) {
    this.#onChange = onChange;
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
      const loop = (): void => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        entry.detector.feed(Math.sqrt(sum / buf.length));
        entry.raf = requestAnimationFrame(loop);
      };
      entry.raf = requestAnimationFrame(loop);
    } catch {
      // AudioContext-ctor kann vor User-Gesture/in Headless werfen — Track
      // bleibt halt "nicht sprechend", kein Crash.
      this.#entries.delete(identity);
    }
  }

  detach(identity: string): void {
    const e = this.#entries.get(identity);
    if (!e) return;
    if (e.raf !== null) cancelAnimationFrame(e.raf);
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
  }

  isSpeaking(identity: string): boolean {
    return this.#entries.get(identity)?.speaking ?? false;
  }

  clear(): void {
    for (const id of [...this.#entries.keys()]) this.detach(id);
    if (this.#ctx && this.#ctx.state !== 'closed') {
      void this.#ctx.close().catch(() => {
        /* ignore */
      });
    }
    this.#ctx = null;
  }
}
