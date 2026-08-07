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
    // Codec-Wahl mit EINEM Sicherheitsnetz: kann die HW den gewünschten Codec
    // nicht encodieren, auf H.264 zurückfallen statt den Encoder-open crashen
    // zu lassen. Die UI bietet AV1 auf solcher HW zwar gar nicht erst an (der
    // `health`-Report filtert über dieselbe Probe), aber ein veralteter Client
    // oder ein Direktaufruf käme sonst zum harten Fehler. Geht auch H.264
    // nicht, bleibt der Wunsch stehen → echter, ehrlicher Encoder-Fehler.
    //
    // **Der zweite Rückfall ist am 2026-08-02 entfallen.** Er nahm bei jedem
    // WHIP-Ziel AV1 zurück, weil ffmpegs WHIP-Muxer ausschließlich H.264 trägt
    // (in 8.1 und in `master`: ein einziger Payload-Typ). Über diesen Muxer
    // läuft der Weg aber nicht mehr — `encode::create_whip` benutzt den eigenen
    // Sendeweg in `crate::whip`, und der paketiert AV1 selbst. Bliebe der
    // Rückfall stehen, verlöre jeder WHIP-Stream still seinen Codec.
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
    // Betriebsart vor dem Encoder-Open hinterlegen — `vendor_opts` und die
    // Prüfung lesen sie von dort (s. `opts::intra_refresh_gewuenscht`).
    if let Some(an) = requested_intra_refresh(overrides) {
        crate::encode::opts::intra_refresh_setzen(an);
    }
    // Dasselbe Muster, derselbe Grund: die Opus-Paketlänge hängt am Sendeweg,
    // gebraucht wird sie aber dort, wo die Ziel-URL nicht hinkommt — vor allem
    // im Aufnahme-Raster. **Vor** dem Aufbau der Aufnahme setzen.
    //
    // Ohne `if let`: es gibt kein „ungesagt". Die URL liegt vor, also steht der
    // Weg fest, und ein Rest aus dem vorigen Stream wäre hier schlimmer als
    // eine Vorgabe.
    crate::encode::audio::setze_sendeweg(crate::encode::is_whip_url(&push_url));
    // Hier stand bis 2026-08-02 eine Warnung, Intra-Refresh trage auf AV1
    // nicht. Sie war falsch — Begruendung und Gegenmessung stehen bei der
    // entfernten `traegt_intra_refresh` in `encode/opts.rs`. Ob der Encoder
    // die Betriebsart wirklich annimmt, entscheidet ohnehin
    // `intra_refresh_pruefen` vor dem Open, und zwar mit Abbruch statt Warnung.
    // HDR schaltet 10 bit SELBST ein, statt es vom Nutzer zu verlangen: PQ
    // verteilt seine Codewerte ueber 0,0001 bis 10 000 cd/m2, und in 8 bit
    // stuenden dafuer 256 Stufen zur Verfuegung (Begruendung `encode::hdr`).
    let hdr_gewuenscht = requested_hdr(overrides);
    let ausgang_wunsch = overrides
        .and_then(|o| o.get("hdr_ausgang"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let wants_ten_bit = requested_ten_bit(overrides) || hdr_gewuenscht;
    let ten_bit = wants_ten_bit && ten_bit_possible(&codec);
    if wants_ten_bit && !ten_bit {
        log_ten_bit_refusal(&codec);
    }
    // **Unerfuellbar heisst Startverweigerung, nicht stiller Rueckfall.** Ein
    // SDR-Bild unter HDR-Etikett sieht der Zuschauer am ganzen Bild, und er
    // sucht den Fehler bei seinem Schirm. Geprueft wird hier, VOR dem Aufbau
    // der Aufnahme — der Aufnahmeweg haengt an der Antwort.
    if hdr_gewuenscht {
        hdr_pruefen_oder_absagen(&codec, ten_bit, ausgang_wunsch.as_deref())?;
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
            hdr: hdr_gewuenscht && ten_bit,
            ausgang: ausgang_wunsch,
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

/// Wunsch aus dem Wire-Format lesen: `overrides.hdr` = true. Fehlt das Feld
/// oder steht etwas anderes darin, heisst es Nein — HDR darf nie versehentlich
/// angehen, denn es zieht den ganzen Aufnahmeweg mit (Scanout statt Portal).
pub(crate) fn requested_hdr(overrides: Option<&Map<String, Value>>) -> bool {
    overrides
        .and_then(|o| o.get("hdr"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// HDR gegen Encoder und Ausgang pruefen; bei Absage bricht der `start`-Op ab.
///
/// Die Meldung nennt jeweils die Abhilfe, nicht nur den Befund — ein „HDR nicht
/// moeglich" ohne Grund fuehrt zur Fehlersuche an der falschen Stelle.
fn hdr_pruefen_oder_absagen(
    codec: &str,
    ten_bit: bool,
    ausgang_wunsch: Option<&str>,
) -> anyhow::Result<()> {
    if !ten_bit {
        anyhow::bail!(
            "HDR verlangt, aber dieser Stream laeuft in 8 bit ({codec}). HDR ohne 10 bit \
             waeren sichtbare Ringe in jedem Verlauf. Abhilfe: AV1 waehlen."
        );
    }
    let (vendor, _) = crate::system::drm::detect()
        .ok_or_else(|| anyhow::anyhow!("HDR verlangt, aber keine DRM-Render-Node gefunden"))?;
    let karte = crate::capture::kms::KmsKarte::erste_mit_ausgaengen().map_err(|e| {
        anyhow::anyhow!(
            "HDR verlangt, aber die Scanout-Aufnahme laesst sich nicht oeffnen: {e:#}. \
             Sie ist der einzige Weg zu HDR-Bildpunkten — der Portal-Weg liefert auch bei \
             eingeschaltetem HDR ein SDR-Bild."
        )
    })?;
    let ausgang = karte.ausgang_waehlen(ausgang_wunsch)?;
    let angaben = crate::encode::hdr::pruefen(vendor, codec, &ausgang)?;
    // Die Berechtigung ist die letzte Bedingung — und die einzige, die der
    // Nutzer selbst herstellen muss. Sie wird hier VOR dem Start geprueft,
    // damit die Absage am `start`-Aufruf haengt und nicht als Stream-Fehler
    // erscheint, den niemand einem fehlenden Programm zuordnet.
    //
    // Geprueft wird die billige Frage („liegt der Helfer da?"); ob er die
    // Faehigkeit wirklich traegt und ob seine Fassung passt, sagt der
    // Handschlag Sekundenbruchteile spaeter — mit ebenso benannter Abhilfe.
    // Wer die Rechte selbst hat (Labor, root), braucht ihn gar nicht: dann
    // gelingt der unmittelbare Weg, und `KmsAufnahme` fragt nie nach.
    if karte.bild(ausgang.crtc_id, 0, 0).is_err() && !crate::capture::kms_helfer::vorhanden() {
        anyhow::bail!(
            "HDR verlangt, aber das Hilfsprogramm fuer die Bildschirmaufnahme fehlt. Der Kernel \
             gibt die Bildpuffer nur an Programme mit erhoehten Rechten heraus, und die kann die \
             App als Flatpak nicht selbst tragen. Einmalig einrichten (fragt nach dem Passwort): \
             {}",
            crate::capture::kms_helfer::installationsbefehl()
        );
    }
    tracing::info!(
        target: "stream",
        ausgang = %ausgang.name, max_cll = angaben.max_cll,
        "HDR: Scanout-Aufnahme, BT.2020 mit PQ"
    );
    Ok(())
}

/// Wunsch aus dem Wire-Format lesen: `overrides.intra_refresh` = true|false.
///
/// Fehlt das Feld, wird NICHT auf `false` entschieden, sondern gar nicht — dann
/// bleibt `PULSE_INTRA_REFRESH` zuständig. Sonst könnte ein Client, der das Feld
/// nicht kennt, dem Prüfstand die Betriebsart unter den Füßen wegziehen.
pub(crate) fn requested_intra_refresh(overrides: Option<&Map<String, Value>>) -> Option<bool> {
    overrides
        .and_then(|o| o.get("intra_refresh"))
        .and_then(Value::as_bool)
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
