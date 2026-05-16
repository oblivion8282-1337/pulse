import type { Track, TrackProcessor, ProcessorOptions } from 'livekit-client';
import { DeepFilterNoiseFilterProcessor } from 'deepfilternet3-noise-filter';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import type { NoiseSuppressionMode } from '$lib/stores/settings.svelte';

/** Whichever modes are backed by a LiveKit audio TrackProcessor we publish ourselves. */
export type ProcessorMode = Exclude<NoiseSuppressionMode, 'off' | 'browser'>;

export type AudioTrackProcessor = TrackProcessor<Track.Kind.Audio>;

/** TrackProcessor + a live-tunable `setSuppressionLevel`. RNNoise has no
 *  equivalent, so its handle is just the processor with no extra surface. */
export type NoiseProcessorHandle = {
  processor: AudioTrackProcessor;
  /** Only present for DFN3 — adjusts the WASM attenuation limit live. */
  setSuppressionLevel?: (level: number) => void;
};

/**
 * RNNoise-based noise suppression as a LiveKit audio TrackProcessor.
 *
 * Wraps `@sapphi-red/web-noise-suppressor`'s AudioWorklet RNNoise node in the
 * `init / restart / destroy / processedTrack` shape that livekit-client expects
 * for `LocalAudioTrack.setProcessor()`.
 */
class RnnoiseTrackProcessor implements TrackProcessor<Track.Kind.Audio> {
  name = 'rnnoise-noise-filter';
  processedTrack?: MediaStreamTrack;

  #ctx: AudioContext | null = null;
  #ownsCtx = false;
  #source: MediaStreamAudioSourceNode | null = null;
  #node: RnnoiseWorkletNode | null = null;
  #dest: MediaStreamAudioDestinationNode | null = null;
  #wasmBinary: ArrayBuffer | null = null;

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

  async #buildGraph(track: MediaStreamTrack, audioContext?: AudioContext): Promise<void> {
    // RNNoise assumes 48kHz; force it so the worklet's frame math is correct.
    this.#ownsCtx = !audioContext;
    const ctx = audioContext ?? new AudioContext({ sampleRate: 48000 });
    this.#ctx = ctx;

    if (!this.#wasmBinary) {
      this.#wasmBinary = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
    }
    await ctx.audioWorklet.addModule(rnnoiseWorkletPath);

    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: this.#wasmBinary });
    const dest = ctx.createMediaStreamDestination();
    source.connect(node).connect(dest);

    this.#source = source;
    this.#node = node;
    this.#dest = dest;
    this.processedTrack = dest.stream.getAudioTracks()[0];
  }

  async #teardownGraph(): Promise<void> {
    try {
      this.#source?.disconnect();
      this.#node?.disconnect();
      this.#node?.destroy();
      this.#dest?.disconnect();
    } catch {
      /* ignore teardown races */
    }
    this.#source = null;
    this.#node = null;
    this.#dest = null;
    this.processedTrack = undefined;
    // Only close contexts we created ourselves; never LiveKit's shared one.
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
 * Warm the HTTP cache for DFN3 assets without touching AudioContext.
 * Safe to call before any user gesture.
 */
export function preloadNoiseFilter(): void {
  WebAssembly.compileStreaming(fetch('/deepfilternet3/v2/pkg/df_bg.wasm')).catch(() => {});
  fetch('/deepfilternet3/v2/models/DeepFilterNet3_onnx.tar.gz', { priority: 'low' } as RequestInit).catch(() => {});
}

/**
 * Build the audio TrackProcessor for the requested mode.
 * `strength` 0..100 controls DeepFilterNet3's max attenuation in dB (ignored for RNNoise).
 */
export function createNoiseProcessor(mode: ProcessorMode, strength: number): NoiseProcessorHandle {
  if (mode === 'deepfilternet') {
    const filter = new DeepFilterNoiseFilterProcessor({
      sampleRate: 48000,
      noiseReductionLevel: strength,
      enabled: true,
      assetConfig: {
        cdnUrl: '/deepfilternet3'
      }
    });
    return {
      processor: filter as unknown as AudioTrackProcessor,
      setSuppressionLevel: (level) => filter.setSuppressionLevel(level)
    };
  }
  return { processor: new RnnoiseTrackProcessor() };
}
