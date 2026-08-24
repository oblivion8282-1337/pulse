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
import { windowDisplayName } from './windowName';
import { monitorNummer } from './quellenummer';
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
  /**
   * Welchen Bildschirm des Hosts dieser Strom zeigt — 1-basiert, passend zur
   * Aufnahmequelle `Monitor: <index>`.
   *
   * **Der Name allein reicht nicht.** Zwei baugleiche Monitore heissen gleich;
   * wer nur den Namen ueber den Draht schickt, macht die Zuordnung beim
   * Zuschauer unmoeglich (Fehler vom 2026-08-24). `undefined` bei
   * Fenster-Aufnahmen, beim Linux-Portal — und bei einer 0, die beim Klienten
   * „keine Nummer" bedeutet (s. `quellenummer.ts::MONITOR_INDEX_MIN`).
   */
  monitorIndex?: number;
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
    const idx = monitorNummer(src);
    const mon = idx === undefined ? undefined : catalogs.monitors.find((m) => m.index === idx);
    if (mon?.name) return { label: mon.name, icon: 'monitor', monitorIndex: idx };
    if (idx !== undefined) return { label: `Monitor ${idx}`, icon: 'monitor', monitorIndex: idx };
    return fallback;
  }

  if (src.startsWith(WINDOW_CAPTURE_PREFIX)) {
    const id = Number(src.slice(WINDOW_CAPTURE_PREFIX.length));
    const win = catalogs.windows.find((w) => w.id === id);
    // Same readable name the source picker shows — viewers see this as the
    // stream's name, so "Google Chrome" beats "chrome.exe" (see windowName.ts).
    const name = win ? windowDisplayName(win) : '';
    return { label: name || 'Window', icon: 'app' };
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

// ── Per-slot custom labels (streamer-side only) ──────────────────────────
//
// Linux Wayland uses `capture_source = 'portal'` and the source is chosen
// interactively in the xdg-desktop-portal dialog at capture time — GSR doesn't
// report the choice back, so the catalog lookup always falls back to a generic
// "Stream <N>". The streamer can give each slot a stable local name here; the
// custom name is preferred over the catalog/portal fallback in
// `resolveStreamLabel` but ONLY on the streamer side — the viewer picker still
// sees whatever label the streamer sent to the backend at stream-start (so
// syncing this to media-svc / chat-gateway is a separate, wider change).
//
// Persists in localStorage (key `pulse.stream.customLabel`) so the name sticks
// across reloads and app restarts. Survives Electron-vs-browser (each has its
// own localStorage; the streamer uses whichever they're logged into).
//
// These helpers are pure & non-reactive on purpose (label.ts is `.ts`, not
// `.svelte.ts`) — the consumer keeps a `$state`-backed copy + bumps it on edit
// to drive derived re-reads.

const CUSTOM_STORAGE_KEY = 'pulse.stream.customLabel';
const MAX_CUSTOM_LABEL = 40;

export type CustomLabelMap = Record<string, string>; // serialized as JSON; keys are strings per JSON

/** Read the persisted custom-label map. Returns `{}` if storage is unavailable
 *  (SSR, tests, denied). Tolerant to malformed JSON — drops the whole map on
 *  parse failure rather than throwing into a Svelte `$state` init. */
export function loadCustomLabels(): CustomLabelMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as unknown;
    if (obj === null || typeof obj !== 'object') return {};
    // Coerce — never trust localStorage shape.
    const out: CustomLabelMap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0 && v.length <= MAX_CUSTOM_LABEL) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Snapshot the in-memory map back to storage. Best-effort — quota / private
 *  mode failures are swallowed (the in-memory `$state` copy survives the
 *  session either way). */
export function saveCustomLabels(labels: CustomLabelMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(labels));
  } catch {
    /* ignore — quota, disabled storage, etc. */
  }
}

/** Look up the custom name for a slot. Returns `undefined` when unset or
 *  blank — fall through to the catalog / portal fallback in that case. */
export function getCustomLabel(labels: CustomLabelMap, slot: number): string | undefined {
  const v = labels[String(slot)];
  return v && v.trim() ? v : undefined;
}

/** Sanitize a user-entered label — trim, length-cap, drop empties. Used by
 *  both the inline-edit input and any future bulk-import paths. */
export function sanitizeCustomLabel(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  return t.length > MAX_CUSTOM_LABEL ? t.slice(0, MAX_CUSTOM_LABEL) : t;
}
