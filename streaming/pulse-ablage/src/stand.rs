//! Der Stand der lokalen Ablage zwischen zwei Faeden — und die Buchfuehrung
//! ueber „wer hat sie zuletzt angefasst".
//!
//! **Warum das hier liegt und nicht im Sidecar:** kein einziger Aufruf ans
//! Betriebssystem steht darin, und die Frage, die es beantwortet — welche
//! Aenderung die eigene ist und welche die des Nutzers — stellt sich auf jeder
//! Plattform, auf der der Ablauf zwei Faeden hat. Bis zum 2026-08-31 lag die
//! Datei als `win-hq-sidecar/src/ablage/geteilt.rs` beim einzigen Verbraucher;
//! dort hingen ihre Tests an **keinem** Gate (`gate-rust.sh` nimmt den
//! Windows-Sidecar ausdruecklich nicht, er baut auf Linux nicht). Dasselbe
//! Argument, mit dem [`crate::lage`] hierher zog.
//!
//! **Wie weit sie plattformfrei ist, ehrlich:** die Zaehl-Regeln (Eigentum
//! verloren = unverbuchte Aenderung, nur Text zaehlt, ein Wechsel verwirft ein
//! gelesenes Ergebnis) und die beiden Handschlaege (Rendervorgang, Lesevorgang)
//! gelten ueberall. Der Zaehler [`Ablagestand::erwartet`] ist dagegen an einer
//! **Meldung** aufgehaengt; macOS hat keine, dort wird `changeCount` gepollt
//! (Plan 1c). Ob 1c denselben Zaehler benutzt oder seinen eigenen Stand merkt,
//! ist offen — **die Datei behauptet das nicht im Voraus.**
//!
//! **Die Invariante, die diese Struktur traegt:** die Sperre darum wird **nie
//! ueber einen Aufruf ans Betriebssystem gehalten**. Auf Windows schickt
//! `EmptyClipboard` dem Eigentuemer synchron ein `WM_DESTROYCLIPBOARD`, und das
//! landet im eigenen Fensterrueckruf auf demselben Faden — eine gehaltene
//! `Mutex` waere dort ein Selbstblock, denn `std::sync::Mutex` ist nicht
//! wiedereintrittsfaehig.

