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
import { RESOLUTION_VALUES, type OverrideSet } from './settingsCatalog';

// ── Reactive state ──────────────────────────────────────────────────────────

// Auswahlfelder. Persistiert davon nur `profile_name` — Quelle und Ton sind
// Sitzungszustand (bei jedem Dialog-Öffnen Vorgabe, `platzZuruecksetzen`);
// die übrigen persistenten Felder stehen weiter unten.
export const streamSettings = $state({
  profile_name: '',
  capture_source: 'portal' as 'portal' | string,
  // Quelle jedes WEITEREN Streams (Slot ≥ 1), als `{ "<slot>": "<quelle>" }`.
  // Sitzungszustand, kein Speicherplatz: seit dem 2026-09-20 steht die Quelle
  // bei jedem Öffnen des Stream-Dialogs wieder auf der Monitor-Vorgabe
  // (`platzZuruecksetzen`) — die Karte trägt nur die Wahl der laufenden
  // Dialog-Sitzung.
  capture_sources: {} as Record<string, string>,
  // 'Aus' | 'Desktop' | 'Mikrofon' | 'Desktop + Mikrofon' oder `"App: <name>"`
  // (capture a specific running app).
  // Bewusst NICHT mehr persistent (2026-09-20): eine gemerkte App-Wahl
  // überlebte ihre App und startete den nächsten Stream stumm bzw. ohne Ton.
  // Jeder Dialog-Öffnen beginnt bei `tonVorgabeFuerPlatz`.
  audio_mode: 'Desktop' as string,
  // Remembers the last app picked for the "App: …" mode, so toggling away and
  // back keeps the selection — innerhalb der Dialog-Sitzung; beim Öffnen
  // geleert, damit „Spezifische App" aus der frischen Liste wählt.
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
//
// Quelle (`capture_source`/`capture_sources`) und Ton (`audio_mode`/
// `audio_app`) stehen hier bewusst NICHT mehr (2026-09-20): beides resettiert
// `platzZuruecksetzen` bei jedem Öffnen des Stream-Dialogs auf die Vorgabe.
// Ein gemerkter Wert wäre genau der tote Zustand, den das ablösen sollte —
// eine App-Wahl, die ihre App überlebt, startet stumm bzw. ohne Ton.
const PERSIST_KEYS = [
  'profile_name',
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

function applyPersisted(data: Record<string, unknown>): void {
  // Plain string fields: accept any string, no further validation.
  if (typeof data.profile_name === 'string') streamSettings.profile_name = data.profile_name;

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
