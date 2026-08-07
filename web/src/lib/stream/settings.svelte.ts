/**
 * User-side stream settings (T3b + T3c).
 *
 * In-memory `$state` object that holds the *user's* current picker selections
 * — distinct from `state.svelte.ts` which mirrors the live sidecar state
 * (running/fps/uptime/log) coming back over `gsr://event`.
 *
 * - Persistence (via `persistence.ts`: `window.pulse.store.*` under Electron,
 *   `localStorage` fallback in a plain browser) for the user's picker
 *   selections. Persisted values *win over* the GPU-Detection-Defaults — see
 *   `loadCatalogs()`.
 * - GPU-detection: after the sidecar's `gpu_info` response is in, we default
 *   the codec from the GPU (AV1 if it can encode it, else H.264), but only if
 *   nothing was persisted yet.
 *
 * The HQ-stream panel is channel-mode only: Pulse always streams into the
 * current voice channel (per-(channel,user) MediaMTX path, token + push URL
 * from chat-gateway/media-svc), capturing via the Wayland portal.
 *
 * Field shapes mirror what the sidecar's `gsr_start` body expects (see
 * `gsr.ts::GsrStartArgs` and `streaming/gsr-sidecar/control.py::op_start`).
 */

import { gsr, type GsrGpuInfo, type GsrMonitor, type GsrStartArgs, type GsrWindow } from './gsr';
import { debounce, loadAll, saveAll } from './persistence';
import { stream } from './state.svelte';
import { isWindows, isMac } from '$lib/platform/runtime';
import { capabilities } from '$lib/stores/capabilities.svelte';
import { effectiveHqLimits } from '$lib/stream/guildLimits';

// ── Types ───────────────────────────────────────────────────────────────────

export type AudioMode = 'Aus' | 'Desktop' | 'Mikrofon' | 'Desktop + Mikrofon';

export interface OverrideSet {
  codec?: string;
  /** Farbtiefe je Kanal: 8 (Standard) oder 10. Nur der Linux-Rust-Sidecar
   *  versteht das Feld und nur mit AV1 — ältere Sidecars ignorieren es
   *  stillschweigend, und der Linux-Sidecar schiebt einen unerfüllbaren Wunsch
   *  selbst auf 8 bit zurück. Deshalb ist es hier ungefährlich mitzuschicken.
   *  In der Oberfläche ist es mit dem Codec zu EINEM Feld verbunden, s.
   *  [`VIDEO_MODES`]. */
  bit_depth?: number;
  bitrate_kbps?: number;
  fps?: number;
  resolution?: string;
  /**
   * Rollender Intra-Refresh statt periodischer Vollbilder. Fehlt das Feld,
   * entscheidet der Sidecar über `PULSE_INTRA_REFRESH` — deshalb wird es nur
   * gesetzt, wenn die Oberfläche wirklich eine Wahl getroffen hat.
   */
  intra_refresh?: boolean;
  /**
   * HDR senden — der Bildschirminhalt wird in seinem vollen Helligkeitsumfang
   * aufgenommen und als PQ/BT.2020 encodiert.
   *
   * **Anders als `bit_depth` kein Wunsch, der still zurückgenommen wird.**
   * Kann der Sidecar HDR nicht liefern — Schirm läuft in SDR, falscher Codec,
   * falscher Encode-Weg —, bricht er den Start mit einer Meldung ab. Das ist
   * Absicht: 10 bit weniger als bestellt sieht man höchstens an einem Verlauf,
   * SDR statt HDR sieht man am ganzen Bild.
   *
   * Setzt 10 bit voraus (PQ in 8 bit wäre in jedem Verlauf geringelt) und
   * damit AV1; die Oberfläche erzwingt beides beim Anhaken.
   */
  hdr?: boolean;
}

// Hard caps for the HQ-stream bitrate. MediaMTX fans out WHEP copies to every
// viewer, so an unbounded value can saturate the VPS uplink very fast.
export const HQ_BITRATE_MIN_KBPS = 1000;
export const HQ_BITRATE_MAX_KBPS = 10_000;

// Codec values the GSR `-k` flag accepts. The UI only offers H.264 (universal
// browser compat) and AV1 (~half the bitrate at the same quality); the sidecar
// still understands the HEVC / 10-bit / HDR variants, we just don't surface
// them (this also matches the Flatpak GSR build, which only ships h264 + av1).
export const CODEC_VALUES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'h264', label: 'H.264' },
  { value: 'av1', label: 'AV1' },
];

