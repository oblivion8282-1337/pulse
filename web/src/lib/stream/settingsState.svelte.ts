/**
 * Zustand + Persistenz der Stream-Einstellungen.
 *
 * Der `$state`-Kern (`streamSettings`) und alles, was ihn auf die Platte bringt
 * und zurückholt. Aus `settings.svelte.ts` herausgelöst; die Ableitungen daraus
 * (GPU-Vorgaben, Sidecar-Argumente, Quellenwahl) stehen in den Nachbardateien
 * und importieren von hier — nie umgekehrt.
 *
 * Persistenzweg: `persistence.ts` → `window.pulse.store.*` unter Electron,
 * `localStorage` im reinen Browser.
 */

import type { GsrGpuInfo, GsrMonitor, GsrWindow } from './gsr';
import { debounce, loadAll, saveAll } from './persistence';
import { isWindows } from '$lib/platform/runtime';
import {
  APP_AUDIO_PREFIX,
  AUDIO_MODES,
  RESOLUTION_VALUES,
  type OverrideSet,
} from './settingsCatalog';

// ── Reactive state ──────────────────────────────────────────────────────────

export const streamSettings = $state({
  // Selections (persisted)
  profile_name: '',
  capture_source: 'portal' as 'portal' | string,
  // Quelle jedes WEITEREN Streams (Slot ≥ 1), als `{ "<slot>": "<quelle>" }`.
  //
  // **Bis zum 2026-08-12 waren das zwei feste Felder** (`capture_source` +
  // `capture_source_1`), und alles ab Slot 2 fiel auf das Feld von Slot 0
  // zurück: wer beim dritten Stream einen Monitor wählte, stellte damit
  // unbemerkt die Quelle des ERSTEN um. Mit vier möglichen Streams war das eine
  // Randnotiz, mit 99 ein echter Fehler.
  //
  // Eine Karte statt eines Feldes je Slot, und Slot 0 bleibt ausdrücklich
  // draußen: sein Feld ist der alte, unveränderte Speicherplatz (eine ältere
  // Version findet ihre Quelle also weiter), und die Karte trägt nur, was der
  // Nutzer wirklich gewählt hat. Ein Eintrag je MÖGLICHEM Slot wären 98
  // gespeicherte Zeilen für jemanden, der einen Schirm teilt — die Vorgabe für
  // einen unbelegten Slot rechnet `captureSourceForSlot()` stattdessen beim
  // Lesen aus.
  capture_sources: {} as Record<string, string>,
  // One of AUDIO_MODES, or `"App: <name>"` (capture a specific running app).
  audio_mode: 'Desktop' as string,
  // Remembers the last app picked for the "App: …" mode, so toggling away and
  // back keeps the selection.
  audio_app: '' as string,
  excluded_apps: [] as string[],
  overrides: {} as OverrideSet,
  use_overrides: false,
  // Mauszeiger im Stream zeigen — default an (entspricht GSRs eingebautem
  // `-cursor yes`). Toggle im OverridesEditor.
  show_cursor: true,
  // Windows-only: konstanter A/V-Trim in ms (>0 = Ton später). Feintuning für
  // den Rest-Lippensync, den die QPC-Verankerung nicht abfängt. Auf Linux
  // ungenutzt (gpu-screen-recorder synct selbst). 0 = neutral.
  av_offset_ms: 0,

  // Catalogs from sidecar (filled by `loadCatalogs()`)
  available_audio_apps: [] as string[],
  // Display monitors — only populated on Windows (Linux uses the portal picker).
  available_monitors: [] as GsrMonitor[],
  available_windows: [] as GsrWindow[],

  // GPU info cache (filled by `loadCatalogs()` → consumed by the codec default).
  gpu_info: null as GsrGpuInfo | null,

  // Diagnostics
  catalogs_loaded: false,
  catalog_error: null as string | null,
  persisted_loaded: false,
});

// ── Persistence ─────────────────────────────────────────────────────────────

// Which fields get persisted. Order doesn't matter; the keys are stable.
const PERSIST_KEYS = [
  'profile_name',
  'capture_source',
  // `capture_source_1` steht hier NICHT mehr — sein Inhalt wandert beim Laden
  // einmalig nach `capture_sources['1']` (s. `applyPersisted`). Der alte
  // Schlüssel wird nur noch gelesen, nie wieder geschrieben.
  'capture_sources',
  'audio_mode',
  'audio_app',
  'excluded_apps',
  'overrides',
  'use_overrides',
  'show_cursor',
  'av_offset_ms',
] as const;

type PersistKey = (typeof PERSIST_KEYS)[number];

function snapshotPersisted(): Record<PersistKey, unknown> {
  const snap = {} as Record<PersistKey, unknown>;
  for (const key of PERSIST_KEYS) {
    const value = streamSettings[key];
    // Clone the mutable fields so the snapshot can't be aliased by later
    // `$state` mutations; primitives copy by value.
    if (Array.isArray(value)) snap[key] = value.slice();
    else if (value && typeof value === 'object') snap[key] = { ...value };
    else snap[key] = value;
  }
  return snap;
}

const persistDebounced = debounce(() => saveAll(snapshotPersisted()), 300);

/**
 * Persist current settings. Debounced ~300ms so frantic input (bitrate slider,
 * etc.) doesn't hammer disk. Safe to call from `$effect`.
 */
export function persistSettings(): void {
  persistDebounced();
}

