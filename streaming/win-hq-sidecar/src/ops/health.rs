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

use crate::encode::{VideoCodec, auffrischung};
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

    // Zusatzfelder gegenüber Python/mac, gleiche Namen wie im Linux-Sidecar.
    // Ältere Sidecars melden sie nicht — Konsumenten lesen `undefined` als
    // `false` (`web/src/lib/stream/state.svelte.ts`).
    //
    // `ten_bit` hängt am AV1-Zero-Copy-Weg (P010-Pool + `bitdepth=10` an
    // `av1_amf`), nicht am Codec allein; `intra_refresh` daran, ob der Encoder,
    // der bei dieser Kombination WIRKLICH läuft, die Betriebsart trägt — auf
    // AMD ist das AV1, nicht H.264 (`encode::auffrischung`).
    let ten_bit = vendor.is_some_and(|v| {
        video_codecs.iter().any(|c| {
            VideoCodec::from_slug(c).supports_ten_bit()
                && auffrischung::encoder_name(v, VideoCodec::from_slug(c), "").is_some()
        })
    });
    let intra_refresh = vendor.is_some_and(|v| auffrischung::verfuegbar(v, &video_codecs));

    let mut gsr = json!({
        "available": available,
        "source": source,
        "is_flatpak": false,
        "display_server": "windows",
        "video_codecs": video_codecs,
        "capture_options": ["window", "monitor", "region"], // WGC kann alle drei
        "has_flv_patch": Value::Null,
        "ten_bit": ten_bit,
        "intra_refresh": intra_refresh,
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
