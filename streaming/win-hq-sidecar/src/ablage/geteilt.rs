//! Der Zustand zwischen den beiden Faeden — und die Buchfuehrung ueber
//! „wer hat die Ablage zuletzt angefasst".
//!
//! **Warum das eine eigene Datei ist:** hier steht kein einziger Win32-Aufruf,
//! und genau deshalb laesst sich der einzige Teil der Windows-Haelfte pruefen,
//! der eine Rechnung enthaelt — die Frage, welche Aenderung der Zwischenablage
//! die eigene ist und welche die des Nutzers. Alles andere in [`super`] ist
//! Betriebssystem und auf dieser Maschine nur uebersetzbar, nicht ausfuehrbar.
//!
//! **Die Invariante, die diese Struktur traegt:** die Sperre darum wird **nie
//! ueber einen Win32-Aufruf gehalten**. `EmptyClipboard` schickt dem
//! Eigentuemer synchron ein `WM_DESTROYCLIPBOARD`, und das landet im eigenen
//! Fensterrueckruf auf demselben Faden — eine gehaltene `Mutex` waere dort ein
//! Selbstblock, denn `std::sync::Mutex` ist nicht wiedereintrittsfaehig.

/// Alles, was Fensterfaden und Takt-Faden gemeinsam sehen.
///
/// [`Geteilt::neu`] ist `const`, damit die `Mutex` darum ein `static` sein
/// kann — `Default` genuegt dafuer nicht.
pub(super) struct Geteilt {
    /// Zaehlt Wechsel der Ablage. Die Nachbildung von
    /// `NSPasteboard.changeCount` ist Absicht — dieselbe Bauart wie im
    /// Testdoppel `pulse_ablage::pruefstand::TestAblage` und im Wayland-Weg.
    stand: u64,
    gesehen: u64,
    /// Halten WIR die Ablage gerade? Kommt aus `GetClipboardOwner`, nicht aus
    /// einem Merker: hat der Nutzer selbst kopiert, ist „wir haben
    /// beansprucht" laengst falsch.
    eigen: bool,
    /// Selbst ausgeloeste Aenderungen, deren `WM_CLIPBOARDUPDATE` noch
    /// unterwegs ist.
    ///
    /// **Warum das genau aufgeht und kein Rennen ist:** jede eigene Aenderung
    /// laeuft auf dem Fensterfaden, und die Meldung darueber wird an dasselbe
    /// Fenster GEPOSTET. Sie kann also erst dran sein, wenn der laufende
    /// Rueckruf zurueckgekehrt ist — der Zaehler steht dann sicher. Ohne ihn
    /// kuendigte jeder eigene Anspruch der Gegenseite ihren eigenen Inhalt als
    /// Neuigkeit zurueck, sie beanspruchte daraufhin, und das ginge endlos
    /// (dieselbe Falle, die auf Wayland `AblageZustand::eigene` abfaengt).
    erwartet: u32,
    /// Ein `WM_RENDERFORMAT` wartet auf Inhalt — auf Windows blockiert dabei
    /// das einfuegende Programm.
    wartet: bool,
    /// Was der wartende Rendervorgang bekommt, sobald es da ist.
    antwort: Option<String>,
    /// Bricht den wartenden Rendervorgang ab, weil die Ablage gerade neu
    /// beansprucht oder freigegeben wird. Ohne ihn stuende der Befehl dafuer
    /// bis zu einer Abruf-Frist an.
    abbruch: bool,
    /// Ergebnis des letzten Lesevorgangs. `None` = keiner fertig,
    /// `Some(None)` = „nichts zu holen".
    gelesen: Option<Option<String>>,
    /// Ein Lesebefehl ist unterwegs.
    lesen_laeuft: bool,
}

impl Geteilt {
    pub(super) const fn neu() -> Geteilt {
        Geteilt {
            stand: 0,
            gesehen: 0,
            eigen: false,
            erwartet: 0,
            wartet: false,
            antwort: None,
            abbruch: false,
            gelesen: None,
            lesen_laeuft: false,
        }
    }

