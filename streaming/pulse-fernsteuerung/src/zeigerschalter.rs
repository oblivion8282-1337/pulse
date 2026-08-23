//! Der Zeiger-Schalter: ob eine Fernsteuerung den Host-Cursor gerade aus der
//! Aufnahme nehmen darf, und was ein gescheiterter Plattform-Aufruf danach
//! bedeutet.
//!
//! **Herkunft.** `win-hq-sidecar/src/capture/cursorsteuerung.rs` hatte diese
//! Zustandsführung bis zum 2026-08-23 neben der einen WinRT-Zeile
//! (`SetIsCursorCaptureEnabled`) liegen — reine Arithmetik, aber mit einer
//! asymmetrischen Fehlerbehandlung, deren Begründung nur dort stand. Ein
//! macOS-Sidecar hätte sie ein zweites Mal schreiben müssen, ohne die
//! Begründung zu kennen. Diese Kiste kennt kein WinRT und keine Session — nur
//! die Entscheidung, ob und in welche Richtung umgeschaltet werden soll.
//!
//! **Drei Zusagen, ein Typ:**
//! * Nie über den Ausgangszustand hinaus — wer ohne Cursor streamt
//!   (`basis_sichtbar: false` bei [`Schalter::neu`]), bekommt ihn durch eine
//!   Fernsteuerung nicht untergeschoben.
//! * Nur ein Zustandswechsel liefert eine Wirkung — bei bis zu 125
//!   Eingabe-Nachrichten je Sekunde wäre ein Plattform-Aufruf je Nachricht
//!   vermeidbare Arbeit.
//! * Scheitert das Verbergen, ist der Platz zu räumen: [`Schalter::setzen`]
//!   läuft je Eingabe-Nachricht, und ohne das Räumen wiederholte sich
//!   derselbe Fehlschlag samt Log-Zeile mit jeder weiteren Nachricht — der
//!   Zustandswechsel-Filter greift nämlich nur nach einem Erfolg. Scheitert
//!   dagegen das Zeigen, bleibt der Platz stehen: er ist die einzige
//!   Möglichkeit, den Host-Cursor zurückzuholen — geräumt verlören alle
//!   Zuschauer ihn bis zum Stream-Ende.
//!
//! Der Zustand ändert sich ausschließlich über [`Schalter::gelungen`]:
//! [`Schalter::setzen`] selbst schreibt nichts fest (sonst würde ein
//! scheiternder Aufruf fälschlich als geschehen gelten), und
//! [`Schalter::gescheitert`] meldet nur, ob geräumt werden muss.

/// Was der Aufrufer als Nächstes tun soll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wirkung {
    /// Kein Cursor im Ausgangszustand, oder der Zielzustand ist schon
    /// erreicht — nichts zu tun.
    Nichts,
    /// Der Plattform-Aufruf ist fällig. Das Argument ist die angefragte
    /// Richtung (`true` = verbergen) — **nicht** das Argument des
    /// Plattform-Rufs selbst. Die Übersetzung (unter Windows z. B.
    /// `SetIsCursorCaptureEnabled(!v)`) bleibt beim Aufrufer, der die
    /// Plattform kennt.
    Umschalten(bool),
}

/// Zustand eines einzelnen Cursor-Platzes, plattformfrei.
pub struct Schalter {
    /// Zeigt der Stream den Cursor von Haus aus (`show_cursor` der
    /// Start-Anfrage)? Nur dann gibt es überhaupt etwas zu verbergen — und
    /// „zeigen" heißt immer nur: zurück auf diesen Ausgangszustand, nie
    /// darüber hinaus.
    basis_sichtbar: bool,
    /// Ist der Cursor gerade verborgen — nach dem letzten GELUNGENEN
    /// Umschalten, nicht nach dem zuletzt angefragten. Ändert sich
    /// ausschließlich über [`Schalter::gelungen`].
    verborgen: bool,
}

impl Schalter {
    /// Ein frischer Platz im gemeldeten Ausgangszustand des Streams. Startet
    /// stets ungehindert sichtbar — eine Fernsteuerung beginnt nie mitten in
    /// einem verborgenen Cursor.
    pub fn neu(basis_sichtbar: bool) -> Self {
        Self { basis_sichtbar, verborgen: false }
    }

