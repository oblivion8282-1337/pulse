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

    // Direktmodus (`"direct": true`): KEIN Server als Ziel — der Strom geht
    // über eine eigene WebRTC-Verbindung zum Player, der als Angeboter
    // `direct_offer` nachschiebt (Zwilling `win-hq-sidecar/src/ops/start.rs`).
    //
    // **Streng wie die Overrides**: nur ein echtes `true` zählt, ein
    // `"true"`-String oder eine 1 sind Fehler beim Bauen des Requests — und
    // der soll niemandem als „hat ja funktioniert" durchgehen.
    //
    // **Entscheidung direct + push_url: ABLEHNUNG, nicht Ignorieren.** Ein
    // Request, der beides trägt, widerspricht sich; still das eine zu
    // gewinnen wäre genau die Sorte Verwechslung, gegen die der Muxer-Guard
    // in `open_output` gebaut ist. Stufe 1 ist exklusiv (Begruendung in
    // `crate::direct`).
    let direct = match params.get("direct") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(andere) => {
            return Err(anyhow!("direct muss ein Boolean sein (war {andere})"));
        }
    };
    let push_url = if direct {
        if params
            .get("channel")
            .and_then(Value::as_object)
            .is_some_and(|k| k.contains_key("push_url"))
        {
            return Err(anyhow!(
                "direct:true und channel.push_url schließen sich aus — \
                 entweder Server-Push oder Direktpfad"
            ));
        }
        // Der Platzhalter-Kanal trägt nur die Diagnose-argv (`--out` zeigt
        // auf `direct::SITZUNG_URL`); ein echter Kanal existiert im
        // Direktmodus nicht.
        crate::direct::SITZUNG_URL.to_string()
    } else {
        let channel = params
            .get("channel")
            .and_then(Value::as_object)
            .context("channel ist Pflicht (Pulse streamt immer in einen Voice-Channel)")?;
        channel
            .get("push_url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                anyhow!("channel.push_url ist Pflicht (media-svc reicht die rtmps://-URL durch)")
            })?
    };

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
    let fps = fps_aus(overrides, profile.fps);
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
            direct,
        },
        argv.clone(),
    )?;

    // Die Warte-Buchung der Direkt-Sitzung — NACH dem Controller, dessen
    // „läuft bereits“-Wache der strengere Doppelstart-Schutz ist. Prak-
    // tisch unfehlbar (der Dispatch ist single-threaded), aber wer hier
    // stillschweigend weiterliefe, würde einen `wartend`-Controller ohne
    // Empfangsbereitschaft hinterlassen. (Zwilling: win `ops/start.rs`.)
    if direct {
        crate::direct::sitzung().bereite_vor()?;
    }

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

/// Die gewuenschte Bildrate, gegen Unsinn abgesichert.
///
/// **Die Obergrenze ist eine Vernunftgrenze, keine Richtlinie.** Wie hoch ein
/// Nutzer gehen darf, entscheidet der Betreiber in den Streaming-Einstellungen
/// (`hq_fps_max`, Vorgabe 360) und die Community daneben; die Oberflaeche
/// klemmt bereits darauf. Was hier steht, faengt nur noch Werte ab, die gar
/// keine Bildrate sein koennen — eine 0 (Division durch null im Taktgeber) und
/// astronomische Zahlen aus einem kaputten Aufruf.
///
/// **Bis zum 2026-08-23 stand hier `clamp(1, 120)`**, ohne ein Wort der
/// Begruendung, und war damit eine zweite Obergrenze neben der des Betreibers
/// — an einer Stelle, an der er sie nicht ueberstimmen kann. Wer 144 einstellte,
/// bekam 120, und zwar unabhaengig von Aufloesung und Maschine; es sah nach
/// einer Leistungsgrenze aus und war eine Zahl. Der Linux-Zwilling klemmt bei
/// 1000 und schreibt den Grund daneben ("Frontend clampt zusaetzlich auf den
/// Admin-Deckel"), Windows klemmt nach oben gar nicht. Diese Fassung folgt
/// Linux.
fn fps_aus(overrides: Option<&Map<String, Value>>, profil_fps: u32) -> u32 {
    overrides
        .and_then(|o| o.get("fps"))
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(profil_fps))
        .clamp(1, 1000) as u32
}