/**
 * Was im Codec-Feld steht. Codec, Bittiefe und HDR sind für den Nutzer EINE
 * Entscheidung — mehrere Felder daraus zu machen hiesse, ihm Kopplungen zu
 * erklären, die der Sidecar ohnehin erzwingt: 10 bit gibt es nur mit AV1 (die
 * H.264-Variante wäre `High 10`, die kein Browser dekodiert), und HDR gibt es
 * nur mit 10 bit (PQ in 8 bit wäre in jedem Verlauf sichtbar geringelt,
 * `encode/hdr.rs`).
 *
 * **HDR war bis zum 2026-08-07 ein eigenes Kästchen**, das beim Anhaken das
 * Codec-Feld von sich aus auf „AV1 10 bit" zog. Das ist derselbe Fall, den die
 * Bittiefe am 2026-08-02 schon hatte, und er wird hier aus demselben Grund
 * gleich gelöst: **zwei gekoppelte Bedienelemente zu erklären ist mehr Aufwand
 * als eine Liste, in der die unmögliche Kombination gar nicht vorkommt.** Ein
 * Kästchen, das ein anderes Feld umstellt, ist eine Fernwirkung, die niemand
 * erwartet.
 *
 * `bit_depth` geht nur bei 10 mit auf die Leitung, `hdr` nur bei `true`. Ein
 * `bit_depth: 8` bzw. `hdr: false` wäre gleichbedeutend mit „fehlt", würde aber
 * in jeder persistierten Einstellung mitgeschleppt.
 */
export const VIDEO_MODES: ReadonlyArray<{
  value: string;
  label: string;
  codec: string;
  tenBit: boolean;
  hdr?: boolean;
}> = [
  { value: 'h264', label: 'H.264', codec: 'h264', tenBit: false },
  { value: 'av1', label: 'AV1 8 bit', codec: 'av1', tenBit: false },
  { value: 'av1-10', label: 'AV1 10 bit', codec: 'av1', tenBit: true },
  { value: 'av1-10-hdr', label: 'AV1 10 bit HDR', codec: 'av1', tenBit: true, hdr: true },
];

/** Welcher Eintrag zu den aktuellen Overrides passt. */
export function videoModeOf(o: OverrideSet): string {
  const codec = o.codec ?? 'h264';
  if (codec !== 'av1' || o.bit_depth !== 10) return codec;
  return o.hdr === true ? 'av1-10-hdr' : 'av1-10';
}

/**
 * Auswahl zurück in Codec, Bittiefe und HDR übersetzen.
 *
 * **`hdr` wird bei jedem anderen Eintrag ENTFERNT**, nicht bloss nicht gesetzt.
 * Sonst überlebte ein `hdr: true` den Wechsel auf H.264 in der gespeicherten
 * Einstellung, und der Sidecar bräche den Start ab („HDR verlangt, aber H.264
 * kann hier kein 10 bit") — für eine Kombination, die der Nutzer im Feld gar
 * nicht mehr sieht.
 */
export function applyVideoMode(o: OverrideSet, value: string): OverrideSet {
  const mode = VIDEO_MODES.find((m) => m.value === value) ?? VIDEO_MODES[0];
  const next: OverrideSet = { ...o, codec: mode.codec };
  if (mode.tenBit) next.bit_depth = 10;
  else delete next.bit_depth;
  if (mode.hdr) next.hdr = true;
  else delete next.hdr;
  return next;
}

// Eine Stufe ist eine BOX, in die das Bild aspektwahrend eingepasst wird — NIE
// hochskaliert (`fit_within_box` im Sidecar), 'Native' = gar nicht skalieren.
// Eine Box größer als die Quelle bewirkt darum nichts; welche Stufen für die
// gewählte Quelle wirklich verkleinern, filtert `resolution.ts` für die UI.
export const RESOLUTION_VALUES: ReadonlyArray<string> = [
  'Native',
  '4K',
  '1440p',
  '1080p',
  '720p',
  '480p',
];

// Resolution ordering is descending in size (index 0 = biggest, 'Native' =
// uncapped source). The admin-set ``hq_resolution_max`` is a *ceiling*: only
// values at or below it (index >= its index) are allowed. 'Native' as a max
// means "no cap". Helpers below back both the admin/stream UI (filter the
// option list) and buildStartArgs (clamp a chosen value).

/** The resolutions allowed under a given ceiling (max first → smallest). */
export function allowedResolutions(maxRes: string): ReadonlyArray<string> {
  const maxIdx = RESOLUTION_VALUES.indexOf(maxRes);
  if (maxIdx < 0) return RESOLUTION_VALUES; // unknown ceiling → don't filter
  return RESOLUTION_VALUES.filter((_, i) => i >= maxIdx);
}

