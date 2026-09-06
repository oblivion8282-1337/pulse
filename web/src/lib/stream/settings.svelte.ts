import { errText } from '$lib/utils/errText';
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
  aktiveQuelleFuerSlot,
  resetCaptureSourcesToPortal,
  verfalleneWahlenErsetzen,
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
 * HDR — Wunsch UND Erfüllbarkeit?
 *
 * Dieselbe Bauart wie [`tenBitPossible`], und aus demselben Grund an EINER
 * Stelle. Der Unterschied zu beiden: die Folge eines
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
 * AV1 — kann diese Maschine es, UND kommt es auch heil beim Zuschauer an?
 *
 * `gpuHasAv1` allein beantwortet nur die erste Hälfte: es fragt den Encoder.
 * **Auf macOS ist die zweite Hälfte seit dem 2026-08-18 nein** (korrigiert am
 * 2026-08-19). Seit `pushProtokoll` bedingungslos WHIP liefert, geht der
 * mac-Sidecar über ffmpegs WHIP-Muxer — der trägt kein AV1, und der Sidecar
 * nimmt den Codec beim Start still auf H.264 zurück
 * (`mac-hq-sidecar/src/encode/mod.rs`). Linux und Windows bringen dafür einen
 * eigenen WebRTC-Sender mit (`src/whip/` in beiden Sidecars), macOS nicht.
 *
 * Ein nicht angebotener Eintrag ist besser als einer, der beim Start still
 * zurückgenommen wird: auf einem M3+ stand „AV1" im Feld, war sogar die
 * Vorbelegung, und übertragen wurde H.264 — sichtbar nirgends.
 *
 * Wer hier je das `!isMac()` entfernt, baut vorher den eigenen WHIP-Sender für
 * macOS.
 */
