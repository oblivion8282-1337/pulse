/**
 * User-side stream settings (T3b + T3c).
 *
 * Was der Nutzer eingestellt hat, und was daraus für den Sidecar folgt — im
 * Unterschied zu `state.svelte.ts`, das den LAUFENDEN Sidecar spiegelt
 * (running/fps/uptime/log über `gsr://event`).
 *
 * - GPU-Erkennung: sobald die `gpu_info`-Antwort da ist, wird der Codec aus der
 *   Karte vorbelegt (AV1, wenn sie es kann, sonst H.264) — aber nur, wo noch
 *   nichts gespeichert war. Gespeichertes gewinnt (`loadCatalogs()`).
 * - Ableitungen für den Start: `pushProtokoll()` und `buildStartArgs()`.
 *
 * The HQ-stream panel is channel-mode only: Pulse always streams into the
 * current voice channel (per-(channel,user) MediaMTX path, token + push URL
 * from chat-gateway/media-svc), capturing via the Wayland portal.
 *
 * Field shapes mirror what the sidecar's `gsr_start` body expects (see
 * `gsr.ts::GsrStartArgs` and `streaming/gsr-sidecar/control.py::op_start`).
 *
 * **Diese Datei ist zugleich die Sammelstelle.** Der Werte-Katalog, der
 * `$state`-Kern samt Persistenz und die Quellenwahl je Slot stehen in eigenen
 * Nachbardateien (die Datei war über 880 Zeilen gewachsen); sie werden hier
 * unverändert weitergereicht, damit jeder bestehende Import auf
 * `stream/settings.svelte` weiter stimmt.
 */

import { gsr, type GsrStartArgs } from './gsr';
import { stream } from './state.svelte';
import { isWindows, isMac } from '$lib/platform/runtime';
import { capabilities } from '$lib/stores/capabilities.svelte';
import { effectiveHqLimits } from '$lib/stream/guildLimits';
import { applyVideoMode, gpuHasAv1, clampResolution, type OverrideSet } from './settingsCatalog';
import { streamSettings, persistSettings, loadPersisted } from './settingsState.svelte';
import {
  captureSourceForSlot,
  resetCaptureSourcesToPortal,
  resolveMonitorCaptureSource,
} from './captureSource';

export * from './settingsCatalog';
export * from './settingsState.svelte';
export * from './captureSource';

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
 * **Umgekehrt gilt das seit dem 2026-08-07 NICHT mehr:** ein `false` hier heißt
 * nicht mehr „also RTMPS". Bei H.264 nimmt `pushProtokoll` unabhängig von
 * diesem Wert WHIP, weil der Encoder die Betriebsart dort von sich aus fährt —
 * die Begründung steht dort, nicht hier.
 *
 * **`stream.intraRefreshAvailable` gehört zwingend dazu**, obwohl das Kästchen
 * bereits danach gated ist. Die Einstellung wird persistiert und wandert damit
 * zwischen Rechnern: ein auf einem NVIDIA-Rechner gesetzter Haken läge sonst
 * auf einer AMD-Maschine ohne gepatchtes FFmpeg weiter an — unsichtbar, weil
 * das Kästchen dort gar nicht erscheint, und der Stream bräche beim Start ab.
 *
 * **Hier stand bis zum 2026-08-07: „unter Windows trägt die Betriebsart nur
 * AV1 (über AMF), H.264 läuft über einen Encoder, der die Option annimmt und
 * nichts damit tut". Das ist falsch** — es beschreibt `h264_d3d12va`, und der
 * ist auf AMD seit dem 2026-08-04 nicht mehr der Regelweg (nur noch über
 * `PULSE_HQ_AMD_D3D12=1`). Heute geht AMD mit jedem Codec über AMF, und
 * `h264_amf` trägt die Betriebsart sehr wohl — sogar ungefragt
 * (`win-hq-sidecar/src/encode/auffrischung.rs`).
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
 * **`stream.hdrAvailable` gehört zwingend dazu**, obwohl der Eintrag im
 * Codec-Feld bereits danach gated ist: die Einstellung wird persistiert und
 * wandert mit dem Konto zwischen Rechnern. Ein auf der HDR-Maschine gewählter
 * Eintrag läge sonst auf einem Rechner ohne HDR-fähigen Encoder weiter an —
 * unsichtbar, weil er dort im Feld gar nicht steht, und jeder Streamversuch
 * bräche ab.
 *
 * Die Kopplung an 10 bit ist keine zweite Bedingung, sondern dieselbe: HDR
 * gibt es nur mit AV1 in 10 bit, und genau das prüft `tenBitPossible`.
 */
