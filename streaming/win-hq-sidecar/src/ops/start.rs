//! `start` — Stream starten.
//!
//! Parsed dieselbe Request-Shape wie auf Linux (`gsr-sidecar/control.py::op_start`):
//!
//! ```jsonc
//! {"op":"start", "profile":"H.264 Standard",
//!  "channel":{"id":"123","token":"…","push_url":"rtmps://…"},
//!  "capture":"portal"|"monitor"|"Monitor: <n>"|"window:<hwnd>"|"Window: <title>",
//!  "audio":{"mode":"Aus|Desktop|Mikrofon|Desktop + Mikrofon","excluded_apps":[]},
//!  "overrides":{"codec":"h264","bitrate_kbps":4000,"fps":60,"resolution":"1080p"}?,
//!  "show_cursor":true?,
//!  "av_offset_ms":0?,   // konstanter A/V-Trim, >0 = Audio später
//!  "direct":true?}      // Direktpfad statt Server-Push (s. `crate::direct`)
//! ```
//!
//! Mit `"direct": true` entfällt `channel` ganz; der Sidecar geht in den
//! Wartezustand (`{"ev":"state","running":true,"state":"wartend"}`) und
//! beantwortet per `direct_offer` das Angebot des Players.
//!
//! Returnt `{"ok":true, "argv":[…redactet…]}`, danach kommen via `events::emit`
//! die `state`/`fps`/`log`/`error`/`stopped`-Events.

use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value};

use crate::audio::AudioSource;
use crate::capture::CaptureSource;
use crate::encode::VideoCodec;
use crate::profiles::{APP_LABEL_PREFIX, BASELINE, profile_label};
use crate::stream_controller::{StartParams, StreamController};
use crate::system::audio_sessions;

