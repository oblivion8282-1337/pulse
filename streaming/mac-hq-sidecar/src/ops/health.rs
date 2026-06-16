//! `health` — capability probe.
//!
//! Wire-form mirrors `gsr-sidecar/control.py::op_health`:
//!
//! ```jsonc
//! {"ok": true, "gsr": {"available": ..., "source": ..., "is_flatpak": ...,
//!                       "path": ..., "version": ..., "vendor": ...,
//!                       "display_server": ..., "video_codecs": [...],
//!                       "capture_options": [...], "has_flv_patch": ...}}
//! ```
//!
//! On macOS the encoder is VideoToolbox (always present on macOS 13+). The
//! `video_codecs` list is the *real* hardware-encodable set, probed by
//! [`crate::caps`] (h264/hevc baseline; av1 only on AV1-capable silicon + an
//! FFmpeg with `av1_videotoolbox`). The renderer's `state.svelte.ts` flips
//! `stream.gsrAvailable` on `gsr.available` (with `isMac()`) to ungate the
//! HQ-Stream button, and `gpuHasAv1(video_codecs)` to gate the codec choice.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::caps;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let path = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string));

    let mut gsr = json!({
        "available": true,
        "source": "builtin",
        "is_flatpak": false,
        "vendor": "apple",
        "display_server": "macos",
        // Actual hardware-encodable codecs (h264/hevc baseline; av1 only on
        // AV1-capable silicon + an FFmpeg with av1_videotoolbox).
        "video_codecs": caps::available_video_codecs(),
        // SCK can capture a display, a window or a region.
        "capture_options": ["display", "window", "region"],
        "has_flv_patch": Value::Null,
    });
    if let Some(p) = path {
        gsr["path"] = Value::String(p);
    }

    let mut out = Map::new();
    out.insert("gsr".to_string(), gsr);
    Ok(out)
}
