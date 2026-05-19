//! `state` — aktueller Stream-Status.
//!
//! Day-1-Stub: alles idle/null, identisch zur Linux-Variante wenn kein
//! Stream läuft.

use anyhow::Result;
use serde_json::{Map, Value, json};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    Ok(json_to_map(json!({
        "running": false,
        "state": "idle",
        "fps": null,
        "uptime_s": null,
        "argv": null,
    })))
}

fn json_to_map(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