export function hdrPossible(): boolean {
  return streamSettings.overrides.hdr === true && stream.hdrAvailable && tenBitPossible();
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
      // Linux: every slot uses the Wayland portal — each start opens its own
      // portal dialog so the user picks a (different) screen per stream.
      resetCaptureSourcesToPortal();
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
    // Und dasselbe für HDR — hier sogar dringender: ein mitgereister Wunsch
    // bricht den Start ab, statt still auf etwas Kleineres zurückzufallen.
    if (streamSettings.overrides.hdr === true && !hdrPossible()) {
      const { hdr: _hdrWeg, ...rest } = streamSettings.overrides;
      streamSettings.overrides = rest;
    }
    // **Intra-Refresh ist seit 2026-08-06 die VORGABE, wo der Sidecar ihn
    // meldet** — vorher musste ihn jeder Nutzer von Hand einschalten, und
    // praktisch niemand tat das.
    //
    // Was daran hing, war mehr als die Betriebsart selbst: `pushProtokoll()`
    // koppelt den Sendeweg daran (Intra-Refresh braucht den WHIP-Rückkanal),
    // und nur über WHIP erzeugt der Server FlexFEC-Parität. Ohne den Haken lief
    // also dreierlei nicht — rollender Refresh, Rückkanal und Verlustschutz —,
    // obwohl alle drei gemessen, ausgeliefert und in Betrieb waren. In der
    // Produktionsauswertung vom 2026-08-06 bekamen 71 von 71 RTMPS-Sitzungen
    // KEINE Parität, während über WHIP 75 von 131 welche hatten.
    //
    // Der Gewinn ist gemessen (`profiles/hq-2026-07-31-intra-refresh-echter-
    // sender.json`): bei gleicher Datenrate 1,4 statt 48,7 Prozent gestörte
    // Sekunden und 92,8 statt 76,3 VMAF.
    //
    // Gesetzt wird ausdrücklich `true` statt nur die Prüfung umzudrehen: der
    // Wert muss in `overrides` LANDEN, damit `buildStartArgs` ihn mitschickt.
    // Fehlt er, entscheidet die Vorgabe im Sidecar — und die ist aus. Genau so
    // ging der Wunsch am 2026-08-02 schon einmal verloren, ohne dass etwas
    // auffiel.
    //
    // Ein ausdrückliches `false` bleibt unangetastet: eine Abwahl ist eine
    // Willensbekundung, keine fehlende Vorgabe. Die Rücknahme oben schützt
    // weiterhin davor, dass ein mitgereister Haken auf ungeeigneter Hardware
    // liegen bleibt.
    if (streamSettings.overrides.intra_refresh === undefined && stream.intraRefreshAvailable) {
      streamSettings.overrides = { ...streamSettings.overrides, intra_refresh: true };
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
 * Der Push-Weg, den Betriebsart und Codec verlangen.
 *
 * Nur WHIP hat den RTCP-Rueckkanal, ueber den die Vollbild-Anforderung eines
 * beitretenden Zuschauers den Encoder erreicht. Wo ein Strom nach dem Start
 * kaum noch Vollbilder fuehrt, bekommt der Zuschauer sein erstes nur auf
 * Anforderung — ueber RTMPS saehe er GAR NICHTS (gemessen: 0 Bilder gegen
 * 2228). Zwei Faelle brauchen ihn deshalb:
 *
 * **1. Intra-Refresh.** Die Betriebsart selbst, ausdruecklich gewaehlt.
 *
 * **2. H.264, immer — auch mit abgewaehltem Intra-Refresh.** Das ist seit dem
 * 2026-08-07 nicht mehr die Ausnahme, sondern der Regelfall, und der Grund
 * liegt nicht hier, sondern im Encoder: `h264_amf` bekommt aus Last-Gruenden
 * `usage=ultralowlatency` (`win-hq-sidecar/src/encode/opts.rs`, seit dem
 * 2026-07-30, drittelt die Video-Engine-Last), und diese Einstellung schaltet
 * die rollende Auffrischung von sich aus mit ein. **Das Kaestchen aendert
 * daran nichts.** Ein H.264-Strom auf AMD hat also nach dem Start praktisch
 * kein Vollbild mehr, ganz gleich, was die Oberflaeche glaubt zu bestellen —
 * die Zeile „Vollbilder" im Sidecar-Log ist fuer diesen Encoder nur das
 * Etikett des Wunsches, nicht die Beschreibung des Stroms
 * (`encode/mod.rs::log_encoder_open`).
 *
 * Belegt in der Produktion am 2026-08-07: derselbe Kanal, dieselben Minuten.
 * H.264 ueber RTMPS ohne Intra-Refresh — 1400 Pakete in 5 s, 0 Verlust, **0
 * dekodierte Bilder**, 25 unbeantwortete Vollbild-Anforderungen, danach
 * zwanzig Neuaufbauten in Folge ueber zwei Minuten, keiner davon mit Bild.
 * Dieselbe Maschine ueber WHIP: 2681 Bilder. AV1 ueber RTMPS: 1146 Bilder (AV1
 * braucht fuer die Auffrischung einen eigenen Schalter, der ohne Wunsch nicht
 * gesetzt wird — deshalb ist dort ein Vollbild je zwei Sekunden im Strom).
 *
 * **Warum nicht auf AMD eingeschraenkt**, obwohl nur dieser Encoder betroffen
 * ist: welchen Encoder der Sidecar wirklich oeffnet, entscheidet sich dort und
 * haengt an Hersteller, Plattform und `PULSE_HQ_AMD_D3D12` — die Oberflaeche
 * weiss es nicht zuverlaessig. Eine Regel, die auf eine Vermutung ueber den
 * Encoder baut, waere genau die Sorte stiller Fehlannahme, die diesen Fehler
 * erzeugt hat. Der Rueckkanal schadet nirgends: wo er nicht gebraucht wird,
 * bleibt er ungenutzt, und die FlexFEC-Paritaet gibt es ohnehin nur ueber
 * WHIP (2026-08-06: 71 von 71 RTMPS-Sitzungen ohne, 75 von 131 WHIP-Sitzungen
 * mit).
 *
 * **Warum als Funktion und nicht zweimal ausgeschrieben:** die Regel stand in
 * `StreamControls` und im Auto-Neustart getrennt, und im Auto-Neustart stand
 * sie falsch (hart `'rtmp'`). Ein Stream, der sich nach einem Encoder-Abbruch
 * selbst neu startete, wechselte damit lautlos auf einen Weg, auf dem er nicht
 * funktioniert — sichtbar erst beim Zuschauer, als schwarzes Bild.
 */
export function pushProtokoll(): 'rtmp' | 'whip' {
  // Derselbe Rueckgriff auf `'h264'` wie in `tenBitPossible`: ein ungesetzter
  // Codec IST H.264 (s. die Vorgabe in `loadSettings`), und der Fall haette
  // sonst ausgerechnet bei einer frischen Installation gefehlt.
  const codec = streamSettings.overrides.codec ?? 'h264';
  return intraRefreshPossible() || codec === 'h264' ? 'whip' : 'rtmp';
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
