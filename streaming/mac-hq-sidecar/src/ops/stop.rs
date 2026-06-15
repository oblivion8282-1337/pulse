//! `stop` — end a running stream. Idempotent.
//!
//! Day-1 skeleton has no StreamController yet, so there's never a running stream
//! to stop → always the no-op response (same shape as the Linux sidecar):
//! `{"ok": true, "running": false, "note": "kein laufender Stream"}`.
//!
//! TODO(stage: capture): signal the StreamController, which stops the worker and
//! emits a `stopped` event. Note: unlike Windows, do NOT self-exit the process
//! here (see `main.rs`/`dispatch.rs`).

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
