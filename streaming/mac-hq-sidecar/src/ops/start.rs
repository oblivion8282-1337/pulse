//! `start` — begin a capture→encode→push stream.
//!
//! Resolves the request (profile + overrides + capture source + push_url) into
//! [`StartParams`] and hands it to the [`StreamController`], which runs the
//! ScreenCaptureKit → VideoToolbox → FLV/RTMPS pipeline on a worker thread and
//! emits `state`/`fps`/`stopped` events. Returns the redacted argv (same shape
//! as `build_argv`). Preflight of Screen-Recording permission happens implicitly
//! in the capture content query — a missing grant surfaces as an `error` event.

use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value};

use crate::capture::{self, AudioScope};
use crate::profiles::{BASELINE, profile_label};
use crate::stream_controller::{StartParams, StreamController};

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let profile_name = profile_label(&params);
    let profile = &BASELINE;

    let channel = params
        .get("channel")
        .and_then(Value::as_object)
        .context("channel ist Pflicht (Pulse streamt immer in einen Voice-Channel)")?;
    let push_url = channel
        .get("push_url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow!("channel.push_url ist Pflicht (media-svc reicht die rtmps://-URL durch)")
        })?;

    let capture_src = params.get("capture").and_then(Value::as_str).unwrap_or("display:1");
    let window_id = parse_window_id(capture_src);
    let display_index = parse_display_index(capture_src);

    let overrides = params.get("overrides").and_then(Value::as_object);
    let codec = overrides
        .and_then(|o| o.get("codec"))
        .and_then(Value::as_str)
        .unwrap_or(profile.codec)
        .to_string();
    let fps = overrides
        .and_then(|o| o.get("fps"))
        .and_then(Value::as_u64)
        .unwrap_or(profile.fps as u64)
        .clamp(1, 120) as u32;
    let bitrate_kbps = overrides
        .and_then(|o| o.get("bitrate_kbps"))
        .and_then(Value::as_u64)
        .unwrap_or(profile.bitrate_kbps as u64) as u32;
    let show_cursor = params.get("show_cursor").and_then(Value::as_bool).unwrap_or(true);
    // Manual A/V trim from the UI slider (>0 = audio later); clamped to ±1000ms.
    let av_offset_ms = params
        .get("av_offset_ms")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(-1000, 1000) as i32;

    // Audio: parse `audio.{mode, excluded_apps}` into a capture scope.
    //   "App: <name>"            → only that app's audio (and its windows as video)
    //   "Desktop"/"Desktop + …"  → desktop audio, minus Pulse (echo) + excluded_apps
    //   "Aus" / "Mikrofon"-only  → no audio (mic needs an AVCaptureSession path, TBD)
    let audio_obj = params.get("audio").and_then(Value::as_object);
    let audio_mode = audio_obj
        .and_then(|a| a.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("Aus");
    let excluded_apps: Vec<String> = audio_obj
        .and_then(|a| a.get("excluded_apps"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let (enable_audio, audio_scope) = if let Some(app) = audio_mode.strip_prefix("App: ") {
        (true, AudioScope::App(app.trim().to_string()))
    } else if audio_mode.contains("Desktop") {
        (true, AudioScope::Desktop { exclude: excluded_apps })
    } else {
        (false, AudioScope::None)
    };

    let (width, height) = resolve_resolution(overrides, display_index)?;

    let argv = build_redacted_argv(
        &push_url,
        profile_name,
        &codec,
        fps,
        bitrate_kbps,
        width,
        height,
    );

    StreamController::singleton().start(
        StartParams {
            display_index,
            window_id,
            width,
            height,
            fps,
            bitrate_kbps,
            codec,
            push_url,
            show_cursor,
            enable_audio,
            audio_scope,
            av_offset_ms,
        },
        argv.clone(),
    )?;

    let mut out = Map::new();
    out.insert(
        "argv".to_string(),
        Value::Array(argv.into_iter().map(Value::String).collect()),
    );
    Ok(out)
}

/// Extract a 1-based display index from the capture string. Accepts
/// `"display:<n>"`, `"Monitor: <n>"`, `"portal"` (→ 1), etc.
fn parse_display_index(capture: &str) -> usize {
    let digits: String = capture.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<usize>().unwrap_or(1).max(1)
}

/// A `"window:<cg-window-id>"` capture token selects a single window. Anything
/// else (display/monitor/portal) returns None → display capture.
fn parse_window_id(capture: &str) -> Option<u32> {
    capture.strip_prefix("window:")?.trim().parse::<u32>().ok()
}

/// h264/hevc require even dimensions.
fn even(n: u32) -> u32 {
    n & !1
}

fn resolve_resolution(
    overrides: Option<&Map<String, Value>>,
    display_index: usize,
) -> Result<(u32, u32)> {
    if let Some(res) = overrides
        .and_then(|o| o.get("resolution"))
        .and_then(Value::as_str)
    {
        if let Some((w, h)) = res.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) {
                if w > 0 && h > 0 {
                    return Ok((even(w), even(h)));
                }
            }
        }
    }
    // Default to the chosen display's native size.
    if let Ok(displays) = capture::list_displays() {
        let idx = if display_index >= 1 && display_index <= displays.len() {
            display_index - 1
        } else {
            0
        };
        if let Some(d) = displays.get(idx) {
            if d.width > 0 && d.height > 0 {
                return Ok((even(d.width as u32), even(d.height as u32)));
            }
        }
    }
    Ok((1920, 1080))
}

fn build_redacted_argv(
    push_url: &str,
    profile_name: &str,
    codec: &str,
    fps: u32,
    bitrate_kbps: u32,
    width: u32,
    height: u32,
) -> Vec<String> {
    vec![
        "pulse-mac-hq-sidecar".to_string(),
        "--profile".to_string(),
        profile_name.to_string(),
        "--codec".to_string(),
        codec.to_string(),
        "--size".to_string(),
        format!("{width}x{height}"),
        "--fps".to_string(),
        fps.to_string(),
        "--bitrate".to_string(),
        format!("{bitrate_kbps}k"),
        "--out".to_string(),
        crate::redact::redact_url(push_url),
    ]
}
