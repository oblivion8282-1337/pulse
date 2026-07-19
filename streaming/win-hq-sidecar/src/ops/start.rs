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

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let profile_name = profile_label(&params);
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

    let capture = parse_capture(&params)?;
    let audio = parse_audio(&params);
    let (override_codec, override_bitrate, override_fps, override_resolution) =
        parse_overrides(&params);
    // Mauszeiger im Stream — Default `true` (GSR-Default `-cursor yes`); fehlt
    // das Feld oder ist es kein Bool, bleibt's an.
    let show_cursor = params
        .get("show_cursor")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // Konstanter A/V-Trim in ms (UI-Slider; >0 = Audio später). Fehlt das Feld
    // → 0 (neutral; dann greift ggf. der `PULSE_HQ_AV_OFFSET_MS`-Env-Fallback).
    let av_offset_ms = params
        .get("av_offset_ms")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0) as i32;

    let start_params = StartParams {
        profile,
        profile_name: profile_name.to_string(),
        channel_id,
        token,
        push_url,
        capture,
        audio,
        override_codec,
        override_bitrate_kbps: override_bitrate,
        override_fps,
        override_resolution,
        show_cursor,
        av_offset_ms,
    };

    let argv = StreamController::singleton().start(start_params)?;

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

fn parse_overrides(
    params: &Map<String, Value>,
) -> (Option<VideoCodec>, Option<u32>, Option<u32>, Option<(u32, u32)>) {
    let o = match params.get("overrides").and_then(Value::as_object) {
        Some(o) => o,
        None => return (None, None, None, None),
    };
    let codec = o.get("codec").and_then(Value::as_str).and_then(|s| match s {
        "h264" => Some(VideoCodec::H264),
        "hevc" => Some(VideoCodec::Hevc),
        "av1" => Some(VideoCodec::Av1),
        _ => None,
    });
    let bitrate = o.get("bitrate_kbps").and_then(Value::as_u64).map(|n| n as u32);
    let fps = o.get("fps").and_then(Value::as_u64).map(|n| n as u32);
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
    (codec, bitrate, fps, resolution)
}
