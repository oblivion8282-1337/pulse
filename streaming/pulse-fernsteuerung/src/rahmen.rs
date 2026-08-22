//! Frame-Format der Fernsteuerung — Parser, rein und plattformunabhängig.
//!
//! Verbindlich ist `docs/plans/2026-08-12-input-wire-protokoll-v2.md`. Little-
//! endian, Byte 0 = Opcode, **feste** Längen. Der Slot steckt **nicht** im
//! Frame, sondern in der Hülle (`remote_input`-Op bzw. Hello des
//! DataChannel-Weges) — deshalb nimmt `parse` ihn auch nicht entgegen: alle
//! Frames einer Nachricht gehen ohnehin an dasselbe Ziel, und ein Feld je Frame
//! kostete bei 60 Bewegungen je Sekunde ohne Gegenwert.
//!
//! Ein Fehler hier ist **nie** verzeihlich: unbekannter Opcode oder falsche
//! Länge → der Aufrufer legt die Sitzung still (fail-closed). Die Eingabe kommt
//! vom einzigen, per Consent bestätigten Gegenüber; alles Missgeformte ist ein
//! Fehler oder ein Angriff, und in beiden Fällen ist Beenden richtiger als
//! Raten.

use crate::format::*;

/// Ein dekodierter Eingabe-Frame. Koordinaten/Deltas sind noch roh (0..65535
/// normiert bzw. Pixel-/Rasteinheiten) — die Umrechnung aufs Quell-Rechteck
/// macht die Zuordnung (`super::zuordnung`), nicht der Parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputFrame {
    /// `0x00` — Handschlag, MUSS der erste Frame der Sitzung sein.
    Hello { version: u8 },
    /// `0x01` — absolute Maus, x/y ∈ 0..65535 normiert **aufs Videobild des
    /// gemeinten Slots**, nicht auf den Desktop des Hosts.
    MouseMoveAbs { x: u16, y: u16 },
    /// `0x02` — relative Maus (Zeigerfang), Pixel-Delta.
    MouseMoveRel { dx: i16, dy: i16 },
    /// `0x03` — Maustaste. `btn`: 0=links 1=rechts 2=mitte 3=X1 4=X2.
    MouseButton { btn: u8, down: bool },
    /// `0x04` — Mausrad in Windows-Rastschritten (120 = eine Raste), `dv`
    /// senkrecht, `dh` waagerecht, Windows-Vorzeichen (dv>0 = vom Nutzer weg).
    MouseWheel { dv: i16, dh: i16 },
    /// `0x05` — Taste per Windows Scancode Satz 1, erweiterte als `0xE0xx`.
    Key { scan: u16, down: bool },
}

/// Warum ein Frame nicht dekodierbar war — beides führt zu fail-closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Leerer Frame oder unbekanntes Opcode-Byte.
    UnknownOpcode(Option<u8>),
    /// Bekanntes Opcode, aber falsche Byte-Länge.
    BadLength { opcode: u8, expected: usize, got: usize },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::UnknownOpcode(None) => write!(f, "leerer Frame"),
            ParseError::UnknownOpcode(Some(op)) => write!(f, "unbekannter Opcode {op:#04x}"),
            ParseError::BadLength { opcode, expected, got } => write!(
                f,
                "Opcode {opcode:#04x} verlangt {expected} Byte, bekam {got}"
            ),
        }
    }
}

