/**
 * Per-participant binaural spatialisation built on the vendored Resonance Audio
 * scene. One `SpatialScene` is owned by the playback graph (`audioElements.ts`);
 * each participant gets one Resonance source whose `.input` the participant's
 * audio chain tail feeds into. The scene's binaural output goes to the
 * destination once.
 *
 * The listener sits at the origin facing forward and never moves — head motion
 * is the listener's real head, which we can't track in a browser, so we don't
 * fake it. Direction/distance come entirely from where each source sits.
 *
 * Positions are listener-local: the UI arranges everyone around *you*, purely
 * for your own listening. Until the UI assigns one (Phase 3), sources are
 * auto-spread evenly across the frontal arc so even the default sounds spatial.
 */
import type { SpatialMode } from '$lib/stores/settings.svelte';
import type {
  ResonanceCtor,
  ResonanceRoomMaterials,
  ResonanceScene,
  ResonanceSource
} from './resonanceLoader';

/** Concrete render quality — `auto` resolves to one of these at runtime. */
export type SpatialQuality = 'standard' | 'high';

interface QualityConfig {
  /** Ambisonic order: the main CPU lever (1 = cheap/blurry, 3 = sharp/costly). */
  ambisonicOrder: number;
  dimensions: { width: number; height: number; depth: number };
  materials: ResonanceRoomMaterials;
  /** Source spread in degrees — a little width takes the edge off "in-head". */
  sourceWidth: number;
}

function uniform(material: string): ResonanceRoomMaterials {
  return { left: material, right: material, front: material, back: material, up: material, down: material };
}

const QUALITY: Record<SpatialQuality, QualityConfig> = {
  // Absorptive box + 1st order: minimal reverb, lowest CPU — for laptops.
  standard: {
    ambisonicOrder: 1,
    dimensions: { width: 5, height: 3, depth: 5 },
    materials: uniform('curtain-heavy'),
    sourceWidth: 20
  },
  // Living-room reflections + 3rd order: full externalised image — for desktops.
  high: {
    ambisonicOrder: 3,
    dimensions: { width: 6, height: 3, depth: 5 },
    materials: {
      left: 'curtain-heavy',
      right: 'wood-panel',
      front: 'glass-thin',
      back: 'brick-bare',
      up: 'acoustic-ceiling-tiles',
      down: 'grass'
    },
    sourceWidth: 30
  }
};

const SOURCE_MIN_DISTANCE = 1;
const SOURCE_MAX_DISTANCE = 40;
const DEFAULT_DISTANCE = 2.5;
/** Frontal arc the auto-spread fans speakers across (−ARC/2 … +ARC/2), degrees. */
const AUTO_SPREAD_ARC = 200;

/** Pick a concrete quality for a mode, sensing the device for `auto`. */
export function resolveQuality(mode: Exclude<SpatialMode, 'off'>): SpatialQuality {
  if (mode === 'standard' || mode === 'high') return mode;
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return cores >= 8 ? 'high' : 'standard';
}

interface ManagedSource {
  src: ResonanceSource;
  /** True once the UI set an explicit position — excludes it from auto-spread. */
  manual: boolean;
}

export class SpatialScene {
  #scene: ResonanceScene;
  #ctx: AudioContext;
  #width: number;
  #sources = new Map<string, ManagedSource>();

  constructor(Ctor: ResonanceCtor, ctx: AudioContext, quality: SpatialQuality) {
    const cfg = QUALITY[quality];
    this.#ctx = ctx;
    this.#width = cfg.sourceWidth;
    this.#scene = new Ctor(ctx, { ambisonicOrder: cfg.ambisonicOrder });
    this.#scene.output.connect(ctx.destination);
    this.#scene.setRoomProperties(cfg.dimensions, cfg.materials);
    this.#scene.setListenerOrientation(0, 0, -1, 0, 1, 0);
  }

  /** Input node for `userId`'s source, creating it on first use. */
  ensureSource(userId: string): AudioNode {
    let managed = this.#sources.get(userId);
    if (!managed) {
      const src = this.#scene.createSource();
      src.setRolloff('logarithmic');
      src.setMinDistance(SOURCE_MIN_DISTANCE);
      src.setMaxDistance(SOURCE_MAX_DISTANCE);
      src.setSourceWidth(this.#width);
      managed = { src, manual: false };
      this.#sources.set(userId, managed);
      this.#autoSpread();
    }
    return managed.src.input;
  }

  sourceInput(userId: string): AudioNode | null {
    return this.#sources.get(userId)?.src.input ?? null;
  }

  removeSource(userId: string): void {
    const managed = this.#sources.get(userId);
    if (!managed) return;
    try {
      managed.src.input.disconnect();
    } catch {
      /* already gone */
    }
    this.#sources.delete(userId);
    this.#autoSpread();
  }

  /** Place `userId` at an azimuth (0° = front, +90° = right) and distance (m). */
  setPosition(userId: string, azimuthDeg: number, distance: number): void {
    const managed = this.#sources.get(userId);
    if (!managed) return;
    managed.manual = true;
    this.#applyPosition(managed.src, azimuthDeg, distance);
  }

  destroy(): void {
    for (const { src } of this.#sources.values()) {
      try {
        src.input.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.#sources.clear();
    try {
      this.#scene.output.disconnect();
    } catch {
      /* already gone */
    }
  }

  #applyPosition(src: ResonanceSource, azimuthDeg: number, distance: number): void {
    const rad = (azimuthDeg * Math.PI) / 180;
    src.setPosition(distance * Math.sin(rad), 0, -distance * Math.cos(rad));
  }

  /** Evenly fan all not-yet-manually-placed sources across the frontal arc. */
  #autoSpread(): void {
    const auto = [...this.#sources.values()].filter((m) => !m.manual);
    const n = auto.length;
    auto.forEach((m, i) => {
      const azimuth = n === 1 ? 0 : -AUTO_SPREAD_ARC / 2 + (AUTO_SPREAD_ARC * i) / (n - 1);
      this.#applyPosition(m.src, azimuth, DEFAULT_DISTANCE);
    });
  }
}
