//! `start` — begin a capture→encode→push stream.
//!
//! Resolves the request (profile + overrides + capture source + push_url) into
//! [`StartParams`] and hands it to the [`StreamController`], which runs the
//! ScreenCaptureKit → VideoToolbox → FLV/RTMPS pipeline on a worker thread and
//! emits `state`/`fps`/`stopped` events. Returns the redacted argv (same shape
//! as `build_argv`). Preflight of Screen-Recording permission happens implicitly
//! in the capture content query — a missing grant surfaces as an `error` event.

use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value};

use crate::capture::{self, AudioScope};
use crate::profiles::{BASELINE, profile_label};
use crate::stream_controller::{StartParams, StreamController};

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
            anyhow!("channel.push_url ist Pflicht (media-svc reicht die rtmps://-URL durch)")
        })?;

    let capture_src = params.get("capture").and_then(Value::as_str).unwrap_or("display:1");
    let window_id = parse_window_id(capture_src);
    let display_index = parse_display_index(capture_src);

    let overrides = params.get("overrides").and_then(Value::as_object);
    let requested_codec = overrides
        .and_then(|o| o.get("codec"))
        .and_then(Value::as_str)
        .unwrap_or(profile.codec)
        .to_string();
    let codec = resolve_codec(&requested_codec);
    let fps = overrides
        .and_then(|o| o.get("fps"))
        .and_then(Value::as_u64)
        .unwrap_or(profile.fps as u64)
        .clamp(1, 120) as u32;
    let bitrate_kbps = overrides
        .and_then(|o| o.get("bitrate_kbps"))
        .and_then(Value::as_u64)
        .unwrap_or(profile.bitrate_kbps as u64) as u32;
    let show_cursor = params.get("show_cursor").and_then(Value::as_bool).unwrap_or(true);
    // Manual A/V trim from the UI slider (>0 = audio later); clamped to ±1000ms.
    let av_offset_ms = params
        .get("av_offset_ms")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(-1000, 1000) as i32;

    // Audio: parse `audio.{mode, excluded_apps}` into a capture scope.
    //   "App: <name>"            → only that app's audio (and its windows as video)
    //   "Desktop"/"Desktop + …"  → desktop audio, minus Pulse (echo) + excluded_apps
    //   "Aus" / "Mikrofon"-only  → no audio (mic needs an AVCaptureSession path, TBD)
    let audio_obj = params.get("audio").and_then(Value::as_object);
    let audio_mode = audio_obj
        .and_then(|a| a.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("Aus");
    let excluded_apps: Vec<String> = audio_obj
        .and_then(|a| a.get("excluded_apps"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let (enable_audio, audio_scope) = if let Some(app) = audio_mode.strip_prefix("App: ") {
        (true, AudioScope::App(app.trim().to_string()))
    } else if audio_mode.contains("Desktop") {
        (true, AudioScope::Desktop { exclude: excluded_apps })
    } else {
        (false, AudioScope::None)
    };

    let (width, height) = resolve_resolution(overrides, display_index)?;

    let argv = build_redacted_argv(
        &push_url,
        profile_name,
        &codec,
        fps,
        bitrate_kbps,
        width,
        height,
    );

    StreamController::singleton().start(
        StartParams {
            display_index,
            window_id,
            width,
            height,
            fps,
            bitrate_kbps,
            codec,
            push_url,
            show_cursor,
            enable_audio,
            audio_scope,
            av_offset_ms,
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

/// Extract a 1-based display index from the capture string. Accepts
/// `"display:<n>"`, `"Monitor: <n>"`, `"portal"` (→ 1), etc.
fn parse_display_index(capture: &str) -> usize {
    let digits: String = capture.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<usize>().unwrap_or(1).max(1)
}

/// Codec-Wahl mit EINEM Sicherheitsnetz: kann diese Hardware den gewuenschten
/// Codec nicht encodieren, hier auf h264 zurueckfallen — VOR jedem Encoder-
/// oder Sendeweg-Aufbau. Zwilling zur Absage in
/// `linux-hq-sidecar/src/ops/start.rs` (dort ausfuehrlich begruendet: "ein
/// veralteter Client oder ein Direktaufruf kaeme sonst zum harten Fehler").
///
/// **Warum hier und nicht erst am Encoder.** Ohne diese Schranke fiel bisher
/// nur `videotoolbox_encoder` (`encode/wahl.rs`) STILL auf
/// `h264_videotoolbox` zurueck, wenn die Hardware den angefragten Codec nicht
/// encodieren kann (etwa AV1 vor M3, oder wenn das gelinkte FFmpeg keinen
/// `av1_videotoolbox` mitbringt) — waehrend der eigene WHIP-Sendeweg
/// (`whip::WhipSender::connect`) weiterhin die rohe, unkorrigierte
/// `codec_id` bekam. Das Ergebnis: der Handschlag kuendigt AV1 an, der
/// Encoder liefert H.264-Bytes, und `sdp::codec_capability` waehlt den
/// AV1-Paketierer, der diese Bytes als OBUs zerlegt — der Zuschauer sieht
/// nichts, und nirgends erscheint ein Fehler. `h264` bleibt auf Apple Silicon
/// immer verfuegbar (Basisfall, `caps::supports_codec`), der Fallback landet
/// also nie im Leeren.
fn resolve_codec(requested: &str) -> String {
    if crate::caps::supports_codec(requested) {
        requested.to_string()
    } else {
        eprintln!(
            "[start] Codec '{requested}' auf dieser Hardware nicht encodierbar → Fallback auf h264"
        );
        "h264".to_string()
    }
}

/// A `"window:<cg-window-id>"` capture token selects a single window. Anything
/// else (display/monitor/portal) returns None → display capture.
fn parse_window_id(capture: &str) -> Option<u32> {
    capture.strip_prefix("window:")?.trim().parse::<u32>().ok()
}

/// h264/hevc require even dimensions.
fn even(n: u32) -> u32 {
    n & !1
}

fn resolve_resolution(
    overrides: Option<&Map<String, Value>>,
    display_index: usize,
) -> Result<(u32, u32)> {
    if let Some(res) = overrides
        .and_then(|o| o.get("resolution"))
        .and_then(Value::as_str)
    {
        if let Some((w, h)) = res.split_once('x') {
            if let (Ok(w), Ok(h)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) {
                if w > 0 && h > 0 {
                    return Ok((even(w), even(h)));
                }
            }
        }
    }
    // Default to the chosen display's native size.
    if let Ok(displays) = capture::list_displays() {
        let idx = if display_index >= 1 && display_index <= displays.len() {
            display_index - 1
        } else {
            0
        };
        if let Some(d) = displays.get(idx) {
            if d.width > 0 && d.height > 0 {
                return Ok((even(d.width as u32), even(d.height as u32)));
            }
        }
    }
    Ok((1920, 1080))
}

fn build_redacted_argv(
    push_url: &str,
    profile_name: &str,
    codec: &str,
    fps: u32,
    bitrate_kbps: u32,
    width: u32,
    height: u32,
) -> Vec<String> {
    vec![
        "pulse-mac-hq-sidecar".to_string(),
        "--profile".to_string(),
        profile_name.to_string(),
        "--codec".to_string(),
        codec.to_string(),
        "--size".to_string(),
        format!("{width}x{height}"),
        "--fps".to_string(),
        fps.to_string(),
        "--bitrate".to_string(),
        format!("{bitrate_kbps}k"),
        "--out".to_string(),
        crate::redact::redact_url(push_url),
    ]
}

#[cfg(test)]
mod codec_resolution_tests {
    use super::{parse_display_index, resolve_codec, resolve_resolution};

    /// **K-1.** Nicht "die Funktion gibt h264 zurueck" — sondern die
    /// Eigenschaft, um die es geht: der Codec, den `resolve_codec` an den
    /// Sendeweg (WHIP wie Muxer) durchlaesst, ist IMMER derselbe, den
    /// `videotoolbox_encoder` (`encode/wahl.rs`) fuer diesen Codec
    /// tatsaechlich oeffnet. `videotoolbox_encoder` faellt NUR dann still auf
    /// `h264_videotoolbox` zurueck, wenn `caps::supports_codec` fuer den
    /// uebergebenen Codec falsch ist — und genau das schliesst
    /// `resolve_codec` jetzt aus, bevor irgendein Encoder oder Sendeweg den
    /// Codec zu Gesicht bekommt. Ohne diesen Test haette ein AV1-Wunsch auf
    /// Hardware ohne AV1-Encoding weiterhin still auseinanderlaufen koennen:
    /// Encoder faehrt h264, WHIP-Handschlag kuendigt av1 an.
    #[test]
    fn ergebnis_deckt_sich_mit_dem_tatsaechlich_geoeffneten_encoder() {
        for requested in ["h264", "hevc", "h265", "av1", "unbekannt", ""] {
            let resolved = resolve_codec(requested);

            assert!(
                crate::caps::supports_codec(&resolved),
                "resolve_codec({requested:?}) lieferte {resolved:?}, aber \
                 diese Hardware encodiert das laut caps::supports_codec nicht"
            );

            let tatsaechlich_geoeffnet = crate::encode::videotoolbox_encoder(&resolved);
            let fuer_resolved_erwartet = crate::caps::vt_encoder_name(&resolved)
                .expect("ein von resolve_codec durchgelassener Codec hat eine Encoder-Zuordnung");
            assert_eq!(
                tatsaechlich_geoeffnet, fuer_resolved_erwartet,
                "videotoolbox_encoder({resolved:?}) faellt auf {tatsaechlich_geoeffnet} \
                 zurueck, obwohl resolve_codec {resolved:?} als unterstuetzt gemeldet hat — \
                 genau die K-1-Luecke waere das fuer den Sendeweg, der {resolved:?} bekommt"
            );
        }
    }

    /// Ein Codec, den die Hardware traegt, geht unveraendert durch.
    #[test]
    fn unterstuetzter_codec_bleibt_unveraendert() {
        assert_eq!(resolve_codec("h264"), "h264");
    }

    /// **Befund W-7 der Pruefung, hier festgehalten — nicht behoben.**
    ///
    /// `parse_display_index` filtert die Ziffern aus der Aufnahme-Kennung. Bei
    /// `"window:2737"` kommt damit **2737** heraus und wird als Schirmindex
    /// gelesen. Das ist kein Tippfehler in der Kennung, sondern die Bauart der
    /// Funktion: sie ist fuer `"display:1"` und `"Monitor: 2"` geschrieben.
    ///
    /// Die Folge steht im Test darunter.
    #[test]
    fn eine_fensterkennung_wird_als_schirmindex_gelesen() {
        assert_eq!(parse_display_index("window:2737"), 2737);
        assert_eq!(parse_display_index("window:3931"), 3931);
        // Zum Vergleich, wofuer die Funktion gedacht ist:
        assert_eq!(parse_display_index("display:1"), 1);
        assert_eq!(parse_display_index("Monitor: 2"), 2);
        assert_eq!(parse_display_index("portal"), 1);
    }

    /// **Und deshalb bekommt ein Fenster-Strom die Masse des Hauptschirms.**
    ///
    /// Ein Index ausserhalb der Schirmliste faellt auf den ersten Schirm
    /// zurueck — bei einer Fensterkennung ist er das immer. Die Aufnahme laeuft
    /// also in Schirmgroesse, waehrend das Fenster viel kleiner ist;
    /// `SCStreamConfiguration.scalesToFit` bleibt ungesetzt (Vorgabe YES), das
    /// Fenster wird seitenverhaeltnistreu eingepasst und der Rest mit Balken
    /// gefuellt.
    ///
    /// **Warum das die Fernsteuerung angeht:** der Steuernde schickt Anteile am
    /// **ganzen Bild samt Balken**, `remote_input::ziel` liefert das **nackte**
    /// Fensterrechteck, und `pulse_fernsteuerung::zuordnung` spreizt das eine
    /// ueber das andere. In der Mitte stimmt es, zum Rand hin waechst der
    /// Versatz. Gemessene Zahlen und die Abgrenzung dessen, was NICHT gemessen
    /// ist, stehen in `docs/plans/2026-08-23-macos-eingabe-messungen.md`,
    /// Nachtrag 9.
    ///
    /// Der Test vergleicht mit Index 1 statt mit festen Zahlen — er soll auf
    /// jeder Maschine dasselbe sagen.
    #[test]
    fn ein_fenster_strom_nimmt_die_masse_des_hauptschirms() {
        let bei_fensterkennung = resolve_resolution(None, parse_display_index("window:2737"));
        let beim_ersten_schirm = resolve_resolution(None, 1);
        assert_eq!(
            bei_fensterkennung.unwrap(),
            beim_ersten_schirm.unwrap(),
            "die Aufnahme eines Fensters laeuft in Schirmgroesse — nicht in Fenstergroesse"
        );
    }
}
