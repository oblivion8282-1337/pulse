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
//! On macOS the encoder is VideoToolbox (always present on macOS 13+), so the
//! capability set is static for the Day-1 skeleton. The renderer's
//! `state.svelte.ts:59` flips `stream.gsrAvailable` on `gsr.available`, which
//! (together with `isMac()`) ungates the HQ-Stream button.
//!
//! TODO(stage: encode): probe VideoToolbox for the *actual* codec list
//! (`VTCopyVideoEncoderList`) and add "av1" only on Apple-Silicon M3+. Until
//! then we advertise the universally-available baseline (h264, hevc).

use anyhow::Result;
use serde_json::{Map, Value, json};

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
        "video_codecs": ["h264", "hevc"],
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
