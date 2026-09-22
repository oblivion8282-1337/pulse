//! Encoder baseline values.
//!
//! (Ponytail-Audit Runde 2, 2026-09-21: die ServerProfile-Push-URL-
//! Konstruktion war Linux-seitig nie verdrahtet — start.rs baut die Push-URL
//! aus den Raw-Parametern; das Mac-Twin hat seine eigene Fassung in
//! `mac-hq-sidecar/src/ops/build_argv.rs`.)

use serde_json::{Map, Value};

/// Codec/bitrate/fps/container baseline that unset overrides fall back to.
#[derive(Debug, Clone)]
pub struct StreamProfile {
    pub codec: &'static str,
    pub audio_codec: &'static str,
    pub container: &'static str,
    pub bitrate_kbps: u32,
    pub fps: u32,
}

// ── Baseline values ──────────────────────────────────────────────────────────
//
// Until 2026-07-19 this held a four-entry profile catalogue plus a
// `list_profiles` op. It never had a consumer, and all four entries carried the
// same 4000 kbps / 60 fps — the names implied gradations that did not exist.
// Full reasoning in `streaming/win-hq-sidecar/src/profiles.rs` in the main repo.
//
// What remains is the baseline that unset override fields fall back to; these
// are exactly the former "Custom" values.

pub static BASELINE: StreamProfile = StreamProfile {
    codec: "h264",
    audio_codec: "opus",
    container: "flv",
    bitrate_kbps: 4000,
    fps: 60,
};

/// The `profile` field of a `start`/`build_argv` request. Purely a label for the
/// diagnostic argv now — the encoder values come from [`BASELINE`] plus the
/// overrides. Still accepted because older renderers send it; its absence is not
/// an error.
pub fn profile_label(params: &Map<String, Value>) -> &str {
    params.get("profile").and_then(Value::as_str).unwrap_or("Custom")
}