    /// Eine Meldung des Systems, dass sich die Ablage geaendert hat
    /// (`WM_CLIPBOARDUPDATE`).
    ///
    /// `eigner` = gehoert die Ablage jetzt unserem Fenster, `text_da` = liegt
    /// Text darin.
    pub(super) fn systemmeldung(&mut self, eigner: bool, text_da: bool) {
        // Ein Ergebnis gehoert der Ablage, aus der es stammt.
        self.gelesen = None;
        let verloren = self.eigen && !eigner;
        self.eigen = eigner;
        if self.erwartet > 0 {
            // Unsere eigene Aenderung — sie anzukuendigen hiesse, der
            // Gegenseite ihren eigenen Inhalt als Neuigkeit zurueckzumelden.
            self.erwartet -= 1;
            return;
        }
        // **Der Eigentumsverlust zaehlt selbst dann, wenn kein Text im Fach
        // liegt** — fail-closed, dieselbe Begruendung wie
        // `AblageZustand::abgeloest` auf Wayland: solange wir die Ablage
        // hielten, war die angekuendigte Generation an unseren Stand gebunden;
        // ist sie weg, stimmt diese Bindung nicht mehr, und ein `hol` darf
        // nicht mit frisch gelesenem Inhalt beantwortet werden.
        //
        // **Nur TEXT bewegt den Zaehler sonst.** Ein kopiertes Bild
        // anzukuendigen braechte der Gegenseite nichts: sie beanspruchte
        // daraufhin ihre Ablage — und loeschte damit den Vorbestand ihres
        // Nutzers — nur um beim Einfuegen ein `weg` zu bekommen.
        if verloren || (!eigner && text_da) {
            self.stand += 1;
        }
    }

    /// Eine Aenderung, die wir selbst gerade ausgeloest haben. **Erst nach dem
    /// geglueckten Win32-Aufruf rufen** — sonst schluckte der Zaehler bei einem
    /// Fehlschlag die naechste fremde Meldung.
    pub(super) fn selbst_geaendert(&mut self, eigen: bool) {
        self.erwartet += 1;
        self.eigen = eigen;
        self.gelesen = None;
    }

    /// Verbrauchend, wie `Beobachter::geaendert` es verlangt.
    pub(super) fn aenderung_abholen(&mut self) -> bool {
        let neu = self.stand != self.gesehen;
        self.gesehen = self.stand;
        neu
    }

    pub(super) fn eigen(&self) -> bool {
        self.eigen
    }

    pub(super) fn wartet(&self) -> bool {
        self.wartet
    }

    /// Ein Rendervorgang beginnt zu warten.
    pub(super) fn warten_beginnen(&mut self) {
        self.wartet = true;
        self.antwort = None;
        self.abbruch = false;
    }

    /// Was der wartende Rendervorgang bekommt — `None`, solange nichts da ist
    /// und nichts abgebrochen wurde.
    pub(super) fn antwort_nehmen(&mut self) -> Option<String> {
        if let Some(text) = self.antwort.take() {
            return Some(text);
        }
        // **Ein abgebrochener Rendervorgang bekommt eine leere Zeichenkette,
        // nicht gar nichts.** Er blockiert ein fremdes Programm; ohne Antwort
        // stuende es bis zu unserer eigenen Frist.
        if self.abbruch { Some(String::new()) } else { None }
    }

    pub(super) fn warten_beenden(&mut self) {
        self.wartet = false;
        self.antwort = None;
        self.abbruch = false;
    }

    /// Inhalt fuer den wartenden Rendervorgang hinterlegen
    /// (`Eigentum::liefern`). Wartet keiner, ist es folgenlos.
    pub(super) fn antwort_setzen(&mut self, text: &str) {
        if self.wartet {
            self.antwort = Some(text.to_string());
        }
    }

    /// Einen wartenden Rendervorgang abbrechen, weil die Ablage gleich neu
    /// belegt wird.
    pub(super) fn abbrechen(&mut self) {
        if self.wartet {
            self.abbruch = true;
        }
    }

    /// Ist noch kein Lesevorgang unterwegs oder fertig?
    pub(super) fn lesen_offen(&self) -> bool {
        !self.lesen_laeuft && self.gelesen.is_none()
    }