export function av1Nutzbar(codecs: ReadonlyArray<string> | undefined): boolean {
  return !isMac() && gpuHasAv1(codecs);
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
      verfalleneWahlenErsetzen();
    } else {
      // Linux: every slot uses the Wayland portal — each start opens its own
      // portal dialog so the user picks a (different) screen per stream.
      resetCaptureSourcesToPortal();
    }
    streamSettings.profile_name = 'Custom';
    streamSettings.use_overrides = true;
    // Default codec/bitrate — only if the user hasn't already saved a value.
    // Für die Bildrate steht seither kein Default mehr hier: „Standard" im
    // FPS-Feld heißt gerade, dass die Oberfläche nichts mitgibt und der
    // Sidecar seine Vorgabe nimmt (`FPS_STANDARD`) — eine Vorbelegung auf 60
    // hätte den Eintrag nie sichtbar werden lassen.
    const hasAv1 = av1Nutzbar(streamSettings.gpu_info?.video_codecs);
    const defaults: OverrideSet = {};
    if (!streamSettings.overrides.codec) defaults.codec = hasAv1 ? 'av1' : 'h264';
    // Coerce a previously-saved codec this GPU can't encode (e.g. 'av1' carried
    // over to an H.264-only machine) back to the baseline.
    else if (streamSettings.overrides.codec === 'av1' && !hasAv1) defaults.codec = 'h264';
    if (streamSettings.overrides.bitrate_kbps === undefined) defaults.bitrate_kbps = 4000;
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
    // Und dasselbe für HDR — hier sogar dringender: ein mitgereister Wunsch
    // bricht den Start ab, statt still auf etwas Kleineres zurückzufallen.
    if (streamSettings.overrides.hdr === true && !hdrPossible()) {
      const { hdr: _hdrWeg, ...rest } = streamSettings.overrides;
      streamSettings.overrides = rest;
    }
    streamSettings.catalogs_loaded = true;
  } catch (e) {
    streamSettings.catalog_error = errText(e);
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
 * **Warum es keine Fallunterscheidung mehr gibt.** Frueher waehlte die
 * Oberflaeche RTMPS, wo sie einen Strom mit regelmaessigen Vollbildern
 * erwartete. Das war vertretbar, solange GARANTIERT alle zwei Sekunden eines im
 * Strom stand. Seit `PULSE_KEYFRAME_SECONDS` den Abstand streckbar macht
 * (2026-08-18, bis zu 120 s), gilt diese Garantie nicht mehr, und die Regel
 * kippte damit still: bei 30 s Abstand wartete ein beitretender Zuschauer bis
 * zu **30 Sekunden** auf sein erstes Bild, ohne dass irgendwo etwas
 * Auffaelliges im Log stand. Live beobachtet am 2026-08-18.
 *
 * Statt die Regel um den Abstand zu erweitern — der hier gar nicht bekannt ist,
 * er ist eine Umgebungsvariable des Sidecars — faellt sie ganz weg. Das ist
 * auch die Richtung, in die die Begruendung ohnehin schon zeigte: *der
 * Rueckkanal schadet nirgends, wo er nicht gebraucht wird, bleibt er
 * ungenutzt.* Dazu kommt die **FlexFEC-Paritaet, die es nur ueber WHIP gibt**
 * (2026-08-06: 71 von 71 RTMPS-Sitzungen ohne, 75 von 131 WHIP-Sitzungen mit)
 * — ein AV1-Strom hatte damit bisher gar keinen Verlustschutz.
 *
 * AV1 ueber WHIP ist kein neuer Weg: der Sidecar bringt dafuer seinen eigenen
 * WebRTC-Sender mit (`linux-hq-sidecar/src/whip/`, ffmpegs Muxer traegt kein
 * AV1), und er laeuft seit Langem in Produktion.
 *
 * **RTMPS bleibt serverseitig bestehen** (media-svc vergibt weiter solche
 * Token, MediaMTX horcht weiter auf 1936). Wer es braucht — etwa in einem Netz,
 * das UDP sperrt, waehrend TCP durchgeht — kann es dort anfordern; nur waehlt
 * die Oberflaeche es nicht mehr von sich aus.
 *
 * **Wie teuer ein fehlender Rueckkanal wirklich ist**, am Beispiel, das die
 * Regel erzwungen hat: `h264_amf` bekommt aus Last-Gruenden
 * `usage=ultralowlatency` (`win-hq-sidecar/src/encode/opts.rs`, seit dem
 * 2026-07-30, drittelt die Video-Engine-Last), und diese Einstellung schaltet
 * eine rollende Auffrischung von sich aus mit ein. Ein H.264-Strom auf AMD hat
 * damit nach dem Start praktisch kein Vollbild mehr — die kommen dort
 * ausschliesslich aus `keyframe::Selbsttakt` und aus Anforderungen ueber den
 * Rueckkanal.
 *
 * Belegt in der Produktion am 2026-08-07: derselbe Kanal, dieselben Minuten.
 * H.264 ueber RTMPS — 1400 Pakete in 5 s, 0 Verlust, **0 dekodierte Bilder**,
 * 25 unbeantwortete Vollbild-Anforderungen, danach zwanzig Neuaufbauten in
 * Folge ueber zwei Minuten, keiner davon mit Bild. Dieselbe Maschine ueber
 * WHIP: 2681 Bilder.
 *
 * **Warum nicht auf AMD eingeschraenkt**, obwohl nur dieser Encoder betroffen
 * ist: welchen Encoder der Sidecar wirklich oeffnet, entscheidet sich dort und
 * haengt an Hersteller, Plattform und `PULSE_HQ_AMD_D3D12` — die Oberflaeche
 * weiss es nicht zuverlaessig. Eine Regel, die auf eine Vermutung ueber den
 * Encoder baut, waere genau die Sorte stiller Fehlannahme, die diesen Fehler
 * erzeugt hat.
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
  p2p = false,
): GsrStartArgs {
  // Ein geweckter Standplatz-Rechner übersteuert IMMER — das Profil ist ja
  // gerade dafür da, dass nicht gilt, was zuletzt von Hand eingestellt war
  // (`$lib/devices/profil.svelte.ts`).
  const apply = !!standplatz || streamSettings.use_overrides || streamSettings.profile_name === 'Custom';

  const args: GsrStartArgs = {
    profile: streamSettings.profile_name,
    // **P2P: kein Kanal-Block.** Ohne Token und Push-URL hat der Sidecar
    // keinen Serverkontakt — er startet im Wartezustand und verhandelt die
    // Direktverbindung später selbst (`op direct_offer`,
    // `$lib/remote/direktbild`). Stattdessen reist die Markierung `direct`,
    // die den Sidecar-Zweig wählt.
    ...(p2p ? {} : {
      channel: {
        id: channelArg.channelId,
        token: channelArg.token,
        ...(channelArg.pushUrl ? { push_url: channelArg.pushUrl } : {}),
      },
    }),
    ...(p2p ? { direct: true } : {}),
    // Each slot captures its own source (a different monitor); the rest of the
    // settings — profile, audio, overrides — are shared across both streams.
    // Die aktive, nicht die gemerkte Quelle: fehlt der gewählte Bildschirm
    // gerade, liefe eine Nummer an den Sidecar, die es nicht gibt.
    capture: standplatz ? standplatz.quelle : aktiveQuelleFuerSlot(slot).quelle,
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
    // HDR nur mitschicken, wenn es erfüllbar ist — ein `hdr: false` wäre
    // dasselbe wie es wegzulassen, und ein `hdr: true`, das der Sidecar nicht
    // einlösen kann, bräche den Start ab.
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
