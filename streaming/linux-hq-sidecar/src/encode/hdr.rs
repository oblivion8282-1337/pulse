//! Wer HDR wirklich traegt — und die Absage fuer alle anderen.
//!
//! Gegenstueck zu `win-hq-sidecar/src/encode/hdr.rs` und aus demselben Grund
//! gebaut: **ein Strom, der unter dem Etikett „HDR" laeuft und in Wahrheit SDR
//! ist, ist schlimmer als ein Start, der abbricht.** Der Zuschauer sieht dann
//! ein Bild, das plausibel aussieht, nur flau — und sucht den Fehler bei seinem
//! Schirm.
//!
//! **Auf Linux haengt HDR an vier Dingen, und alle vier muessen stimmen:**
//!
//! 1. Der aufgenommene **Ausgang** laeuft in HDR mit PQ. Ablesbar an der
//!    DRM-Property `HDR_OUTPUT_METADATA` (`capture::kms`), nicht zu raten.
//! 2. Die Aufnahme laeuft ueber den **Scanout** (DRM/KMS). Der Portal-Weg
//!    scheidet aus: KWins ScreenCast fuehrt nur 8-Bit-Formate und liefert bei
//!    eingeschaltetem HDR ein byte-identisches SDR-Bild (Messakte
//!    `hdr-2026-08-07-machbarkeit-linux-nvidia.json`).
//! 3. Der **Encoder** traegt HDR bis in den Strom — Tabelle unten.
//! 4. Es wird in **10 bit** encodiert. Keine zusaetzliche Bedingung, sondern
//!    eine Folge: PQ verteilt seine Codewerte ueber 0,0001 bis 10 000 cd/m2,
//!    und in 8 bit stuenden dafuer 256 Stufen zur Verfuegung. HDR schaltet
//!    10 bit deshalb selbst ein, statt es vom Nutzer zu verlangen.
//!
//! **Warum hier eine Tabelle steht und keine Abfrage.** Dieselbe Erfahrung wie
//! beim Intra-Refresh und auf Windows: `avcodec_open2` nimmt Farbfelder, die
//! der Encoder nicht weiterreicht, klaglos entgegen. Was ein Encoder wirklich
//! tut, steht am fertigen Strom — und was hier steht, ist dort nachgesehen.

use anyhow::{Result, bail};
use ffmpeg_next as ffmpeg;

use crate::capture::kms::HdrAngaben;
use crate::system::drm::Vendor;

/// Traegt dieser FFmpeg-Encoder eine HDR-Signalisierung bis in den Strom?
///
/// `false` heisst **nicht** „die Hardware kann es nicht" — es heisst „wir haben
/// es hier nicht belegt". Der Unterschied steht je Zeile dabei, damit niemand
/// eine Absage fuer ein Naturgesetz haelt.
fn traegt_hdr(encoder: &str) -> bool {
    match encoder {
        // **Der belegte Weg.** Am Bitstrom nachgewiesen (IVF, also ein
        // Container ohne eigene Farbtags, gelesen mit `trace_headers`):
        // `high_bitdepth=1`, `color_primaries=9` (BT.2020),
        // `transfer_characteristics=16` (SMPTE ST 2084),
        // `matrix_coefficients=9`, `color_range=0`. Messakte
        // `hdr-2026-08-07-machbarkeit-linux-nvidia.json`, Befund M8.
        //
        // Die Falle dazu steht in Befund M9 derselben Akte und ist der Grund,
        // warum `signalisieren` die Felder am Codec-Kontext setzt und nicht als
        // Encoder-Option uebergibt: als reine Option bleiben Primaervalenzen
        // und Transferkurve auf „unspecified", der Strom BEHAUPTET dann HDR und
        // laesst die beiden entscheidenden Felder leer.
        "av1_nvenc" => true,
        // Alles andere: nein, und zwar begruendet.
        //
        // * `h264_nvenc`/`h264_vaapi` — HDR verlangt 10 bit (s. Modul-Kopf),
        //   und 10-bit-H.264 waere High 10, das kein Browser dekodiert.
        //   `ops::start` schiebt jeden 10-bit-Wunsch ohne AV1 ohnehin auf 8 bit
        //   zurueck. Es ist also keine Encoder-Grenze, sondern eine
        //   Produktentscheidung weiter oben.
        // * `av1_vaapi` — **ungemessen, nicht ausgeschlossen.** Der 10-bit-Weg
        //   ueber `scale_vaapi=format=p010` laeuft (Messung 2026-08-04), und
        //   Mesa reicht Farbfelder grundsaetzlich durch. Was fehlt, ist ein
        //   Lauf auf einer AMD-Karte an einem HDR-Schirm — und die Frage, ob
        //   der Scanout dort ebenso in PQ vorliegt. Bis den jemand gemacht hat,
        //   waere ein `true` hier eine Behauptung.
        _ => false,
    }
}