/// Parst die `start`/`build_argv`-Request-Shape zu fertigen `StartParams` —
/// alles vor dem eigentlichen `StreamController::start()`-Aufruf, damit
/// `build_argv` denselben Parse-Pfad durchläuft wie `start` (Wire-Parität zu
/// Linux' `control.py`, wo `op_build_argv`/`op_start` dasselbe Body-Parsing
/// teilen).
pub(crate) fn parse_start_params(params: &Map<String, Value>) -> Result<StartParams> {
    let profile_name = profile_label(params);
    let profile = &BASELINE;

    // Direktmodus (`"direct": true`): KEIN Server als Ziel — der Strom geht
    // über eine eigene WebRTC-Verbindung zum Player, der als Angeboter
    // `direct_offer` nachschiebt. Alles andere (Codec, fps, Bitrate, Capture,
    // Audio, Overrides, Profil) verhält sich identisch.
    //
    // **Streng wie die Overrides**: nur ein echtes `true` zählt, ein
    // `"true"`-String oder eine 1 sind Fehler beim Bauen des Requests — und
    // der soll niemandem als „hat ja funktioniert" durchgehen.
    //
    // **Entscheidung direct + push_url: ABLEHNUNG, nicht Ignorieren.** Ein
    // Request, der beides trägt, widerspricht sich; still das eine zu
    // gewinnen wäre genau die Sorte Verwechslung, gegen die der Muxer-Guard
    // in `open_output` gebaut ist. Stufe 1 ist exklusiv (Begruendung in
    // `crate::direct`).
    let direct = match params.get("direct") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(andere) => {
            return Err(anyhow!("direct muss ein Boolean sein (war {andere})"));
        }
    };
    let (channel_id, token, push_url) = if direct {
        if params
            .get("channel")
            .and_then(Value::as_object)
            .is_some_and(|k| k.contains_key("push_url"))
        {
            return Err(anyhow!(
                "direct:true und channel.push_url schließen sich aus — \
                 entweder Server-Push oder Direktpfad"
            ));
        }
        // Der Platzhalter-Kanal trägt nur die Diagnose-argv (`--out` zeigt
        // auf `direct::SITZUNG_URL`); ein echter Kanal existiert im
        // Direktmodus nicht.
        ("direct".to_string(), String::new(), crate::direct::SITZUNG_URL.to_string())
    } else {
        let channel = params
            .get("channel")
            .and_then(Value::as_object)
            .context("channel ist Pflicht (Pulse streamt immer in einen Voice-Channel)")?;
        let channel_id = channel
            .get("id")
            .and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string())))
            .ok_or_else(|| anyhow!("channel.id ist Pflicht"))?;
        let token = channel
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let push_url = channel
            .get("push_url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                anyhow!(
                    "channel.push_url ist auf Windows Pflicht (media-svc reicht die rtmps://- bzw. WHIP-URL durch)"
                )
            })?;
        (channel_id, token, push_url)
    };

    let capture = parse_capture(params)?;
    let audio = parse_audio(params);
    let overrides = parse_overrides(params);
    // Mauszeiger im Stream — Default `true` (GSR-Default `-cursor yes`); fehlt
    // das Feld oder ist es kein Bool, bleibt's an.
    let show_cursor = params
        .get("show_cursor")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // Konstanter A/V-Trim in ms (UI-Slider; >0 = Audio später). Fehlt das Feld
    // → 0 (neutral; dann greift ggf. der `PULSE_HQ_AV_OFFSET_MS`-Env-Fallback).
    // Geclampt auf ±1000 ms (doppelter UI-Slider-Bereich, `AvOffsetSlider.svelte`
    // MIN/MAX = ±500) — Defense-in-Depth gegen einen Renderer-Bug oder einen
    // manuell zusammengebauten Request: ein extremer negativer Wert würde sonst
    // den Audio-PTS-Anker so weit nach vorn verschieben, dass jedes Audio-Paket
    // als "vor dem Streamstart" verworfen wird und die Spur dauerhaft stumm ist.
    let av_offset_ms = params
        .get("av_offset_ms")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
        .clamp(-1000, 1000) as i32;

    // Welchen Stream-Platz dieser Prozess bedient. Optional und heute von
    // niemandem gesetzt — Electron fährt je Platz einen eigenen Sidecar. Wer es
    // setzt, bekommt dafür die strenge Zuordnung in der Fernsteuerung: Frames
    // eines anderen Slots landen dann nicht auf diesem Bildschirm
    // (`remote_input::ziel`).
    let slot = params
        .get("slot")
        .and_then(Value::as_u64)
        .map(|n| n.min(u32::MAX as u64) as u32);

    Ok(StartParams {
        profile,
        profile_name: profile_name.to_string(),
        channel_id,
        token,
        push_url,
        capture,
        slot,
        audio,
        override_codec: overrides.codec,
        override_bitrate_kbps: overrides.bitrate_kbps,
        override_fps: overrides.fps,
        override_resolution: overrides.resolution,
        // HDR schaltet 10 bit selbst ein — beides einzeln zu verlangen hiesse,
        // zwei Dinge zu trennen, die zusammengehören. In der Oberfläche ist
        // das seit dem 2026-08-07 ohnehin EIN Eintrag im Codec-Feld
        // („AV1 10 bit HDR"); hier stand bis dahin „zwei Kästchen", und das
        // eine davon gibt es nicht mehr. (Begründung: `StartParams::hdr`.)
        ten_bit: overrides.ten_bit || overrides.hdr,
        hdr: overrides.hdr,
        // Wird erst vom Verteiler gefüllt, wenn `hdr` geprüft ist — hier steht
        // noch nicht fest, ob der Schirm mitspielt.
        schirm: None,
        show_cursor,
        av_offset_ms,
        // Direktmodus: der Controller startet im Wartezustand, die Pipeline
        // erst, wenn die PeerConnection steht (`direct::Sitzung`).
        direct,
    })
}

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let start_params = parse_start_params(&params)?;
    let direct = start_params.direct;
    // Die Opus-Rahmenlänge haengt am Sendeweg,
    // gebraucht wird sie aber an Stellen, die die Start-Parameter nicht sehen
    // (Aufnahme-Raster, Paketdauer im Sendeweg). **Vor** `start()`, weil die
    // Aufnahme ihr Raster daraus nimmt.
    //
    // Ohne "ungesagt": die Ziel-URL liegt vor, also steht der Weg fest — und
    // ein Rest aus dem vorigen Stream waere hier schlimmer als eine Vorgabe.
    // Der Direktpfad zählt als eigener Sendeweg: RTP mit eigener Spur-Zeit-
    // basierung, also derselbe 10-ms-Rahmen wie beim WHIP-Weg.
    crate::encode::audio::setze_sendeweg(
        direct || crate::encode::output::is_whip_url(&start_params.push_url),
    );
    let argv = StreamController::singleton().start(start_params)?;

    // Die Warte-Buchung der Direkt-Sitzung — NACH dem Controller, dessen
    // „already running"-Wache der strengere Doppelstart-Schutz ist. Prak-
    // tisch unfehlbar (der Dispatch ist single-threaded), aber wer hier
    // stillschweigend weiterliefe, würde einen `wartend`-Controller ohne
    // Empfangsbereitschaft hinterlassen.
    if direct {
        crate::direct::sitzung().bereite_vor()?;
    }

    let mut out = Map::new();
    out.insert(
        "argv".to_string(),
        Value::Array(argv.into_iter().map(Value::String).collect()),
    );
    Ok(out)
}

