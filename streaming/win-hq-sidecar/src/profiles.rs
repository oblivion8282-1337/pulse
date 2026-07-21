//! Encoder-Sockelwerte (`BASELINE`) + `profile`-Etikett.
//!
//! Die Push-URL kommt IMMER fertig aus dem `start`-Request (`push_url`,
//! media-svc mintet sie inkl. Token) — `ops/start.rs::parse_start_params`
//! verlangt sie als Pflichtfeld. Eine URL-Rekonstruktion à la Linux
//! (`profiles.py::ServerProfile.from_channel`) gab es hier nur als nie
//! angeschlossenes Day-1-Skelett; entfernt 2026-07-21.

use serde_json::{Map, Value};

/// Codec/Bitrate/FPS/Container-Sockel, auf den nicht gesetzte Overrides fallen.
#[derive(Debug, Clone)]
pub struct StreamProfile {
    pub codec: &'static str,
    pub audio_codec: &'static str,
    pub container: &'static str,
    pub bitrate_kbps: u32,
    pub fps: u32,
}

// ── Basiswerte ──────────────────────────────────────────────────────────────
//
// Bis 2026-07-19 stand hier ein vierteiliger Profil-Katalog ("AV1 Effizient",
// "H.264 Standard", "H.264 Sparmodus", "Custom") plus eine `list_profiles`-Op.
// Der Katalog hatte nie einen Konsumenten: das HQ-Panel ist channel-mode-only
// und setzt hart `profile_name='Custom'` + `use_overrides=true`
// (`web/src/lib/stream/settings.svelte.ts`), holt `listProfiles` also gar nicht
// erst. Zudem trugen alle vier Einträge dieselben 4000 kbps / 60 fps — die
// Namen suggerierten Abstufungen, die es nie gab.
//
// Was bleibt, ist der Sockel: `buildStartArgs` schickt Overrides nur für
// *ausgefüllte* Felder, ein leeres Feld fällt bewusst auf diesen Default
// zurück. Die Werte sind exakt die des früheren "Custom"-Eintrags — dieselbe
// Konfiguration, nur ohne die Attrappe drumherum.

pub static BASELINE: StreamProfile = StreamProfile {
    codec: "h264",
    audio_codec: "opus",
    container: "flv",
    bitrate_kbps: 4000,
    fps: 60,
};

/// Das `profile`-Feld aus `start`/`build_argv` ist seit dem Wegfall des Katalogs
/// ein reines Etikett: es landet in der Diagnose-argv, wählt aber nichts mehr
/// aus. Ältere Renderer schicken es weiter mit — sein Fehlen ist kein Fehler.
pub fn profile_label(params: &Map<String, Value>) -> &str {
    params.get("profile").and_then(Value::as_str).unwrap_or("Custom")
}

pub const APP_LABEL_PREFIX: &str = "App: ";
