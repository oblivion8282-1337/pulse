//! `state` — current stream status.
//!
//! Shape (same as the other sidecars): `{ok, running, state, fps, uptime_s, argv}`,
//! read from the [`StreamController`] snapshot.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::stream_controller::StreamController;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let s = StreamController::singleton().state();
    // `Option`-Felder serialisieren als Null bei None, sonst Zahl bzw. Liste —
    // exakt die bisherige Hand-Auflistung (nicht-finite Zahlen inklusive).
    Ok(super::json_to_map(json!({
        "running": s.running,
        "state": s.state,
        "fps": s.fps,
        "uptime_s": s.uptime_s,
        "argv": s.argv_redacted,
    })))
}