/// `capture` aus dem Request → konkreter `CaptureSource`.
///
/// Linux nimmt `"portal"`/`"monitor"`/`"window"` als String. Auf Windows
/// mappen wir das so:
/// - `"portal"` (Default) → `PrimaryMonitor` (kein Portal-Picker auf Windows;
///   greift auch als Fallback wenn `list_monitors` leer war)
/// - `"monitor"` → `PrimaryMonitor`
/// - `"Monitor: <n>"` → `MonitorByIndex(n)` (1-basiert, matcht `list_monitors`)
/// - `"window:<hwnd>"` → `WindowByHwnd(hwnd)` (HWND-Zahl aus `list_windows`)
/// - alles was mit `"Window: <title>"` anfängt → `WindowByTitle(title)`
///   (Legacy/Komfort-Pfad: Titel-Substring statt HWND)
fn parse_capture(params: &Map<String, Value>) -> Result<CaptureSource> {
    let raw = params
        .get("capture")
        .and_then(Value::as_str)
        .unwrap_or("portal");
    // `window:<hwnd>` (kleines w, Doppelpunkt) = der reguläre Picker-Token.
    // `Window: <title>` (großes W, Leerzeichen) bleibt als Titel-Fallback.
    if let Some(id) = raw.strip_prefix("window:") {
        let hwnd: i64 = id
            .trim()
            .parse()
            .map_err(|_| anyhow!("ungültige Fenster-ID in capture: {raw:?}"))?;
        return Ok(CaptureSource::WindowByHwnd(hwnd));
    }
    if let Some(title) = raw.strip_prefix("Window: ") {
        return Ok(CaptureSource::WindowByTitle(title.to_string()));
    }
    if let Some(idx) = raw.strip_prefix("Monitor: ") {
        let index: usize = idx
            .trim()
            .parse()
            .map_err(|_| anyhow!("ungültiger Monitor-Index in capture: {raw:?}"))?;
        return Ok(CaptureSource::MonitorByIndex(index));
    }
    match raw {
        "portal" | "monitor" | "" => Ok(CaptureSource::PrimaryMonitor),
        other => Err(anyhow!("unsupported capture source: {other}")),
    }
}

