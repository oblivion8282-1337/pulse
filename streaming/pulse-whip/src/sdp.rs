//! Was im SDP-Angebot ueber unsere Spuren steht.
//!
//! Herausgeloest aus `whip/mod.rs`, weil es eine eigene Sache ist: hier wird
//! ZUGESAGT, was gesendet wird. Der Empfaenger leitet daraus seine
//! Pufferabmessungen ab und entscheidet, ob er annehmen kann — eine falsche
//! Angabe faellt deshalb nicht beim Bauen auf, sondern beim Zuschauer.
//!
//! **Die Zusage muss auch hinauskommen — dafuer gibt es [`register_codecs`].**
//! Bis 2026-08-12 rechnete diese Datei die H.264-Stufe sorgfaeltig aus, und
//! `whip/mod.rs` rief zwei Zeilen spaeter `register_default_codecs()`. Im
//! Angebot stand dann die Vorgabeliste von webrtc-rs, nicht unser Wert: 1440p60
//! und 4K60 erzeugten Zeichen fuer Zeichen dasselbe Angebot (gemessen
//! 2026-08-12 gegen einen Stub-Empfaenger). Fuer 1440p stimmte `640033` nur
//! zufaellig, weil die Vorgabeliste sie ohnehin fuehrt; das fuer 4K noetige
//! `640034` kam gar nicht vor. Der Ton hatte dieselbe Luecke, und die ist
//! hoerbar: `stereo=1` fehlte im Angebot, also mischt der Empfaenger nach
//! RFC 7587 auf mono.
//!
//! Seitdem melden wir GENAU die Codecs an, die wir wirklich senden, und keine
//! weiteren. Das Angebot ist damit eine Aussage ueber diesen einen Strom statt
//! einer Liste von Moeglichkeiten, die wir gar nicht haben.

use anyhow::{bail, Context, Result};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_AV1, MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::interceptor::registry::Registry;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType,
};
use webrtc::rtp_transceiver::{PayloadType, RTCPFeedback};

use crate::av1;

/// Nutzlast-Nummern, die wir selbst vergeben.
///
/// Wer die Codecs selbst anmeldet, vergibt auch die Nummern selbst. Genommen
/// sind die, die `register_default_codecs` demselben Codec gab — die Nummer ist
/// frei waehlbar (ihre Bedeutung steht im `a=rtpmap` desselben Angebots), aber
/// AV1 und Opus gingen vorher unter genau diesen Nummern hinaus, und fuer die
/// beiden Wege soll sich auf der Leitung gar nichts aendern. Eine Kollision
/// kann es nicht geben: ausser diesen dreien ist nichts angemeldet.
const PT_H264: PayloadType = 102;
const PT_AV1: PayloadType = 41;
const PT_OPUS: PayloadType = 111;

