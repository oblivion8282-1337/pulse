//! Zusammensetzen von Zugriffseinheiten aus (bereits sortierten) RTP-Paketen.
//!
//! Bewusst nicht ueber `webrtc::media::io::sample_builder::SampleBuilder`:
//! der bringt sein eigenes Umsortieren mit und versteckt damit genau die
//! Puffer-Entscheidung, die dieser Player steuerbar machen soll. Sortiert wird
//! eine Stufe frueher in [`crate::jitter`]; hier geht es nur noch um
//! Codec-Grammatik.

pub mod av1;

use bytes::{Bytes, BytesMut};
use webrtc::rtp::codecs::h264::H264Packet;
use webrtc::rtp::packetizer::Depacketizer;

use crate::whep::Codec;

/// Obergrenze fuer eine im Aufbau befindliche Zugriffseinheit.
///
/// Der AV1-Pfad hat sein eigenes Pendant (`av1::MAX_TEMPORAL_UNIT_BYTES`); hier
/// gilt dasselbe fuer H.264. Ohne die Grenze laesst ein Sender, der nie ein
/// Marker-Bit setzt, den Speicher volllaufen — die Einheit wird ja nur beim
/// Marker freigegeben.
const MAX_ACCESS_UNIT_BYTES: usize = 32 * 1024 * 1024;

/// Codec-abhaengiger Teil des Zusammensetzens.
enum Kind {
    Av1(av1::Av1Assembler),
    H264 { depacketizer: Box<H264Packet>, unit: BytesMut, dropped: bool },
    /// Opus: ein RTP-Paket ist genau ein Frame, nichts zusammenzusetzen.
    Opus,
}

/// Zusammensetzer fuer genau einen Track.
///
/// **Prueft die Sequenznummern selbst.** Der Jitter-Puffer davor meldet Luecken
/// per [`Assembler::on_gap`], und er tut das an allen drei Stellen, an denen er
/// Pakete ueberspringt. Trotzdem haengt die Korrektheit damit an der Sorgfalt
/// des Aufrufers, und die Folge eines vergessenen Aufrufs ist kein Fehler,
/// sondern *stiller Bildmuell*: bei einem verlorenen MITTLEREN Fragment traegt
/// das ueberlebende Fortsetzungspaket selbst `Z=1`, die Z/Y-Pruefung sieht also
/// nichts Verdaechtiges und klebt zwei Haelften verschiedener OBUs zusammen.
/// Gegen echte AV1-Daten gemessen (2026-07-28): 4450 ausgelieferte Byte, nicht
/// identisch mit dem Original.
///
/// Deshalb hier die zweite Linie — sie kostet einen `u16`-Vergleich je Paket
/// und macht die Zusicherung lokal statt verteilt.
pub struct Assembler {
    kind: Kind,
    /// Sequenznummer des zuletzt verarbeiteten Pakets; `None` vor dem ersten.
    last_seq: Option<u16>,
}

impl Assembler {
    pub fn for_codec(codec: Codec) -> Self {
        let kind = match codec {
            Codec::Av1 => Kind::Av1(av1::Av1Assembler::new()),
            Codec::H264 => Kind::H264 {
                depacketizer: Box::new(H264Packet::default()),
                unit: BytesMut::new(),
                dropped: false,
            },
            Codec::Opus => Kind::Opus,
        };
        Self { kind, last_seq: None }
    }

    /// Aktuelle Groesse der im Aufbau befindlichen Einheit — fuer Tests und
    /// Diagnose.
    #[cfg(test)]
    pub fn buffered_len(&self) -> usize {
        match &self.kind {
            Kind::H264 { unit, .. } => unit.len(),
            _ => 0,
        }
    }

    /// Meldet eine Luecke im Paketstrom (der Jitter-Puffer hat aufgegeben).
    /// Angefangene Einheiten werden verworfen — ein halber Frame ergibt keinen
    /// gueltigen Bitstrom.
    pub fn on_gap(&mut self) {
        match &mut self.kind {
            Kind::Av1(a) => a.on_gap(),
            Kind::H264 { unit, dropped, .. } => {
                unit.clear();
                *dropped = true;
            }
            Kind::Opus => {}
        }
    }

