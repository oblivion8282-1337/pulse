//! `list_application_audio` — apps for the audio picker (specific-app capture +
//! the "exclude these apps from Desktop capture" list).
//!
//! Shape (same as the other sidecars): `{ok, applications: [str, ...]}`. Backed
//! by `capture::list_audio_applications()` (running apps with an on-screen
//! window). Errors (e.g. missing Screen-Recording permission) degrade to an
//! empty list rather than failing the op.

use anyhow::Result;
use serde_json::{Map, Value};

use crate::capture;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let apps = capture::list_audio_applications().unwrap_or_else(|e| {
        eprintln!("[mac-hq-sidecar] list_application_audio failed: {e:#}");
        Vec::new()
    });
    let mut out = Map::new();
    out.insert(
        "applications".to_string(),
        Value::Array(apps.into_iter().map(Value::String).collect()),
    );
    Ok(out)
}
