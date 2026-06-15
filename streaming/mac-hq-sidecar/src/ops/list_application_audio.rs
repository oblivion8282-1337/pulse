//! `list_application_audio` — apps with active audio output, for the
//! "exclude these apps from Desktop capture" picker.
//!
//! Shape (same as the other sidecars): `{ok, applications: [str, ...]}`.
//!
//! Day-1 stub: empty list.
//!
//! TODO(stage: audio): enumerate `SCShareableContent.current.applications`
//! (the same content query as `list_monitors`) and return the
//! `applicationName`s. SCK's audio capture can then exclude chosen bundle IDs
//! via `SCContentFilter` / `SCStreamConfiguration`, which is how we keep Pulse's
//! own voice playback out of a Desktop-audio capture (the macOS analogue of the
//! Windows WASAPI process-loopback EXCLUDE path; PULSE_SELF_PID is passed in by
//! `sidecar.ts`).

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    out.insert("applications".to_string(), Value::Array(vec![]));
    Ok(out)
}