impl InputFrame {
    /// Little-endian, Byte 0 = Opcode, feste Längen. Fehler → der Aufrufer legt
    /// die Sitzung still (fail-closed).
    pub fn parse(data: &[u8]) -> Result<InputFrame, ParseError> {
        let opcode = *data.first().ok_or(ParseError::UnknownOpcode(None))?;
        // Exakte Länge je Opcode — zu lang ist genauso ungültig wie zu kurz.
        let check = |expected: usize| -> Result<(), ParseError> {
            if data.len() == expected {
                Ok(())
            } else {
                Err(ParseError::BadLength { opcode, expected, got: data.len() })
            }
        };
        let le_u16 = |off: usize| u16::from_le_bytes([data[off], data[off + 1]]);
        let le_i16 = |off: usize| i16::from_le_bytes([data[off], data[off + 1]]);
        match opcode {
            OP_HELLO => {
                check(2)?;
                Ok(InputFrame::Hello { version: data[1] })
            }
            OP_MAUS_ABS => {
                check(5)?;
                Ok(InputFrame::MouseMoveAbs { x: le_u16(1), y: le_u16(3) })
            }
            OP_MAUS_REL => {
                check(5)?;
                Ok(InputFrame::MouseMoveRel { dx: le_i16(1), dy: le_i16(3) })
            }
            OP_MAUS_KNOPF => {
                check(3)?;
                Ok(InputFrame::MouseButton { btn: data[1], down: data[2] != 0 })
            }
            OP_MAUS_RAD => {
                check(5)?;
                Ok(InputFrame::MouseWheel { dv: le_i16(1), dh: le_i16(3) })
            }
            OP_TASTE => {
                check(4)?;
                Ok(InputFrame::Key { scan: le_u16(1), down: data[3] != 0 })
            }
            other => Err(ParseError::UnknownOpcode(Some(other))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_traegt_die_version() {
        assert_eq!(
            InputFrame::parse(&[0x00, 2]),
            Ok(InputFrame::Hello { version: 2 })
        );
    }

    /// Die Version wird vom Parser **nicht** bewertet — das tut die Sitzung
    /// (`crate::sitzung::Sitzung`). Ein v1-Hello ist also wohlgeformt und wird
    /// erst eine Ebene höher abgewiesen.
    #[test]
    fn hello_v1_ist_wohlgeformt_aber_alt() {
        assert_eq!(
            InputFrame::parse(&[0x00, 1]),
            Ok(InputFrame::Hello { version: 1 })
        );
        assert_ne!(1, PROTOKOLL_VERSION);
    }

    #[test]
    fn maus_abs_ist_little_endian() {
        // x = 0x0201 = 513, y = 0x0403 = 1027
        assert_eq!(
            InputFrame::parse(&[0x01, 0x01, 0x02, 0x03, 0x04]),
            Ok(InputFrame::MouseMoveAbs { x: 513, y: 1027 })
        );
    }

    #[test]
    fn maus_rel_ist_vorzeichenbehaftet() {
        assert_eq!(
            InputFrame::parse(&[0x02, 0xFF, 0xFF, 0x01, 0x00]),
            Ok(InputFrame::MouseMoveRel { dx: -1, dy: 1 })
        );
    }

    #[test]
    fn maustaste_runter_und_hoch() {
        assert_eq!(
            InputFrame::parse(&[0x03, 1, 1]),
            Ok(InputFrame::MouseButton { btn: 1, down: true })
        );
        assert_eq!(
            InputFrame::parse(&[0x03, 0, 0]),
            Ok(InputFrame::MouseButton { btn: 0, down: false })
        );
    }

    #[test]
    fn rad_ist_vorzeichenbehaftet() {
        assert_eq!(
            InputFrame::parse(&[0x04, 120, 0, 0, 0]),
            Ok(InputFrame::MouseWheel { dv: 120, dh: 0 })
        );
    }

    #[test]
    fn taste_mit_erweiterungs_praefix() {
        // scan = 0xE01D (rechte Strg-Taste), runter
        assert_eq!(
            InputFrame::parse(&[0x05, 0x1D, 0xE0, 1]),
            Ok(InputFrame::Key { scan: 0xE01D, down: true })
        );
    }

    #[test]
    fn unbekanntes_opcode_wird_abgewiesen() {
        assert_eq!(
            InputFrame::parse(&[0x7F, 0, 0]),
            Err(ParseError::UnknownOpcode(Some(0x7F)))
        );
    }

    #[test]
    fn leerer_frame_wird_abgewiesen() {
        assert_eq!(InputFrame::parse(&[]), Err(ParseError::UnknownOpcode(None)));
    }

    #[test]
    fn zu_kurz_wird_abgewiesen() {
        assert_eq!(
            InputFrame::parse(&[0x01, 0x00, 0x00]),
            Err(ParseError::BadLength { opcode: 0x01, expected: 5, got: 3 })
        );
    }

    /// Zu lang ist genauso ungültig wie zu kurz — sonst könnte ein Sender an
    /// einen wohlgeformten Frame Bytes anhängen, die niemand ansieht.
    #[test]
    fn zu_lang_wird_abgewiesen() {
        assert!(InputFrame::parse(&[0x03, 0, 0, 99]).is_err());
    }
}
