//! `start` — begin a stream.
//!
//! Day-1 stub: validates nothing and returns a clear "not implemented" error so
//! the renderer surfaces a real message instead of a silent failure.
//!
//! TODO(stage: capture+encode): build an `SCContentFilter` from the `capture`
//! param, start an `SCStream` (video + system audio), feed `CVPixelBuffer`s into
//! a `VTCompressionSession` (h264/hevc), encode audio with libopus, mux to FLV
//! and push over RTMPS — see the crate README pipeline diagram. On success emit
//! `state: starting` → `state: live` + `fps` events and return the redacted argv
//! (same shape as `build_argv`). Preflight `CGPreflightScreenCaptureAccess()`
//! first and emit an `error` event if Screen-Recording permission is missing
//! (SCK otherwise delivers black frames silently).

use anyhow::{Result, bail};
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    bail!(
        "macOS HQ-Streaming ist noch nicht implementiert \
         (ScreenCaptureKit + VideoToolbox-Pipeline ausstehend — siehe \
         streaming/mac-hq-sidecar/README.md)."
    );
}
