//! `build_argv` — baut die diagnostische Argumentliste OHNE zu starten.
//!
//! Wie bei den anderen Sidecars rein diagnostisch: der Renderer zeigt die
//! argv in einem Stats-Panel. Die echte Pipeline (Phase 5) treibt FFmpeg per
//! API-Aufrufen, nicht indem sie diese argv exec't — sie ist eine
//! *repräsentative* argv, kein literal command line. Token-redacted.
//!
//! Shape: `{ok, binary, argv}`.

use anyhow::{Result, anyhow};
use serde_json::{Map, Value};

use crate::profiles::{BASELINE, profile_label};
use crate::redact::redact_url;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let profile_name = profile_label(&params);
    let profile = &BASELINE;

    let channel = params
        .get("channel")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("channel ist Pflicht"))?;
    let push_url = channel
        .get("push_url")
        .and_then(Value::as_str)
        .unwrap_or("");

    let overrides = params.get("overrides").and_then(Value::as_object);
    let codec = overrides
        .and_then(|o| o.get("codec"))
        .and_then(Value::as_str)
        .unwrap_or(profile.codec);
    // Gleiche Normalisierung wie `start` — die Diagnose-argv soll den Befehl
    // zeigen, der WIRKLICH liefe (nicht `--fps 99999` / `--bitrate 0k`).
    let fps = overrides
        .and_then(|o| o.get("fps"))
        .and_then(Value::as_u64)
        .unwrap_or(profile.fps as u64)
        .clamp(1, 1000);
    let bitrate_kbps = crate::ops::start::effective_bitrate(
        overrides
            .and_then(|o| o.get("bitrate_kbps"))
            .and_then(Value::as_u64),
        profile.bitrate_kbps,
    );
    let resolution = overrides
        .and_then(|o| o.get("resolution"))
        .and_then(Value::as_str)
        .unwrap_or("Native");
    let capture = params.get("capture").and_then(Value::as_str).unwrap_or("portal");
    let audio_mode = params
        .get("audio")
        .and_then(|a| a.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("Aus");

    // Wie bei fps/bitrate: die angezeigte Tiefe ist die, die `start` WIRKLICH
    // nähme (10 bit verfällt ohne AV1 bzw. ohne passende Hardware).
    let ten_bit = crate::ops::start::requested_ten_bit(overrides)
        && crate::ops::start::ten_bit_possible(codec);

    let argv = build_argv(
        profile_name,
        codec,
        fps as u32,
        bitrate_kbps,
        resolution,
        capture,
        audio_mode,
        push_url,
        ten_bit,
    );

    let mut out = Map::new();
    out.insert("binary".to_string(), Value::String("pulse-linux-hq-sidecar".to_string()));
    out.insert(
        "argv".to_string(),
        Value::Array(argv.into_iter().map(Value::String).collect()),
    );
    Ok(out)
}

#[cfg(test)]
mod clamp_tests {
    use super::handle;
    use serde_json::json;

    /// Die Diagnose-argv muss dieselben Normalisierungen zeigen wie `start`
    /// sie anwenden würde — sonst zeigt das Stats-Panel einen Befehl
    /// (`--fps 99999`, `--bitrate 0k`), der so nie liefe.
    #[test]
    fn argv_shows_normalized_values() {
        let params = json!({
            "profile": "H.264 Standard",
            "channel": {"push_url": "rtmps://h/x?pass=S"},
            "overrides": {"fps": 99999, "bitrate_kbps": 0}
        });
        let out = handle(params.as_object().unwrap().clone()).unwrap();
        let argv: Vec<String> = out["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let arg_after = |flag: &str| {
            let i = argv.iter().position(|a| a == flag).unwrap();
            argv[i + 1].clone()
        };
        assert_eq!(arg_after("--fps"), "1000", "fps muss wie in start geclampt sein");
        assert_eq!(arg_after("--bitrate"), "4000k", "bitrate 0 muss aufs Profil zurückfallen");
        assert_eq!(arg_after("--bit-depth"), "8", "ohne Wunsch bleibt es 8 bit");
    }

    /// 10 bit ist an AV1 gebunden — bei H.264 darf die Diagnose-argv keine
    /// 10 bit zeigen, weil `start` sie dort auch nicht nähme.
    #[test]
    fn zehn_bit_verfaellt_ohne_av1() {
        let params = json!({
            "channel": {"push_url": "rtmps://h/x"},
            "overrides": {"codec": "h264", "bit_depth": 10}
        });
        let out = handle(params.as_object().unwrap().clone()).unwrap();
        let argv: Vec<String> = out["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let i = argv.iter().position(|a| a == "--bit-depth").unwrap();
        assert_eq!(argv[i + 1], "8");
    }
}

#[allow(clippy::too_many_arguments)]
fn build_argv(
    profile: &str,
    codec: &str,
    fps: u32,
    bitrate_kbps: u32,
    resolution: &str,
    capture: &str,
    audio_mode: &str,
    push_url: &str,
    ten_bit: bool,
) -> Vec<String> {
    let argv = vec![
        "pulse-linux-hq-sidecar".to_string(),
        "--profile".to_string(),
        profile.to_string(),
        "--capture".to_string(),
        capture.to_string(),
        "--codec".to_string(),
        codec.to_string(),
        "--bit-depth".to_string(),
        if ten_bit { "10" } else { "8" }.to_string(),
        "--fps".to_string(),
        fps.to_string(),
        "--bitrate".to_string(),
        format!("{bitrate_kbps}k"),
        "--audio".to_string(),
        audio_mode.to_string(),
        "--resolution".to_string(),
        resolution.to_string(),
        "--out".to_string(),
        redact_url(push_url),
    ];
    argv
}