    pub(super) fn lesen_beginnen(&mut self) {
        self.lesen_laeuft = true;
    }

    pub(super) fn lesen_fertig(&mut self, text: Option<String>) {
        self.lesen_laeuft = false;
        self.gelesen = Some(text);
    }

    pub(super) fn lesen_bereit(&self) -> bool {
        self.gelesen.is_some()
    }

    pub(super) fn gelesenes(&self) -> Option<String> {
        self.gelesen.clone().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::Geteilt;

    /// Der eigene Anspruch darf keine Ankuendigung ausloesen.
    ///
    /// Sonst meldeten wir der Gegenseite ihren eigenen Inhalt als Neuigkeit
    /// zurueck, sie beanspruchte daraufhin ihre Ablage, und das ginge endlos.
    #[test]
    fn der_eigene_anspruch_zaehlt_nicht_als_aenderung() {
        let mut g = Geteilt::neu();
        g.selbst_geaendert(true);
        g.systemmeldung(true, false);
        assert!(!g.aenderung_abholen(), "die eigene Aenderung darf nicht hinausgehen");
    }

    /// Kopiert der Nutzer selbst, geht genau eine Ankuendigung hinaus.
    #[test]
    fn fremdes_kopieren_zaehlt_einmal() {
        let mut g = Geteilt::neu();
        g.systemmeldung(false, true);
        assert!(g.aenderung_abholen());
        assert!(!g.aenderung_abholen(), "verbrauchend, sonst antwortet jedes hol mit veraltet");
    }

    /// **Der Eigentumsverlust ist eine unverbuchte Aenderung** — auch ohne Text
    /// im Fach, fail-closed.
    ///
    /// Solange wir die Ablage hielten, war die angekuendigte Generation an
    /// unseren Stand gebunden. Ist sie weg, stimmt das nicht mehr, und
    /// `Ankuendiger::beantworte` darf ein `hol` nicht mit frisch gelesenem
    /// Inhalt beantworten.
    #[test]
    fn eigentumsverlust_zaehlt_auch_ohne_text() {
        let mut g = Geteilt::neu();
        g.selbst_geaendert(true);
        g.systemmeldung(true, false);
        g.aenderung_abholen();
        // Ein anderes Programm raeumt die Ablage: kein Text, aber wir sind raus.
        g.systemmeldung(false, false);
        assert!(g.aenderung_abholen(), "der Verlust selbst ist die Aenderung");
        assert!(!g.eigen());
    }

    /// Ein kopiertes Bild bewegt den Zaehler nicht: die Gegenseite loeschte
    /// dafuer den Vorbestand ihres Nutzers und bekaeme beim Einfuegen ein `weg`.
    #[test]
    fn ein_fach_ohne_text_kuendigt_nichts_an() {
        let mut g = Geteilt::neu();
        g.systemmeldung(false, false);
        assert!(!g.aenderung_abholen());
    }

    /// Ein abgebrochener Rendervorgang bekommt eine leere Antwort statt gar
    /// keiner — sonst haengt das einfuegende Programm.
    #[test]
    fn ein_abbruch_beantwortet_den_wartenden_leer() {
        let mut g = Geteilt::neu();
        g.warten_beginnen();
        assert_eq!(g.antwort_nehmen(), None, "solange nichts da ist, wird gewartet");
        g.abbrechen();
        assert_eq!(g.antwort_nehmen().as_deref(), Some(""));
    }

    /// Eine Aenderung der Ablage macht ein bereits gelesenes Ergebnis
    /// ungueltig — es gehoert dem Fach, aus dem es stammt.
    #[test]
    fn eine_aenderung_verwirft_das_gelesene() {
        let mut g = Geteilt::neu();
        g.lesen_beginnen();
        g.lesen_fertig(Some("alt".into()));
        assert!(g.lesen_bereit());
        g.systemmeldung(false, true);
        assert!(!g.lesen_bereit(), "sonst antwortete ein hol mit dem Inhalt von vorhin");
        assert!(g.lesen_offen(), "und ein neuer Lesevorgang muss moeglich sein");
    }
}
