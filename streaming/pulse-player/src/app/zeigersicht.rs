//! Ob der **lokale** Zeiger des Steuernden im Player-Fenster zu sehen ist.
//!
//! Zwei voellig verschiedene Gruende koennen ihn ausblenden, und beide gelten
//! gleichzeitig oder gar nicht — deshalb rechnen sie hier zusammen und nicht
//! an drei Stellen im Fenstercode:
//!
//! * **Zeigerfang** (Spiele): der Zeiger steht still und liefert nur noch
//!   Differenzen; ein sichtbarer Zeiger klebte dabei in der Bildmitte.
//! * **Rueckfall „Zeiger im Bild"**: der Host kann seine Zeigerform nicht mehr
//!   melden (macOS liest sie ueber eine von Apple abgekuendigte Abfrage) und
//!   legt seinen Zeiger stattdessen zurueck in die Aufnahme. Er reitet dann im
//!   Videobild mit — formrichtig, aber der Hand um die Uebertragungszeit
//!   hinterher. Der lokale muss dafuer weichen, sonst stehen zwei Zeiger im
//!   Bild und der falsche ist der schnellere.
//!
//! **Der sichere Zustand ist SICHTBAR.** Ein doppelter Zeiger ist ein
//! Schoenheitsfehler, ein fehlender kostet die Bedienbarkeit — und im
//! schlimmsten Fall saesse der Nutzer nach dem Ende der Fernsteuerung ohne
//! Zeiger vor seinem eigenen Rechner. Deshalb gibt es [`Zeigersicht::erfassung_aus`]
//! als EINEN Ausgang, der beide Gruende faellen laesst, und deshalb wird ein
//! fehlendes Feld auf der Leitung als „nicht im Bild" gelesen
//! (`eingabe.rs::remote_pointer`).
//!
//! Getrennt von [`super::eingabe`] aus demselben Grund wie
//! [`super::zeigerform`]: das hier ist reine Rechnung, kennt weder Fenster noch
//! Sitzung und ist fuer sich pruefbar.

/// Die beiden Gruende, aus denen der lokale Zeiger verschwindet.
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct Zeigersicht {
    /// Der Zeiger ist ans Fenster gefesselt (`CursorGrabMode`). Das ist der
    /// TATSAECHLICHE Fang, nicht der Wunsch — der steht als
    /// `Session::fang_gewuenscht` daneben.
    fang: bool,
    /// Der Host laesst seinen Zeiger im Videobild mitlaufen.
    im_bild: bool,
}

impl Zeigersicht {
    /// Der Zeigerfang hat sich geaendert (Erfassung an/aus, Fokuswechsel).
    pub(super) fn fang_setzen(&mut self, fang: bool) {
        self.fang = fang;
    }

    /// Der Host hat gemeldet, ob sein Zeiger gerade im Videobild steht.
    pub(super) fn im_bild_setzen(&mut self, im_bild: bool) {
        self.im_bild = im_bild;
    }

    /// Die Erfassung endet — **beide** Gruende fallen.
    ///
    /// Der Rueckfall gehoert ausdruecklich dazu: er gilt fuer die Dauer einer
    /// Fernsteuerung, und ohne diese Ruecknahme bliebe der lokale Zeiger danach
    /// ausgeblendet. Der Renderer setzt beim Sitzungsende ebenfalls zurueck
    /// (`$lib/remote/zeigerImBild.ts`) — doppelt, weil die beiden Wege
    /// (Sitzungsende, Fenster zu) nicht immer in derselben Reihenfolge laufen
    /// und einer davon ausbleiben kann.
    pub(super) fn erfassung_aus(&mut self) {
        self.fang = false;
        self.im_bild = false;
    }

    /// Was dem Fenster zu sagen ist (`Window::set_cursor_visible`).
    pub(super) fn sichtbar(&self) -> bool {
        !self.fang && !self.im_bild
    }
}

#[cfg(test)]
mod tests {
    use super::Zeigersicht;

    /// Ohne Grund ist der Zeiger da. Das ist der Ausgangszustand jeder Sitzung
    /// und zugleich der sichere Fall.
    #[test]
    fn ohne_grund_sichtbar() {
        assert!(Zeigersicht::default().sichtbar());
    }

    /// Jeder Grund fuer sich blendet aus.
    #[test]
    fn jeder_grund_blendet_aus() {
        let mut z = Zeigersicht::default();
        z.fang_setzen(true);
        assert!(!z.sichtbar(), "Zeigerfang muss ausblenden");

        let mut z = Zeigersicht::default();
        z.im_bild_setzen(true);
        assert!(!z.sichtbar(), "der Rueckfall muss ausblenden");
    }

    /// Faellt ein Grund weg, waehrend der andere gilt, bleibt es beim
    /// Ausblenden — sonst blitzte beim Fokuswechsel ein zweiter Zeiger auf.
    #[test]
    fn ein_grund_genuegt() {
        let mut z = Zeigersicht::default();
        z.fang_setzen(true);
        z.im_bild_setzen(true);
        z.fang_setzen(false);
        assert!(!z.sichtbar(), "der Rueckfall gilt noch");
        z.im_bild_setzen(false);
        assert!(z.sichtbar());
    }

    /// **Der wichtigste Test dieser Datei.** Endet die Erfassung, waehrend der
    /// Rueckfall gilt, muss der Zeiger zurueckkommen — sonst sitzt der Nutzer
    /// nach der Fernsteuerung ohne Zeiger vor seinem eigenen Rechner. Das ist
    /// der schlimmste denkbare Ausgang dieser Funktion.
    #[test]
    fn erfassung_aus_gibt_den_zeiger_zurueck() {
        let mut z = Zeigersicht::default();
        z.fang_setzen(true);
        z.im_bild_setzen(true);
        z.erfassung_aus();
        assert!(z.sichtbar(), "nach dem Ende der Erfassung MUSS der Zeiger sichtbar sein");
    }

    /// Auch der Rueckfall allein — ohne Zeigerfang — wird beim Ende
    /// zurueckgenommen. Genau dieser Weg ist der Regelfall auf macOS: dort
    /// laeuft der Rueckfall, ohne dass je ein Fang bestanden haette.
    #[test]
    fn erfassung_aus_nimmt_auch_den_reinen_rueckfall_zurueck() {
        let mut z = Zeigersicht::default();
        z.im_bild_setzen(true);
        assert!(!z.sichtbar());
        z.erfassung_aus();
        assert!(z.sichtbar());
    }
}
