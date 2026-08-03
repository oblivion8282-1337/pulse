//! Was im SDP-Angebot ueber unsere Spuren steht.
//!
//! Herausgeloest aus `whip/mod.rs`, weil es eine eigene Sache ist: hier wird
//! ZUGESAGT, was gesendet wird. Der Empfaenger leitet daraus seine
//! Pufferabmessungen ab und entscheidet, ob er annehmen kann — eine falsche
//! Angabe faellt deshalb nicht beim Bauen auf, sondern beim Zuschauer.

use anyhow::{bail, Result};
use webrtc::api::media_engine::{MIME_TYPE_AV1, MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

use super::av1;

/// H.264-Stufe, die fuer diese Bildgroesse und Bildrate reicht.
///
/// Tabelle A-1 der H.264-Spezifikation, auf die zwei Groessen eingedampft, die
/// hier entscheiden: `MaxFS` (Makrobloecke je Bild) und `MaxMBPS` (Makrobloecke
/// je Sekunde). Gesucht ist die NIEDRIGSTE Stufe, die beides traegt — eine zu
/// hohe anzumelden ist zwar folgenlos, eine zu niedrige nicht.
fn h264_stufe(breite: u32, hoehe: u32, fps: u32) -> u8 {
    // (Stufe, MaxMBPS, MaxFS)
    const TABELLE: &[(u8, u64, u64)] = &[
        (30, 40_500, 1_620),
        (31, 108_000, 3_600),
        (32, 216_000, 5_120),
        (40, 245_760, 8_192),
        (42, 522_240, 8_704),
        (50, 589_824, 22_080),
        (51, 983_040, 36_864),
        (52, 2_073_600, 36_864),
        (60, 4_177_920, 139_264),
        (61, 8_355_840, 139_264),
        (62, 16_711_680, 139_264),
    ];
    let mbs = u64::from(breite.div_ceil(16)) * u64::from(hoehe.div_ceil(16));
    let mbps = mbs * u64::from(fps.max(1));
    TABELLE
        .iter()
        .find(|(_, max_mbps, max_fs)| mbs <= *max_fs && mbps <= *max_mbps)
        // Groesser als 6.2 gibt es nicht — dann die hoechste anmelden und den
        // echten Encoder-Open entscheiden lassen.
        .map_or(62, |(stufe, _, _)| *stufe)
}

/// Fassung fuer den Codec, wie sie im Angebot steht.
pub(super) fn codec_capability(
    codec: &str,
    breite: u32,
    hoehe: u32,
    fps: u32,
) -> Result<RTCRtpCodecCapability> {
    match codec {
        "h264" => Ok(RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: av1::RTP_TAKT_HZ,
            // `packetization-mode=1` ist Pflicht fuer fragmentierte NAL-Units.
            //
            // **`profile-level-id` stand bis 2026-08-04 fest auf `42e01f`** —
            // Baseline, Stufe 3.1, also ausgelegt fuer 720p. Gesendet wird aber
            // nachweislich etwas anderes: am Encoder gemessen `profile=High,
            // level=51` bei 1440p. Baseline verbietet zudem CABAC, das unsere
            // Encoder-Vorgaben ausdruecklich einschalten (`coder=cabac`).
            //
            // Die Angabe ist keine Beschriftung, sondern eine Zusage: der
            // Empfaenger leitet daraus seine Pufferabmessungen ab und
            // entscheidet, ob er ueberhaupt annehmen kann. Eine feste
            // Zeichenkette kann fuer 720p und 4K nicht beide richtig sein.
            //
            // `64` = High, `00` = keine zusaetzlichen Randbedingungen, danach
            // die Stufe aus der echten Bildgroesse (s. [`h264_stufe`]).
            sdp_fmtp_line: format!(
                "level-asymmetry-allowed=1;packetization-mode=1;\
                 profile-level-id=6400{:02x}",
                h264_stufe(breite, hoehe, fps)
            ),
            ..Default::default()
        }),
        // `profile-id=0` muss dastehen, weil die Fassung Wort fuer Wort zu der
        // passen muss, die `register_default_codecs` anmeldet — sonst findet
        // die Spur beim Binden ihren Codec nicht.
        "av1" => Ok(RTCRtpCodecCapability {
            mime_type: MIME_TYPE_AV1.to_owned(),
            clock_rate: av1::RTP_TAKT_HZ,
            sdp_fmtp_line: "profile-id=0".to_owned(),
            ..Default::default()
        }),
        andere => bail!("WHIP: Codec {andere} nicht unterstuetzt"),
    }
}

/// Fassung fuer die Tonspur — immer Opus, der Ton-Encoder kennt nichts anderes
/// (s. [`crate::encode::audio`]).
pub(super) fn opus_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48000,
        channels: 2,
        // `stereo=1` verlangt, dass der Empfaenger zweikanalig ausgibt; ohne
        // die Angabe mischt er nach RFC 7587 auf mono. Dieselbe Falle wie im
        // Browser-Client (s. `whep.ts`).
        sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1".to_owned(),
        ..Default::default()
    }
}

#[cfg(test)]
mod fassung_tests {
    use super::{codec_capability, h264_stufe};

    /// Gegen den ECHTEN Encoder geprüft: `h264_vaapi` meldete bei 2560x1440
    /// `level=51`, bei 3840x2160 mit 30 fps ebenfalls `level=51` (gemessen
    /// 2026-08-03 auf einer Radeon 780M). Die Tabelle muss dasselbe sagen —
    /// sonst melden wir wieder etwas an, das nicht gesendet wird.
    #[test]
    fn stufe_stimmt_mit_dem_encoder_ueberein() {
        assert_eq!(h264_stufe(2560, 1440, 60), 51);
        assert_eq!(h264_stufe(3840, 2160, 30), 51);
    }

    /// Die Bildrate entscheidet mit: dieselbe Größe bei doppelter Rate braucht
    /// eine Stufe mehr. Genau das kann eine feste Zeichenkette nicht abbilden.
    #[test]
    fn hoehere_bildrate_hebt_die_stufe() {
        assert_eq!(h264_stufe(3840, 2160, 60), 52);
        assert_eq!(h264_stufe(1280, 720, 30), 31);
        assert_eq!(h264_stufe(1280, 720, 60), 32);
    }

    /// Der alte feste Wert war `42e01f` — Baseline, Stufe 3.1. Für 1440p ist
    /// beides falsch; die Angabe muss jetzt High (`64`) und Stufe 5.1 (`33`)
    /// nennen.
    #[test]
    fn angebot_nennt_high_und_die_richtige_stufe() {
        let cap = codec_capability("h264", 2560, 1440, 60).unwrap();
        assert!(
            cap.sdp_fmtp_line.contains("profile-level-id=640033"),
            "unerwartet: {}",
            cap.sdp_fmtp_line
        );
        assert!(cap.sdp_fmtp_line.contains("packetization-mode=1"));
    }

    /// AV1 traegt seine Fassung nicht in der fmtp-Zeile — dort darf sich nichts
    /// geaendert haben, sonst findet die Spur beim Binden ihren Codec nicht.
    #[test]
    fn av1_angebot_bleibt_unveraendert() {
        let cap = codec_capability("av1", 7680, 4320, 60).unwrap();
        assert_eq!(cap.sdp_fmtp_line, "profile-id=0");
    }
}
