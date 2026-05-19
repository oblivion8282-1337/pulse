//! `state` — aktueller Stream-Status.
//!
//! Returnt einen `StreamSnapshot` aus dem `StreamController`. Form wie Linux:
//! `{ok, running, state, fps, uptime_s, argv}`.

use anyhow::Result;
use serde_json::{Map, Value};

use crate::stream_controller::StreamController;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let s = StreamController::singleton().state();
    let mut out = Map::new();
    out.insert("running".to_string(), Value::Bool(s.running));
    out.insert("state".to_string(), Value::String(s.state.to_string()));
    out.insert(
        "fps".to_string(),
        s.fps
            .and_then(|f| serde_json::Number::from_f64(f).map(Value::Number))
            .unwrap_or(Value::Null),
    );
    out.insert(
        "uptime_s".to_string(),
        s.uptime_s
            .and_then(|u| serde_json::Number::from_f64(u).map(Value::Number))
            .unwrap_or(Value::Null),
    );
    out.insert(
        "argv".to_string(),
        match s.argv_redacted {
            Some(v) => Value::Array(v.into_iter().map(Value::String).collect()),
            None => Value::Null,
        },
    );
    Ok(out)
}
