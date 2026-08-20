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
import {
  applyVideoMode,
  gpuHasAv1,
  clampResolution,
  type AudioMode,
  type OverrideSet,
} from './settingsCatalog';
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
 *
 * `overrides` ist ein Parameter, kein fester Zugriff auf den Store — beim
 * Standplatz-Gerät zählt der Wunsch aus dem Profil (`standplatz.uebersteuerung`),
 * nicht der des abwesenden Besitzers (fehlte das hier: Zuschauer-Ansage und
 * tatsächlich gesendete Tiefe liefen auseinander). Default bleibt der
 * Besitzer-Store, jeder bestehende Aufruf ohne Argument bleibt also gültig.
 */
export function tenBitPossible(overrides: OverrideSet = streamSettings.overrides): boolean {
  const codec = overrides.codec ?? 'h264';
  return overrides.bit_depth === 10 && codec === 'av1' && stream.tenBitAvailable;
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

/**
 * AV1 — kann diese Maschine es wirklich encodieren?
 *
 * Bewusst **nur** `gpuHasAv1`, also die vom Sidecar gemeldete echte Fähigkeit,
 * ohne Plattform-Riegel. Bis zum 2026-08-19 stand hier zusätzlich `!isMac()`,
 * weil der mac-Sidecar über ffmpegs WHIP-Muxer ging, der kein AV1 trägt und
 * den Codec beim Start still auf H.264 zurücknahm; mit dem eigenen WHIP-Sender
 * (`mac-hq-sidecar/src/whip/`) ist dieser Grund weg.
 *
 * **Auf heutiger Mac-Hardware bleibt AV1 trotzdem draußen — das ist kein
 * fehlender Riegel, sondern die ehrliche Antwort**: die gelinkte FFmpeg 8.0.1
 * hat keinen `av1_videotoolbox`-Encoder, und kein Apple-Chip kann AV1
 * encodieren (M3+ nur dekodieren, s. `mac-hq-sidecar/src/caps.rs`). Der
 * Sidecar meldet deshalb `video_codecs: ["h264","hevc"]`. Liefert das hier
 * eines Tages `true`, kann die Maschine es tatsächlich.
 *
 * Der Wrapper bleibt als benannte Stelle bestehen: käme je wieder ein Grund
 * hinzu, AV1 trotz fähigem Encoder nicht anzubieten, gehört er hierher und
 * nicht in jeden Aufrufer.
 */
export function av1Nutzbar(codecs: ReadonlyArray<string> | undefined): boolean {
  return gpuHasAv1(codecs);
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
    const hasAv1 = av1Nutzbar(streamSettings.gpu_info?.video_codecs);
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
    // **Intra-Refresh bekommt hier bewusst KEINE Vorgabe mehr.** Wer nichts
    // einstellt, streamt ohne — der Haken unter „Erweitert" ist die einzige
    // Stelle, die ihn setzt.
    //
    // Vom 2026-08-06 bis zum 2026-08-18 stand hier das Gegenteil: ein
    // `undefined` wurde auf `true` gehoben, wo der Sidecar die Fähigkeit
    // meldete. Beide Gründe dafür sind entfallen.
    //
    // *Der gemessene Vorteil hat sich umgedreht.* Er galt gegen einen
    // Vollbild-Abstand von 2 s; seit dem 2026-08-18 sind es 60 s, und damit
    // liefert der lange Takt an identischen Bildern bei 2000 kbps **+1,87 VMAF
    // bei 16 % weniger Daten** (95,16 gegen 93,29 bei 1687 gegen 1999 kbit/s;
    // Tabelle bei `KEYFRAME_SEKUNDEN_VORGABE` im Linux-Sidecar). Dazu der
    // schwerere Punkt: ein Intra-Refresh-Strom **heilt sich nach Paketverlust
    // nicht selbst**, ein Vollbild-Strom heilt am nächsten Takt.
    //
    // *Der Sendeweg hängt nicht mehr daran.* Die Vorgabe war halb damit
    // begründet, dass nur WHIP FlexFEC-Parität bekommt und `pushProtokoll()`
    // den Weg am Haken festmachte. Seit dem 2026-08-18 liefert `pushProtokoll`
    // für jeden Codec `'whip'` — Rückkanal und Parität stehen also unabhängig
    // von dieser Betriebsart.
    //
    // Die Bereinigung in `settingsState.svelte.ts::applyPersisted` räumt einen
    // aus der alten Lage gespeicherten Haken einmalig weg. Sie war wirkungslos,
    // solange diese Zeilen hier standen: sie löscht den Wert, und der nächste
    // Aufruf von `loadCatalogs()` setzte ihn sofort wieder auf `true`.
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
 * Der Push-Weg. **Seit dem 2026-08-18 immer WHIP.**
 *
 * Nur WHIP hat den RTCP-Rueckkanal, ueber den die Vollbild-Anforderung eines
 * beitretenden Zuschauers den Encoder erreicht. Wo ein Strom nach dem Start
 * kaum noch Vollbilder fuehrt, bekommt der Zuschauer sein erstes nur auf
 * Anforderung — ueber RTMPS saehe er GAR NICHTS (gemessen: 0 Bilder gegen
 * 2228).
 *
 * **Warum die Fallunterscheidung weg ist.** Bis hierher galt WHIP nur fuer
 * Intra-Refresh und H.264; AV1 mit periodischen Vollbildern ging ueber RTMPS.
 * Das war vertretbar, solange dort GARANTIERT alle zwei Sekunden ein Vollbild
 * im Strom stand — genau so stand es weiter unten auch als Begruendung. Seit
 * `PULSE_KEYFRAME_SECONDS` den Abstand streckbar macht (2026-08-18, bis zu 120
 * s), gilt diese Garantie nicht mehr, und die Regel kippte damit still: bei 30
 * s Abstand wartete ein beitretender Zuschauer bis zu **30 Sekunden** auf sein
 * erstes Bild, ohne dass irgendwo etwas Auffaelliges im Log stand. Live
 * beobachtet am 2026-08-18.
 *
 * Statt die Regel um den Abstand zu erweitern — der hier gar nicht bekannt ist,
 * er ist eine Umgebungsvariable des Sidecars — faellt sie ganz weg. Das ist
 * auch die Richtung, in die die Begruendung ohnehin schon zeigte: *der
 * Rueckkanal schadet nirgends, wo er nicht gebraucht wird, bleibt er
 * ungenutzt.* Dazu kommt die **FlexFEC-Paritaet, die es nur ueber WHIP gibt**
 * (2026-08-06: 71 von 71 RTMPS-Sitzungen ohne) — ein AV1-Strom hatte damit
 * bisher gar keinen Verlustschutz.
 *
 * AV1 ueber WHIP ist kein neuer Weg: der Sidecar bringt dafuer seinen eigenen
 * WebRTC-Sender mit (`linux-hq-sidecar/src/whip/`, ffmpegs Muxer traegt kein
 * AV1), und er laeuft in Produktion, seit Intra-Refresh ausgeliefert wird.
 *
 * **RTMPS bleibt serverseitig bestehen** (media-svc vergibt weiter solche
 * Token, MediaMTX horcht weiter auf 1936). Wer es braucht — etwa in einem Netz,
 * das UDP sperrt, waehrend TCP durchgeht — kann es dort anfordern; nur waehlt
 * die Oberflaeche es nicht mehr von sich aus.
 *
 * Die beiden Faelle, die den Rueckkanal schon vorher erzwangen, und warum sie
 * ihn brauchen — die Begruendung bleibt lesenswert, weil sie erklaert, wie
 * teuer ein fehlender Rueckkanal wirklich ist:
 *
 * **1. Intra-Refresh.** Die Betriebsart selbst, ausdruecklich gewaehlt.
 *
 * **2. H.264, immer — auch mit abgewaehltem Intra-Refresh.** Das ist seit dem
 * 2026-08-07 nicht mehr die Ausnahme, sondern der Regelfall, und der Grund
 * liegt nicht hier, sondern im Encoder: `h264_amf` bekommt aus Last-Gruenden
 * `usage=ultralowlatency` (`win-hq-sidecar/src/encode/opts.rs`, seit dem
 * 2026-07-30, drittelt die Video-Engine-Last), und diese Einstellung schaltet
 * die rollende Auffrischung von sich aus mit ein.
 *
 * **Das Kaestchen aendert daran wieder nichts — und das ist Absicht.** Vom
 * 2026-08-07 bis zum 2026-08-19 schaltete `auffrischung.rs::
 * abschalt_optionen_fuer` `h264_amf` bei abgewaehltem Haken auf
 * `usage=transcoding` und nahm die Auffrischung damit wirklich weg; das kostete
 * aber die sparsame Betriebsart (25,2 statt 10,2 Prozent Video-Engine,
 * nachgemessen), und seit Intra-Refresh abgewaehlt voreingestellt ist, haette
 * das jeder AMD-Windows-Stream gezahlt. Seit dem 2026-08-19 gibt
 * `abschalt_optionen_fuer` fuer `h264_amf` deshalb `&[]` zurueck,
 * `usage=ultralowlatency` bleibt unbedingt stehen — die Vollbilder kommen
 * stattdessen aus `keyframe::Selbsttakt`.
 *
 * Beim Stand von damals galt: Ein H.264-Strom auf AMD hat nach dem Start
 * praktisch kein Vollbild mehr, ganz gleich, was die Oberflaeche bestellt —
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
export function pushProtokoll(_uebersteuerung?: OverrideSet): 'rtmp' | 'whip' {
  // Der Parameter bleibt in der Signatur, obwohl er nicht mehr gelesen wird:
  // die Aufrufstelle beim Standplatz-Gerät (`stream/starten.ts`) reicht dort
  // das Profil des geweckten Rechners herein, und sie soll das weiter tun. Kommt
  // je wieder eine Unterscheidung, haengt sie genau an diesem Satz — dass sie
  // frueher am FALSCHEN Satz hing (global statt Profil), war der Bughunt-Fund
  // vom 2026-08-16.
  //
  // Der Rueckgabetyp behaelt `'rtmp'` bewusst: RTMPS ist serverseitig nicht
  // abgeschafft, nur nicht mehr die Wahl der Oberflaeche (Begruendung oben).
  return 'whip';
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
export function buildStartArgs(
  channelArg: ChannelStreamArg,
  slot = 0,
  standplatz?: { quelle: string; uebersteuerung: OverrideSet; ton: AudioMode },
): GsrStartArgs {
  // Ein geweckter Standplatz-Rechner übersteuert IMMER — das Profil ist ja
  // gerade dafür da, dass nicht gilt, was zuletzt von Hand eingestellt war
  // (`$lib/devices/profil.svelte.ts`).
  const apply = !!standplatz || streamSettings.use_overrides || streamSettings.profile_name === 'Custom';

  const args: GsrStartArgs = {
    profile: streamSettings.profile_name,
    channel: {
      id: channelArg.channelId,
      token: channelArg.token,
      ...(channelArg.pushUrl ? { push_url: channelArg.pushUrl } : {}),
    },
    // Each slot captures its own source (a different monitor); the rest of the
    // settings — profile, audio, overrides — are shared across both streams.
    capture: standplatz ? standplatz.quelle : captureSourceForSlot(slot),
    audio: {
      // **Beim Standplatz-Gerät entscheidet der Rufer über den Ton, nicht die
      // Einstellung des Besitzers.** Der erste Bildschirm einer Sitzung trägt
      // den Systemton, jeder dazugeschaltete ist stumm — sonst käme derselbe
      // Ton zwei- oder dreifach an, leicht gegeneinander versetzt, und das
      // klingt schlechter als gar keiner (`$lib/devices/wecken.ts`).
      mode: standplatz ? standplatz.ton : streamSettings.audio_mode,
      excluded_apps: streamSettings.excluded_apps.slice(),
    },
    show_cursor: streamSettings.show_cursor,
    // A/V-Trim auf Windows + macOS mitschicken (beide Sidecars timestampen
    // selbst). Linux lässt es weg — GSR synct selbst, dort wäre es ein toter Wert.
    ...(isWindows() || isMac() ? { av_offset_ms: streamSettings.av_offset_ms } : {}),
  };

  if (apply) {
    const o = standplatz ? standplatz.uebersteuerung : streamSettings.overrides;
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
    // 10 bit nur mitschicken, wenn es auch erfüllbar ist — `o` ist bereits die
    // richtige Wunschquelle (Profil beim Standplatz-Gerät, sonst der eigene
    // Store), `tenBitPossible(o)` prüft sie EINMAL für alle drei Verwendungen.
    if (tenBitPossible(o)) cleaned.bit_depth = 10;
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
    // **Aus DEMSELBEN Satz, nicht global** (Bughunt-Nachtrag 2026-08-16): beim
    // Standplatz-Profil hätte `intraRefreshPossible()` die Einstellung des
    // Besitzers für seine EIGENEN Übertragungen gelesen — der geweckte Rechner
    // hätte dann etwas anderes gefahren, als im Profil steht. Gesendet wird
    // weiterhin der ERFÜLLBARE Wert: ein Haken, den dieses FFmpeg nicht
    // einlösen kann, bräche den Start ab.
    if (o.intra_refresh !== undefined) {
      cleaned.intra_refresh = o.intra_refresh === true && stream.intraRefreshAvailable;
    }
    // HDR nur mitschicken, wenn es erfüllbar ist — ein `hdr: false` wäre
    // dasselbe wie es wegzulassen, und ein `hdr: true`, das der Sidecar nicht
    // einlösen kann, bräche den Start ab. Anders als bei Intra-Refresh gibt es
    // hier keinen prozessweiten Rest aus dem vorigen Lauf, den man überschreiben
    // müsste: HDR steht in den Start-Parametern, nicht in einer Variablen des
    // Sidecar-Prozesses.
    // Auch hier zählt beim Gerät der Wunsch aus dem Profil. HDR hängt an
    // `cleaned.bit_depth` und nicht am Wunsch: was oben durchgefallen ist
    // (kein AV1, Karte kann es nicht), darf hier nicht doch noch ein `hdr:true`
    // nach sich ziehen — das bräche den Start.
    const hdrGewuenscht = standplatz
      ? standplatz.uebersteuerung.hdr === true
      : streamSettings.overrides.hdr === true;
    if (hdrGewuenscht && cleaned.bit_depth === 10 && stream.hdrAvailable) cleaned.hdr = true;
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
