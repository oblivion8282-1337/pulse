//! Aus RTP-Paketen wieder Bilder machen — je Codec anders.
//!
//! **Warum es das gibt.** Bis 2026-08-02 setzte das Messwerk jeden Strom mit
//! dem AV1-Sammler zusammen. Bei H.264 kam damit Unsinn heraus: 688 Pakete an,
//! 0 Bilder, 34 vom Decoder abgelehnt — und das sah nach einem kaputten Sender
//! aus, während der Server die Spur sauber als `H264` führte. Ein Messwerk, das
//! den Codec nicht unterscheidet, beschuldigt den Falschen.
//!
//! **Zwei Wege, weil der Sender zwei Wege hat.** AV1 paketiert das Labor selbst
//! (der `Av1Payloader` des `rtp`-Crates schreibt Längenfelder ab 128 falsch,
//! s. [`crate::whip::av1`]), also gibt es dafür einen eigenen Entpacker mit
//! Rundlauf-Tests. H.264 paketiert webrtc-rs — dann ist dessen `H264Packet` das
//! richtige Gegenstück, und ein zweiter Eigenbau wäre die schlechteste aller
//! Antworten.

use anyhow::{Result, bail};
use bytes::Bytes;
use webrtc::rtp::codecs::h264::H264Packet;
use webrtc::rtp::packetizer::Depacketizer;

use crate::whip::av1_entpacken::Sammler;

pub(super) enum Entpacker {
    Av1(Sammler),
    H264(H264Sammler),
}

impl Entpacker {
    /// Nach dem MIME-Typ der empfangenen Spur wählen.
    pub(super) fn fuer(mime: &str) -> Result<Self> {
        match mime.to_ascii_lowercase() {
            m if m.ends_with("av1") => Ok(Self::Av1(Sammler::default())),
            m if m.ends_with("h264") => Ok(Self::H264(H264Sammler::default())),
            other => bail!("kein Entpacker fuer {other}"),
        }
    }

    /// Eine RTP-Nutzlast einwerfen. `luecke` sagt, dass davor mindestens ein
    /// Paket fehlt; `marker` schliesst den Zeitabschnitt ab.
    ///
    /// **Der Fehler wird durchgereicht, nicht verschluckt.** Der AV1-Sammler
    /// meldet z.B. „Element-Laenge N reicht ueber das Paketende" — ein
    /// `unwrap_or(None)` machte daraus ein stilles „kein Abschnitt fertig",
    /// und ein kaputter Paketierer sähe dann aus wie ein Strom ohne Bilder.
    pub(super) fn schieb(
        &mut self,
        nutzlast: &Bytes,
        marker: bool,
        luecke: bool,
    ) -> Result<Option<Vec<u8>>> {
        match self {
            Self::Av1(s) => s.schieb(nutzlast, marker, luecke),
            Self::H264(s) => Ok(s.schieb(nutzlast, marker, luecke)),
        }
    }

    /// Abschnitte, die wegen einer Lücke verworfen wurden.
    pub(super) fn verworfen(&self) -> u64 {
        match self {
            Self::Av1(s) => s.verworfen,
            Self::H264(s) => s.verworfen,
        }
    }
}

/// Sammelt H.264-NAL-Einheiten bis zum Marker-Bit.
///
/// `H264Packet` löst Einzel-NAL, STAP-A und FU-A auf und liefert **Annex-B**
/// (mit Startcodes) — genau die Form, die der Decoder erwartet. Zusammensetzen
/// bis zum Marker muss der Aufrufer, weil ein Zugriffsblock über mehrere
/// Pakete geht.
#[derive(Default)]
pub(super) struct H264Sammler {
    entpacker: H264Packet,
    puffer: Vec<u8>,
    /// Ein Stück fehlt — der laufende Zugriffsblock ist unbrauchbar.
    ///
    /// **Wichtig, dass es das gibt:** ein Bild aus halben NALs sieht für den
    /// Decoder wie gültige Daten aus und führt zu Fehlern, die nach einem
    /// Encoder-Problem aussehen statt nach einem Verlust. Gleiche Überlegung
    /// wie beim AV1-Sammler.
    kaputt: bool,
    pub(super) verworfen: u64,
}

