//! `stop` — end the running stream. Idempotent.
//!
//! No running stream → `{"ok": true, "running": false, "note": "kein laufender
//! Stream"}` (same shape as the Linux sidecar). Otherwise signals the
//! StreamController, which stops capture, flushes the encoder and closes the
//! RTMP connection (the worker emits the `stopped` event). Der Linux-Sidecar
//! self-exit'et nicht nach stop — er bleibt warm für den nächsten Stream.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::stream_controller::StreamController;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let ctrl = StreamController::singleton();
    if !ctrl.state().running {
        return Ok(super::json_to_map(json!({
            "running": false,
            "note": "kein laufender Stream",
        })));
    }
    ctrl.stop()?;
    // Gleiche Shape wie der Idempotenz-Zweig — der Parent muss `running` nicht
    // je nach Pfad mal lesen können und mal nicht.
    Ok(super::json_to_map(json!({ "running": false })))
}