/// Das Kuerzel der Oberflaeche in einen Kasten uebersetzen.
///
/// **Die Oberflaeche schickt Kuerzel, keine Zahlen** — `RESOLUTION_VALUES` in
/// `web/src/lib/stream/settingsCatalog.ts` kennt `Native`, `4K`, `1440p`,
/// `1080p`, `720p`, `480p`. Bis zum 2026-08-23 verstand dieser Sidecar als
/// einziger nur `BREITExHOEHE`, scheiterte an jedem Kuerzel und fiel
/// stillschweigend auf die native Bildschirmgroesse zurueck: wer 720p
/// einstellte, streamte weiter in voller Groesse, ohne Meldung. Die Tabelle
/// ist wortgleich zu `win-hq-sidecar/src/ops/start.rs` und
/// `linux-hq-sidecar`s `ResolutionRequest::parse`.
///
/// `Native` und Unbekanntes liefern `None` — dann gilt die native Groesse.
/// Bewusst kein Raten bei einem Tippfehler: lieber die volle Groesse als
/// heimlich eine andere als die dastehende.
fn kasten_aus(kuerzel: &str) -> Option<(u32, u32)> {
    Some(match kuerzel {
        "4K" => (3840, 2160),
        "1440p" => (2560, 1440),
        "1080p" => (1920, 1080),
        "720p" => (1280, 720),
        "480p" => (854, 480),
        // Auch Zahlenpaare gelten als Kasten, nicht als Sollmass — s.
        // [`einpassen`]. Der Weg ist heute unbenutzt (die Oberflaeche schickt
        // Kuerzel), aber ein `1280x720` soll sich nicht anders verhalten als
        // `720p`.
        _ => {
            let (b, h) = kuerzel.split_once('x')?;
            let (b, h) = (b.trim().parse::<u32>().ok()?, h.trim().parse::<u32>().ok()?);
            if b == 0 || h == 0 {
                return None;
            }
            (b, h)
        }
    })
}

/// Die native Groesse in den Kasten einpassen — **seitenverhaeltnistreu und
/// nie vergroessernd**.
///
/// Wortgleiche Regel wie `fit_within_box` auf Windows und
/// `ResolutionRequest::target_for` auf Linux. Windows nahm den Kasten frueher
/// woertlich und stauchte damit jeden Ultrawide-Schirm auf 16:9; die Lehre
/// steht dort im Kommentar und wandert hiermit mit.
///
/// Kein Hochskalieren: aus einem 1280x720-Schirm wird mit dem Wunsch „1080p"
/// kein Full-HD-Bild, sondern weiterhin 1280x720. Eine Vergroesserung kostet
/// Bandbreite und bringt kein Detail.
fn einpassen(nativ_b: u32, nativ_h: u32, kasten_b: u32, kasten_h: u32) -> (u32, u32) {
    let faktor = f64::min(
        f64::from(kasten_b) / f64::from(nativ_b.max(1)),
        f64::from(kasten_h) / f64::from(nativ_h.max(1)),
    )
    .min(1.0);
    let b = (f64::from(nativ_b) * faktor).round() as u32;
    let h = (f64::from(nativ_h) * faktor).round() as u32;
    (even(b).max(2), even(h).max(2))
}

fn resolve_resolution(
    overrides: Option<&Map<String, Value>>,
    display_index: usize,
) -> Result<(u32, u32)> {
    // Erst die native Groesse bestimmen — sie ist sowohl der Rueckfall als
    // auch die Grundlage des Einpassens.
    let mut nativ = (1920u32, 1080u32);
    if let Ok(displays) = capture::list_displays() {
        let idx = if display_index >= 1 && display_index <= displays.len() {
            display_index - 1
        } else {
            0
        };
        if let Some(d) = displays.get(idx) {
            if d.width > 0 && d.height > 0 {
                nativ = (d.width as u32, d.height as u32);
            }
        }
    }
    let kasten = overrides
        .and_then(|o| o.get("resolution"))
        .and_then(Value::as_str)
        .and_then(kasten_aus);
    Ok(zielmasse(nativ, kasten))
}

