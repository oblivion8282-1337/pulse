//! Das Format der Leitung — Zahlen, die BEIDE Seiten kennen muessen.
//!
//! Verbindlich ist `docs/plans/2026-08-12-input-wire-protokoll-v2.md`.
//!
//! **Warum das ein eigenes Modul ist.** Bis zum 2026-08-22 stand es zweimal im
//! Baum: der Player baute Frames aus seinen Konstanten, der Sidecar parste sie
//! mit seinen. Kein Zwillings-Test hielt die beiden zusammen — genau die Lage,
//! aus der der Zeigerbild-Fehler entstand (Sender und Empfaenger aus zwei
//! getrennten Vorstellungen geschrieben, beide Testnetze gruen). Seit die
//! Zahlen hier stehen, ist der Hin-und-zurueck-Test moeglich, und die Frage
//! „passen die beiden Seiten zusammen?" ist eine Uebersetzung und keine
//! Durchsicht.

/// Fassung im Hello-Frame. **2** seit dem Serverweg; v1 hat nie ausgeliefert.
pub const PROTOKOLL_VERSION: u8 = 2;

pub const OP_HELLO: u8 = 0x00;
pub const OP_MAUS_ABS: u8 = 0x01;
pub const OP_MAUS_REL: u8 = 0x02;
pub const OP_MAUS_KNOPF: u8 = 0x03;
pub const OP_MAUS_RAD: u8 = 0x04;
pub const OP_TASTE: u8 = 0x05;

/// Eine Windows-Raste am Mausrad (`WHEEL_DELTA`).
pub const RASTE: i32 = 120;

/// Knopf-Nummern der Leitung. **Nicht** die von winit und nicht die von
/// JavaScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Knopf {
    Links = 0,
    Rechts = 1,
    Mitte = 2,
    X1 = 3,
    X2 = 4,
}

/// Kennt die Leitung diese Knopf-Nummer? Ein unbekannter Knopf ist
/// fail-closed — der Host beendet die Sitzung, statt zu raten.
///
/// **Hier und nicht in der Plattform**, weil es eine Aussage ueber das
/// Protokoll ist und nicht ueber das Betriebssystem: 0..4 sind die Nummern,
/// die ein Sender schicken darf, egal wer sie spaeter einspielt.
pub fn knopf_bekannt(btn: u8) -> bool {
    btn <= Knopf::X2 as u8
}

/// Ist der Scancode so, wie Satz 1 ihn kennt?
///
/// Satz 1 hat genau zwei Formen: `0x00xx` (Grundtaste) und `0xE0xx`
/// (erweiterte Taste). **Alles andere darf nicht eingespielt werden.** Auf
/// Windows traegt `wScan` nur das niederwertige Byte: `0xE11D` (der
/// `0xE1`-Praefix der Pause-Taste) kaeme dort als **linke Strg-Taste** an — und
/// bliebe, weil das Hoch-Ereignis unter demselben missgeformten Code gemerkt
/// wird, am fremden Rechner gedrueckt.
pub fn scancode_gueltig(scan: u16) -> bool {
    matches!(scan >> 8, 0x00 | 0xE0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knopf_nummern_null_bis_vier() {
        for btn in 0..=4u8 {
            assert!(knopf_bekannt(btn), "btn={btn}");
        }
        assert!(!knopf_bekannt(5));
        assert!(!knopf_bekannt(255));
    }

    /// `0xE11D` ist der Fall, der ohne diese Pruefung als linke Strg-Taste
    /// eingespielt wuerde — und dann gedrueckt bliebe.
    #[test]
    fn nur_satz_1_scancodes_sind_gueltig() {
        assert!(scancode_gueltig(0x001D)); // linke Strg-Taste
        assert!(scancode_gueltig(0x0000));
        assert!(scancode_gueltig(0xE01D)); // rechte Strg-Taste
        assert!(scancode_gueltig(0xE04B)); // Pfeil links
        assert!(!scancode_gueltig(0xE11D)); // Pause-Praefix
        assert!(!scancode_gueltig(0x011D)); // erfundener Praefix
        assert!(!scancode_gueltig(0xFFFF));
    }

}