/** Clamp a chosen resolution down to the ceiling (bigger choices → the max). */
export function clampResolution(res: string, maxRes: string): string {
  const maxIdx = RESOLUTION_VALUES.indexOf(maxRes);
  const idx = RESOLUTION_VALUES.indexOf(res);
  if (maxIdx < 0 || idx < 0) return res;
  return idx >= maxIdx ? res : maxRes;
}

export const AUDIO_MODES: ReadonlyArray<AudioMode> = [
  'Aus',
  'Desktop',
  'Mikrofon',
  'Desktop + Mikrofon',
];

/** Prefix the sidecar uses to recognise "capture this app's audio" — the
 *  on-the-wire `audio.mode` for app capture is `"App: <name>"`, which the
 *  sidecar maps to GSR's `-a "app:<name>"`. (Mirrors `APP_LABEL_PREFIX` in
 *  `streaming/gsr-sidecar/profiles.py`.) */
export const APP_AUDIO_PREFIX = 'App: ';

/** Prefix for a per-monitor capture source. The on-the-wire `capture` value is
 *  `"Monitor: <index>"` (1-based); the Windows sidecar resolves it via
 *  `Monitor::from_index` (see `ops/start.rs::parse_capture`). Windows-only —
 *  on Linux `capture_source` stays `'portal'` (the Wayland portal dialog picks
 *  the screen). */
export const MONITOR_CAPTURE_PREFIX = 'Monitor: ';
/** capture_source token for a single window (Windows + macOS): `window:<id>`
 *  — id is the HWND on Windows, the CoreGraphics window id on macOS. */
export const WINDOW_CAPTURE_PREFIX = 'window:';

export function isAppAudioMode(mode: string): boolean {
  return mode.startsWith(APP_AUDIO_PREFIX);
}

export function appFromAudioMode(mode: string): string {
  return isAppAudioMode(mode) ? mode.slice(APP_AUDIO_PREFIX.length) : '';
}

export function audioModeUsesDesktop(mode: string): boolean {
  return mode === 'Desktop' || mode === 'Desktop + Mikrofon';
}

/** True iff the GPU's reported `video_codecs` mention AV1 (i.e. AV1 encode is
 *  available). Heuristic: any codec string containing "av1", case-insensitive.
 *  Each sidecar reports the *actual* hardware codec set (Linux GSR, Windows
 *  adapter probe, macOS VideoToolbox), so this gates the codec choice to what
 *  the machine can really encode — RTX 40xx/M3+ get AV1, older GPUs / M2 don't. */
export function gpuHasAv1(codecs: ReadonlyArray<string> | undefined): boolean {
  return (codecs ?? []).some((c) => /av1/i.test(c));
}

/**
 * Wird der nächste Stream mit 10 bit Farbtiefe gesendet — Wunsch UND
 * Erfüllbarkeit?
 *
 * Drei Bedingungen, alle nötig: der Nutzer hat es eingeschaltet, die Karte kann
 * es (`health.gsr.ten_bit` — der Linux- und seit 2026-08-04 der
 * Windows-Sidecar melden das; macOS nicht, dort bleibt es `undefined`), und der
 * Codec ist AV1. Letzteres ist keine Bequemlichkeit: 10-bit-H.264 wäre
 * `High 10`, und das dekodiert kein Browser — Zuschauer ohne den nativen Player
 * sehen den Stream über ein `<video>`. Derselbe Riegel sitzt im Sidecar.
 *
 * EINE Definition für drei Verwendungen: die Sidecar-Argumente
 * (`buildStartArgs`), die Token-Anforderung (der Wert reist zu den Zuschauern,
 * damit die den Wiedergabeweg wählen können) und den Auto-Neustart. Liefen die
 * auseinander, bekäme ein Zuschauer das eigene Fenster für einen 8-bit-Stream
 * oder umgekehrt.
 */
export function tenBitPossible(): boolean {
  const codec = streamSettings.overrides.codec ?? 'h264';
  return (
    streamSettings.overrides.bit_depth === 10 && codec === 'av1' && stream.tenBitAvailable
  );
}

