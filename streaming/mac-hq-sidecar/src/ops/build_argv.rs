//! `build_argv` — the FFmpeg argv that `start` would run.
//!
//! Diagnostic only: the renderer shows this in the stats/debug panel, it's not
//! parsed programmatically. The real macOS pipeline drives FFmpeg's
//! `*_videotoolbox` encoder + FLV mux + RTMPS push from API calls (it does not
//! exec an external ffmpeg), so this is a representative argv, not the literal
//! command line.
//!
//! Token redaction is mandatory (CLAUDE.md): the renderer must never receive the
//! raw stream key.

use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value, json};

use crate::profiles::{BASELINE, ServerProfile, profile_label};

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
    let token = channel.get("token").and_then(Value::as_str).unwrap_or_default();
    let push_url = channel.get("push_url").and_then(Value::as_str).map(str::to_string);
    let endpoint = channel
        .get("mediamtx_endpoint")
        .and_then(Value::as_str)
        .unwrap_or("howispulse.com");
    let push_protocol = channel
        .get("push_protocol")
        .and_then(Value::as_str)
        .unwrap_or("rtmp");

    let server =
        ServerProfile::from_channel(&channel_id, token, endpoint, push_protocol, push_url);

    let binary = "pulse-mac-hq-sidecar".to_string();
    let target = server
        .push_url
        .clone()
        .unwrap_or_else(|| {
            format!(
                "{}://{}:{}/{}",
                server.push_protocol, server.push_host, server.push_port, server.push_path
            )
        });

    let argv = vec![
        Value::String(binary.clone()),
        Value::String("--profile".to_string()),
        Value::String(profile_name.to_string()),
        Value::String("--codec".to_string()),
        Value::String(profile.codec.to_string()),
        Value::String("--fps".to_string()),
        Value::String(profile.fps.to_string()),
        Value::String("--bitrate".to_string()),
        Value::String(format!("{}k", profile.bitrate_kbps)),
        Value::String("--audio-codec".to_string()),
        Value::String(profile.audio_codec.to_string()),
        Value::String("--container".to_string()),
        Value::String(profile.container.to_string()),
        Value::String("--out".to_string()),
        // Token redaction (analogue of `streaming/gsr-sidecar/redact.py`).
        Value::String(crate::redact::redact_url(&target)),
    ];

    Ok(json_to_map(json!({
        "binary": binary,
        "argv": argv,
    })))
}

fn json_to_map(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