    /// Soll umgeschaltet werden? No-Op ohne Cursor im Ausgangszustand oder
    /// wenn der Zielzustand schon erreicht ist. Schreibt selbst nichts fest —
    /// das übernimmt erst [`Schalter::gelungen`], nachdem der Aufruf wirklich
    /// glückte.
    pub fn setzen(&mut self, verbergen: bool) -> Wirkung {
        if !self.basis_sichtbar || self.verborgen == verbergen {
            Wirkung::Nichts
        } else {
            Wirkung::Umschalten(verbergen)
        }
    }

    /// Der Plattform-Aufruf aus [`Schalter::setzen`] ist geglückt — Zustand
    /// nachziehen.
    pub fn gelungen(&mut self, verbergen: bool) {
        self.verborgen = verbergen;
    }

    /// Der Plattform-Aufruf aus [`Schalter::setzen`] ist gescheitert. Liefert
    /// `true`, wenn der Platz zu räumen ist — siehe die Modul-Doku für die
    /// Begründung der Asymmetrie. Der interne Zustand bleibt unangetastet:
    /// er spiegelt weiterhin, was zuletzt wirklich glückte, egal wie hier
    /// entschieden wird — deshalb `&self`, ohne `mut`.
    pub fn gescheitert(&self, verbergen: bool) -> bool {
        verbergen
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Nie über den Ausgangszustand hinaus.** Wer ohne Cursor streamt,
    /// bekommt ihn durch eine Fernsteuerung nicht untergeschoben.
    #[test]
    fn ohne_cursor_im_ausgangszustand_passiert_nichts() {
        let mut s = Schalter::neu(false);
        assert_eq!(s.setzen(true), Wirkung::Nichts);
        assert_eq!(s.setzen(false), Wirkung::Nichts);
    }

    /// Nur Zustandswechsel lösen einen Aufruf aus — bei bis zu 125
    /// Nachrichten je Sekunde wäre ein WinRT-Aufruf je Nachricht vermeidbare
    /// Arbeit.
    #[test]
    fn nur_der_wechsel_loest_aus() {
        let mut s = Schalter::neu(true);
        assert_eq!(s.setzen(true), Wirkung::Umschalten(true));
        s.gelungen(true);
        assert_eq!(s.setzen(true), Wirkung::Nichts, "schon verborgen");
        assert_eq!(s.setzen(false), Wirkung::Umschalten(false));
        s.gelungen(false);
        assert_eq!(s.setzen(false), Wirkung::Nichts);
    }

    /// **Die asymmetrische Fehlerbehandlung, aus einem Bughunt.** Scheitert
    /// das VERBERGEN, wird der Platz geräumt (sonst wiederholt sich der
    /// Fehlschlag samt Log-Zeile mit jeder Nachricht). Scheitert das ZEIGEN,
    /// bleibt er stehen — er ist die einzige Möglichkeit, den Host-Cursor
    /// zurückzuholen; geräumt verlören alle Zuschauer ihn bis zum
    /// Stream-Ende.
    #[test]
    fn scheitern_wirkt_in_beide_richtungen_verschieden() {
        let s = Schalter::neu(true);
        assert!(s.gescheitert(true), "verbergen gescheitert -> raeumen");
        let mut s = Schalter::neu(true);
        s.setzen(true);
        s.gelungen(true);
        assert!(!s.gescheitert(false), "zeigen gescheitert -> stehen lassen");
    }

    /// Und nach einem gescheiterten Zeigen bleibt ein weiteres Verbergen ein
    /// No-Op, bis das Zeigen glückt — sonst entstünde die
    /// Wiederholungsflut auf dem anderen Weg.
    #[test]
    fn nach_gescheitertem_zeigen_verbirgt_nichts_erneut() {
        let mut s = Schalter::neu(true);
        s.setzen(true);
        s.gelungen(true);
        s.gescheitert(false);
        assert_eq!(s.setzen(true), Wirkung::Nichts);
    }
}
