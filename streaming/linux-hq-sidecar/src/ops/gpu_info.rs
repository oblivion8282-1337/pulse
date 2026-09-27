//! `gpu_info` — GPU-Vendor + Codec-Set.
//!
//! Echte DRM-Vendor-Erkennung (`system::drm`: sysfs renderD*/driver →
//! nvidia/amd/intel) + Render-Node-Pfad (`card_path`). Codecs aus der echten
//! Open-Probe (`caps::gemeldete_video_codecs` — Phase 4 ist gelandet): pro
//! Kandidat wird der Hardware-Encoder über das gelinkte FFmpeg geöffnet, nur
//! was aufgeht, gilt als verfügbar. Hat die Probe noch kein definitives
//! Ergebnis (Sidecar frisch gestartet, GPU-Reset), bleibt `video_codecs`
//! WEG — „fehlend" heißt „unbekannt", nicht „nichts" (Begründung:
//! `caps::gemeldete_video_codecs`).
//! Shape wie die anderen Sidecars: `{ok, vendor, card_path, display_server, video_codecs}`.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::caps;
use crate::system::drm;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let (vendor, card_path) = match drm::detect() {
        Some((v, path)) => (Value::String(v.slug().to_string()), Value::String(path)),
        None => (Value::String("unknown".to_string()), Value::Null),
    };

    let mut out = super::json_to_map(json!({
        "vendor": vendor,
        "card_path": card_path,
        "display_server": std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
    }));
    if let Some(codecs) = caps::gemeldete_video_codecs() {
        out.insert("video_codecs".to_string(), json!(codecs));
    }
    Ok(out)
}