/// `audio` aus dem Request → `AudioSource`. UI-Labels wie auf Linux:
/// `"Aus"`/`"Desktop"`/`"Mikrofon"`/`"Desktop + Mikrofon"`/`"App: <name>"`.
/// Die App-Variante schickt der Renderer mit dem Prozessnamen; wir lösen ihn
/// hier via `audio_sessions::resolve_application_pid` zur Tree-Root-PID auf
/// und bauen den WASAPI-Process-Loopback (`AudioSource::Application`).
/// `"Desktop"` schließt Pulses eigenen Ton aus (s. `desktop_audio_source`).
fn parse_audio(params: &Map<String, Value>) -> Option<AudioSource> {
    let mode = params
        .get("audio")
        .and_then(Value::as_object)
        .and_then(|o| o.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("Aus");
    match mode {
        "Aus" => None,
        "Desktop" => Some(desktop_audio_source()),
        "Mikrofon" => Some(AudioSource::DefaultMicrophone),
        "Desktop + Mikrofon" => Some(AudioSource::DesktopPlusMicrophone),
        s if s.starts_with(APP_LABEL_PREFIX) => {
            let app_name = s[APP_LABEL_PREFIX.len()..].trim();
            match audio_sessions::resolve_application_pid(app_name) {
                // `include_tree=true` — Chromium/Firefox erzeugen Audio in
                // Child-Prozessen, der Loopback muss den ganzen Tree erfassen.
                Some(pid) => Some(AudioSource::Application { pid, include_tree: true }),
                None => {
                    // App nicht (mehr) gefunden — kein stiller Mitschnitt des
                    // gesamten Desktops (Privacy); lieber video-only streamen.
                    eprintln!(
                        "[hq-sidecar] Audio-App {app_name:?} läuft nicht — Audio deaktiviert"
                    );
                    None
                }
            }
        }
        _ => None,
    }
}

/// „Desktop"-Audio-Quelle. Ist die Pulse-Main-PID via `PULSE_SELF_PID` bekannt
/// (von `sidecar.ts` beim Spawn gesetzt), capturen wir den Desktop-Mix UNTER
/// Ausschluss des Pulse-Prozess-Trees — sonst landet Pulses eigene Wiedergabe
/// (Voice der anderen Teilnehmer) als Echo im Stream. Ohne die PID (z. B.
/// Standalone-Test des Sidecars) Fallback auf den simplen Render-Loopback, der
/// alles inkl. Pulse mitnimmt. Mirror des Linux `app-inverse:Pulse`.
fn desktop_audio_source() -> AudioSource {
    match pulse_self_pid() {
        Some(pid) => AudioSource::DesktopExcludingTree { pid },
        None => {
            eprintln!(
                "[hq-sidecar] PULSE_SELF_PID nicht gesetzt — Desktop-Audio ohne \
                 Pulse-Ausschluss (eigener Ton kann als Echo im Stream landen)"
            );
            AudioSource::DefaultDesktop
        }
    }
}

/// Electron-Main-PID aus `PULSE_SELF_PID`. `None` wenn unset/leer/0/unparsebar.
fn pulse_self_pid() -> Option<u32> {
    std::env::var("PULSE_SELF_PID")
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|&p| p != 0)
}

