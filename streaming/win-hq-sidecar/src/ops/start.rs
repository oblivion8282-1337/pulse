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
//!  "av_offset_ms":0?}   // konstanter A/V-Trim, >0 = Audio später
//! ```
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
        gpu_wunsch: overrides.gpu,
        // Ebenfalls erst vom Verteiler, aus `gpu_wunsch` und der Kartenliste.
        gpu: None,
        show_cursor,
        av_offset_ms,
    })
}

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let start_params = parse_start_params(&params)?;
    // Die Betriebsart ist prozessweit, nicht Teil der `StartParams` — sie wird
    // an vier Stellen gelesen, die diese Konfiguration nicht sehen
    // (`encode::auffrischung`). **Nur hier setzen, nicht in
    // `parse_start_params`:** das teilt sich `build_argv`, und der baut nur
    // eine Kommandozeile zum Anzeigen. Eine Vorschau darf die Betriebsart des
    // nächsten echten Streams nicht umstellen.
    if let Some(an) = requested_intra_refresh(params.get("overrides").and_then(Value::as_object)) {
        crate::encode::auffrischung::setzen(an);
    }
    // Dasselbe Muster, derselbe Grund: die Opus-Rahmenlänge haengt am Sendeweg,
    // gebraucht wird sie aber an Stellen, die die Start-Parameter nicht sehen
    // (Aufnahme-Raster, Paketdauer im Sendeweg). **Vor** `start()`, weil die
    // Aufnahme ihr Raster daraus nimmt.
    //
    // Anders als oben ohne `if let`: es gibt kein "ungesagt". Die Ziel-URL
    // liegt vor, also steht der Weg fest — und ein Rest aus dem vorigen Stream
    // waere hier schlimmer als eine Vorgabe.
    crate::encode::audio::setze_sendeweg(crate::encode::output::is_whip_url(
        &start_params.push_url,
    ));
    let argv = StreamController::singleton().start(start_params)?;

    let mut out = Map::new();
    out.insert(
        "argv".to_string(),
        Value::Array(argv.into_iter().map(Value::String).collect()),
    );
    Ok(out)
}

/// Wunsch aus dem Wire-Format lesen: `overrides.intra_refresh` = true|false.
///
/// Fehlt das Feld, wird NICHT auf `false` entschieden, sondern gar nicht — dann
/// bleibt `PULSE_INTRA_REFRESH` zuständig. Sonst zöge ein Client, der das Feld
/// nicht kennt, dem Messstand die Betriebsart unter den Füßen weg. Wortgleich
/// zum Linux-Sidecar (`ops/start.rs::requested_intra_refresh`).
fn requested_intra_refresh(overrides: Option<&Map<String, Value>>) -> Option<bool> {
    overrides
        .and_then(|o| o.get("intra_refresh"))
        .and_then(Value::as_bool)
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
    /// Welche Grafikkarte, aus `overrides.gpu`. Siehe [`gpu_wunsch`].
    gpu: crate::system::gpu_wahl::Wunsch,
}

/// `overrides.gpu` einlesen.
///
/// Erwartet die **Kennung**, die `gpu_info` je Karte als `id` herausgibt:
/// `"<vendor_id>:<device_id>"`, beide vierstellig hexadezimal, z. B.
/// `"10DE:1E84"`. Fehlend, leer oder `"auto"` heißt Automatik.
///
/// **Eine undeutbare Kennung führt zur Automatik, nicht zum Abbruch.** Sie
/// kommt aus einer gespeicherten Einstellung, und eine Einstellung aus einer
/// älteren Fassung darf niemanden am Streamen hindern — die Automatik trifft
/// ohnehin die vernünftige Wahl. Sichtbar bleibt es über die Log-Zeile in
/// `select_adapter`, die den verfehlten Wunsch meldet.
fn parse_gpu(o: &Map<String, Value>) -> crate::system::gpu_wahl::Wunsch {
    use crate::system::gpu_wahl::Wunsch;
    let Some(text) = o.get("gpu").and_then(Value::as_str) else {
        return Wunsch::Automatisch;
    };
    if text.is_empty() || text.eq_ignore_ascii_case("auto") {
        return Wunsch::Automatisch;
    }
    let Some((v, d)) = text.split_once(':') else {
        eprintln!("[start] overrides.gpu unlesbar ({text:?}) — es wird automatisch gewählt");
        return Wunsch::Automatisch;
    };
    match (u32::from_str_radix(v.trim(), 16), u32::from_str_radix(d.trim(), 16)) {
        (Ok(vendor_id), Ok(device_id)) => Wunsch::Genau { vendor_id, device_id },
        _ => {
            eprintln!("[start] overrides.gpu unlesbar ({text:?}) — es wird automatisch gewählt");
            Wunsch::Automatisch
        }
    }
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
    // **Gleiche Bauart und gleicher Grund wie `PULSE_INTRA_REFRESH`**
    // (`encode::auffrischung::gewuenscht`): der Sidecar wird auch ohne
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
    Overrides { codec, bitrate_kbps: bitrate, fps, resolution, ten_bit, hdr, gpu: parse_gpu(o) }
}
