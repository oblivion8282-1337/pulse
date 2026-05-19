//! `list_application_audio` — Prozesse mit aktivem Audio-Output.
//!
//! Echte Implementation (Stage 2 / Day 1.5): WASAPI Session-Enum am Default-
//! Render-Endpoint → PIDs → `sysinfo` für Process-Namen. Wire-form gleich
//! Linux: `{ok: true, applications: ["chrome.exe", "Spotify.exe", ...]}`.

use anyhow::Result;
use serde_json::{Map, Value};

use crate::system::audio_sessions;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let names = audio_sessions::list_audio_application_names().unwrap_or_else(|e| {
        eprintln!("[hq-sidecar] list_application_audio failed: {e:#}");
        Vec::new()
    });
    let mut out = Map::new();
    out.insert(
        "applications".to_string(),
        Value::Array(names.into_iter().map(Value::String).collect()),
    );
    Ok(out)
}