    /// Verarbeitet ein Paket; liefert eine fertige Einheit, sobald der Marker
    /// das Ende signalisiert.
    ///
    /// `seq` ist die RTP-Sequenznummer. Ist sie nicht die unmittelbare
    /// Fortsetzung der vorigen, wird die angefangene Einheit verworfen — auch
    /// wenn niemand [`on_gap`](Self::on_gap) gerufen hat. Doppelte Meldung
    /// (Jitter-Puffer *und* diese Pruefung) ist harmlos: beide verwerfen
    /// dasselbe.
    pub fn push(&mut self, seq: u16, payload: &Bytes, marker: bool) -> Option<Bytes> {
        // `wrapping_add`, weil die Sequenznummer bei 65535 umlaeuft — das ist
        // der Normalfall alle gut 18 Minuten bei 60 fps, kein Sonderfall.
        if self.last_seq.is_some_and(|prev| seq != prev.wrapping_add(1)) {
            self.on_gap();
        }
        self.last_seq = Some(seq);

        match &mut self.kind {
            Kind::Av1(a) => a.push(payload, marker),
            Kind::H264 { depacketizer, unit, dropped } => {
                match depacketizer.depacketize(payload) {
                    // Der H264-Depacketizer liefert bereits Annex-B mit
                    // Startcodes; anhaengen reicht.
                    Ok(nal) => unit.extend_from_slice(&nal),
                    Err(_) => *dropped = true,
                }
                if unit.len() > MAX_ACCESS_UNIT_BYTES {
                    // Der Marker ist offenbar verlorengegangen. Verwerfen ist
                    // besser als weiterwachsen.
                    unit.clear();
                    *dropped = true;
                }
                if !marker {
                    return None;
                }
                let bad = std::mem::take(dropped);
                let out = unit.split().freeze();
                (!bad && !out.is_empty()).then_some(out)
            }
            Kind::Opus => (!payload.is_empty()).then(|| payload.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fortlaufende Sequenznummern ab 1 — der Normalfall.
    fn folge(n: u16) -> impl FnMut() -> u16 {
        let mut i = n;
        move || {
            let v = i;
            i = i.wrapping_add(1);
            v
        }
    }

    #[test]
    fn opus_reicht_paket_direkt_durch() {
        let mut a = Assembler::for_codec(Codec::Opus);
        let p = Bytes::from_static(&[1, 2, 3]);
        assert_eq!(a.push(1, &p, true).as_deref(), Some(&[1u8, 2, 3][..]));
    }

    #[test]
    fn opus_verwirft_leere_pakete() {
        let mut a = Assembler::for_codec(Codec::Opus);
        assert!(a.push(1, &Bytes::new(), true).is_none());
    }

    #[test]
    fn h264_sammelt_bis_marker() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);
        // Single-NAL-Unit-Paket (Typ 1), vom Depacketizer mit Startcode versehen.
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        assert!(a.push(seq(), &nal, false).is_none(), "ohne Marker keine Einheit");
        let out = a.push(seq(), &nal, true).expect("Marker schliesst die Einheit ab");
        assert!(out.len() > nal.len(), "beide Pakete muessen drin sein");
    }

    /// Kern der zweiten Verteidigungslinie: ein Aufrufer, der die Luecke NICHT
    /// meldet, darf trotzdem keine zusammengeklebte Einheit bekommen. Ohne
    /// diese Pruefung lieferte der AV1-Pfad gegen echte Daten 4450 Byte
    /// Bildmuell aus (2026-07-28).
    #[test]
    fn sprung_in_der_sequenz_verwirft_auch_ohne_gap_meldung() {
        let mut a = Assembler::for_codec(Codec::H264);
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        a.push(1, &nal, false);
        // 2 fehlt, niemand meldet es.
        assert!(a.push(3, &nal, true).is_none(), "Einheit ueber die Luecke darf nicht raus");
        // Danach wieder regulaer.
        assert!(a.push(4, &nal, true).is_some(), "Erholung nach dem Sprung");
    }

    /// Die Sequenznummer laeuft bei 65535 um — bei 60 fps alle gut 18 Minuten.
    /// Wuerde der Umlauf als Luecke gelten, riss die Wiedergabe regelmaessig ab.
    #[test]
    fn sequenz_umlauf_ist_keine_luecke() {
        let mut a = Assembler::for_codec(Codec::H264);
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        a.push(u16::MAX, &nal, false);
        assert!(a.push(0, &nal, true).is_some(), "65535 -> 0 ist die regulaere Fortsetzung");
    }

    /// Regression: ohne Marker-Bit waechst die H.264-Einheit unbegrenzt.
    /// Der AV1-Pfad hat dafuer eine Obergrenze, der H.264-Pfad hatte keine —
    /// ein Sender, der nie ein Marker-Bit setzt, haette den Speicher
    /// leerlaufen lassen.
    #[test]
    fn h264_einheit_waechst_nicht_unbegrenzt() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);
        let nal = Bytes::from_static(&[0x41; 4096]);
        // Deutlich mehr als die Obergrenze einspeisen, nie ein Marker.
        for _ in 0..20_000 {
            assert!(a.push(seq(), &nal, false).is_none());
        }
        assert!(
            a.buffered_len() <= MAX_ACCESS_UNIT_BYTES,
            "Einheit waechst unbegrenzt: {} Bytes",
            a.buffered_len()
        );
    }

    #[test]
    fn gap_verwirft_h264_einheit() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        a.push(seq(), &nal, false);
        a.on_gap();
        assert!(a.push(seq(), &nal, true).is_none(), "nach Luecke keine Teil-Einheit");
        assert!(a.push(seq(), &nal, true).is_some(), "danach wieder normal");
    }
}
