//! Vollbild-Abstand + Codec-/Ziel-Auswahl — herausgeloest aus `encode/mod.rs`,
//! weil die Datei sonst die Groessen-Policy (hart 500 Zeilen) reisst. Reine
//! Rechnungen und Nachschlagetabellen ohne ffmpeg-Handle, deshalb ein eigenes
//! Modul statt eine weitere Abspaltung von `VideoEncoder` selbst.
//!
//! `KEYFRAME_SEKUNDEN_UNBEDENKLICH` bleibt in `mod.rs` (dort `pub(crate)`
//! fuer `keyframe.rs`) — hier nur ueber `super::` referenziert.

use super::KEYFRAME_SEKUNDEN_UNBEDENKLICH;

/// Regulaerer Vollbild-Abstand, Vorgabe in Sekunden — wie Linux und Windows.
///
/// Der so gestreckte Abstand setzt einen RTCP-Rueckkanal voraus, ueber den ein
/// beitretender Zuschauer sein Einstiegs-Vollbild anfordert; den bringt der
/// eigene WHIP-Sender (`crate::whip`) mit, nachgemessen — s. README, Abschnitt
/// "Own WHIP sender + back channel". Die Begruendung der 60 s selbst
/// (Stossfenster-Messung) steht beim Linux-Zwilling
/// `encode::KEYFRAME_SEKUNDEN_VORGABE`.
///
/// RTMPS hat den Rueckkanal nicht (s.
/// [`warne_bei_langem_abstand_ohne_rueckkanal`]), wird auf macOS aber praktisch
/// nie gewaehlt: `pushProtokoll` nimmt fuer H.264 immer WHIP, und AV1 findet
/// auf heutiger Mac-Hardware keinen Encoder (s. `caps.rs`).
const KEYFRAME_SEKUNDEN_VORGABE: f32 = 60.0;

/// Regulaerer Vollbild-Abstand in Bildern.
///
/// **Zwillingsrechnung** zu `keyframe::abstand_bilder` im Windows-Sidecar und
/// `encode::keyframe_abstand_bilder` im Linux-Sidecar. Die ausfuehrliche
/// Begruendung der Grenzen steht beim Linux-Zwilling.
pub(super) fn keyframe_abstand_bilder(fps: u32) -> u32 {
    ((fps as f32 * keyframe_abstand_sekunden()).round() as u32).max(1)
}

/// Der eingestellte Vollbild-Abstand in Sekunden.
///
/// Aus der Umgebung gelesen, mit [`KEYFRAME_SEKUNDEN_VORGABE`] als Vorgabe.
/// `PULSE_KEYFRAME_SECONDS` bleibt wirksam — der Schalter ist fuer Messreihen
/// da, und wer ihn setzt, weiss was er tut; gewarnt wird trotzdem (s.
/// [`warne_bei_langem_abstand_ohne_rueckkanal`]).
fn keyframe_abstand_sekunden() -> f32 {
    abstand_sekunden_aus(std::env::var("PULSE_KEYFRAME_SECONDS").ok().as_deref())
}

/// Die reine Rechnung dahinter — von der Umgebung getrennt, damit sie ohne
/// `set_var` (in Edition 2024 `unsafe` und zwischen Testfaeden unsicher)
/// pruefbar ist.
fn abstand_sekunden_aus(roh: Option<&str>) -> f32 {
    const VORGABE: f32 = KEYFRAME_SEKUNDEN_VORGABE;
    const MIN: f32 = 0.1;
    const MAX: f32 = 120.0;
    match roh {
        None => VORGABE,
        Some(roh) => match roh.parse::<f32>() {
            Ok(v) if (MIN..=MAX).contains(&v) => v,
            _ => {
                // Gemeldet statt still verworfen: eine Messreihe mit "60 s" im
                // Protokoll, die in Wahrheit mit 2 s lief, sieht plausibel aus.
                eprintln!(
                    "[encode] PULSE_KEYFRAME_SECONDS={roh:?} unbrauchbar \
                     (erlaubt {MIN}..={MAX}) — es gilt die Vorgabe {VORGABE}"
                );
                VORGABE
            }
        },
    }
}

