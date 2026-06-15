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

use crate::profiles::{ServerProfile, profile_by_name};

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
        Value::String(profile.name.to_string()),
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
        Value::String(redact_token_in_url(&target)),
    ];

    Ok(json_to_map(json!({
        "binary": binary,
        "argv": argv,
    })))
}

/// Mask `pass=`/`token=`/streamid tail in a push URL. Deliberately coarse — the
/// Linux variant uses a regex; this is enough for diagnostic output.
fn redact_token_in_url(url: &str) -> String {
    let patterns = ["pass=", "token=", "streamid=publish:"];
    let mut s = url.to_string();
    for pat in patterns {
        if let Some(idx) = s.find(pat) {
            let tail_start = idx + pat.len();
            let tail_end = s[tail_start..]
                .find(|c: char| c == '&' || c == ' ')
                .map(|i| tail_start + i)
                .unwrap_or(s.len());
            s.replace_range(tail_start..tail_end, "***");
        }
    }
    s
}

fn json_to_map(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