/**
 * Rollender Intra-Refresh — Wunsch UND Erfüllbarkeit?
 *
 * Wie [`tenBitPossible`], und aus demselben Grund EINE Definition: der Wert
 * entscheidet an drei Stellen dasselbe — die Sidecar-Argumente
 * (`buildStartArgs`), den Push-Weg (`pushProtokoll`, Intra-Refresh braucht den
 * WHIP-Rückkanal) und den Auto-Neustart. Liefen die auseinander, entstünde
 * genau die Kombination, die am 2026-08-03 ein schwarzes Bild erzeugt hat:
 * Intra-Refresh-Strom über RTMPS, also ohne den Rückkanal, über den ein
 * beitretender Zuschauer sein erstes Vollbild anfordern könnte.
 *
 * **`stream.intraRefreshAvailable` gehört zwingend dazu**, obwohl das Kästchen
 * bereits danach gated ist. Die Einstellung wird persistiert und wandert damit
 * zwischen Rechnern: ein auf einem NVIDIA-Rechner gesetzter Haken läge sonst
 * auf einer AMD-Maschine ohne gepatchtes FFmpeg weiter an — unsichtbar, weil
 * das Kästchen dort gar nicht erscheint, und der Stream bräche beim Start ab.
 * Seit Windows dazugekommen ist, wandert er auch über Plattformgrenzen: dort
 * trägt die Betriebsart nur AV1 (über AMF), H.264 läuft über einen Encoder,
 * der die Option annimmt und nichts damit tut.
 */
export function intraRefreshPossible(): boolean {
  return streamSettings.overrides.intra_refresh === true && stream.intraRefreshAvailable;
}

/**
 * HDR — Wunsch UND Erfüllbarkeit?
 *
 * Dieselbe Bauart wie [`tenBitPossible`] und [`intraRefreshPossible`], und aus
 * demselben Grund an EINER Stelle. Der Unterschied zu beiden: die Folge eines
 * falschen Ja ist hier keine stille Rücknahme, sondern ein abgebrochener Start
 * — der Sidecar verweigert HDR, das er nicht liefern kann (Begründung dort in
 * `encode/hdr.rs`). Umso wichtiger, dass die Oberfläche gar nicht erst danach
 * fragt, wenn es aussichtslos ist.
 *
 * **`stream.hdrAvailable` gehört zwingend dazu**, obwohl das Kästchen bereits
 * danach gated ist: die Einstellung wird persistiert und wandert mit dem Konto
 * zwischen Rechnern. Ein auf der HDR-Maschine gesetzter Haken läge sonst auf
 * einem Rechner ohne HDR-fähigen Encoder weiter an — unsichtbar, weil das
 * Kästchen dort nicht erscheint, und jeder Streamversuch bräche ab.
 *
 * Die Kopplung an 10 bit ist keine zweite Bedingung, sondern dieselbe: HDR
 * gibt es nur mit AV1 in 10 bit, und genau das prüft `tenBitPossible`.
 */
export function hdrPossible(): boolean {
  return streamSettings.overrides.hdr === true && stream.hdrAvailable && tenBitPossible();
}

// ── Reactive state ──────────────────────────────────────────────────────────

