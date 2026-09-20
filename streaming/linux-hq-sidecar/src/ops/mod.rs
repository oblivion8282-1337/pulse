//! Op handlers — one module per JSON-RPC op.
//!
//! Every handler is a free function `fn handle(params) -> Result<Map>`. Sync.
//!
//! Implementierungs-Status (Roadmap siehe Plan):
//!
//! | Op                     | Status          | Bemerkung                                |
//! |------------------------|-----------------|-----------------------------------------|
//! | health                 | real            | DRM-Vendor + VAAPI/NVENC-Open-Probe     |
//! | gpu_info               | real            | DRM-Vendor + `caps`-Codec-Probe         |
//! | list_monitors          | stub (`[]`)     | Linux wählt die Quelle im Portal-Dialog |
//! | list_windows           | stub (`[]`)     | dito; Fenster wählt der Portal-Dialog   |
//! | list_application_audio | real            | PipeWire-Node-Enumeration               |
//! | build_argv             | real            | diagnostic argv (token-redacted)        |
//! | start                  | real            | PipeWire + VAAPI/NVENC + RTMPS (Ph. 5)  |
//! | stop                   | real            | StreamController, idempotent            |
//! | state                  | real            | StreamController snapshot               |

pub mod build_argv;
pub mod gpu_info;
pub mod health;
pub mod keyframe;
pub mod list_application_audio;
pub mod list_monitors;
pub mod list_windows;
pub mod start;
pub mod state;
pub mod stop;

use serde_json::{Map, Value};

/// Flatten a `json!({...})` object into the field-map an op handler returns.
/// A non-object (never produced by the handlers) yields an empty map.
pub(crate) fn json_to_map(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
