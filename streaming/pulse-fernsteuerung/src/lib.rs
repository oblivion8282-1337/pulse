//! Der plattformfreie Kern der Pulse-Fernsteuerung.
//!
//! **Warum es diese Kiste gibt.** Bis zum 2026-08-22 lag der ganze Kern im
//! Windows-Sidecar, und der Player fuehrte seine eigene Fassung des
//! Frame-Formats. Mit dem mac-Sidecar als zweitem Host waeren daraus drei
//! Kopien geworden — darunter die Sitzungs-Zustandsmaschine, an der die
//! Sicherheitszusagen der Fernsteuerung haengen („alles loslassen beim Ende",
//! fail-closed, Hello heisst Neuanfang). Eine Kopie davon liefe still
//! auseinander, und der Schaden waere eine klemmende Taste auf einem fremden
//! Rechner.
//!
//! **Was hier NICHT steht:** alles, was ein Betriebssystem kennt. Der Schnitt
//! sind die drei Traits in `plattform` — Injektion, Wache, Umgebung. Wer eine
//! neue Plattform anschliesst, schreibt genau diese drei und sonst nichts.
//!
//! **Kein globaler Zustand.** Die Sitzung traegt ihre Plattform als Feld. Das
//! ist nicht Geschmack: die Tests brauchen dadurch keine prozessweite
//! Reihenfolge-Sperre, jeder bekommt eine frische Sitzung mit eigenem
//! Pruefstand.

pub mod base64;
pub mod bauen;
pub mod bewegung;
pub mod format;
pub mod rahmen;
pub mod zuordnung;

/// Sender und Empfaenger gegeneinander: was [`bauen`] erzeugt, muss [`rahmen`]
/// wieder auseinandernehmen koennen — und dasselbe herausbekommen.
///
/// **Diesen Test konnte es bis zum 2026-08-22 nicht geben.** Das Format stand
/// in zwei Kisten, die einander nicht sehen. Der Zeigerbild-Fehler vom
/// 2026-08-17 ist genau so entstanden: die eine Seite hielt eine Kurzform
/// fest, die andere verlangte Pflichtfelder, beide Testnetze gruen, und
/// niemand sah ueber die Grenze.
#[cfg(test)]
mod hin_und_zurueck {
    use crate::bauen;
    use crate::format::{Knopf, PROTOKOLL_VERSION};
    use crate::rahmen::InputFrame;

    fn zurueck(r: bauen::Rahmen) -> InputFrame {
        InputFrame::parse(r.as_slice()).expect("was der Sender baut, muss der Host lesen koennen")
    }

    #[test]
    fn hello() {
        assert_eq!(
            zurueck(bauen::hello()),
            InputFrame::Hello { version: PROTOKOLL_VERSION }
        );
    }

    #[test]
    fn maus_abs_ueber_den_ganzen_bereich() {
        for (x, y) in [(0u16, 0u16), (1, 2), (32767, 32768), (65535, 65535)] {
            assert_eq!(
                zurueck(bauen::maus_abs(x, y)),
                InputFrame::MouseMoveAbs { x, y },
                "({x},{y})"
            );
        }
    }

    #[test]
    fn maus_rel_mit_vorzeichen() {
        for (dx, dy) in [(0i16, 0i16), (1, -1), (i16::MIN, i16::MAX)] {
            assert_eq!(
                zurueck(bauen::maus_rel(dx, dy)),
                InputFrame::MouseMoveRel { dx, dy },
                "({dx},{dy})"
            );
        }
    }

    /// Die Knopf-Nummern muessen auf beiden Seiten dieselben sein — hier
    /// entstuende sonst ein Rechtsklick aus einem Linksklick.
    #[test]
    fn jeder_knopf_kommt_als_derselbe_an() {
        for (knopf, nr) in [
            (Knopf::Links, 0u8),
            (Knopf::Rechts, 1),
            (Knopf::Mitte, 2),
            (Knopf::X1, 3),
            (Knopf::X2, 4),
        ] {
            for runter in [true, false] {
                assert_eq!(
                    zurueck(bauen::maus_knopf(knopf, runter)),
                    InputFrame::MouseButton { btn: nr, down: runter },
                    "{knopf:?} runter={runter}"
                );
            }
        }
    }

    #[test]
    fn rad_mit_vorzeichen() {
        for (dv, dh) in [(120i16, 0i16), (0, -120), (-360, 240)] {
            assert_eq!(
                zurueck(bauen::maus_rad(dv, dh)),
                InputFrame::MouseWheel { dv, dh },
                "({dv},{dh})"
            );
        }
    }

    /// Der Erweiterungs-Praefix `0xE0` muss den ganzen Weg ueberleben.
    #[test]
    fn tasten_samt_erweiterungs_praefix() {
        for scan in [0x0000u16, 0x001E, 0x001D, 0xE01D, 0xE04B, 0x00FF] {
            for runter in [true, false] {
                assert_eq!(
                    zurueck(bauen::taste(scan, runter)),
                    InputFrame::Key { scan, down: runter },
                    "{scan:#06x} runter={runter}"
                );
            }
        }
    }

    /// Jeder gebaute Frame hat genau die Laenge, die der Parser verlangt — zu
    /// lang ist dort so ungueltig wie zu kurz.
    #[test]
    fn jede_gebaute_laenge_wird_angenommen() {
        let alle = [
            bauen::hello(),
            bauen::maus_abs(1, 2),
            bauen::maus_rel(1, 2),
            bauen::maus_knopf(Knopf::Links, true),
            bauen::maus_rad(120, 0),
            bauen::taste(0x1E, true),
        ];
        for r in alle {
            assert!(
                InputFrame::parse(r.as_slice()).is_ok(),
                "Opcode {:#04x} mit {} Byte",
                r.opcode(),
                r.as_slice().len()
            );
        }
    }
}
