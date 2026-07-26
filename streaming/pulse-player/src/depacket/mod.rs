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

/// Zusammensetzer fuer genau einen Track.
pub enum Assembler {
    Av1(av1::Av1Assembler),
    H264 { depacketizer: Box<H264Packet>, unit: BytesMut, dropped: bool },
    /// Opus: ein RTP-Paket ist genau ein Frame, nichts zusammenzusetzen.
    Opus,
}

impl Assembler {
    pub fn for_codec(codec: Codec) -> Self {
        match codec {
            Codec::Av1 => Self::Av1(av1::Av1Assembler::new()),
            Codec::H264 => Self::H264 {
                depacketizer: Box::new(H264Packet::default()),
                unit: BytesMut::new(),
                dropped: false,
            },
            Codec::Opus => Self::Opus,
        }
    }

    /// Meldet eine Luecke im Paketstrom (der Jitter-Puffer hat aufgegeben).
    /// Angefangene Einheiten werden verworfen — ein halber Frame ergibt keinen
    /// gueltigen Bitstrom.
    pub fn on_gap(&mut self) {
        match self {
            Self::Av1(a) => a.on_gap(),
            Self::H264 { unit, dropped, .. } => {
                unit.clear();
                *dropped = true;
            }
            Self::Opus => {}
        }
    }

    /// Verarbeitet ein Paket; liefert eine fertige Einheit, sobald der Marker
    /// das Ende signalisiert.
    pub fn push(&mut self, payload: &Bytes, marker: bool) -> Option<Bytes> {
        match self {
            Self::Av1(a) => a.push(payload, marker),
            Self::H264 { depacketizer, unit, dropped } => {
                match depacketizer.depacketize(payload) {
                    // Der H264-Depacketizer liefert bereits Annex-B mit
                    // Startcodes; anhaengen reicht.
                    Ok(nal) => unit.extend_from_slice(&nal),
                    Err(_) => *dropped = true,
                }
                if !marker {
                    return None;
                }
                let bad = *dropped;
                *dropped = false;
                let out = unit.split().freeze();
                (!bad && !out.is_empty()).then_some(out)
            }
            Self::Opus => (!payload.is_empty()).then(|| payload.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_reicht_paket_direkt_durch() {
        let mut a = Assembler::for_codec(Codec::Opus);
        let p = Bytes::from_static(&[1, 2, 3]);
        assert_eq!(a.push(&p, true).as_deref(), Some(&[1u8, 2, 3][..]));
    }

    #[test]
    fn opus_verwirft_leere_pakete() {
        let mut a = Assembler::for_codec(Codec::Opus);
        assert!(a.push(&Bytes::new(), true).is_none());
    }

    #[test]
    fn h264_sammelt_bis_marker() {
        let mut a = Assembler::for_codec(Codec::H264);
        // Single-NAL-Unit-Paket (Typ 1), vom Depacketizer mit Startcode versehen.
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        assert!(a.push(&nal, false).is_none(), "ohne Marker keine Einheit");
        let out = a.push(&nal, true).expect("Marker schliesst die Einheit ab");
        assert!(out.len() > nal.len(), "beide Pakete muessen drin sein");
    }

    #[test]
    fn gap_verwirft_h264_einheit() {
        let mut a = Assembler::for_codec(Codec::H264);
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        a.push(&nal, false);
        a.on_gap();
        assert!(a.push(&nal, true).is_none(), "nach Luecke keine Teil-Einheit");
        assert!(a.push(&nal, true).is_some(), "danach wieder normal");
    }
}
