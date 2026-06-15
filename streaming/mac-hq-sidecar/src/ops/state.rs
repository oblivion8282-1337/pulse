//! `state` — current stream status.
//!
//! Shape (same as the other sidecars): `{ok, running, state, fps, uptime_s, argv}`.
//!
//! Day-1 skeleton has no StreamController, so it's always idle.
//!
//! TODO(stage: capture): return the StreamController's `StreamSnapshot`.

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    out.insert("running".to_string(), Value::Bool(false));
    out.insert("state".to_string(), Value::String("idle".to_string()));
    out.insert("fps".to_string(), Value::Null);
    out.insert("uptime_s".to_string(), Value::Null);
    out.insert("argv".to_string(), Value::Null);
    Ok(out)
}
