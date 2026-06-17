/**
 * Lazy-loader for the vendored Resonance Audio UMD bundle
 * (`/vendor/resonance-audio/resonance-audio.min.js`, see that folder's README).
 *
 * The bundle is a static asset, never part of the main JS bundle — it's fetched
 * the first time a desktop user actually turns spatial audio on, then cached on
 * `window.ResonanceAudio`. The minimal type surface below covers only the bits
 * we use (the upstream package ships no types).
 */

export interface ResonanceRoomDimensions {
  width: number;
  height: number;
  depth: number;
}

export interface ResonanceRoomMaterials {
  left: string;
  right: string;
  front: string;
  back: string;
  up: string;
  down: string;
}

export interface ResonanceSource {
  /** Web Audio input node — connect a participant's chain tail here. */
  input: AudioNode;
  setPosition(x: number, y: number, z: number): void;
  setSourceWidth(degrees: number): void;
  setRolloff(model: 'logarithmic' | 'linear' | 'none'): void;
  setMinDistance(meters: number): void;
  setMaxDistance(meters: number): void;
}

export interface ResonanceScene {
  /** Binaural output bus — connect once to `ctx.destination`. */
  output: AudioNode;
  createSource(): ResonanceSource;
  setRoomProperties(dimensions: ResonanceRoomDimensions, materials: ResonanceRoomMaterials): void;
  setListenerOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
}

export interface ResonanceCtor {
  new (ctx: AudioContext, options?: { ambisonicOrder?: number }): ResonanceScene;
}

const SCRIPT_SRC = '/vendor/resonance-audio/resonance-audio.min.js';

let loadPromise: Promise<ResonanceCtor> | null = null;

function globalCtor(): ResonanceCtor | undefined {
  return (window as unknown as { ResonanceAudio?: ResonanceCtor }).ResonanceAudio;
}

/** Resolve the Resonance Audio constructor, injecting the vendored script once.
 *  Subsequent calls reuse the in-flight or completed load. */
export function loadResonance(): Promise<ResonanceCtor> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('resonance: no DOM'));
  }
  const existing = globalCtor();
  if (existing) return Promise.resolve(existing);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<ResonanceCtor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      const ctor = globalCtor();
      if (ctor) resolve(ctor);
      else reject(new Error('resonance: ResonanceAudio missing after load'));
    };
    script.onerror = () => {
      loadPromise = null; // allow a later retry
      reject(new Error('resonance: script failed to load'));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}
