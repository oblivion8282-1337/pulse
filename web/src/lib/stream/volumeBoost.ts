/**
 * Volume control for an HTMLMediaElement that can go *above* 100% via a Web
 * Audio GainNode. `HTMLMediaElement.volume` is clamped to [0, 1] by the HTML
 * spec, so any boost factor has to route through Web Audio.
 *
 * Lazy: while the requested volume is ≤ 1.0 we just set `el.volume`. The
 * AudioContext + MediaElementSource are only built on the first request for
 * boost > 1.0 (driven by a slider input → user gesture, so `resume()` works).
 *
 * Once the graph is up, the element's native `volume` is pinned to 1.0 — the
 * audio stream is now consumed by the graph, not the speaker, so the element's
 * own volume would just be double-attenuation. The mute toggle still drives
 * us, it just sets gain to 0.
 *
 * Boost > 1.0 will clip / distort sources already near 0 dBFS. That's expected
 * for a user-controlled boost slider.
 */
export class VolumeBoost {
  private ctx: AudioContext | null = null;
  private src: MediaElementAudioSourceNode | null = null;
  private gain: GainNode | null = null;

  constructor(private readonly el: HTMLMediaElement) {}

  /** Set the volume as a linear gain (0..MAX). 1.0 = 100%. */
  setVolume(v: number): void {
    const want = Math.max(0, v);
    if (!this.ctx && want <= 1.0) {
      this.el.volume = want;
      return;
    }
    if (!this.ctx && !this._initGraph()) {
      this.el.volume = Math.min(1.0, want);
      return;
    }
    if (this.ctx!.state === 'suspended') void this.ctx!.resume();
    if (this.gain) this.gain.gain.value = want;
  }

  dispose(): void {
    try {
      this.src?.disconnect();
      this.gain?.disconnect();
      void this.ctx?.close();
    } catch {
      /* element/context already torn down */
    }
    this.ctx = null;
    this.src = null;
    this.gain = null;
  }

  private _initGraph(): boolean {
    const Ctor =
      (window.AudioContext as typeof AudioContext | undefined) ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return false;
    try {
      this.ctx = new Ctor();
      this.src = this.ctx.createMediaElementSource(this.el);
      this.gain = this.ctx.createGain();
      this.src.connect(this.gain).connect(this.ctx.destination);
      this.el.volume = 1.0;
      return true;
    } catch {
      this.ctx = null;
      this.src = null;
      this.gain = null;
      return false;
    }
  }
}

/** Slider max for the HQ + screen-share volume controls (200%). */
export const VOLUME_BOOST_MAX = 200;