/// Aus nativer Groesse und gewuenschtem Kasten die Zielmasse.
///
/// **Eigene Funktion, damit sie ohne Bildschirm pruefbar ist.** Solange die
/// Entscheidung in [`resolve_resolution`] stand, hing jeder Test an
/// `capture::list_displays()` — und auf einem 16:9-Entwicklerschirm liefert
/// „einpassen" dasselbe wie „Kasten woertlich nehmen". Die Mutation
/// „stauchen statt einpassen" ueberlebte deshalb jede Pruefung, obwohl sie
/// genau der Fehler ist, den Windows schon einmal hatte. Gemessen am
/// 2026-08-23; hier faellt sie sofort auf.
///
/// Gleicher Name und gleiche Aufgabe wie `zielmasse` im Windows-Zwilling.
fn zielmasse(nativ: (u32, u32), kasten: Option<(u32, u32)>) -> (u32, u32) {
    match kasten {
        Some((kb, kh)) => einpassen(nativ.0, nativ.1, kb, kh),
        None => (even(nativ.0).max(2), even(nativ.1).max(2)),
    }
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
    use super::{
        einpassen, fps_aus, kasten_aus, parse_display_index, resolve_codec, resolve_resolution,
        zielmasse,
    };
    use serde_json::{Map, Value};

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

    /// **Der zweite Fehler vom 2026-08-23**: eine feste Obergrenze von 120,
    /// unabhaengig von Aufloesung und Maschine. Sie sah aus wie eine
    /// Leistungsgrenze und war eine Zahl ohne Begruendung.
    #[test]
    fn die_bildrate_wird_nicht_bei_120_gedeckelt() {
        let mut o = Map::new();
        o.insert("fps".to_string(), Value::from(144u64));
        assert_eq!(fps_aus(Some(&o), 60), 144);
        o.insert("fps".to_string(), Value::from(180u64));
        assert_eq!(fps_aus(Some(&o), 60), 180);
        o.insert("fps".to_string(), Value::from(240u64));
        assert_eq!(fps_aus(Some(&o), 60), 240);
    }

    /// Was bleibt, ist eine Vernunftgrenze: eine 0 teilte den Taktgeber durch
    /// null, und eine astronomische Zahl kommt aus einem kaputten Aufruf.
    #[test]
    fn unsinnige_bildraten_werden_abgefangen() {
        let mut o = Map::new();
        o.insert("fps".to_string(), Value::from(0u64));
        assert_eq!(fps_aus(Some(&o), 60), 1, "0 haette den Taktgeber zerlegt");
        o.insert("fps".to_string(), Value::from(u64::MAX));
        assert_eq!(fps_aus(Some(&o), 60), 1000);
    }

    /// Ohne Wunsch gilt die Vorgabe des Profils — und die wird nicht geklemmt,
    /// solange sie vernuenftig ist.
    #[test]
    fn ohne_wunsch_gilt_das_profil() {
        assert_eq!(fps_aus(None, 60), 60);
        assert_eq!(fps_aus(Some(&Map::new()), 144), 144);
    }

    /// **Der Fehler vom 2026-08-23**: die Oberflaeche schickt Kuerzel, dieser
    /// Sidecar verstand als einziger nur Zahlenpaare. Jedes Kuerzel scheiterte
    /// still, und der Strom lief in voller Groesse weiter — wer 720p
    /// einstellte, bekam Full-HD ohne jede Meldung.
    #[test]
    fn jedes_kuerzel_der_oberflaeche_wird_verstanden() {
        // Genau die Liste aus `web/src/lib/stream/settingsCatalog.ts`.
        assert_eq!(kasten_aus("4K"), Some((3840, 2160)));
        assert_eq!(kasten_aus("1440p"), Some((2560, 1440)));
        assert_eq!(kasten_aus("1080p"), Some((1920, 1080)));
        assert_eq!(kasten_aus("720p"), Some((1280, 720)));
        assert_eq!(kasten_aus("480p"), Some((854, 480)));
        // „Native" ist kein Kasten, sondern die Abwesenheit eines Wunsches.
        assert_eq!(kasten_aus("Native"), None);
    }

    /// Ein Tippfehler darf nicht heimlich etwas anderes einstellen als
    /// dasteht — dann lieber die volle Groesse.
    #[test]
    fn unsinn_ist_kein_kasten() {
        for k in ["", "720", "p720", "1080i", "x", "0x0", "1280x", "abcxdef"] {
            assert_eq!(kasten_aus(k), None, "{k:?} haette kein Kasten sein duerfen");
        }
    }

    /// Der eigentliche Zweck: 720p auf einem Full-HD-Schirm ist 1280x720 und
    /// nicht 1920x1080.
    #[test]
    fn ein_kuerzel_verkleinert_wirklich() {
        assert_eq!(einpassen(1920, 1080, 1280, 720), (1280, 720));
        // **852, nicht 854** — und das ist richtig, nicht schlampig: der
        // uebliche 480p-Kasten 854x480 ist mit 1,779 gar nicht exakt 16:9.
        // Weil die Regel das Verhaeltnis der QUELLE wahrt, stoesst die Hoehe
        // zuerst an und die Breite bleibt zwei Punkte darunter. Wer hier 854
        // erwartet, verlangt in Wahrheit eine Stauchung.
        assert_eq!(einpassen(1920, 1080, 854, 480), (852, 480));
    }

    /// **Seitenverhaeltnistreu, nicht gestaucht.** Windows nahm den Kasten
    /// frueher woertlich und presste jeden Ultrawide-Schirm auf 16:9. Ein
    /// 21:9-Schirm muss in der Breite anstossen und in der Hoehe Luft lassen.
    #[test]
    fn ultrawide_wird_nicht_gestaucht() {
        let (b, h) = einpassen(3440, 1440, 1920, 1080);
        assert_eq!(b, 1920, "Breite muss den Kasten ausfuellen");
        assert!(h < 1080, "Hoehe darf den Kasten NICHT ausfuellen: {h}");
        // Und das Verhaeltnis bleibt erhalten (auf Rundung genau).
        let vorher = 3440.0 / 1440.0;
        let nachher = f64::from(b) / f64::from(h);
        assert!((vorher - nachher).abs() < 0.01, "{vorher} gegen {nachher}");
    }

    /// Nie vergroessern: ein kleiner Schirm bleibt klein, auch wenn ein
    /// grosser Kasten gewuenscht ist. Hochskalieren kostet Bandbreite und
    /// bringt kein Detail.
    #[test]
    fn ein_kleiner_schirm_wird_nicht_aufgeblasen() {
        assert_eq!(einpassen(1280, 720, 3840, 2160), (1280, 720));
        assert_eq!(einpassen(1280, 720, 1920, 1080), (1280, 720));
    }

    /// **Der Kasten ist eine Obergrenze, kein Sollmass.** Diese Pruefung
    /// braucht eine Quelle, die NICHT 16:9 ist — auf einem 16:9-Schirm
    /// liefern „einpassen" und „Kasten woertlich nehmen" dasselbe, und die
    /// Stauchung bliebe unsichtbar. Genau daran ist die erste Fassung
    /// vorbeigelaufen.
    #[test]
    fn der_kasten_staucht_nicht() {
        // 21:9-Schirm, 16:9-Kasten.
        let (b, h) = zielmasse((3440, 1440), Some((1920, 1080)));
        assert_eq!((b, h), (1920, 804), "Kasten woertlich genommen?");
        // 4:3-Schirm, 16:9-Kasten: die Hoehe stoesst an, die Breite bleibt frei.
        let (b, h) = zielmasse((1600, 1200), Some((1920, 1080)));
        assert_eq!((b, h), (1440, 1080));
    }

    /// Ohne Wunsch bleibt die native Groesse — nur auf gerade Kanten gebracht.
    #[test]
    fn ohne_kasten_bleibt_die_native_groesse() {
        assert_eq!(zielmasse((3440, 1440), None), (3440, 1440));
        assert_eq!(zielmasse((1367, 769), None), (1366, 768));
    }

    /// Encoder in 4:2:0 verlangen gerade Kantenlaengen.
    #[test]
    fn die_kanten_sind_immer_gerade() {
        for (nb, nh, kb, kh) in [(1366u32, 768u32, 1280u32, 720u32), (1080, 1920, 1280, 720)] {
            let (b, h) = einpassen(nb, nh, kb, kh);
            assert_eq!(b % 2, 0, "Breite ungerade: {b}");
            assert_eq!(h % 2, 0, "Hoehe ungerade: {h}");
        }
    }
}
