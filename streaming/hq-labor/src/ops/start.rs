//! `start` — begin a capture→encode→push stream.
//!
//! Löst den Request (profile + overrides + capture source + push_url) auf.
//! `channel.push_url` (von media-svc, Token drin) ist verbindlich — Pulse
//! streamt immer in einen Voice-Channel. Der Linux-Capture-Default ist `"portal"`
//! (Wayland-Portal-Dialog wählt die Quelle), wie beim Python-GSR-Sidecar.
//!
//! Wire-Format (gleich wie Python-Sidecar / win / mac, gebaut von
//! `web/src/lib/stream/settings.svelte.ts::buildStartArgs`):
//! - `overrides.fps`: 1..=1000 (Frontend clampt zusätzlich auf den Admin-Deckel)
//! - `overrides.resolution`: Token (`Native`/`4K`/`1440p`/`1080p`/`720p`/`480p`)
//!   oder literal `WxH`
//! - `show_cursor`: bool (top-level), default true
//! - `audio.mode`: `Aus`/`Desktop`/`Mikrofon`/`Desktop + Mikrofon`/`App: <name>`
//! - `audio.excluded_apps`: nur für Desktop-Modi relevant (Pulse selbst wird
//!   IMMER zusätzlich ausgeschlossen — Echo-Schutz, siehe `AudioSelection`)

use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value};

