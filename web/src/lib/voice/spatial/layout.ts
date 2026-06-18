/**
 * Global spatial-audio layout preference — how the auto-positioner fans the
 * other speakers out in front of you. Listener-local, persisted in
 * localStorage, shared across all channels (it's "how I like my spatial
 * layout", not per-room). Everyone sits in a frontal arc at one shared
 * distance; new joins re-balance automatically (the engine recomputes).
 */
const STORAGE_KEY = 'dcc.spatial.layout';

export const SPREAD_MIN = 0;
export const SPREAD_MAX = 160;
export const DIST_MIN = 0.5;
export const DIST_MAX = 6;

export interface SpatialLayout {
  /** Total frontal arc the speakers are fanned across, in degrees (centred on 0° = front). */
  spreadDeg: number;
  /** Distance of every speaker from the listener, in metres. */
  distanceM: number;
}

export const DEFAULT_LAYOUT: SpatialLayout = { spreadDeg: 40, distanceM: 1 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Azimuth (degrees, 0° = front) of speaker `i` of `n`, fanned evenly across
 *  the total `spread`. Shared by the audio engine and the on-screen circle so
 *  the two stay in lock-step. */
export function azimuthFor(i: number, n: number, spread: number): number {
  return n <= 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);
}

export function loadLayout(): SpatialLayout {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_LAYOUT };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const p = JSON.parse(raw) as Partial<SpatialLayout>;
    return {
      spreadDeg: clamp(Number(p.spreadDeg ?? DEFAULT_LAYOUT.spreadDeg), SPREAD_MIN, SPREAD_MAX),
      distanceM: clamp(Number(p.distanceM ?? DEFAULT_LAYOUT.distanceM), DIST_MIN, DIST_MAX)
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: SpatialLayout): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* quota — layout is non-critical, drop silently */
  }
}