/// Warnt, wenn jemand den Abstand ueber das Unbedenkliche hinaus streckt UND
/// der gewaehlte Weg keinen Rueckkanal hat.
///
/// Gegenstueck zu `warne_bei_langem_vollbild_abstand_ohne_rueckkanal` im
/// Linux-Sidecar (dort `encode/mod.rs`).
/// Haengt am ZIEL, nicht am Abstand: der eigene WHIP-Sender (`crate::whip`)
/// haengt an `VideoEncoder::start` und hat den Rueckkanal, RTMPS/SRT nicht.
/// Seit die Vorgabe bei [`KEYFRAME_SEKUNDEN_VORGABE`] (60 s) liegt, ist diese
/// Warnung der einzige verbliebene Riegel fuer den RTMPS-Fall — heute
/// unerreicht (s. dort), aber echt, falls sich das aendert.
pub(super) fn warne_bei_langem_abstand_ohne_rueckkanal(hat_rueckkanal: bool) {
    if hat_rueckkanal {
        return;
    }
    let sekunden = keyframe_abstand_sekunden();
    if sekunden > KEYFRAME_SEKUNDEN_UNBEDENKLICH {
        eprintln!(
            "[encode] Langer Vollbild-Abstand ({sekunden} s) ohne RTCP-Rueckkanal: dieser \
             Sidecar kann keine Vollbild-Anforderung beantworten — ein beitretender \
             Zuschauer wartet bis zum naechsten regulaeren Vollbild, also bis zu so viele \
             Sekunden, und der native Player gibt nach 20 s auf."
        );
    }
}

/// Map a stream profile codec id to the matching VideoToolbox encoder.
///
/// Uses the real hardware-capability probe (`crate::caps`): the exact encoder
/// when this machine can encode the codec (so a gated AV1 profile produces real
/// `av1_videotoolbox` on M3+), else a defensive fall back to h264 (universally
/// available). `health` already reports the same probe to the renderer, which
/// filters the codec picker by it — so in practice the requested codec is
/// always supported here.
pub(crate) fn videotoolbox_encoder(codec: &str) -> &'static str {
    match crate::caps::vt_encoder_name(codec) {
        Some(name) if crate::caps::supports_codec(codec) => name,
        _ => "h264_videotoolbox",
    }
}

/// FLV for RTMP/RTMPS, MPEG-TS for SRT, WHIP for http(s) — but WHIP does NOT
/// go through ffmpeg's own muxer here (s. `Ausgabe::Whip` in `mod.rs`); the
/// hint only decides the branch in `VideoEncoder::start`.
pub(super) fn url_format_hint(target: &str) -> Option<&'static str> {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("rtmp://") || lower.starts_with("rtmps://") {
        Some("flv")
    } else if lower.starts_with("srt://") {
        Some("mpegts")
    } else if lower.starts_with("http://") || lower.starts_with("https://") {
        Some("whip")
    } else {
        None
    }
}

#[cfg(test)]
mod keyframe_tests {
    use super::{KEYFRAME_SEKUNDEN_UNBEDENKLICH, KEYFRAME_SEKUNDEN_VORGABE, abstand_sekunden_aus};

    /// **Der eigentliche Punkt dieser Datei.** Ohne gesetzte Umgebung gilt auf
    /// macOS dieselbe gestreckte Vorgabe wie auf Linux und Windows (60 s), und
    /// sie ist ausdruecklich NICHT dieselbe Zahl wie
    /// `KEYFRAME_SEKUNDEN_UNBEDENKLICH` (2 s), an dem Drossel-Deckel und
    /// Warnschwelle haengen. Ein Zwilling, der die beiden wieder
    /// zusammenzieht, faellt hier auf.
    #[test]
    fn macos_folgt_der_regulaeren_vorgabe() {
        assert_eq!(abstand_sekunden_aus(None), KEYFRAME_SEKUNDEN_VORGABE);
        assert_eq!(abstand_sekunden_aus(None), 60.0);
        assert_ne!(KEYFRAME_SEKUNDEN_VORGABE, KEYFRAME_SEKUNDEN_UNBEDENKLICH);
    }

    /// Der Messschalter bleibt wirksam — auch nach oben.
    #[test]
    fn umgebung_uebersteuert_im_erlaubten_bereich() {
        assert_eq!(abstand_sekunden_aus(Some("30")), 30.0);
        assert_eq!(abstand_sekunden_aus(Some("0.1")), 0.1);
        assert_eq!(abstand_sekunden_aus(Some("120")), 120.0);
    }

    /// Unbrauchbares faellt auf die Vorgabe zurueck (und wird gemeldet).
    #[test]
    fn unbrauchbares_faellt_auf_die_vorgabe() {
        for roh in ["", "abc", "0", "-5", "121"] {
            assert_eq!(
                abstand_sekunden_aus(Some(roh)),
                KEYFRAME_SEKUNDEN_VORGABE,
                "{roh:?}"
            );
        }
    }

    /// Bilder statt Sekunden, und nie 0 (ein GOP von 0 lesen manche Encoder
    /// als "unbegrenzt"). 3600 = 60 fps * 60 s Vorgabe.
    #[test]
    fn bilder_aus_sekunden_nie_null() {
        assert_eq!(((60.0 * abstand_sekunden_aus(None)).round() as u32).max(1), 3600);
        assert_eq!(((1.0 * abstand_sekunden_aus(Some("0.1"))).round() as u32).max(1), 1);
    }
}