/** One-shot: load persisted values into `streamSettings`. Idempotent. */
export async function loadPersisted(): Promise<void> {
  if (streamSettings.persisted_loaded) return;
  const data = await loadAll();
  applyPersisted(data);
  streamSettings.persisted_loaded = true;
}

/**
 * Die gespeicherten Quellen der Slots ≥ 1 übernehmen — inklusive der alten
 * Form.
 *
 * Bis zum 2026-08-12 lag die Quelle des zweiten Streams in einem eigenen Feld
 * `capture_source_1`. Wer die App aktualisiert, hat genau das auf der Platte
 * liegen, und ohne diese Übernahme stünde sein zweiter Stream danach wieder auf
 * dem vorgeschlagenen Monitor statt auf dem gewählten — also unter Umständen
 * auf dem falschen Schirm, ohne dass er es vor dem Losstreamen merkt.
 *
 * Der alte Wert verliert gegen einen bereits vorhandenen Eintrag in der neuen
 * Karte. Das macht den Schritt wiederholbar: nach dem ersten Speichern trägt
 * die Karte die '1', der alte Schlüssel liegt nur noch als toter Rest daneben
 * und wird nie wieder herangezogen.
 */
function applyPersistedCaptureSources(data: Record<string, unknown>): void {
  const next: Record<string, string> = {};
  const raw = data.capture_sources;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      // Nur echte Slot-Nummern ≥ 1: ein '0' hier hätte zwei Speicherplätze für
      // dieselbe Quelle, und die beiden könnten auseinanderlaufen.
      if (typeof value === 'string' && /^[1-9]\d*$/.test(key)) next[key] = value;
    }
  }
  if (next['1'] === undefined && typeof data.capture_source_1 === 'string') {
    next['1'] = data.capture_source_1;
  }
  streamSettings.capture_sources = next;
}

function applyPersisted(data: Record<string, unknown>): void {
  // Plain string fields: accept any string, no further validation.
  for (const key of ['profile_name', 'capture_source', 'audio_app'] as const) {
    if (typeof data[key] === 'string') streamSettings[key] = data[key];
  }

  applyPersistedCaptureSources(data);

  if (
    typeof data.audio_mode === 'string' &&
    ((AUDIO_MODES as ReadonlyArray<string>).includes(data.audio_mode) ||
      data.audio_mode.startsWith(APP_AUDIO_PREFIX))
  ) {
    streamSettings.audio_mode = data.audio_mode;
  }
  // "Desktop + Mikrofon" hat auf dem Windows-Sidecar keinen Mixer (Stage-7-
  // TODO). Die UI blendet den Modus dort aus (AudioModePicker) — einen
  // alt-persistierten Wert hier auf "Desktop" zurücksetzen, sonst streamt der
  // Windows-Sidecar mit einem verhungernden Audio-Stream und crasht den Muxer.
  if (isWindows() && streamSettings.audio_mode === 'Desktop + Mikrofon') {
    streamSettings.audio_mode = 'Desktop';
  }
  if (Array.isArray(data.excluded_apps)) {
    streamSettings.excluded_apps = data.excluded_apps.filter((x): x is string => typeof x === 'string');
  }
  if (data.overrides && typeof data.overrides === 'object') {
    const o = { ...(data.overrides as OverrideSet) };
    // Normalise a resolution that the dropdown no longer offers (e.g. an old
    // persisted '1440p') so the UI doesn't show "Native" while streaming bigger.
    if (o.resolution && !(RESOLUTION_VALUES as ReadonlyArray<string>).includes(o.resolution)) {
      o.resolution = 'Native';
    }
    streamSettings.overrides = o;
  }
  if (typeof data.use_overrides === 'boolean') {
    streamSettings.use_overrides = data.use_overrides;
  }
  if (typeof data.show_cursor === 'boolean') {
    streamSettings.show_cursor = data.show_cursor;
  }
  if (typeof data.av_offset_ms === 'number' && Number.isFinite(data.av_offset_ms)) {
    streamSettings.av_offset_ms = Math.round(data.av_offset_ms);
  }

  // Migration cleanup (one-shot, ~2026-05-13): an earlier version auto-added
  // "Pulse" to excluded_apps. It killed the streamer's desktop audio when the
  // PA name didn't match, so it was reverted. Detect the marker the old code
  // wrote, drop "Pulse" from the persisted exclude list, and re-save. The
  // marker key isn't in PERSIST_KEYS, so the cleaned blob omits it on the
  // next write and this branch never runs again.
  if (data.excluded_apps_pulse_seeded === true && streamSettings.excluded_apps.includes('Pulse')) {
    streamSettings.excluded_apps = streamSettings.excluded_apps.filter((x) => x !== 'Pulse');
    persistSettings();
  }

  // Altlast: Intra-Refresh ist mit dieser Fassung ganz entfallen. Ein
  // gespeicherter Haken laege sonst dauerhaft in den Nutzerdaten und reiste bei
  // jedem Speichern mit — gelesen wird er nirgends mehr.
  //
  // Anders als die frueheren Bereinigungen braucht das KEINEN Merker: es gibt
  // keine Stelle mehr, die den Wert setzen koennte, also kann diese Zeile auch
  // keine bewusste Wahl des Nutzers ueberschreiben. Sie darf weg, sobald
  // gespeicherte Einstellungen ihn plausibel nicht mehr enthalten.
  if ('intra_refresh' in streamSettings.overrides) {
    const { intra_refresh: _alt, ...rest } = streamSettings.overrides as Record<string, unknown>;
    streamSettings.overrides = rest;
    persistSettings();
  }
}
