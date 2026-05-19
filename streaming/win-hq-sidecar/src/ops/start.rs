//! `start` — Stream starten.
//!
//! Stage 5-8: Capture (windows-capture WGC) + Audio (wasapi Process-Loopback) +
//! Encode (ffmpeg-next NVENC/AMF/QSV) + Mux (FLV) + Push (RTMPS).
//!
//! Day-1-Stub: signalisiert sauberen „nicht verfügbar"-Fehler.

use anyhow::{Result, bail};
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    bail!("start not yet implemented — Stages 5-8 of WINDOWS_HQ_SIDECAR.md");
}