/// Der Encoder-Name, den diese Kombination wirklich oeffnen wuerde.
///
/// Bewusst ueber dieselbe Zuordnung wie der Encoder-Aufbau
/// (`Vendor::encoder_family` + Codec-Kuerzel): zwei Fassungen davon liefen mit
/// dem naechsten Encode-Weg auseinander, und dann meldete eine Stelle eine
/// Faehigkeit fuer einen Encoder, den die andere gar nicht startet.
fn encoder_name(vendor: Vendor, codec: &str) -> String {
    format!("{codec}_{}", vendor.encoder_family())
}

/// Kann diese Maschine ueberhaupt HDR senden — unabhaengig davon, ob gerade ein
/// Schirm in HDR laeuft?
///
/// Das ist die Frage, die `health.gsr.hdr` beantwortet, und sie ist bewusst die
/// **Geraete**-Frage: die Oberflaeche soll das Kaestchen anbieten duerfen, auch
/// wenn HDR am Bildschirm gerade aus ist. Sonst verschwaende die Option spurlos
/// und niemand kaeme darauf, dass sie an einer Anzeigeeinstellung haengt. Ob
/// die konkrete Lage mitspielt, sagt [`pruefen`] beim Start.
pub fn verfuegbar(vendor: Vendor, codecs: &[impl AsRef<str>]) -> bool {
    codecs
        .iter()
        .any(|c| traegt_hdr(&encoder_name(vendor, c.as_ref())))
}

/// Dasselbe fuer die GPU dieses Rechners. Ohne erkannte Karte: nein.
pub fn verfuegbar_hier(codecs: &[impl AsRef<str>]) -> bool {
    crate::system::drm::detect().is_some_and(|(v, _)| verfuegbar(v, codecs))
}

/// Darf dieser Stream in HDR laufen? Liefert bei Ja die Angaben des Ausgangs,
/// die als Mastering-Metadaten in den Strom gehen.
///
/// Einmal je Start aufzurufen, **bevor** die Aufnahme beginnt: der
/// Aufnahmeweg haengt an der Antwort (Portal gegen Scanout), und eine Aufnahme,
/// die schon ueber das Portal laeuft, liesse sich hinterher nicht mehr retten.
///
/// Die Meldungen nennen jeweils die Abhilfe, nicht nur den Befund. Ein „HDR
/// nicht verfuegbar" ohne Grund fuehrt zu Fehlersuche an der falschen Stelle.
pub fn pruefen(vendor: Vendor, codec: &str, ausgang: &crate::capture::kms::Ausgang) -> Result<HdrAngaben> {
    let encoder = encoder_name(vendor, codec);
    if !traegt_hdr(&encoder) {
        bail!(
            "HDR verlangt, aber '{encoder}' traegt es nicht bis in den Strom. Belegt ist heute \
             allein AV1 ueber NVENC; AMD/Intel sind ungemessen, nicht ausgeschlossen. \
             Abhilfe: AV1 waehlen. Begruendung je Encoder: encode/hdr.rs"
        );
    }
    let Some(angaben) = ausgang.hdr else {
        bail!(
            "HDR verlangt, aber der Ausgang '{}' meldet keine HDR-Angaben (DRM-Property \
             HDR_OUTPUT_METADATA ist nicht gesetzt). Die Aufnahme bekaeme dann gewoehnliche \
             SDR-Bildpunkte, und der Strom truege das HDR-Etikett trotzdem. Abhilfe: HDR fuer \
             diesen Bildschirm einschalten (Plasma: Anzeige-Einstellungen, oder \
             `kscreen-doctor output.{}.hdr.enable`).",
            ausgang.name, ausgang.name
        );
    };
    if !angaben.ist_pq() {
        bail!(
            "HDR verlangt, aber der Ausgang '{}' laeuft mit der Transferkurve {} statt mit PQ \
             (SMPTE ST 2084). Wir signalisieren ausschliesslich PQ; HLG oder ein \
             HDR-Gamma unter PQ-Etikett waere beim Zuschauer sichtbar falsch.",
            ausgang.name, angaben.eotf
        );
    }
    Ok(angaben)
}

