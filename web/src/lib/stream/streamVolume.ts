/**
 * Persisted per-streamer viewer volume.
 *
 * The WHEP viewer's volume slider (`WhepPlayer.svelte`) is per-component and
 * was reset to 100 % on every mount — re-opening a stream tile (channel
 * switch, hide/show, detach-close, reconnect) lost a manually lowered level.
 * This keeps a small ``{ [userId]: percent }`` map in localStorage so a
 * streamer who is "always too loud" stays turned down across channels and
 * sessions.
 *
 * Why localStorage and not the Electron ``pulse.store``: WHEP *viewing* runs
 * in any browser (only HQ *publishing* is Electron-gated), so this must work
 * outside the desktop shell. Plain JSON blob, same pattern as `dcc.settings`.
 *
 * Value semantics mirror the slider: 0 = muted, 100 = unity, up to
 * ``VOLUME_BOOST_MAX`` (200) for the Web-Audio gain boost. We persist the raw
 * value including 0 and >100 — a muted stream stays muted on re-entry, a
 * boosted one stays boosted.
 */

import { VOLUME_BOOST_MAX } from './volumeBoost';

const LS_KEY = 'dcc.streamVolumes';
const DEBOUNCE_MS = 300;

/** Default when a streamer has no remembered level. */
export const DEFAULT_STREAM_VOLUME = 100;

function clamp(v: number): number {
  return Math.min(VOLUME_BOOST_MAX, Math.max(0, v));
}

function read(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Remembered volume for ``userId`` (0..VOLUME_BOOST_MAX), or the default. */
export function getStreamVolume(userId: string): number {
  const v = read()[userId];
  // Clamp on read too — guards against a corrupt/hand-edited localStorage
  // value blasting the gain on the next mount.
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? clamp(v) : DEFAULT_STREAM_VOLUME;
}

let pending: Record<string, number> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  if (!pending || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(pending));
  } catch {
    /* quota / disabled storage — non-fatal, volume just won't persist */
  }
  pending = null;
}

/** Persist ``userId``'s volume. Debounced — slider drags fire rapidly. */
export function setStreamVolume(userId: string, percent: number): void {
  pending = { ...(pending ?? read()), [userId]: clamp(percent) };
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
}