/// Alles, was der Faden mit dem Betriebssystem-Rueckruf und der Takt-Faden
/// gemeinsam sehen.
///
/// [`Ablagestand::neu`] ist `const`, damit die `Mutex` darum ein `static` sein
/// kann — `Default` genuegt dafuer nicht.
pub struct Ablagestand {
    /// Zaehlt Wechsel der Ablage. Die Nachbildung von
    /// `NSPasteboard.changeCount` ist Absicht — dieselbe Bauart wie im
    /// Testdoppel `pulse_ablage::pruefstand::TestAblage` und im Wayland-Weg.
    stand: u64,
    gesehen: u64,
    /// Halten WIR die Ablage gerade? Kommt aus `GetClipboardOwner`, nicht aus
    /// einem Merker: hat der Nutzer selbst kopiert, ist „wir haben
    /// beansprucht" laengst falsch.
    eigen: bool,
    /// Selbst ausgeloeste Aenderungen, deren Meldung noch unterwegs ist.
    ///
    /// **Wozu:** ohne ihn kuendigte jeder eigene Anspruch der Gegenseite ihren
    /// eigenen Inhalt als Neuigkeit zurueck, sie beanspruchte daraufhin, und
    /// das ginge endlos — dieselbe Falle, die auf Wayland
    /// `AblageZustand::eigene` abfaengt.
    ///
    /// **Warum er aufgehen SOLLTE — gefolgert, nicht gemessen.** Die Rechnung:
    /// jede eigene Aenderung laeuft auf dem Faden mit dem Fensterrueckruf, und
    /// `WM_CLIPBOARDUPDATE` wird an dasselbe Fenster *gepostet*; die Meldung
    /// kann also erst dran sein, wenn der laufende Rueckruf zurueck ist, und
    /// der Zaehler steht dann. **Sie setzt zwei Dinge ueber Windows voraus,
    /// die auf der Entwicklungsmaschine niemand pruefen kann** (kein Windows,
    /// kein Bau): dass die Meldung gepostet und nicht synchron gesendet wird,
    /// und dass es **genau eine** je eigener Operation gibt. Beides ist aus
    /// der Doku gefolgert.
    ///
    /// **Die drei Ausgaenge, wenn eine der beiden Annahmen nicht traegt** —
    /// sie gehoeren auf die Liste des ersten Handlaufs auf einer echten
    /// Maschine:
    ///
    /// * **synchron zugestellt** (aus `SetClipboardData` heraus): dann laeuft
    ///   [`Ablagestand::systemmeldung`] VOR [`Ablagestand::selbst_geaendert`],
    ///   `erwartet` steht auf 0, der eigene Anspruch geht als Ankuendigung
    ///   hinaus, die Gegenseite beansprucht zurueck — **genau die
    ///   Endlosschleife, gegen die dieser Zaehler gebaut ist.**
    /// * **zwei Meldungen je Operation**: dasselbe, nur eine Runde spaeter.
    /// * **gar keine Meldung**: der Zaehler bleibt stehen und schluckt die
    ///   naechste echte Kopie des Nutzers — eine ausbleibende Ankuendigung,
    ///   also die harmlose Richtung.
    ///
    /// Erkennbar ist der erste Fall im Betrieb daran, dass unmittelbar nach
    /// einem Anspruch eine Ankuendigung hinausgeht, ohne dass jemand kopiert
    /// hat.
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

impl Ablagestand {
    pub const fn neu() -> Ablagestand {
        Ablagestand {
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
    /// (`WM_CLIPBOARDUPDATE` auf Windows).
    ///
    /// `eigner` = gehoert die Ablage jetzt unserem Fenster, `text_da` = liegt
    /// Text darin.
    pub fn systemmeldung(&mut self, eigner: bool, text_da: bool) {
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
    pub fn selbst_geaendert(&mut self, eigen: bool) {
        self.erwartet += 1;
        self.eigen = eigen;
        self.gelesen = None;
    }

    /// Verbrauchend, wie `Beobachter::geaendert` es verlangt.
    pub fn aenderung_abholen(&mut self) -> bool {
        let neu = self.stand != self.gesehen;
        self.gesehen = self.stand;
        neu
    }

    pub fn eigen(&self) -> bool {
        self.eigen
    }

    pub fn wartet(&self) -> bool {
        self.wartet
    }

    /// Ein Rendervorgang beginnt zu warten.
    pub fn warten_beginnen(&mut self) {
        self.wartet = true;
        self.antwort = None;
        self.abbruch = false;
    }

    /// Was der wartende Rendervorgang bekommt — `None`, solange nichts da ist
    /// und nichts abgebrochen wurde.
    pub fn antwort_nehmen(&mut self) -> Option<String> {
        if let Some(text) = self.antwort.take() {
            return Some(text);
        }
        // **Ein abgebrochener Rendervorgang bekommt eine leere Zeichenkette,
        // nicht gar nichts.** Er blockiert ein fremdes Programm; ohne Antwort
        // stuende es bis zu unserer eigenen Frist.
        if self.abbruch { Some(String::new()) } else { None }
    }

    pub fn warten_beenden(&mut self) {
        self.wartet = false;
        self.antwort = None;
        self.abbruch = false;
    }

    /// Inhalt fuer den wartenden Rendervorgang hinterlegen
    /// (`Eigentum::liefern`). Wartet keiner, ist es folgenlos.
    pub fn antwort_setzen(&mut self, text: &str) {
        if self.wartet {
            self.antwort = Some(text.to_string());
        }
    }

    /// Einen wartenden Rendervorgang abbrechen, weil die Ablage gleich neu
    /// belegt wird.
    pub fn abbrechen(&mut self) {
        if self.wartet {
            self.abbruch = true;
        }
    }

    /// Ist noch kein Lesevorgang unterwegs oder fertig?
    pub fn lesen_offen(&self) -> bool {
        !self.lesen_laeuft && self.gelesen.is_none()
    }

    pub fn lesen_beginnen(&mut self) {
        self.lesen_laeuft = true;
    }

    pub fn lesen_fertig(&mut self, text: Option<String>) {
        self.lesen_laeuft = false;
        self.gelesen = Some(text);
    }

    pub fn lesen_bereit(&self) -> bool {
        self.gelesen.is_some()
    }

    pub fn gelesenes(&self) -> Option<String> {
        self.gelesen.clone().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::Ablagestand;

    /// Der eigene Anspruch darf keine Ankuendigung ausloesen.
    ///
    /// Sonst meldeten wir der Gegenseite ihren eigenen Inhalt als Neuigkeit
    /// zurueck, sie beanspruchte daraufhin ihre Ablage, und das ginge endlos.
    #[test]
    fn der_eigene_anspruch_zaehlt_nicht_als_aenderung() {
        let mut g = Ablagestand::neu();
        g.selbst_geaendert(true);
        g.systemmeldung(true, false);
        assert!(!g.aenderung_abholen(), "die eigene Aenderung darf nicht hinausgehen");
    }

    /// Kopiert der Nutzer selbst, geht genau eine Ankuendigung hinaus.
    #[test]
    fn fremdes_kopieren_zaehlt_einmal() {
        let mut g = Ablagestand::neu();
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
        let mut g = Ablagestand::neu();
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
        let mut g = Ablagestand::neu();
        g.systemmeldung(false, false);
        assert!(!g.aenderung_abholen());
    }

    /// Ein abgebrochener Rendervorgang bekommt eine leere Antwort statt gar
    /// keiner — sonst haengt das einfuegende Programm.
    #[test]
    fn ein_abbruch_beantwortet_den_wartenden_leer() {
        let mut g = Ablagestand::neu();
        g.warten_beginnen();
        assert_eq!(g.antwort_nehmen(), None, "solange nichts da ist, wird gewartet");
        g.abbrechen();
        assert_eq!(g.antwort_nehmen().as_deref(), Some(""));
    }

    /// Eine Aenderung der Ablage macht ein bereits gelesenes Ergebnis
    /// ungueltig — es gehoert dem Fach, aus dem es stammt.
    #[test]
    fn eine_aenderung_verwirft_das_gelesene() {
        let mut g = Ablagestand::neu();
        g.lesen_beginnen();
        g.lesen_fertig(Some("alt".into()));
        assert!(g.lesen_bereit());
        g.systemmeldung(false, true);
        assert!(!g.lesen_bereit(), "sonst antwortete ein hol mit dem Inhalt von vorhin");
        assert!(g.lesen_offen(), "und ein neuer Lesevorgang muss moeglich sein");
    }
}