/// Die Felder aus `overrides`, die der Renderer schicken darf. Als Struct statt
/// als Tupel, weil `None` an vierter von fünf Stellen nichts mehr aussagt und
/// die Vorgabe für den Frühausstieg sonst zweimal dasteht.
#[derive(Default)]
struct Overrides {
    codec: Option<VideoCodec>,
    bitrate_kbps: Option<u32>,
    fps: Option<u32>,
    resolution: Option<(u32, u32)>,
    /// 10 bit statt 8. Vom Renderer angefragt, hier aber nur ein Wunsch: ob er
    /// erfüllt wird, entscheidet [`VideoCodec::supports_ten_bit`] zusammen mit
    /// dem Encode-Weg. **Kann der effektive Encode-Weg gar kein 10 bit (CPU
    /// oder D3D12), ist das seit dem 2026-08-11 ein Fehler** — der Start
    /// bricht ab (`encode::zehnbit::pruefen`) statt still auf 8 bit
    /// zurückzufallen, wie ein Override es sonst täte. Nur die feinere
    /// Rücknahme innerhalb des D3D11-Zero-Copy-Wegs (Codec ohne 10-bit-Träger,
    /// oder ein angemeldeter Encode-Weg mit 8-bit-Pool) bleibt still, mit
    /// einer Log-Zeile statt einem Abbruch (`pipeline_hw`).
    ten_bit: bool,
    /// HDR senden. **Anders als [`ten_bit`](Self::ten_bit) kein Wunsch,
    /// sondern eine Bedingung** — ist sie nicht erfüllbar, verweigert der
    /// Start (`encode::hdr::pruefen`). Der Unterschied ist Absicht und in
    /// `StartParams::hdr` begründet.
    hdr: bool,
}

fn parse_overrides(params: &Map<String, Value>) -> Overrides {
    let o = match params.get("overrides").and_then(Value::as_object) {
        Some(o) => o,
        None => return Overrides::default(),
    };
    let codec = o.get("codec").and_then(Value::as_str).and_then(|s| match s {
        "h264" => Some(VideoCodec::H264),
        "hevc" => Some(VideoCodec::Hevc),
        "av1" => Some(VideoCodec::Av1),
        _ => None,
    });
    // `.filter(|&n| n > 0)`: ein Override von 0 muss wie "nicht gesetzt"
    // behandelt werden (→ Profil-Default greift). Ungefiltert läuft `fps: 0`
    // bis in die Pacing-Berechnung durch (`Duration::from_secs_f64(1.0 / 0.0)`)
    // und legt den Worker-Thread mit einem Panic lahm.
    let bitrate = o
        .get("bitrate_kbps")
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .filter(|&n| n > 0);
    let fps = o
        .get("fps")
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .filter(|&n| n > 0);
    // Auflösungs-Map konsistent zu den Linux-Sidecars: "Native" → None (kein
    // Downscale), sonst eine BOX, in die `run_pipeline` aspektwahrend einpasst
    // (`fit_within_box`) — Ultrawide wird also nicht auf 16:9 gestaucht.
    // Upscale gibt es nie (Pool ist auf Capture-Native allokiert).
    let resolution = o.get("resolution").and_then(Value::as_str).and_then(|s| match s {
        "4K" => Some((3840u32, 2160u32)),
        "1440p" => Some((2560u32, 1440u32)),
        "1080p" => Some((1920u32, 1080u32)),
        "720p" => Some((1280u32, 720u32)),
        "480p" => Some((854u32, 480u32)),
        "Native" | "" => None,
        _ => None,
    });
    // Nur der Wert 10 zählt als Anfrage; alles andere (fehlend, 8, Unsinn) ist
    // der Regelfall. Bewusst kein „alles über 8" — ein Tippfehler soll nicht
    // stillschweigend etwas anderes einschalten, als dasteht.
    let ten_bit = o.get("bit_depth").and_then(Value::as_u64) == Some(10);
    // Gleiche Strenge wie oben: nur ein echtes `true` zählt. Ein `"true"` als
    // Zeichenkette oder eine 1 wären ein Fehler beim Bauen des Requests, und
    // den soll niemand als „hat ja funktioniert" abhaken.
    // Sagt die Oberflaeche nichts, entscheidet `PULSE_HDR=1`.
    //
    // **Der Rueckfall auf die Variable ist Absicht:** der Sidecar wird auch ohne
    // Oberflaeche gefahren — vom Messstand, und vor allem von der ECHTEN
    // Desktop-App, solange das HDR-Kaestchen nur auf dem Feature-Zweig liegt
    // und die App die veroeffentlichte Web-Fassung laedt. Ohne diesen Rueckfall
    // liesse sich HDR im richtigen Programm erst nach dem Deploy ausprobieren,
    // also genau dann nicht, wenn man es noch pruefen will.
    //
    // Die Reihenfolge ist die strengere: ein ausdrueckliches `hdr: false` aus
    // der Oberflaeche schlaegt die Variable. Wer abwaehlt, meint es.
    let hdr = match o.get("hdr").and_then(Value::as_bool) {
        Some(gesagt) => gesagt,
        None => crate::env::flag("PULSE_HDR"),
    };
    Overrides { codec, bitrate_kbps: bitrate, fps, resolution, ten_bit, hdr }
}

