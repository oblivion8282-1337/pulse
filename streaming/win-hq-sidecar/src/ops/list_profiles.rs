//! `list_profiles` — Stream-/Server-/Audio-Mode-Katalog.
//!
//! 1:1 portiert aus `gsr-sidecar/control.py::op_list_profiles`. Shape:
//!
//! ```jsonc
//! {"ok": true,
//!  "profiles": [{name, codec, audio_codec, container, bitrate_kbps, fps,
//!                needs_custom_build, notes}, ...],
//!  "servers": [],
//!  "audio_modes": ["Aus", "Desktop", "Mikrofon", "Desktop + Mikrofon"],
//!  "app_label_prefix": "App: "}
//! ```

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::profiles::{APP_LABEL_PREFIX, AUDIO_MODES, PROFILES};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let profiles: Vec<Value> = PROFILES
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "codec": p.codec,
                "audio_codec": p.audio_codec,
                "container": p.container,
                "bitrate_kbps": p.bitrate_kbps,
                "fps": p.fps,
                "needs_custom_build": p.needs_custom_build,
                "notes": p.notes,
            })
        })
        .collect();

    let mut out = Map::new();
    out.insert("profiles".to_string(), Value::Array(profiles));
    // `servers` bleibt leer — Pulse streamt immer in einen Voice-Channel,
    // kein Server-Catalog. Shape-Compat mit dem Renderer-Type `GsrListProfiles`.
    out.insert("servers".to_string(), Value::Array(vec![]));
    out.insert(
        "audio_modes".to_string(),
        Value::Array(AUDIO_MODES.iter().map(|s| Value::String((*s).to_string())).collect()),
    );
    out.insert(
        "app_label_prefix".to_string(),
        Value::String(APP_LABEL_PREFIX.to_string()),
    );
    Ok(out)
}
