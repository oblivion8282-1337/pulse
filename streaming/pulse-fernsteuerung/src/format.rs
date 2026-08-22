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

/// Jeder Scancode, den ein Sender ueberhaupt erzeugen darf — das Vokabular der
/// Leitung.
///
/// **Wozu die Liste.** Sie ist der Pruefstein zwischen den Enden: der Player
/// prueft, dass er nur daraus sendet (`fernsteuerung/tasten.rs`), und jeder
/// Injektor prueft, dass er zu jedem Eintrag ein Ziel hat. Damit ist „kann
/// diese Plattform alles einspielen, was ein Steuernder schicken kann?" ein
/// Test und keine Durchsicht. Gebraucht wird sie erstmals vom mac-Injektor
/// (Plan 2); sie steht hier, weil sie zum Format gehoert und nicht zu einer
/// Plattform.
///
/// Aufsteigend sortiert, damit eine neue Taste an ihrem Platz landet und der
/// Unterschied im Diff eine Zeile ist.
pub const SATZ1_TASTEN: &[u16] = &[
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e,
    0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d,
    0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c,
    0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b,
    0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x56, 0x57, 0x58,
    0xe01c, 0xe01d, 0xe035, 0xe037, 0xe038, 0xe047, 0xe048, 0xe049, 0xe04b, 0xe04d, 0xe04f,
    0xe050, 0xe051, 0xe052, 0xe053, 0xe05b, 0xe05c, 0xe05d,
];

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

    /// Das Vokabular darf nichts fuehren, was kein Injektor annehmen darf —
    /// sonst behauptete es ein Ziel fuer einen Code, der fail-closed ist.
    #[test]
    fn das_vokabular_ist_durchweg_gueltig() {
        assert!(!SATZ1_TASTEN.is_empty());
        for &scan in SATZ1_TASTEN {
            assert!(scancode_gueltig(scan), "{scan:#06x} steht im Vokabular");
        }
    }

    /// Aufsteigend und ohne Doppelung — eine Doppelung waere ein Eintrag, den
    /// die Vollstaendigkeitspruefung drueben zweimal verlangt.
    #[test]
    fn das_vokabular_ist_sortiert_und_doppelungsfrei() {
        assert!(
            SATZ1_TASTEN.windows(2).all(|p| p[0] < p[1]),
            "SATZ1_TASTEN muss aufsteigend und doppelungsfrei sein"
        );
    }
}
