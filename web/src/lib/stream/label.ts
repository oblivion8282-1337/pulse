/**
 * Resolve a raw `capture_source` (stored per slot in settings) into a
 * human-readable `{ label, icon }` — used by the streamer's status bar (local
 * state) and sent to the backend at stream-start so viewers' picker shows the
 * same text without needing the GSR catalogs.
 *
 * Platform-aware: the `capture_source` token encodes the platform's source model.
 *   - `"portal"` (Linux Wayland) → generic `Stream <N>` fallback. The portal
 *     source is chosen interactively at capture time, so there's nothing to name
 *     up front — two Linux streams differ only by slot number.
 *   - `"Monitor: <index>"` (Windows/macOS) → the enumerated monitor's `name`
 *     (e.g. "DELL U2720Q"), falling back to `Monitor <n>`.
 *   - `"window:<id>"` (Windows/macOS) → the captured window's app/title
 *     (e.g. "Chrome"), falling back to `Window`.
 *   - anything else / empty → generic `Stream <N>`.
 *
 * Pure + side-effect-free so it's cheap to call inside a `$derived`.
 */
import type { GsrMonitor, GsrWindow } from './gsr';
import {
  MONITOR_CAPTURE_PREFIX,
  WINDOW_CAPTURE_PREFIX,
  captureSourceForSlot,
  streamSettings,
} from './settings.svelte';

export type StreamIcon = 'monitor' | 'app' | 'generic';

export interface StreamLabel {
  label: string;
  icon: StreamIcon;
}

export interface StreamCatalogs {
  monitors: GsrMonitor[];
  windows: GsrWindow[];
}

/** `slot` is 0-based; the generic fallback uses the 1-based slot number so two
 *  unnamed streams (Linux portal / unknown) stay distinguishable. */
export function resolveStreamLabel(
  captureSource: string | undefined | null,
  catalogs: StreamCatalogs,
  slot: number,
): StreamLabel {
  const src = (captureSource ?? '').trim();
  const fallback: StreamLabel = { label: `Stream ${slot + 1}`, icon: 'generic' };
  if (!src || src === 'portal') return fallback;

  if (src.startsWith(MONITOR_CAPTURE_PREFIX)) {
    const idx = Number(src.slice(MONITOR_CAPTURE_PREFIX.length));
    const mon = catalogs.monitors.find((m) => m.index === idx);
    if (mon?.name) return { label: mon.name, icon: 'monitor' };
    if (Number.isInteger(idx)) return { label: `Monitor ${idx}`, icon: 'monitor' };
    return fallback;
  }

  if (src.startsWith(WINDOW_CAPTURE_PREFIX)) {
    const id = Number(src.slice(WINDOW_CAPTURE_PREFIX.length));
    const win = catalogs.windows.find((w) => w.id === id);
    // Prefer the terse app name (recognisable); fall back to the window title.
    const name = win?.app?.trim() || win?.title?.trim();
    if (name) return { label: name, icon: 'app' };
    return { label: 'Window', icon: 'app' };
  }

  return fallback;
}

/** Convenience: resolve the label for a slot straight off the live settings
 *  (capture source + the enumerated monitor/window catalogs). Read inside a
 *  `$derived` for reactivity. */
export function resolveSlotLabel(slot: number): StreamLabel {
  return resolveStreamLabel(
    captureSourceForSlot(slot),
    {
      monitors: streamSettings.available_monitors,
      windows: streamSettings.available_windows,
    },
    slot,
  );
}