/// Die Farb-Signalisierung, die in den AV1-Sequenzkopf geht.
///
/// Das ist der **wichtigere** der beiden Teile: ohne diese vier Angaben deutet
/// jeder Zuschauer den Strom als BT.709/SDR, und alles Weitere ist einerlei.
/// Sie werden einmal beim Oeffnen gesetzt, nicht je Bild — der Sequenzkopf
/// entsteht einmal.
///
/// Der Wertebereich bleibt **Studio** und ist hier bewusst mit aufgefuehrt: er
/// muss zu dem passen, was der Shader davor schreibt
/// (`nv_p010`, begrenzter Bereich). Steht an einer der beiden Stellen etwas
/// anderes, ist das Bild um den Faktor 219/255 zu flau oder zu hart — ein
/// Fehler, den man dem Encoder anlastet.
pub fn signalisieren(encoder: &mut ffmpeg::encoder::video::Video) {
    encoder.set_colorspace(ffmpeg::color::Space::BT2020NCL);
    encoder.set_color_range(ffmpeg::color::Range::MPEG);
    // Fuer Primaervalenzen und Transferkurve gibt es in `ffmpeg-next` keine
    // Setzer, nur Leser — deshalb direkt ins Feld. Ohne sie ist alles andere
    // umsonst: `colorspace` allein sagt nur, wie aus YCbCr wieder RGB wird.
    unsafe {
        let ctx = encoder.as_mut_ptr();
        (*ctx).color_primaries = ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT2020;
        (*ctx).color_trc = ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_SMPTE2084;
    }
    tracing::info!(
        target: "stream",
        "HDR-Signalisierung: BT.2020 mit PQ (SMPTE 2084), Studio-Bereich"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::kms::{Ausgang, EOTF_SMPTE_ST2084};

    fn angaben(eotf: u8) -> HdrAngaben {
        HdrAngaben {
            eotf,
            primaries: [(34000, 16000), (13250, 34500), (7500, 3000)],
            weisspunkt: (15635, 16450),
            max_leuchtdichte: 400,
            min_leuchtdichte: 1,
            max_cll: 400,
            max_fall: 200,
        }
    }

    fn ausgang(hdr: Option<HdrAngaben>) -> Ausgang {
        Ausgang { name: "DP-2".into(), crtc_id: 1, hdr }
    }

    /// Auf NVIDIA traegt nur AV1 HDR — H.264 nicht, und zwar nicht wegen der
    /// Hardware, sondern weil 10-bit-H.264 kein Browser dekodiert.
    #[test]
    fn auf_nvidia_traegt_nur_av1_hdr() {
        assert!(traegt_hdr("av1_nvenc"));
        assert!(!traegt_hdr("h264_nvenc"));
    }

    /// Ungemessen heisst Nein. Der Test steht hier, damit ein spaeteres `true`
    /// fuer VAAPI eine bewusste Aenderung ist und nicht als Nebenwirkung
    /// hereinrutscht — zusammen mit der Messung, die es dann traegt.
    #[test]
    fn vaapi_ist_hier_noch_nein() {
        assert!(!verfuegbar(Vendor::Amd, &["av1", "h264"]));
        assert!(!verfuegbar(Vendor::Intel, &["av1"]));
        assert!(verfuegbar(Vendor::Nvidia, &["h264", "av1"]));
        assert!(!verfuegbar(Vendor::Nvidia, &["h264"]));
    }

    #[test]
    fn ohne_hdr_am_ausgang_wird_der_start_verweigert() {
        let e = pruefen(Vendor::Nvidia, "av1", &ausgang(None)).unwrap_err().to_string();
        assert!(e.contains("HDR_OUTPUT_METADATA"), "{e}");
        assert!(e.contains("kscreen-doctor"), "die Abhilfe gehoert in die Meldung: {e}");
    }

    /// HLG und traditionelles HDR-Gamma sind HDR, aber nicht das, was wir
    /// signalisieren — beides muss absagen statt still PQ zu behaupten.
    #[test]
    fn nur_pq_wird_angenommen() {
        for eotf in [0u8, 1, 3] {
            let a = ausgang(Some(angaben(eotf)));
            assert!(pruefen(Vendor::Nvidia, "av1", &a).is_err(), "eotf={eotf}");
        }
        let a = ausgang(Some(angaben(EOTF_SMPTE_ST2084)));
        assert_eq!(pruefen(Vendor::Nvidia, "av1", &a).unwrap().max_cll, 400);
    }

    #[test]
    fn falscher_codec_sagt_ab_bevor_der_schirm_gefragt_wird() {
        let e = pruefen(Vendor::Nvidia, "h264", &ausgang(Some(angaben(EOTF_SMPTE_ST2084))))
            .unwrap_err()
            .to_string();
        assert!(e.contains("AV1 waehlen"), "{e}");
    }
}