export const streamSettings = $state({
  // Selections (persisted)
  profile_name: '',
  capture_source: 'portal' as 'portal' | string,
  // Capture source for the optional SECOND stream (slot 1) — same shape as
  // `capture_source`. Defaults to portal (Linux) / the second monitor
  // (Windows+macOS, picked by resolveMonitorCaptureSource).
  capture_source_1: 'portal' as 'portal' | string,
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
  'capture_source_1',
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

function applyPersisted(data: Record<string, unknown>): void {
  // Plain string fields: accept any string, no further validation.
  for (const key of ['profile_name', 'capture_source', 'audio_app'] as const) {
    if (typeof data[key] === 'string') streamSettings[key] = data[key];
  }

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
}

// ── Catalog loading + GPU defaults ──────────────────────────────────────────

let loading = false;

/**
 * Idempotently fetch profiles + audio-apps + GPU info from the sidecar, then
 * **load persisted settings** and finally **apply the channel-mode defaults**
 * (codec from the GPU) to any field the user hadn't already chosen. Persistence
 * wins.
 *
 * Failures are reported via `catalog_error` — they don't throw.
 */
export async function loadCatalogs(): Promise<void> {
  if (loading) return;
  loading = true;
  streamSettings.catalog_error = null;
  try {
    // Pull persisted first so the GPU-default branch below can check whether
    // the user already has a stored selection.
    await loadPersisted();

    // Monitors back the in-app picker on Windows + macOS (WGC / ScreenCaptureKit
    // have no portal dialog). On Linux the Wayland portal picks the source at
    // stream start, so skip the round-trip there.
    // There is no profile catalog to fetch: the HQ panel is channel-mode only
    // and forces ``profile_name='Custom'`` + ``use_overrides=true`` below. The
    // sidecars keep a single baseline (h264/opus/flv, 4000 kbps, 60 fps) that
    // unset override fields fall back to.
    const [audioApps, gpuInfo, monitors, windows] = await Promise.all([
      gsr.listApplicationAudio(),
      gsr.gpuInfo(),
      isWindows() || isMac() ? gsr.listMonitors() : Promise.resolve(null),
      // Window picking on Windows (WGC) + macOS (SCK): both enumerate windows so
      // the user can stream a single app instead of the whole monitor. Linux
      // delegates that choice to the Wayland portal dialog at stream start.
      isWindows() || isMac() ? gsr.listWindows() : Promise.resolve(null),
    ]);

    if (audioApps?.ok) {
      streamSettings.available_audio_apps = audioApps.applications ?? [];
    }
    if (gpuInfo?.ok) {
      streamSettings.gpu_info = gpuInfo;
    }
    if (monitors?.ok) {
      streamSettings.available_monitors = monitors.monitors ?? [];
    }
    if (windows?.ok) {
      streamSettings.available_windows = windows.windows ?? [];
    }

    // The HQ-stream panel is channel-mode only (push into the current voice
    // channel, explicit codec/res/bitrate/fps). Force the profile; the capture
    // source is platform-dependent — Linux always uses the Wayland portal,
    // Windows + macOS pick a concrete monitor (persisted choice wins if valid).
    if (isWindows() || isMac()) {
      resolveMonitorCaptureSource();
    } else {
      // Linux: both slots use the Wayland portal — each start opens its own
      // portal dialog so the user picks a (different) screen per stream.
      streamSettings.capture_source = 'portal';
      streamSettings.capture_source_1 = 'portal';
    }
    streamSettings.profile_name = 'Custom';
    streamSettings.use_overrides = true;
    // Default codec/bitrate/fps — only if the user hasn't already saved a value.
    const hasAv1 = gpuHasAv1(streamSettings.gpu_info?.video_codecs);
    const defaults: OverrideSet = {};
    if (!streamSettings.overrides.codec) defaults.codec = hasAv1 ? 'av1' : 'h264';
    // Coerce a previously-saved codec this GPU can't encode (e.g. 'av1' carried
    // over to an H.264-only machine) back to the baseline.
    else if (streamSettings.overrides.codec === 'av1' && !hasAv1) defaults.codec = 'h264';
    if (streamSettings.overrides.bitrate_kbps === undefined) defaults.bitrate_kbps = 4000;
    if (streamSettings.overrides.fps === undefined) defaults.fps = 60;
    if (Object.keys(defaults).length > 0) {
      streamSettings.overrides = { ...streamSettings.overrides, ...defaults };
    }
    // 10 bit hängt an AV1 UND an der Hardware. Fällt eines von beidem weg (der
    // Codec ist gerade auf H.264 zurückgenommen worden, oder die Maschine kann
    // es nicht), muss die Bittiefe mitfallen — sonst zeigt das Feld eine Wahl,
    // die der Sidecar beim Start still auf 8 bit zurücknimmt.
    if (streamSettings.overrides.bit_depth === 10 && !tenBitPossible()) {
      streamSettings.overrides = applyVideoMode(
        streamSettings.overrides,
        streamSettings.overrides.codec ?? 'h264',
      );
    }
    // Und dieselbe Rücknahme für Intra-Refresh. Die Einstellungen wandern mit
    // dem Konto zwischen Rechnern: ein auf NVIDIA gesetzter Haken läge sonst
    // auf einer AMD-Maschine ohne gepatchtes FFmpeg weiter in den gespeicherten
    // Werten — unsichtbar, weil das Kästchen dort gar nicht erscheint.
    // `intraRefreshPossible()` fängt das beim Senden ohnehin ab; hier wird der
    // tote Wert zusätzlich weggeräumt, damit er nicht dauerhaft mitreist.
    if (streamSettings.overrides.intra_refresh === true && !intraRefreshPossible()) {
      const { intra_refresh: _weg, ...rest } = streamSettings.overrides;
      streamSettings.overrides = rest;
    }
    // Und dasselbe für HDR — hier sogar dringender: ein mitgereister Haken
    // bricht den Start ab, statt still auf etwas Kleineres zurückzufallen.
    if (streamSettings.overrides.hdr === true && !hdrPossible()) {
      const { hdr: _hdrWeg, ...rest } = streamSettings.overrides;
      streamSettings.overrides = rest;
    }
    streamSettings.catalogs_loaded = true;
  } catch (e) {
    streamSettings.catalog_error = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
  }
}

/** Refresh just the audio-app list (cheap, called from the audio picker). */
export async function refreshAudioApps(): Promise<void> {
  try {
    const r = await gsr.listApplicationAudio();
    if (r?.ok) streamSettings.available_audio_apps = r.applications ?? [];
  } catch {
    // tolerate — keep the previous list
  }
}

/** The capture source for a given stream slot (0 = primary, 1 = second). */
export function captureSourceForSlot(slot: number): string {
  return slot === 1 ? streamSettings.capture_source_1 : streamSettings.capture_source;
}

/** Set the capture source for a given stream slot. */
export function setCaptureSourceForSlot(slot: number, value: string): void {
  if (slot === 1) streamSettings.capture_source_1 = value;
  else streamSettings.capture_source = value;
}

/**
 * Ton passend zur gewählten Quelle vorauswählen: Bildschirm → Systemton,
 * Fenster → Ton genau dieser Anwendung.
 *
 * Bewusst eine feste Kopplung ohne Ausnahmen — wer ein Fenster teilt, meint
 * fast immer dessen Ton, und die Auswahl steht sichtbar im Dialog, bevor der
 * Stream startet. Wer etwas anderes will (oder gar keinen Ton), stellt es
 * danach um; das überlebt, weil hier NUR beim aktiven Klick auf eine Quelle
 * aufgerufen wird — nicht aus `resolveSlotCaptureSource`, das beim Öffnen des
 * Dialogs läuft und sonst jedes Mal die gespeicherte Ton-Wahl überschriebe.
 *
 * Der Prozessname passt ohne Übersetzung: `list_windows` liefert `app`
 * ("chrome.exe"), die Audio-Seite erwartet `App: chrome.exe`. Dass die App
 * gerade still ist, stört nicht — der Sidecar löst den Namen beim Start über
 * alle laufenden Prozesse auf, nicht nur über aktive Audio-Sitzungen.
 * Ohne ermittelbaren Prozessnamen bleibt der Ton unangetastet.
 *
 * **Zweiter Stream-Slot → Ton aus.** Zwei gleichzeitige Streams würden sonst
 * denselben Ton doppelt übertragen; der Zuschauer, der beide Kacheln offen
 * hat, hört alles zweimal. Der Ton ist eine EINZIGE, geteilte Einstellung für
 * beide Slots (s. `buildStartArgs`) — „aus" gilt hier also global, nicht nur
 * für Slot 1. In der Praxis passt das, weil der erste Stream typischerweise
 * schon läuft (ein laufender Stream übernimmt spätere Änderungen nicht mehr).
 * Wer den Ton doch am zweiten Stream will, stellt ihn danach wieder ein.
 */
export function applyAudioForCaptureSource(value: string, slot = 0): void {
  if (slot !== 0) {
    streamSettings.audio_mode = 'Aus';
    return;
  }
  if (value.startsWith(MONITOR_CAPTURE_PREFIX)) {
    streamSettings.audio_mode = 'Desktop';
    return;
  }
  if (!value.startsWith(WINDOW_CAPTURE_PREFIX)) return;
  const id = Number(value.slice(WINDOW_CAPTURE_PREFIX.length));
  const app = streamSettings.available_windows.find((w) => w.id === id)?.app?.trim();
  if (!app) return;
  streamSettings.audio_app = app;
  streamSettings.audio_mode = APP_AUDIO_PREFIX + app;
}

/**
 * Windows + macOS: resolve one slot's capture source to a concrete target from
 * the enumerated sources. A persisted choice wins if it still matches a live
 * window (`window:<id>`) or monitor (`Monitor: <n>`); otherwise default to
 * `fallback`. Falls back to `'portal'` when no monitor is enumerated.
 */
function resolveSlotCaptureSource(slot: number, fallback: GsrMonitor | undefined): void {
  const current = captureSourceForSlot(slot);
  // A still-valid window pick wins — don't snap a chosen app back to a monitor.
  const wins = streamSettings.available_windows;
  if (wins.some((w) => `${WINDOW_CAPTURE_PREFIX}${w.id}` === current)) return;

  const mons = streamSettings.available_monitors;
  if (mons.length === 0 || !fallback) {
    setCaptureSourceForSlot(slot, 'portal');
    return;
  }
  const m = /^Monitor: (\d+)$/.exec(current);
  if (m && mons.some((mon) => mon.index === Number(m[1]))) return;
  setCaptureSourceForSlot(slot, `${MONITOR_CAPTURE_PREFIX}${fallback.index}`);
}

/**
 * Resolve BOTH slots' capture sources (Windows + macOS). Slot 0 defaults to the
 * primary monitor; slot 1 defaults to a *different* monitor when one exists, so
 * a two-monitor user gets one stream per screen out of the box.
 */
function resolveMonitorCaptureSource(): void {
  const mons = streamSettings.available_monitors;
  const primary = mons.find((mon) => mon.primary) ?? mons[0];
  const second = mons.find((mon) => mon !== primary) ?? primary;
  resolveSlotCaptureSource(0, primary);
  resolveSlotCaptureSource(1, second);
}

/** Refresh the monitor list (Windows + macOS; called from the monitor picker).
 *  Re-resolves the capture source so a now-unplugged monitor doesn't linger. */
export async function refreshMonitors(): Promise<void> {
  try {
    const r = await gsr.listMonitors();
    if (r?.ok) {
      streamSettings.available_monitors = r.monitors ?? [];
      resolveMonitorCaptureSource();
    }
  } catch {
    // tolerate — keep the previous list
  }
}

/** Refresh the capturable-window list (Windows + macOS; called from the source
 *  picker). Re-resolves the capture source so a now-closed window doesn't
 *  linger as the selection. */
export async function refreshWindows(): Promise<void> {
  try {
    const r = await gsr.listWindows();
    if (r?.ok) {
      streamSettings.available_windows = r.windows ?? [];
      resolveMonitorCaptureSource();
    }
  } catch {
    // tolerate — keep the previous list
  }
}

// ── Mapping helpers ─────────────────────────────────────────────────────────

/** Args for the per-channel pathway: the chat-gateway-minted publish token and
 *  — the authoritative bit — the full `push_url` from media-svc (rtmps://… /
 *  srt://… with the token in it, per-(channel,user) path). Handed to GSR's
 *  `-o` verbatim by the sidecar. */
export interface ChannelStreamArg {
  channelId: string;
  token: string;
  /** Full push URL from media-svc; handed to GSR's `-o` verbatim. */
  pushUrl?: string;
}

/**
 * Der Push-Weg, den die aktuelle Betriebsart verlangt.
 *
 * Intra-Refresh braucht WHIP: nur dort gibt es den RTCP-Rueckkanal, ueber den
 * die Vollbild-Anforderung eines beitretenden Zuschauers den Encoder erreicht.
 * In einem Intra-Refresh-Strom stehen kaum Vollbilder, also bekommt er sein
 * erstes nur auf Anforderung — ueber RTMPS saehe er GAR NICHTS (gemessen: 0
 * Bilder gegen 2228). Die Betriebsart entscheidet den Transport also mit.
 *
 * **Warum als Funktion und nicht zweimal ausgeschrieben:** die Regel stand in
 * `StreamControls` und im Auto-Neustart getrennt, und im Auto-Neustart stand
 * sie falsch (hart `'rtmp'`). Ein Stream, der sich nach einem Encoder-Abbruch
 * selbst neu startete, wechselte damit lautlos auf einen Weg, auf dem er nicht
 * funktioniert — sichtbar erst beim Zuschauer, als schwarzes Bild.
 */
export function pushProtokoll(): 'rtmp' | 'whip' {
  return intraRefreshPossible() ? 'whip' : 'rtmp';
}

/**
 * Translate the in-memory `streamSettings` into the body shape that
 * `gsr.start()` / `gsr.buildArgv()` expect. Overrides are only included when
 * `use_overrides` is set (or the user picked the synthetic "Custom" profile) —
 * which, in channel mode, is always.
 *
 * Pulse always streams into the current voice channel: emit
 * `channel: {id, token, push_url?}` — the sidecar builds a
 * `ServerProfile.from_channel(...)` from it (per-(channel,user) MediaMTX path,
 * the token used like a stream key, `push_url` taken verbatim when present).
 */
export function buildStartArgs(channelArg: ChannelStreamArg, slot = 0): GsrStartArgs {
  const apply = streamSettings.use_overrides || streamSettings.profile_name === 'Custom';

  const args: GsrStartArgs = {
    profile: streamSettings.profile_name,
    channel: {
      id: channelArg.channelId,
      token: channelArg.token,
      ...(channelArg.pushUrl ? { push_url: channelArg.pushUrl } : {}),
    },
    // Each slot captures its own source (a different monitor); the rest of the
    // settings — profile, audio, overrides — are shared across both streams.
    capture: captureSourceForSlot(slot),
    audio: {
      mode: streamSettings.audio_mode,
      excluded_apps: streamSettings.excluded_apps.slice(),
    },
    show_cursor: streamSettings.show_cursor,
    // A/V-Trim auf Windows + macOS mitschicken (beide Sidecars timestampen
    // selbst). Linux lässt es weg — GSR synct selbst, dort wäre es ein toter Wert.
    ...(isWindows() || isMac() ? { av_offset_ms: streamSettings.av_offset_ms } : {}),
  };

  if (apply) {
    const o = streamSettings.overrides;
    const cleaned: OverrideSet = {};
    // Authoritative clamp point: enforce the effective HQ limits here, right
    // before the sidecar call. Effective = this community's per-guild override
    // (Boost) ?? the admin-set instance default. Best-effort (the server never
    // sees these params) but covers every normal user. Only explicit values
    // are clamped; a blank field falls through to the GSR profile default.
    const hq = effectiveHqLimits(channelArg.channelId);
    if (o.codec) cleaned.codec = o.codec;
    if (typeof o.bitrate_kbps === 'number' && o.bitrate_kbps > 0)
      cleaned.bitrate_kbps = Math.min(
        hq.bitrateMaxKbps,
        Math.max(capabilities.hqBitrateMinKbps, o.bitrate_kbps)
      );
    if (typeof o.fps === 'number' && o.fps > 0)
      cleaned.fps = Math.min(hq.fpsMax, Math.max(capabilities.hqFpsMin, o.fps));
    if (o.resolution) cleaned.resolution = clampResolution(o.resolution, hq.resolutionMax);
    // 10 bit nur mitschicken, wenn es auch erfüllbar ist (AV1 + passende
    // Karte) — sonst stünde in der Diagnose-argv eine Tiefe, die der Sidecar
    // gleich wieder verwirft.
    if (tenBitPossible()) cleaned.bit_depth = 10;
    // Die Wahl mitschicken, sobald die Oberflaeche eine getroffen hat — auch
    // ein `false`. NUR das gar nicht gesetzte Feld bleibt weg, dann entscheidet
    // im Sidecar `PULSE_INTRA_REFRESH`, und der Pruefstand behaelt seine
    // Betriebsart.
    //
    // **Warum `=== true` hier nicht reichte** (2026-08-03, schwarzes Bild beim
    // Zuschauer): Der Sidecar haelt die Betriebsart in einer prozessweiten
    // Variablen (`encode::opts::AUS_PARAMETERN`) und setzt sie nur, wenn das
    // Feld ankommt. Fehlte es, blieb der Wert des VORIGEN Laufs stehen. Wer
    // also einmal mit Intra-Refresh gestreamt hatte und danach auf den
    // Standardweg zurueckschaltete, bekam weiter einen Intra-Refresh-Strom —
    // aber ueber RTMPS, weil `pushProtokoll()` korrekt auf den Standardweg
    // schloss. Dieser Strom hat kaum Vollbilder UND keinen Rueckkanal, ueber
    // den ein Zuschauer eins anfordern koennte: er sieht dauerhaft nichts.
    //
    // Gesendet wird der ERFÜLLBARE Wert, nicht der gespeicherte Wunsch
    // (`intraRefreshPossible`): ein Haken, den dieses FFmpeg nicht einlösen
    // kann, würde den Start abbrechen. Die Fallunterscheidung bleibt trotzdem
    // an `!== undefined` hängen, damit der Prüfstand — der ohne Oberfläche
    // fährt — weiter über `PULSE_INTRA_REFRESH` bestimmt.
    if (o.intra_refresh !== undefined) cleaned.intra_refresh = intraRefreshPossible();
    // HDR nur mitschicken, wenn es erfüllbar ist — ein `hdr: false` wäre
    // dasselbe wie es wegzulassen, und ein `hdr: true`, das der Sidecar nicht
    // einlösen kann, bräche den Start ab. Anders als bei Intra-Refresh gibt es
    // hier keinen prozessweiten Rest aus dem vorigen Lauf, den man überschreiben
    // müsste: HDR steht in den Start-Parametern, nicht in einer Variablen des
    // Sidecar-Prozesses.
    if (hdrPossible()) cleaned.hdr = true;
    if (Object.keys(cleaned).length > 0) args.overrides = cleaned;
  }
  return args;
}

// ── App-Exclude-Liste Mutationen ────────────────────────────────────────────

export function addExcludedApp(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (streamSettings.excluded_apps.includes(trimmed)) return;
  streamSettings.excluded_apps = [...streamSettings.excluded_apps, trimmed];
  persistSettings();
}

export function removeExcludedApp(name: string): void {
  streamSettings.excluded_apps = streamSettings.excluded_apps.filter((a) => a !== name);
  persistSettings();
}
