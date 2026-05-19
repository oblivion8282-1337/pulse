//! `health` — Capability-Probe.
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
//! Available = there is at least one hardware adapter found via DXGI. The
//! renderer's `state.svelte.ts:59` flips `stream.gsrAvailable` on this, which
//! ungates the HQ-Stream button (further gated on `isLinux()` until we deploy
//! a web build that also lets Windows through — covered in a later session).
//!
//! `has_flv_patch` stays `null` until the FFmpeg-LGPL build with the Opus-FLV
//! patch lands (Stage 4 in the task list).

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::system::dxgi;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let adapters = dxgi::list_adapters().unwrap_or_default();
    let primary = adapters.first();

    let (available, source, vendor, video_codecs, path) = match primary {
        Some(a) => (
            true,
            "builtin", // Linux uses: env|flatpak|custom|system|missing
            Some(a.vendor()),
            a.supported_video_codecs(),
            std::env::current_exe()
                .ok()
                .and_then(|p| p.to_str().map(str::to_string)),
        ),
        None => (false, "missing", None, Vec::new(), None),
    };

    let mut gsr = json!({
        "available": available,
        "source": source,
        "is_flatpak": false,
        "display_server": "windows",
        "video_codecs": video_codecs,
        "capture_options": ["window", "monitor", "region"], // WGC kann alle drei
        "has_flv_patch": Value::Null,
    });
    if let Some(p) = path {
        gsr["path"] = Value::String(p);
    }
    if let Some(v) = vendor {
        gsr["vendor"] = Value::String(v.to_string());
    }

    let mut out = Map::new();
    out.insert("gsr".to_string(), gsr);
    Ok(out)
}