/// Rueckmeldungen, die wir zu jeder Bildspur anbieten.
///
/// **`ccm fir` und `nack pli` sind hier keine Formsache** — an ihnen haengt der
/// ganze Grund fuer diesen Sendeweg (s. Modul-Kopf von [`super`]). Ohne sie
/// bittet der Empfaenger nie um ein Vollbild, und der Rueckkanal, fuer den es
/// ffmpegs Muxer zu verlassen galt, laege still.
///
/// `nack`, `nack pli` und `transport-cc` haengt `register_default_interceptors`
/// spaeter ohnehin an jede angemeldete Video-Fassung (`register_feedback`).
/// `goog-remb` und `ccm fir` NICHT — die stehen nur hier. Deshalb dieselbe
/// Liste, die `register_default_codecs` an seine Video-Codecs haengt.
fn video_rtcp_feedback() -> Vec<RTCPFeedback> {
    [("goog-remb", ""), ("ccm", "fir"), ("nack", ""), ("nack", "pli")]
        .into_iter()
        .map(|(typ, parameter)| RTCPFeedback {
            typ: typ.to_owned(),
            parameter: parameter.to_owned(),
        })
        .collect()
}

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
///
/// Dieselbe Fassung geht an [`register_codecs`] UND an die Spur. Das ist kein
/// Zufall, sondern die Absicherung: die Spur findet ihren Codec beim Binden nur
/// ueber einen Vergleich von MIME-Typ und fmtp-Zeile
/// (`codec_parameters_fuzzy_search`), und ein Unterschied zwischen dem
/// Angemeldeten und dem Angebotenen faellt sonst erst am Zuschauer auf.
pub fn codec_capability(
    codec: &str,
    breite: u32,
    hoehe: u32,
    fps: u32,
) -> Result<RTCRtpCodecCapability> {
    match codec {
        "h264" => Ok(RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: av1::RTP_TAKT_HZ,
            rtcp_feedback: video_rtcp_feedback(),
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
            //
            // **Bis 2026-08-12 kam dieser Wert nicht im Angebot an** — er wurde
            // gerechnet und dann von `register_default_codecs` ueberschrieben
            // (Modul-Kopf). Seit [`register_codecs`] steht er wirklich da.
            sdp_fmtp_line: format!(
                "level-asymmetry-allowed=1;packetization-mode=1;\
                 profile-level-id=6400{:02x}",
                h264_stufe(breite, hoehe, fps)
            ),
            ..Default::default()
        }),
        // `profile-id=0` — Main, das einzige Profil, das unsere Encoder fahren.
        // AV1 traegt die Stufe nicht in der fmtp-Zeile, hier ist also nichts
        // aus der Bildgroesse zu rechnen.
        //
        // Bis 2026-08-12 stand hier, die Fassung muesse Wort fuer Wort zu der
        // passen, die `register_default_codecs` anmeldet. Der Zusammenhang
        // stimmt weiter, das Gegenueber ist nur nicht mehr die fremde
        // Vorgabeliste, sondern [`register_codecs`] — und weil das dieselbe
        // Fassung nimmt, die hier herauskommt, kann sie nicht mehr auseinander
        // laufen.
        "av1" => Ok(RTCRtpCodecCapability {
            mime_type: MIME_TYPE_AV1.to_owned(),
            clock_rate: av1::RTP_TAKT_HZ,
            rtcp_feedback: video_rtcp_feedback(),
            sdp_fmtp_line: "profile-id=0".to_owned(),
            ..Default::default()
        }),
        andere => bail!("WHIP: Codec {andere} nicht unterstuetzt"),
    }
}

/// Meldet genau die beiden Fassungen an, die wir wirklich senden — und keine
/// weiteren. Tritt an die Stelle von `MediaEngine::register_default_codecs`.
///
/// **Warum nicht zusaetzlich zur Vorgabeliste.** Dann stuenden unsere Werte
/// zwar mit im Angebot, aber daneben acht weitere H.264-Fassungen, von denen
/// der Empfaenger jede waehlen darf — auch `42001f` (Baseline, Stufe 3.1). Wir
/// senden aber High mit CABAC in der gerechneten Stufe. Ein Angebot, das
/// Baseline nennt und High schickt, ist genau der Fehler, den diese Datei
/// vermeiden soll; ihn nur unwahrscheinlicher zu machen reicht nicht.
///
/// **Muss VOR `register_default_interceptors` laufen.** Das haengt seine
/// Rueckmeldungen (`nack`, `nack pli`, `transport-cc`) an die zu dem Zeitpunkt
/// angemeldeten Fassungen; danach angemeldete bekaemen nichts davon.
pub(super) fn register_codecs(
    media: &mut MediaEngine,
    video: &RTCRtpCodecCapability,
    audio: &RTCRtpCodecCapability,
) -> Result<()> {
    let video_pt = if video.mime_type == MIME_TYPE_AV1 { PT_AV1 } else { PT_H264 };
    for (fassung, pt, typ) in [
        (video, video_pt, RTPCodecType::Video),
        (audio, PT_OPUS, RTPCodecType::Audio),
    ] {
        media.register_codec(
            RTCRtpCodecParameters {
                capability: fassung.clone(),
                payload_type: pt,
                ..Default::default()
            },
            typ,
        )?;
    }
    Ok(())
}

