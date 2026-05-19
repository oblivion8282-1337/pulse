//! `stop` — laufenden Stream beenden.
//!
//! Day-1-Stub: signalisiert „kein laufender Stream", wie das Linux-Sidecar
//! es tut wenn nichts läuft.

use anyhow::Result;
use serde_json::{Map, Value, json};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    Ok(json_to_map(json!({
        "running": false,
        "note": "kein laufender Stream",
    })))
}

fn json_to_map(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
