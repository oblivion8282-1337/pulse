//! Die Bildspur des Direktpfad-Senders: Auftrags-Konfiguration, Paketierer-
//! Wahl und Takt-Rechnung.
//!
//! **Warum getrennt vom Sender** ([`super`]): das sind die RECHNUNGEN und
//! Behälter — der Sender selbst ist Lebensdauer, Aushandlung und PC. Die
//! Stücke hier sind die, die der WHIP-Sender der Sidecars seit je
//! mitführt (`Bildspur`, `dauer_fuer_takte` dort); sie stehen hier einmal
//! statt ein zweites Mal je Weg.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use webrtc::rtp::codecs::h264::H264Payloader;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;

use crate::av1::SpurZustand;
use crate::pacer;

/// Eine Dauer, aus der webrtc-rs **genau** `takte` RTP-Takte macht. Dieselbe
/// Falle wie im WHIP-Sender (`dauer_fuer_takte` dort): `as u32` schneidet ab,
/// 1/30 s mal 90000 ergibt in f64 2999,999… und daraus wird 2999 — 20 ms je
/// Minute Wanderung, ohne dass ein Fehler auftaucht. Die halbe Takt-Zugabe
/// ist dort gemessen und begründet; hier gilt dieselbe Rechnung für den Ton.
pub fn dauer_fuer_takte(takte: u32, uhr: u32) -> Duration {
    let ns = (f64::from(takte) + 0.5) * 1e9 / f64::from(uhr);
    Duration::from_nanos(ns.round() as u64)
}

/// Wie ein encodiertes Bild in RTP-Nutzlasten zerfaellt. Derselbe Schnitt wie
/// im WHIP-Sender: der eigene AV1-Paketierer, webrtc-rs' H.264-Zerleger.
pub(super) enum Paketierer {
    Av1,
    H264(H264Payloader),
}

/// Soll gegen Ist des Taktgebers ins Protokoll — Form und Begruendung im
/// WHIP-Sender (`melde_verteilung` dort). Nur das Etikett unterscheidet sich.
pub(super) fn melde_verteilung(soll_ms: f64, ist_ms: f64, pakete: usize) {
    eprintln!(
        "[direct] Verteilung je Bild: soll {soll_ms:.2} ms, ist {ist_ms:.2} ms ({pakete} Pakete)"
    );
}

/// Was der Aufbau über den Strom wissen muss. Die Maße sind die des ANGEBOTS
/// (fmtp-Stufe), nicht die der Aufnahme — die steht beim Aushandeln noch
/// nicht fest; eine zu HOCH angesetzte H.264-Stufe ist folgenlos, eine zu
/// niedrige die dokumentierte Fehlerklasse (`crate::sdp::codec_capability`).
#[derive(Debug, Clone)]
pub struct Konfig {
    /// Codec-Kurzname wie im `start`-Request — `"h264"` oder `"av1"`.
    pub codec_slug: &'static str,
    pub fps: u32,
    pub breite: u32,
    pub hoehe: u32,
    /// Ziel-Bitrate — Maßstab für die REMB-Einordnung beim Aufrufer.
    pub bitrate_kbps: u32,
}

/// Die Bildspur: Zustand + Paketierer + Taktgeber, Form wie im WHIP-Sender.
pub(super) struct Bildspur {
    /// Zeitstempel-/Sequenz-Zustand + Paketierer unter EINEM Lock — beides
    /// wird pro Bild in einem Zug gebraucht.
    pub(super) zustand: Mutex<(SpurZustand, Paketierer)>,
    /// Verteilt die Pakete eines Bildes ueber die Zeit statt sie als Schwall
    /// zu senden (Zahlen in [`pacer`]). `PULSE_WHIP_PACING=0` schaltet auch
    /// hier die Verteilung zum Gegenmessen ab.
    pub(super) pacer: Option<pacer::Pacer>,
    pub(super) track: Arc<TrackLocalStaticRTP>,
}

#[cfg(test)]
mod tests {
    use super::dauer_fuer_takte;
    use std::time::Duration;

    /// **Genau die Rechnung, die webrtc-rs anstellt** — nachgebaut, damit der
    /// Test die Falle prueft und nicht unsere Absicht (Kopie aus dem
    /// WHIP-Sender, wo der gemessene Ursprung steht).
    fn wie_webrtc_rs(dauer: Duration, uhr: u32) -> u32 {
        (dauer.as_secs_f64() * f64::from(uhr)) as u32
    }

    /// Fuer jede Bildrate, die hier vorkommt, muss die berichtigte Rechnung
    /// den Takt treffen.
    #[test]
    fn dauer_fuer_takte_trifft_den_takt() {
        for fps in [24u32, 25, 30, 50, 60, 90, 120, 144] {
            let takte = (90_000 + fps / 2) / fps;
            let d = dauer_fuer_takte(takte, 90_000);
            assert_eq!(wie_webrtc_rs(d, 90_000), takte, "fps {fps}");
            let soll = f64::from(takte) / 90_000.0;
            assert!((d.as_secs_f64() - soll).abs() < 6e-6, "fps {fps} zu weit weg");
        }
    }

    /// Und für den Ton, ueber alle zulaessigen Opus-Paketlaengen.
    #[test]
    fn dauer_fuer_takte_trifft_auch_den_ton() {
        for ms in [2.5f64, 5.0, 10.0, 20.0, 40.0, 60.0] {
            let takte = (ms * 48.0).round() as u32;
            let d = dauer_fuer_takte(takte, 48_000);
            assert_eq!(wie_webrtc_rs(d, 48_000), takte, "{ms} ms");
        }
    }
}
