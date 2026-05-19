//! `start` — Stream starten.
//!
//! Parsed dieselbe Request-Shape wie auf Linux (`gsr-sidecar/control.py::op_start`):
//!
//! ```jsonc
//! {"op":"start", "profile":"H.264 Standard",
//!  "channel":{"id":"123","token":"…","push_url":"rtmps://…"},
//!  "capture":"portal"|"monitor"|"window"|"App: <name>",
//!  "audio":{"mode":"Aus|Desktop|Mikrofon|Desktop + Mikrofon","excluded_apps":[]},
//!  "overrides":{"codec":"h264","bitrate_kbps":4000,"fps":60,"resolution":"1080p"}?}
//! ```
//!
//! Returnt `{"ok":true, "argv":[…redactet…]}`, danach kommen via `events::emit`
//! die `state`/`fps`/`log`/`error`/`stopped`-Events.

use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value};

use crate::audio::AudioSource;
use crate::capture::CaptureSource;
use crate::encode::VideoCodec;
use crate::profiles::{APP_LABEL_PREFIX, profile_by_name};
use crate::stream_controller::{StartParams, StreamController};

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let profile_name = params
        .get("profile")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("profile (Name) ist Pflicht"))?;
    let profile = profile_by_name(profile_name)
        .ok_or_else(|| anyhow!("Unknown stream profile: {profile_name}"))?;

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
                "channel.push_url ist auf Windows Pflicht (media-svc reicht die rtmps://-URL durch)"
            )
        })?;

    let capture = parse_capture(&params)?;
    let audio = parse_audio(&params);
    let (override_codec, override_bitrate, override_fps, override_resolution) =
        parse_overrides(&params);

    let start_params = StartParams {
        profile,
        channel_id,
        token,
        push_url,
        capture,
        audio,
        override_codec,
        override_bitrate_kbps: override_bitrate,
        override_fps,
        override_resolution,
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
/// - `"portal"` (Default) → `PrimaryMonitor` (kein Portal-Picker auf Windows)
/// - `"monitor"` → `PrimaryMonitor` (Index 1 via `MonitorByIndex(1)` ist
///   alternativ aber primary reicht)
/// - `"window"` ohne weitere Felder → Fehler (Title fehlt)
/// - alles was mit `"Window: <title>"` anfängt → `WindowByTitle(title)`
fn parse_capture(params: &Map<String, Value>) -> Result<CaptureSource> {
    let raw = params
        .get("capture")
        .and_then(Value::as_str)
        .unwrap_or("portal");
    if let Some(title) = raw.strip_prefix("Window: ") {
        return Ok(CaptureSource::WindowByTitle(title.to_string()));
    }
    match raw {
        "portal" | "monitor" | "" => Ok(CaptureSource::PrimaryMonitor),
        other => Err(anyhow!("unsupported capture source: {other}")),
    }
}

/// `audio` aus dem Request → `AudioSource`. UI-Labels wie auf Linux:
/// `"Aus"`/`"Desktop"`/`"Mikrofon"`/`"Desktop + Mikrofon"`/`"App: <name>"`.
/// Die App-Variante schickt der Renderer mit dem Prozessnamen — die PID-
/// Auflösung passiert in Stage-6-WASAPI.
fn parse_audio(params: &Map<String, Value>) -> Option<AudioSource> {
    let mode = params
        .get("audio")
        .and_then(Value::as_object)
        .and_then(|o| o.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("Aus");
    match mode {
        "Aus" => None,
        "Desktop" => Some(AudioSource::DefaultDesktop),
        "Mikrofon" => Some(AudioSource::DefaultMicrophone),
        "Desktop + Mikrofon" => Some(AudioSource::DesktopPlusMicrophone),
        s if s.starts_with(APP_LABEL_PREFIX) => {
            // PID-Resolution würde hier passieren — Stage-7-Audio-Mux braucht
            // das. Day-1-Wire emittiert Audio noch nicht in den Stream, also
            // ignorieren wir die App-Wahl vorerst und fallen auf Desktop zurück.
            Some(AudioSource::DefaultDesktop)
        }
        _ => None,
    }
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
    // Auflösungs-Map konsistent zum Linux-Sidecar (`gsr-sidecar/stream_controller.py`):
    // "Native" → None (kein Downscale), sonst Standard-Streaming-Targets. Downscale-
    // only — Upscale auf größere als Capture-Resolution geht über die Pipeline
    // nicht (Pool ist auf Capture-Native allokiert).
    let resolution = o.get("resolution").and_then(Value::as_str).and_then(|s| match s {
        "1080p" => Some((1920u32, 1080u32)),
        "720p" => Some((1280u32, 720u32)),
        "480p" => Some((854u32, 480u32)),
        "Native" | "" => None,
        _ => None,
    });
    (codec, bitrate, fps, resolution)
}