impl H264Sammler {
    fn schieb(&mut self, nutzlast: &Bytes, marker: bool, luecke: bool) -> Option<Vec<u8>> {
        if luecke {
            self.kaputt = true;
        }
        match self.entpacker.depacketize(nutzlast) {
            Ok(teil) => self.puffer.extend_from_slice(&teil),
            // Ein Paket, das der Entpacker nicht versteht, macht den ganzen
            // Block unbrauchbar — weiterzusammensetzen hiesse, dem Decoder
            // etwas vorzulegen, das nur zufällig noch gültig aussieht.
            Err(_) => self.kaputt = true,
        }
        if !marker {
            return None;
        }
        let fertig = std::mem::take(&mut self.puffer);
        if std::mem::replace(&mut self.kaputt, false) || fertig.is_empty() {
            self.verworfen += 1;
            return None;
        }
        Some(fertig)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waehlt_nach_mime() {
        assert!(matches!(Entpacker::fuer("video/AV1").unwrap(), Entpacker::Av1(_)));
        assert!(matches!(Entpacker::fuer("video/H264").unwrap(), Entpacker::H264(_)));
        assert!(Entpacker::fuer("video/VP9").is_err());
    }

    /// Einzel-NAL, mindestens drei Byte — kürzere lehnt `H264Packet` als
    /// `ErrShortPacket` ab (nur ein AUD darf zwei Byte haben). Genau diese
    /// Regel hat die erste Fassung dieser Tests umgeworfen.
    const IDR: &[u8] = &[0x65, 0x42, 0x43];
    const IDR2: &[u8] = &[0x65, 0x44, 0x45];

    /// Ein Einzel-NAL in einem Paket mit Marker ergibt genau einen Abschnitt,
    /// in Annex-B-Form.
    #[test]
    fn einzelnes_nal_kommt_mit_startcode_heraus() {
        let mut s = H264Sammler::default();
        let aus = s.schieb(&Bytes::from_static(IDR), true, false).expect("Marker schliesst ab");
        assert_eq!(aus, [&[0x00, 0x00, 0x00, 0x01][..], IDR].concat());
        assert_eq!(s.verworfen, 0);
    }

    /// **Eine Lücke muss den Block verwerfen, nicht durchreichen.** Sonst
    /// bekäme der Decoder ein halbes Bild und meldete einen Fehler, der wie ein
    /// Encoder-Problem aussieht.
    #[test]
    fn luecke_verwirft_den_block() {
        let mut s = H264Sammler::default();
        assert!(s.schieb(&Bytes::from_static(IDR), false, false).is_none());
        assert!(s.schieb(&Bytes::from_static(IDR2), true, true).is_none());
        assert_eq!(s.verworfen, 1);
    }

    /// Nach einer verworfenen Lücke muss der NÄCHSTE Block wieder durchkommen —
    /// sonst bliebe der Zuschauer für immer schwarz, auch wenn wieder alles
    /// ankommt.
    #[test]
    fn nach_der_luecke_geht_es_weiter() {
        let mut s = H264Sammler::default();
        assert!(s.schieb(&Bytes::from_static(IDR), true, true).is_none());
        assert!(s.schieb(&Bytes::from_static(IDR2), true, false).is_some());
        assert_eq!(s.verworfen, 1);
    }

    /// Ein Paket, das der Entpacker nicht versteht, macht den Block unbrauchbar
    /// — es darf NICHT stillschweigend übersprungen werden.
    #[test]
    fn unverstaendliches_paket_verwirft_den_block() {
        let mut s = H264Sammler::default();
        assert!(s.schieb(&Bytes::from_static(&[0x65]), true, false).is_none());
        assert_eq!(s.verworfen, 1);
    }
}
