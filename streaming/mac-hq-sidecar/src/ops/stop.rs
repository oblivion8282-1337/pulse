//! `stop` — end the running stream. Idempotent.
//!
//! No running stream → `{"ok": true, "running": false, "note": "kein laufender
//! Stream"}` (same shape as the Linux sidecar). Otherwise signals the
//! StreamController, which stops capture, flushes the encoder and closes the
//! RTMP connection (the worker emits the `stopped` event). The macOS sidecar
//! does NOT self-exit after stop — it stays warm for the next stream.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::stream_controller::StreamController;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    // **Die Zwischenablage zuerst, und VOR der Abkuerzung darunter.**
    //
    // Der Windows-Sidecar beendet sich nach `stop`, und sein Prozessende gibt
    // die Zwischenablage frei. Hier stirbt nichts — ohne diesen Ruf hielte
    // dieser Prozess das Fach des Nutzers weiter beansprucht (also leer), bis
    // die ganze App endet. Es ist derselbe Augenblick, nur ohne Tod.
    //
    // Vor der Abkuerzung, weil die Ablage beansprucht sein kann, ohne dass der
    // StreamController gerade laeuft: der Anstoss `beginn` haengt an der
    // Fernsteuerungs-Sitzung, nicht am Stream. Idempotent — haelt dieser
    // Prozess nichts, tut der Ruf nichts.
    crate::ablage::beenden();
    // Und eine evtl. stehende Direkt-Sitzung: deren PeerConnection gehört
    // zum Prozess — ohne das bliebe der ICE-Socket offen. Idempotent gebaut:
    // ohne Direktpfad ein No-op (s. `crate::direct`, Zwilling win `ops/stop`).
    crate::direct::sitzung().beende_endgueltig();
    let ctrl = StreamController::singleton();
    if !ctrl.state().running {
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
