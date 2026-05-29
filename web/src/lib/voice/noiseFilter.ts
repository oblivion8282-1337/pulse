import type { Track, TrackProcessor, ProcessorOptions } from 'livekit-client';
import { RnnoiseWorkletNode, NoiseGateWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import noiseGateWorkletPath from '@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url';
import type { NoiseSuppressionMode } from '$lib/stores/settings.svelte';

/** Tracks AudioContext instances that have had the RNNoise + gate worklet
 *  modules registered, so restart() skips the addModule round-trips when
 *  rebuilding the graph within the same context. */
const _workletModulesRegistered = new WeakSet<AudioContext>();

/** Hysteresis: gate closes 5 dB below the open threshold so it doesn't
 *  rapidly toggle around the boundary during steady-level breaths/sibilants. */
const GATE_CLOSE_BELOW_OPEN_DB = 5;
/** Grace period before the gate actually closes — long enough that a normal
 *  inter-word pause doesn't cut off, short enough that pauses sound clean. */
const GATE_HOLD_MS = 200;

export type AudioTrackProcessor = TrackProcessor<Track.Kind.Audio>;

/** Which send-side processor to install. `'rnnoise_gated'` mirrors the NS-on
 *  mode; `'gain_only'` is the slim chain used when NS is off but the user's
 *  input makeup gain is ≠ 1.0 (so the slider still has somewhere to apply). */
export type SendProcessorMode = 'rnnoise_gated' | 'gain_only';

/** Post-gain RMS+peak from the processor's internal tap, fired at requestAnimationFrame
 *  cadence. Values are linear amplitude in [0..1+] — caller maps to dBFS/UI scale. */
export type LevelTapCb = (rms: number, peak: number) => void;

/** TrackProcessor + live-tune handles. `setGateThreshold` is a no-op for the
 *  `'gain_only'` processor. `setMakeupGain` adjusts the post-gate GainNode in
 *  both modes; cheap (just sets `gain.gain.value`). `setLevelTap` subscribes
 *  a callback for post-gain RMS/peak — we tap inside the processor's own
 *  AudioContext to side-step the cross-context MediaStreamTrack quirk that
 *  silently zeroes out a separate `MediaStreamAudioSourceNode`. */
export type SendProcessorHandle = {
  processor: AudioTrackProcessor;
  setGateThreshold: (openDb: number) => void;
  setMakeupGain: (v: number) => void;
  setLevelTap: (cb: LevelTapCb | null) => void;
};

/**
 * RNNoise followed by a hard noise-gate — werman/Discord-style "clean pauses".
 * Followed by a GainNode for sender-side makeup gain (slider in the audio
 * settings). Both threshold and makeup can be live-retuned.
 */
class RnnoiseGatedTrackProcessor implements TrackProcessor<Track.Kind.Audio> {
  name = 'rnnoise-gated-noise-filter';
  processedTrack?: MediaStreamTrack;

  #ctx: AudioContext | null = null;
  #ownsCtx = false;
  #source: MediaStreamAudioSourceNode | null = null;
  #rnnoise: RnnoiseWorkletNode | null = null;
  #gate: NoiseGateWorkletNode | null = null;
  #gain: GainNode | null = null;
  #tap: AnalyserNode | null = null;
  #tapBuf: Float32Array<ArrayBuffer> | null = null;
  #tapCb: LevelTapCb | null = null;
  #tapRaf: number | null = null;
  #dest: MediaStreamAudioDestinationNode | null = null;
  #wasmBinary: ArrayBuffer | null = null;
  #openDb: number;
  #makeupGain: number;

  constructor(openDb: number, makeupGain: number) {
    this.#openDb = openDb;
    this.#makeupGain = makeupGain;
  }

  init = async (opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> => {
    await this.#buildGraph(opts.track, opts.audioContext);
  };

  restart = async (opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> => {
    await this.#teardownGraph();
    await this.#buildGraph(opts.track, opts.audioContext);
  };

  destroy = async (): Promise<void> => {
    await this.#teardownGraph();
    this.#wasmBinary = null;
  };

  /** Swap the gate node in place — brief click possible, acceptable on user-
   *  initiated slider release. RNNoise + source + gain + destination stay intact. */
  setGateThreshold(openDb: number): void {
    this.#openDb = openDb;
    const ctx = this.#ctx;
    const rnnoise = this.#rnnoise;
    const gain = this.#gain;
    if (!ctx || !rnnoise || !gain) return;
    try {
      this.#gate?.disconnect();
    } catch {
      /* ignore disconnect races */
    }
    const gate = this.#makeGate(ctx);
    rnnoise.disconnect();
    rnnoise.connect(gate).connect(gain);
    this.#gate = gate;
  }

  /** Live-tune the makeup gain. AudioParam set is cheap, no node swap. */
  setMakeupGain(v: number): void {
    this.#makeupGain = v;
    if (this.#gain) this.#gain.gain.value = v;
  }

  setLevelTap(cb: LevelTapCb | null): void {
    this.#tapCb = cb;
    if (cb && this.#tap && this.#tapRaf === null) this.#tapLoop();
    else if (!cb && this.#tapRaf !== null) {
      cancelAnimationFrame(this.#tapRaf);
      this.#tapRaf = null;
    }
  }

  #tapLoop = (): void => {
    const a = this.#tap;
    const buf = this.#tapBuf;
    const cb = this.#tapCb;
    if (!a || !buf || !cb) { this.#tapRaf = null; return; }
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
    cb(Math.sqrt(sum / buf.length), peak);
    this.#tapRaf = requestAnimationFrame(this.#tapLoop);
  };

  #makeGate(ctx: AudioContext): NoiseGateWorkletNode {
    return new NoiseGateWorkletNode(ctx, {
      openThreshold: this.#openDb,
      closeThreshold: this.#openDb - GATE_CLOSE_BELOW_OPEN_DB,
      holdMs: GATE_HOLD_MS,
      maxChannels: 1
    });
  }

  async #buildGraph(track: MediaStreamTrack, audioContext?: AudioContext): Promise<void> {
    this.#ownsCtx = !audioContext;
    const ctx = audioContext ?? new AudioContext({ sampleRate: 48000 });
    this.#ctx = ctx;

    if (!this.#wasmBinary) {
      this.#wasmBinary = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
    }
    if (!_workletModulesRegistered.has(ctx)) {
      await ctx.audioWorklet.addModule(rnnoiseWorkletPath);
      await ctx.audioWorklet.addModule(noiseGateWorkletPath);
      _workletModulesRegistered.add(ctx);
    }

    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: this.#wasmBinary });
    const gate = this.#makeGate(ctx);
    const gain = ctx.createGain();
    gain.gain.value = this.#makeupGain;
    const tap = ctx.createAnalyser();
    tap.fftSize = 512;
    tap.smoothingTimeConstant = 0.3;
    const dest = ctx.createMediaStreamDestination();
    // Default is 2-ch with channelCountMode "explicit" — a mono worklet only
    // fills output[0], leaving the right channel silent on the published track.
    dest.channelCount = 1;
    source.connect(rnnoise).connect(gate).connect(gain).connect(dest);
    // Parallel tap off the gain node into a sink-AnalyserNode — same context as
    // gain/dest, so reads are direct (no cross-context MediaStreamTrack hop).
    gain.connect(tap);

    this.#source = source;
    this.#rnnoise = rnnoise;
    this.#gate = gate;
    this.#gain = gain;
    this.#tap = tap;
    this.#tapBuf = new Float32Array(new ArrayBuffer(tap.fftSize * Float32Array.BYTES_PER_ELEMENT));
    this.#dest = dest;
    this.processedTrack = dest.stream.getAudioTracks()[0];
    if (this.#tapCb && this.#tapRaf === null) this.#tapLoop();
  }

  async #teardownGraph(): Promise<void> {
    if (this.#tapRaf !== null) {
      cancelAnimationFrame(this.#tapRaf);
      this.#tapRaf = null;
    }
    try {
      this.#source?.disconnect();
      this.#rnnoise?.disconnect();
      this.#rnnoise?.destroy();
      this.#gate?.disconnect();
      this.#gain?.disconnect();
      this.#tap?.disconnect();
      this.#dest?.disconnect();
    } catch {
      /* ignore teardown races */
    }
    this.#source = null;
    this.#rnnoise = null;
    this.#gate = null;
    this.#gain = null;
    this.#tap = null;
    this.#tapBuf = null;
    this.#dest = null;
    this.processedTrack = undefined;
    if (this.#ownsCtx && this.#ctx && this.#ctx.state !== 'closed') {
      try {
        await this.#ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.#ctx = null;
    this.#ownsCtx = false;
  }
}

/**
 * Slim `source → gain → dest` chain used when NS is off but the user wants
 * a non-1.0 input makeup gain (otherwise the slider has nowhere to apply).
 * No worklets, no WASM — cheap to spin up.
 */
class GainOnlyTrackProcessor implements TrackProcessor<Track.Kind.Audio> {
  name = 'gain-only-mic-processor';
  processedTrack?: MediaStreamTrack;

  #ctx: AudioContext | null = null;
  #ownsCtx = false;
  #source: MediaStreamAudioSourceNode | null = null;
  #gain: GainNode | null = null;
  #tap: AnalyserNode | null = null;
  #tapBuf: Float32Array<ArrayBuffer> | null = null;
  #tapCb: LevelTapCb | null = null;
  #tapRaf: number | null = null;
  #dest: MediaStreamAudioDestinationNode | null = null;
  #makeupGain: number;

  constructor(makeupGain: number) {
    this.#makeupGain = makeupGain;
  }

  init = async (opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> => {
    await this.#build(opts.track, opts.audioContext);
  };

  restart = async (opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> => {
    await this.#teardown();
    await this.#build(opts.track, opts.audioContext);
  };

  destroy = async (): Promise<void> => {
    await this.#teardown();
  };

  setMakeupGain(v: number): void {
    this.#makeupGain = v;
    if (this.#gain) this.#gain.gain.value = v;
  }

  setLevelTap(cb: LevelTapCb | null): void {
    this.#tapCb = cb;
    if (cb && this.#tap && this.#tapRaf === null) this.#tapLoop();
    else if (!cb && this.#tapRaf !== null) {
      cancelAnimationFrame(this.#tapRaf);
      this.#tapRaf = null;
    }
  }

  #tapLoop = (): void => {
    const a = this.#tap;
    const buf = this.#tapBuf;
    const cb = this.#tapCb;
    if (!a || !buf || !cb) { this.#tapRaf = null; return; }
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
    cb(Math.sqrt(sum / buf.length), peak);
    this.#tapRaf = requestAnimationFrame(this.#tapLoop);
  };

  async #build(track: MediaStreamTrack, audioContext?: AudioContext): Promise<void> {
    this.#ownsCtx = !audioContext;
    const ctx = audioContext ?? new AudioContext({ sampleRate: 48000 });
    this.#ctx = ctx;
    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = this.#makeupGain;
    const tap = ctx.createAnalyser();
    tap.fftSize = 512;
    tap.smoothingTimeConstant = 0.3;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    source.connect(gain).connect(dest);
    gain.connect(tap);
    this.#source = source;
    this.#gain = gain;
    this.#tap = tap;
    this.#tapBuf = new Float32Array(new ArrayBuffer(tap.fftSize * Float32Array.BYTES_PER_ELEMENT));
    this.#dest = dest;
    this.processedTrack = dest.stream.getAudioTracks()[0];
    if (this.#tapCb && this.#tapRaf === null) this.#tapLoop();
  }

  async #teardown(): Promise<void> {
    if (this.#tapRaf !== null) {
      cancelAnimationFrame(this.#tapRaf);
      this.#tapRaf = null;
    }
    try {
      this.#source?.disconnect();
      this.#gain?.disconnect();
      this.#tap?.disconnect();
      this.#dest?.disconnect();
    } catch {
      /* ignore teardown races */
    }
    this.#source = null;
    this.#gain = null;
    this.#tap = null;
    this.#tapBuf = null;
    this.#dest = null;
    this.processedTrack = undefined;
    if (this.#ownsCtx && this.#ctx && this.#ctx.state !== 'closed') {
      try {
        await this.#ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.#ctx = null;
    this.#ownsCtx = false;
  }
}

/** Build whichever send-side processor matches the current settings. */
export function createSendProcessor(
  mode: SendProcessorMode,
  gateOpenDb: number,
  makeupGain: number
): SendProcessorHandle {
  if (mode === 'rnnoise_gated') {
    const proc = new RnnoiseGatedTrackProcessor(gateOpenDb, makeupGain);
    return {
      processor: proc,
      setGateThreshold: (db) => proc.setGateThreshold(db),
      setMakeupGain: (v) => proc.setMakeupGain(v),
      setLevelTap: (cb) => proc.setLevelTap(cb)
    };
  }
  const proc = new GainOnlyTrackProcessor(makeupGain);
  return {
    processor: proc,
    setGateThreshold: () => undefined,
    setMakeupGain: (v) => proc.setMakeupGain(v),
    setLevelTap: (cb) => proc.setLevelTap(cb)
  };
}
