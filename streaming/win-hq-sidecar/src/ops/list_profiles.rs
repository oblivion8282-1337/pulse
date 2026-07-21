//! `list_profiles` — Encoder-Sockel + Audio-Modi fürs Renderer-Dropdown.
//!
//! Wire-form mirrors `gsr-sidecar/control.py::op_list_profiles`:
//!
//! ```jsonc
//! {"ok": true, "profiles": [{"name", "codec", "audio_codec", "container",
//!                             "bitrate_kbps", "fps", "needs_custom_build",
//!                             "notes"}], "servers": [], "audio_modes": [...],
//!  "app_label_prefix": "App: "}
//! ```
//!
//! Linux trägt (seit 2026-07-19, `profiles.rs`-Kommentar) nur noch den
//! Katalog-Schatten mit — echter Konsument ist keiner mehr, das HQ-Panel ist
//! channel-mode-only und holt `list_profiles` gar nicht erst. Windows hat nie
//! einen Vier-Profil-Katalog gehabt (nur `BASELINE`), spiegelt die Shape aber
//! trotzdem — falls der Renderer (oder ein künftiges Debug-Panel) den Op
//! plattformübergreifend aufruft.
//!
//! `servers` bleibt immer leer — Pulse streamt ausschließlich in
//! Voice-Channels, es gibt keinen Server-Katalog (mirror Linux).
//! `needs_custom_build=false`: anders als Linux (dessen `gpu-screen-recorder`
//! den Opus+FLV-Patch braucht) läuft der Windows-Sidecar mit einem
//! Standard-FFmpeg — kein Custom-Build nötig.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::profiles::{APP_LABEL_PREFIX, BASELINE};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let profile = json!({
        "name": "Custom",
        "codec": BASELINE.codec,
        "audio_codec": BASELINE.audio_codec,
        "container": BASELINE.container,
        "bitrate_kbps": BASELINE.bitrate_kbps,
        "fps": BASELINE.fps,
        "needs_custom_build": false,
        "notes": "Override-Sektion in der UI nutzen.",
    });

    let mut out = Map::new();
    out.insert("profiles".to_string(), Value::Array(vec![profile]));
    out.insert("servers".to_string(), Value::Array(Vec::new()));
    // Dieselben vier Labels wie `ops::start::parse_audio` versteht (+ die
    // dynamische `"App: <name>"`-Variante, die hier nicht als Katalogeintrag
    // auftaucht — analog Linux' `AUDIO_MODES`, das die App-Variante auch nicht
    // listet).
    out.insert(
        "audio_modes".to_string(),
        json!(["Aus", "Desktop", "Mikrofon", "Desktop + Mikrofon"]),
    );
    out.insert(
        "app_label_prefix".to_string(),
        Value::String(APP_LABEL_PREFIX.to_string()),
    );
    Ok(out)
}