use crate::capture::audio::AudioSelection;
use crate::profiles::{BASELINE, profile_label};
use crate::stream_controller::{ResolutionRequest, StartParams, StreamController};

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let profile_name = profile_label(&params);
    let profile = &BASELINE;

    let channel = params
        .get("channel")
        .and_then(Value::as_object)
        .context("channel ist Pflicht (Pulse streamt immer in einen Voice-Channel)")?;
    let push_url = channel
        .get("push_url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow!("channel.push_url ist Pflicht (media-svc reicht die rtmps://- bzw. WHIP-URL durch)")
        })?;

    let overrides = params.get("overrides").and_then(Value::as_object);
    let requested_codec = overrides
        .and_then(|o| o.get("codec"))
        .and_then(Value::as_str)
        .unwrap_or(profile.codec)
        .to_string();
    // Codec-Wahl mit zwei Sicherheitsnetzen, Reihenfolge fest:
    // 1. Kann die HW den gewünschten Codec nicht encodieren, auf H.264 zurück-
    //    fallen statt den Encoder-open crashen zu lassen. Die UI bietet AV1 auf
    //    solcher HW zwar gar nicht erst an (der `health`-Report filtert über
    //    dieselbe Probe), aber ein veralteter Client / Direktaufruf käme sonst
    //    zum harten Fehler. Geht auch H.264 nicht, bleibt der Wunsch stehen →
    //    echter, ehrlicher Encoder-Fehler.
    let codec = if crate::caps::supports_codec(&requested_codec) {
        requested_codec
    } else if crate::caps::supports_codec("h264") {
        tracing::warn!(
            target: "stream", requested = %requested_codec,
            "Codec von der HW nicht encodierbar → Fallback auf h264"
        );
        "h264".to_string()
    } else {
        requested_codec
    };
    // 10 bit ist an AV1 GEBUNDEN und hängt an der Hardware. Reihenfolge der
    // Absagen (jede mit Log, damit „warum sind es 8 bit" beantwortbar bleibt):
    // H.264 → die 10-bit-Variante wäre `High 10`, die kein Browser dekodiert
    // (der WHEP-Rückfall im Web ist ein `<video>`); danach die HW-Probe. Weil
    // der Codec oben schon auf h264 zurückgefallen sein kann (fehlendes AV1),
    // erledigt derselbe Zweig auch diesen Fall.
    let wants_ten_bit = requested_ten_bit(overrides);
    let ten_bit = wants_ten_bit && ten_bit_possible(&codec);
    if wants_ten_bit && !ten_bit {
        log_ten_bit_refusal(&codec);
    }
    let fps = overrides
        .and_then(|o| o.get("fps"))
        .and_then(Value::as_u64)
        .unwrap_or(profile.fps as u64)
        .clamp(1, 1000) as u32;
    let bitrate_kbps = effective_bitrate(
        overrides
            .and_then(|o| o.get("bitrate_kbps"))
            .and_then(Value::as_u64),
        profile.bitrate_kbps,
    );
    let av_offset_ms = params
        .get("av_offset_ms")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(-1000, 1000) as i32;
    let show_cursor = params
        .get("show_cursor")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let audio_obj = params.get("audio").and_then(Value::as_object);
    let audio_mode = audio_obj
        .and_then(|a| a.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("Aus");
    let excluded_apps: Vec<String> = audio_obj
        .and_then(|a| a.get("excluded_apps"))
        .and_then(Value::as_array)
        .map(|xs| {
            xs.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let audio = AudioSelection::parse(audio_mode, excluded_apps);
    if audio_mode.trim() == "Desktop + Mikrofon" {
        tracing::warn!(
            target: "stream",
            "audio: 'Desktop + Mikrofon' — Mikrofon-Mix noch nicht implementiert, es wird nur Desktop gestreamt"
        );
    }

    let resolution = ResolutionRequest::parse(
        overrides
            .and_then(|o| o.get("resolution"))
            .and_then(Value::as_str),
    );

    let argv = build_redacted_argv(
        &push_url,
        profile_name,
        &codec,
        fps,
        bitrate_kbps,
        &resolution,
        show_cursor,
        audio_mode,
        ten_bit,
    );

    StreamController::singleton().start(
        StartParams {
            codec,
            fps,
            bitrate_kbps,
            push_url,
            audio,
            av_offset_ms,
            show_cursor,
            resolution,
            ten_bit,
        },
        argv.clone(),
    )?;

    let mut out = Map::new();
    out.insert(
        "argv".to_string(),
        Value::Array(argv.into_iter().map(Value::String).collect()),
    );
    Ok(out)
}

/// Wunsch aus dem Wire-Format lesen: `overrides.bit_depth` = 8|10. Alles
/// andere (fehlend, 8, Unsinn) heißt 8 bit — ein unbekannter Wert darf nie
/// versehentlich 10 bit einschalten.
pub(crate) fn requested_ten_bit(overrides: Option<&Map<String, Value>>) -> bool {
    overrides
        .and_then(|o| o.get("bit_depth"))
        .and_then(Value::as_u64)
        == Some(10)
}

/// Ist der 10-bit-Wunsch bei diesem Codec und dieser Hardware erfüllbar?
///
/// Bewusst OHNE Logging: `build_argv` ruft dieselbe Entscheidung nur zum
/// Anzeigen auf, und ein Diagnose-Panel darf keine Warnungen ins Log schreiben.
/// Die Absage protokolliert der `start`-Pfad (s. [`log_ten_bit_refusal`]).
pub(crate) fn ten_bit_possible(codec: &str) -> bool {
    codec == "av1" && crate::caps::supports_ten_bit()
}

#[cfg(test)]
mod bit_depth_tests {
    use super::requested_ten_bit;
    use serde_json::json;

    fn overrides(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        v.as_object().unwrap().clone()
    }

    /// Nur die exakte 10 schaltet 10 bit ein. Alles andere — fehlend, 8, ein
    /// String, eine unbekannte Tiefe aus einem neueren Client — muss auf 8 bit
    /// landen: 10 bit ist an AV1 gebunden und darf nie versehentlich anliegen.
    #[test]
    fn nur_exakt_zehn_schaltet_ein() {
        assert!(requested_ten_bit(Some(&overrides(json!({"bit_depth": 10})))));
        assert!(!requested_ten_bit(Some(&overrides(json!({"bit_depth": 8})))));
        assert!(!requested_ten_bit(Some(&overrides(json!({"bit_depth": "10"})))));
        assert!(!requested_ten_bit(Some(&overrides(json!({"bit_depth": 12})))));
        assert!(!requested_ten_bit(Some(&overrides(json!({"fps": 60})))));
        assert!(!requested_ten_bit(None));
    }
}

/// Warum aus dem 10-bit-Wunsch nichts wurde — nur im echten `start`-Pfad.
fn log_ten_bit_refusal(codec: &str) {
    if codec != "av1" {
        tracing::warn!(
            target: "stream", codec,
            "10 bit nur mit AV1 (H.264-10-bit = High 10, im Browser nicht dekodierbar) → 8 bit"
        );
    } else {
        tracing::warn!(target: "stream", "10 bit von dieser Hardware nicht encodierbar → 8 bit");
    }
}

/// `overrides.bitrate_kbps` in einen sinnvollen Bereich zwingen. Ohne Clamp
/// verstümmelt der `as u32`-Cast Werte > u32::MAX modulo (2^32+500 → 500,
/// 2^32 → 0 kbps) — ein kaputt konfigurierter/veralteter Client bekäme einen
/// unbrauchbaren Stream statt eines klaren Werts. 1 Gbit/s deckt jedes reale
/// Profil (Profile liegen bei 4000).
pub(crate) fn effective_bitrate(requested: Option<u64>, profile_default: u32) -> u32 {
    requested
        .filter(|&v| v > 0)
        .unwrap_or(profile_default as u64)
        .clamp(1, 1_000_000) as u32
}

#[cfg(test)]
mod bitrate_tests {
    use super::effective_bitrate;

    #[test]
    fn clamps_instead_of_truncating() {
        assert_eq!(effective_bitrate(Some(4000), 8000), 4000);
        // Kein Modulo-Wrap: 2^32 darf nicht zu 0, 2^32+500 nicht zu 500 werden.
        assert_eq!(effective_bitrate(Some(1 << 32), 8000), 1_000_000);
        assert_eq!(effective_bitrate(Some((1 << 32) + 500), 8000), 1_000_000);
        assert_eq!(effective_bitrate(Some(u64::MAX), 8000), 1_000_000);
    }

    #[test]
    fn zero_and_missing_fall_back_to_profile() {
        // Explizite 0 hieß nie „1 kbps" — sie fällt aufs Profil zurück
        // (beim Python-Sidecar war 0 „Encoder-Default").
        assert_eq!(effective_bitrate(Some(0), 4000), 4000);
        assert_eq!(effective_bitrate(None, 4000), 4000);
    }
}

#[allow(clippy::too_many_arguments)]
fn build_redacted_argv(
    push_url: &str,
    profile_name: &str,
    codec: &str,
    fps: u32,
    bitrate_kbps: u32,
    resolution: &ResolutionRequest,
    show_cursor: bool,
    audio_mode: &str,
    ten_bit: bool,
) -> Vec<String> {
    vec![
        "pulse-linux-hq-sidecar".to_string(),
        "--profile".to_string(),
        profile_name.to_string(),
        "--codec".to_string(),
        codec.to_string(),
        "--bit-depth".to_string(),
        if ten_bit { "10" } else { "8" }.to_string(),
        "--size".to_string(),
        resolution.to_string(),
        "--fps".to_string(),
        fps.to_string(),
        "--bitrate".to_string(),
        format!("{bitrate_kbps}k"),
        "--cursor".to_string(),
        if show_cursor { "yes" } else { "no" }.to_string(),
        "--audio".to_string(),
        audio_mode.to_string(),
        "--out".to_string(),
        crate::redact::redact_url(push_url),
    ]
}