#[cfg(test)]
mod direct_tests {
    use super::*;
    use serde_json::json;

    fn params(v: Value) -> Map<String, Value> {
        v.as_object().expect("Objekt").clone()
    }

    /// Der Direkt-Start OHNE Kanal und OHNE push_url wird angenommen — das
    /// ist der Vertrag mit dem Renderer. `push_url` trägt die Direktpfad-
    /// Markierung, damit die Sendeweg-Weiche (`encode::senke::zustaendig`)
    /// den Strom an den Direkt-Sender schickt.
    #[test]
    fn direct_ohne_channel_wird_akzeptiert() {
        let p = parse_start_params(&params(json!({
            "direct": true,
            "profile": "H.264 Standard",
            "capture": "monitor",
        })))
        .expect("direkter Start ohne channel ist der Normalfall");
        assert!(p.direct);
        assert_eq!(p.push_url, crate::direct::SITZUNG_URL);
        assert_eq!(p.channel_id, "direct");
        // Der Sendeweg-Markierung folgt auch die Weiche:
        assert!(crate::encode::output::is_direct_url(&p.push_url));
        assert!(!crate::encode::output::is_whip_url(&p.push_url));
    }

    /// Beides zusammen ist ein sich widersprechender Request — abgelehnt,
    /// nicht still entschärft (Begründung an der Parse-Stelle).
    #[test]
    fn direct_mit_push_url_wird_abgelehnt() {
        let fehler = parse_start_params(&params(json!({
            "direct": true,
            "channel": {"id": "123", "token": "t", "push_url": "whip://srv/x"},
        })))
        .expect_err("direct und push_url schließen sich aus");
        assert!(format!("{fehler:#}").contains("push_url"), "{fehler:#}");
    }

    /// `false` ist der alte Weg: ohne `direct` bleibt ALLES beim Alten —
    /// fehlender Kanal ist ein Fehler, vorhandener zählt unverändert.
    #[test]
    fn ohne_direct_ist_kein_kanal_ein_fehler() {
        let fehler = parse_start_params(&params(json!({})))
            .expect_err("ohne direct ist channel Pflicht");
        assert!(format!("{fehler:#}").contains("channel"), "{fehler:#}");
    }

    #[test]
    fn ohne_direct_wird_der_kanal_wie_bisher_gelesen() {
        let p = parse_start_params(&params(json!({
            "channel": {"id": 456, "token": "geheim", "push_url": "rtmps://srv/live/key"},
            "direct": false,
        })))
        .expect("klassischer Start unverändert");
        assert!(!p.direct);
        assert_eq!(p.channel_id, "456");
        assert_eq!(p.push_url, "rtmps://srv/live/key");
    }

    /// Streng wie die Overrides: nur ein echtes `true` zählt. Ein String ist
    /// ein Bau-Fehler, kein stiller Direktpfad.
    #[test]
    fn direct_als_string_ist_ein_fehler() {
        let fehler = parse_start_params(&params(json!({
            "direct": "true",
            "channel": {"id": "123", "push_url": "whip://srv/x"},
        })))
        .expect_err("ein 'true'-String ist kein Schalter");
        assert!(format!("{fehler:#}").contains("Boolean"), "{fehler:#}");
    }
}