/// Die fertige webrtc-rs-API, aus der die Verbindung entsteht.
///
/// Steht hier und nicht in `whip/mod.rs`, weil sie ueber den Inhalt des
/// Angebots entscheidet: was in der Media-Engine steht, steht im SDP. Der Test
/// am Ende dieser Datei kommt so an dieselbe Funktion wie der Betrieb — sonst
/// pruefte er einen Nachbau und nicht den Weg.
pub fn baue_api(
    video: &RTCRtpCodecCapability,
    audio: &RTCRtpCodecCapability,
) -> Result<webrtc::api::API> {
    let mut media = MediaEngine::default();
    register_codecs(&mut media, video, audio).context("Codecs registrieren")?;
    let registry = register_default_interceptors(Registry::new(), &mut media)
        .context("Interceptor-Registry")?;
    Ok(APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build())
}

/// Fassung fuer die Tonspur — immer Opus, der Ton-Encoder kennt nichts anderes
/// (s. [`crate::encode::audio`]).
pub fn opus_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48000,
        channels: 2,
        // `stereo=1` verlangt, dass der Empfaenger zweikanalig ausgibt; ohne
        // die Angabe mischt er nach RFC 7587 auf mono. Dieselbe Falle wie im
        // Browser-Client (s. `whep.ts`).
        //
        // **Bis 2026-08-12 kam die Zeile nicht im Angebot an**: dort stand die
        // Opus-Fassung der Vorgabeliste, `minptime=10;useinbandfec=1` ohne
        // `stereo=1` (gemessen). Die Zusage lag also vor und wurde nicht
        // ausgesprochen — anders als bei der Bildstufe ist das kein
        // Schoenheitsfehler, sondern ein hoerbarer.
        //
        // Keine `rtcp_feedback`: fuer Ton gibt es keine Vollbild-Anforderung,
        // und `register_default_codecs` haengt an seine Ton-Codecs ebenfalls
        // keine.
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

    /// Ohne `ccm fir`/`nack pli` im Angebot bittet der Empfaenger nie um ein
    /// Vollbild — und genau dafuer gibt es diesen Sendeweg ueberhaupt.
    #[test]
    fn bildspur_bietet_die_vollbild_anforderung_an() {
        for codec in ["h264", "av1"] {
            let cap = codec_capability(codec, 2560, 1440, 60).unwrap();
            let paare: Vec<(String, String)> = cap
                .rtcp_feedback
                .iter()
                .map(|f| (f.typ.clone(), f.parameter.clone()))
                .collect();
            for soll in [("ccm", "fir"), ("nack", "pli")] {
                assert!(
                    paare.iter().any(|(t, p)| t == soll.0 && p == soll.1),
                    "{codec}: {soll:?} fehlt in {paare:?}"
                );
            }
        }
    }
}

/// Prueft, was WIRKLICH im Angebot steht — nicht, was gerechnet wurde.
///
/// Der Fehler, den diese Tests festhalten, lag genau dazwischen: die Stufe war
/// richtig ausgerechnet und wurde von `register_default_codecs` ueberschrieben.
/// Ein Test auf [`codec_capability`] allein haette ihn nie gesehen — er war
/// gruen, waehrend das Angebot etwas anderes sagte. Deshalb geht der Weg hier
/// bis zum fertigen SDP.
#[cfg(test)]
mod angebot_tests {
    use super::{baue_api, codec_capability, opus_capability};
    use webrtc::peer_connection::configuration::RTCConfiguration;
    use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
    use webrtc::track::track_local::TrackLocal;

