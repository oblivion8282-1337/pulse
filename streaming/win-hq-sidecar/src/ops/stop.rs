//! `stop` — laufenden Stream beenden.
//!
//! Idempotent: kein laufender Stream → `{"ok":true,"running":false,
//! "note":"kein laufender Stream"}` (wie Linux). Sonst signal an
//! `StreamController`, der den Worker stoppt und ein `stopped`-Event emittiert.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::stream_controller::StreamController;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let ctrl = StreamController::singleton();
    let snapshot = ctrl.state();
    if !snapshot.running {
        return Ok(json_to_map(json!({
            "running": false,
            "note": "kein laufender Stream",
        })));
    }
    ctrl.stop()?;
    Ok(Map::new())
}

fn json_to_map(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
