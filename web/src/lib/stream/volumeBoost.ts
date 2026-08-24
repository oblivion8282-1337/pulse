import { applySinkId } from '$lib/audio/applySinkId';

/**
 * Volume control for a WebRTC `MediaStream` that can go above 100% via a Web
 * Audio GainNode. `HTMLMediaElement.volume` is clamped to [0, 1] by the HTML
 * spec, so boost > 1.0 needs Web Audio. Crucially, `createMediaElementSource`
 * does NOT work for elements whose `srcObject` is a MediaStream (WebRTC) in
 * Chromium — the audio bypasses the graph. We therefore route via
 * `createMediaStreamSource` and mute the playback element so we don't double-
 * play.
 *
 * Lifecycle:
 *   1. Construct (no graph yet).
 *   2. `attach(stream)` builds the AudioContext + graph. The AudioContext
 *      starts `suspended` until a user-gesture-driven `resume()` — callers
 *      should mirror that into the existing audio-blocked overlay.
 *   3. `setVolume(v)` adjusts gain (0..MAX, 1.0 = 100%). Cheap; no graph
 *      rebuild.
 *   4. `attach(stream)` again with a different stream re-points the source.
 *   5. `dispose()` tears everything down. The element is left muted — the
 *      caller can un-mute if they want fallback playback.
 */
export class VolumeBoost {
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private attachedStream: MediaStream | null = null;
  private currentGain = 1.0;
  /** Sink chosen in settings — applied to a freshly-created context and
   *  reapplied by rebuilding on `setOutputDevice()` (a live `setSinkId` on a
   *  running context fed by a `MediaStreamAudioSourceNode` does not reliably
   *  reroute, same caveat as `RemoteAudioElements.setOutputDevice`). */
  private outputDeviceId = '';

  /** Notified whenever the underlying AudioContext changes between
   *  `running` and `suspended`. Component wires this into its audio-blocked
   *  state. */
  onStateChange: ((suspended: boolean) => void) | null = null;

  /**
   * Build (or rebuild) the graph for `stream`. Returns true if at least one
   * audio track was found and the graph is live (regardless of suspended
   * state — that's for the caller to resolve via `resume()`).
   */
  attach(stream: MediaStream): boolean {
    if (this.attachedStream === stream && this.src) return true;
    this._teardownGraph();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return false;
    const Ctor =
      (window.AudioContext as typeof AudioContext | undefined) ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return false;
    try {
      if (!this.ctx) {
        this.ctx = new Ctor();
        this.ctx.onstatechange = () => {
          this.onStateChange?.(this.ctx?.state !== 'running');
        };
        if (this.outputDeviceId) void applySinkId(this.ctx, this.outputDeviceId);
      }
      this.src = this.ctx.createMediaStreamSource(new MediaStream(audioTracks));
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.currentGain;
      this.src.connect(this.gain).connect(this.ctx.destination);
      this.attachedStream = stream;
      return true;
    } catch {
      this._teardownGraph();
      return false;
    }
  }

  /** True iff the AudioContext is suspended (autoplay-blocked, etc.). */
  get suspended(): boolean {
    return !!this.ctx && this.ctx.state !== 'running';
  }

  /** Resume the AudioContext. Must be called from a user-gesture handler. */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') {
      await this.ctx.resume();
    }
  }

  setVolume(v: number): void {
    this.currentGain = Math.max(0, v);
    if (this.gain) this.gain.gain.value = this.currentGain;
  }

  /**
   * Switch the audible sink to `deviceId`. Without a live context yet, the
   * next `attach()` binds to it directly. With one already running, rebuild
   * it (see the class-level caveat above `outputDeviceId`) — the retained
   * `attachedStream` lets `attach()` re-point the graph at the fresh context.
   */
  setOutputDevice(deviceId: string): void {
    if (this.outputDeviceId === deviceId) return;
    this.outputDeviceId = deviceId;
    if (!this.ctx) return;
    const stream = this.attachedStream;
    const oldCtx = this.ctx;
    this._teardownGraph();
    this.ctx = null;
    if (stream) this.attach(stream);
    void oldCtx.close().catch(() => undefined);
  }

  dispose(): void {
    this._teardownGraph();
    try {
      void this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.onStateChange = null;
  }

  private _teardownGraph(): void {
    try { this.src?.disconnect(); } catch { /**/ }
    try { this.gain?.disconnect(); } catch { /**/ }
    this.src = null;
    this.gain = null;
    this.attachedStream = null;
  }
}

/** Slider max for the HQ + screen-share volume controls (200%). */
export const VOLUME_BOOST_MAX = 200;
