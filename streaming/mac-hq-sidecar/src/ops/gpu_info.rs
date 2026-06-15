//! `gpu_info` — GPU/encoder detail.
//!
//! Wire-form mirrors `gsr-sidecar`: `{ok, vendor, card_path, display_server,
//! video_codecs}`. On macOS there's no vendor branching (Apple GPU + the
//! unified VideoToolbox encoder), so this is static for the skeleton.
//!
//! TODO(stage: encode): query the Metal device
//! (`MTLCreateSystemDefaultDevice().name` / `supportsFamily:`) for the real
//! GPU name and AV1-encode capability (Apple-Silicon M3+).

use anyhow::Result;
use serde_json::{Map, Value, json};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    Ok(json_to_map(json!({
        "vendor": "apple",
        "card_path": Value::Null,
        "display_server": "macos",
        "video_codecs": ["h264", "hevc"],
    })))
}

fn json_to_map(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
