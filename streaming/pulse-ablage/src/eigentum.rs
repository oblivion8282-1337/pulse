//! „Ich bin Eigentuemer, liefere aber erst auf Abruf" — der Beruehrungspunkt,
//! an dem das Betriebssystem etwas VERLANGT.

/// Eigentum an der lokalen Zwischenablage, mit verzoegertem Rendern.
pub trait Eigentum {
    /// Beanspruchen, **ohne Daten zu hinterlegen**.
    ///
    /// Auf Windows `SetClipboardData(CF_UNICODETEXT, NULL)`, auf macOS
    /// `declareTypes(owner:)`, auf Wayland ein `wl_data_source` samt
    /// `set_selection`.
    fn beanspruchen(&mut self) -> Result<(), String>;

    /// Den Inhalt an einen wartenden Einfuegevorgang geben.
    ///
    /// **Auf Windows und macOS wartet dort ein blockierter Faden.** Ein leerer
    /// Text ist eine gueltige Antwort und heisst „es kam nichts" — das ist
    /// besser als ein haengendes Programm.
    fn liefern(&mut self, text: &str);

    /// Eigentum abgeben.
    ///
    /// `zurueck` ist der gemerkte Vorbestand. **Das ist kein Beiwerk:** ein
    /// Anspruch loescht, was vorher in der Ablage lag. Wird nie eingefuegt,
    /// waere der eigene kopierte Pfad des Nutzers still verloren — durch fremde
    /// Aktivitaet. Zurueckgeschrieben wird nur, wenn wir zum Zeitpunkt des
    /// Freigebens noch Eigentuemer sind; hat inzwischen jemand anders kopiert,
    /// bleibt dessen Inhalt stehen.
    fn freigeben(&mut self, zurueck: Option<&str>);
}

/// Ob ein angemeldeter Anspruch schon eingeloest werden konnte.
///
/// **Wozu das gut ist: Wayland.** Dort verlangt `set_selection` eine
/// Seriennummer aus einem frischen Eingabeereignis, und ein Klient **ohne
/// Fokus kann die Auswahl nicht setzen** — der Compositor verwirft es, und
/// zwar still. Genau der Fall tritt ein: der Nutzer wechselt zu einem lokalen
/// Programm, drueben wird kopiert, die Ankuendigung kommt an — und das
/// Player-Fenster hat keinen Fokus. Der Anspruch wird deshalb EINGEREIHT und
/// beim naechsten Fenster-Ereignis eingeloest.
///
/// Die Rechnung steht hier als reine Zustandsmaschine, damit sie ohne
/// Compositor pruefbar ist — dieselbe Trennung wie bei der Zugerkennung in
/// `pulse-player/src/fernsteuerung/wayland/zustand.rs`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Anspruch {
    offen: bool,
}

impl Anspruch {
    pub fn neu() -> Anspruch {
        Anspruch { offen: false }
    }

    /// Eine Ankuendigung ist eingetroffen — Anspruch anmelden.
    pub fn anmelden(&mut self) {
        self.offen = true;
    }

    /// Ein Fenster-Ereignis ist da. Liefert `true`, wenn jetzt zu beanspruchen
    /// ist — und merkt sich, dass es geschehen ist.
    ///
    /// `serial == None` heisst „kein brauchbares Ereignis": der Anspruch bleibt
    /// offen, statt mit einer erfundenen Nummer still zu verpuffen.
    pub fn seriennummer(&mut self, serial: Option<u32>) -> bool {
        if !self.offen || serial.is_none() {
            return false;
        }
        self.offen = false;
        true
    }

    /// Der Anspruch ist gegenstandslos geworden (Sitzungsende, Typ unbekannt).
    pub fn aufgeben(&mut self) {
        self.offen = false;
    }

    pub fn offen(&self) -> bool {
        self.offen
    }
}

#[cfg(test)]
mod tests {
    use super::Anspruch;

    #[test]
    fn ohne_anmeldung_wird_nichts_beansprucht() {
        let mut a = Anspruch::neu();
        assert!(!a.seriennummer(Some(42)));
    }

    #[test]
    fn ohne_seriennummer_bleibt_der_anspruch_offen() {
        let mut a = Anspruch::neu();
        a.anmelden();
        assert!(!a.seriennummer(None));
        assert!(a.offen(), "er darf nicht verpuffen — sonst bliebe die Ablage leer");
        assert!(a.seriennummer(Some(42)), "mit Nummer wird er eingeloest");
    }

    #[test]
    fn ein_anspruch_wird_nur_einmal_eingeloest() {
        let mut a = Anspruch::neu();
        a.anmelden();
        assert!(a.seriennummer(Some(42)));
        assert!(!a.seriennummer(Some(43)), "kein zweites set_selection ohne neue Ankuendigung");
    }

    #[test]
    fn aufgeben_loescht_den_offenen_anspruch() {
        let mut a = Anspruch::neu();
        a.anmelden();
        a.aufgeben();
        assert!(!a.seriennummer(Some(42)));
    }
}
