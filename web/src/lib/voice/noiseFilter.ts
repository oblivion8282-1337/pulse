import type { Track, TrackProcessor, ProcessorOptions } from 'livekit-client';
import { RnnoiseWorkletNode, NoiseGateWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import noiseGateWorkletPath from '@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url';
import type { NoiseSuppressionMode } from '$lib/stores/settings.svelte';

/** Hysteresis: gate closes 5 dB below the open threshold so it doesn't
 *  rapidly toggle around the boundary during steady-level breaths/sibilants. */
const GATE_CLOSE_BELOW_OPEN_DB = 5;
/** Grace period before the gate actually closes — long enough that a normal
 *  inter-word pause doesn't cut off, short enough that pauses sound clean. */
const GATE_HOLD_MS = 200;

/** Modes backed by a LiveKit audio TrackProcessor we publish ourselves. */
export type ProcessorMode = Exclude<NoiseSuppressionMode, 'off'>;

export type AudioTrackProcessor = TrackProcessor<Track.Kind.Audio>;

/** TrackProcessor + live-tune handle. The gate-threshold setter rebuilds only
 *  the gate node (the worklet has no port API for thresholds). */
export type NoiseProcessorHandle = {
  processor: AudioTrackProcessor;
  setGateThreshold: (openDb: number) => void;
};

/**
 * RNNoise followed by a hard noise-gate — werman/Discord-style "clean pauses".
 * Threshold can be live-retuned via `setGateThreshold(openDb)`.
 */
class RnnoiseGatedTrackProcessor implements TrackProcessor<Track.Kind.Audio> {
  name = 'rnnoise-gated-noise-filter';
  processedTrack?: MediaStreamTrack;

  #ctx: AudioContext | null = null;
  #ownsCtx = false;
  #source: MediaStreamAudioSourceNode | null = null;
  #rnnoise: RnnoiseWorkletNode | null = null;
  #gate: NoiseGateWorkletNode | null = null;
  #dest: MediaStreamAudioDestinationNode | null = null;
  #wasmBinary: ArrayBuffer | null = null;
  #openDb: number;

  constructor(openDb: number) {
    this.#openDb = openDb;
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
   *  initiated slider release. RNNoise + source + destination stay intact. */
  setGateThreshold(openDb: number): void {
    this.#openDb = openDb;
    const ctx = this.#ctx;
    const rnnoise = this.#rnnoise;
    const dest = this.#dest;
    if (!ctx || !rnnoise || !dest) return;
    try {
      this.#gate?.disconnect();
    } catch {
      /* ignore disconnect races */
    }
    const gate = this.#makeGate(ctx);
    rnnoise.disconnect();
    rnnoise.connect(gate).connect(dest);
    this.#gate = gate;
  }

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
    await ctx.audioWorklet.addModule(rnnoiseWorkletPath);
    await ctx.audioWorklet.addModule(noiseGateWorkletPath);

    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: this.#wasmBinary });
    const gate = this.#makeGate(ctx);
    const dest = ctx.createMediaStreamDestination();
    // Default is 2-ch with channelCountMode "explicit" — a mono worklet only
    // fills output[0], leaving the right channel silent on the published track.
    dest.channelCount = 1;
    source.connect(rnnoise).connect(gate).connect(dest);

    this.#source = source;
    this.#rnnoise = rnnoise;
    this.#gate = gate;
    this.#dest = dest;
    this.processedTrack = dest.stream.getAudioTracks()[0];
  }

  async #teardownGraph(): Promise<void> {
    try {
      this.#source?.disconnect();
      this.#rnnoise?.disconnect();
      this.#rnnoise?.destroy();
      this.#gate?.disconnect();
      this.#dest?.disconnect();
    } catch {
      /* ignore teardown races */
    }
    this.#source = null;
    this.#rnnoise = null;
    this.#gate = null;
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

/** Build the (sole) audio TrackProcessor used when noise suppression is on. */
export function createNoiseProcessor(_mode: ProcessorMode, gateOpenDb: number): NoiseProcessorHandle {
  const proc = new RnnoiseGatedTrackProcessor(gateOpenDb);
  return {
    processor: proc,
    setGateThreshold: (openDb) => proc.setGateThreshold(openDb)
  };
}