    /// Baut das Angebot fuer diese Bildgroesse — ohne Netz: `create_offer`
    /// sammelt keine Kandidaten, es schreibt nur auf, was angemeldet ist.
    async fn angebot(codec: &str, breite: u32, hoehe: u32, fps: u32) -> String {
        let video = codec_capability(codec, breite, hoehe, fps).unwrap();
        let audio = opus_capability();
        let api = baue_api(&video, &audio).unwrap();
        let pc = api.new_peer_connection(RTCConfiguration::default()).await.unwrap();
        for (cap, art) in [(video, "video"), (audio, "audio")] {
            let track = std::sync::Arc::new(TrackLocalStaticSample::new(
                cap,
                art.to_owned(),
                "pulse-hq".to_owned(),
            ));
            pc.add_track(track as std::sync::Arc<dyn TrackLocal + Send + Sync>)
                .await
                .unwrap();
        }
        let offer = pc.create_offer(None).await.unwrap();
        pc.close().await.unwrap();
        offer.sdp
    }

    /// Der Kern: die gerechnete Stufe steht im SDP, und zwei Bildgroessen
    /// erzeugen zwei verschiedene Angebote. Bis 2026-08-12 waren sie Zeichen
    /// fuer Zeichen gleich.
    #[tokio::test]
    async fn die_gerechnete_stufe_steht_im_angebot() {
        let s1440 = angebot("h264", 2560, 1440, 60).await;
        let s4k = angebot("h264", 3840, 2160, 60).await;
        assert!(s1440.contains("profile-level-id=640033"), "1440p60:\n{s1440}");
        assert!(s4k.contains("profile-level-id=640034"), "4K60:\n{s4k}");
        assert!(!s1440.contains("640034"));
        assert!(!s4k.contains("640033"));
    }

    /// Und nichts anderes daneben: die acht H.264-Fassungen der Vorgabeliste
    /// duerfen nicht mehr auftauchen — sonst darf der Empfaenger `42001f`
    /// (Baseline) waehlen, waehrend wir High mit CABAC senden.
    #[tokio::test]
    async fn keine_fremden_fassungen_mehr_im_angebot() {
        let sdp = angebot("h264", 2560, 1440, 60).await;
        for fremd in ["42001f", "42e01f", "640028", "640029", "64002a", "640032"] {
            assert!(!sdp.contains(fremd), "{fremd} steht noch im Angebot:\n{sdp}");
        }
        for fremd in ["VP8", "VP9", "H265", "ulpfec", "G722", "PCMU", "PCMA"] {
            assert!(!sdp.contains(fremd), "{fremd} steht noch im Angebot:\n{sdp}");
        }
    }

    /// Der Ton: `stereo=1` ist eine echte Zusage. Fehlt sie im Angebot, mischt
    /// der Empfaenger nach RFC 7587 auf mono — hoerbar, anders als die Stufe.
    #[tokio::test]
    async fn stereo_zusage_steht_im_angebot() {
        let sdp = angebot("h264", 1280, 720, 60).await;
        assert!(sdp.contains("stereo=1"), "{sdp}");
        assert!(sdp.contains("sprop-stereo=1"), "{sdp}");
        assert!(sdp.contains("opus/48000/2"), "{sdp}");
    }

    /// AV1 bleibt bei `profile-id=0` und behaelt seine Nutzlast-Nummer 41 —
    /// dieser Weg paketiert selbst und war vorher in Ordnung.
    #[tokio::test]
    async fn av1_angebot_bleibt_wie_es_war() {
        let sdp = angebot("av1", 2560, 1440, 60).await;
        assert!(sdp.contains("a=rtpmap:41 AV1/90000"), "{sdp}");
        assert!(sdp.contains("a=fmtp:41 profile-id=0"), "{sdp}");
        assert!(!sdp.contains("H264"), "{sdp}");
    }
}
