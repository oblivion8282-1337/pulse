//! Die reine Rechnung der geteilten Zwischenablage — ohne `App`, ohne Fenster,
//! ohne Betriebssystem.
//!
//! **Abgetrennt von [`super`], wo die Verdrahtung wohnt** (`App::ablage`,
//! `ablage_takt`, `ablage_erfassung`): dort steht, WOHER ein Rahmen kommt und
//! wohin die Antwort geht, hier steht, WAS er bedeutet. Der Schnitt ist nicht
//! nur Zeilenkosmetik — er zieht die Deutung eines Rahmens ([`deuten`]) aus
//! dem `App`-Rumpf heraus, wo sie ungeprueft war: wer den Anstoss-Zweig dort
//! entfernte, bekam gruene Tests und zwei wirkungslose Wege.
//!
//! Alles hier ist ohne Compositor pruefbar — die Plattform kommt als
//! [`super::Ablageplattform`] herein und wird im Test von
//! `pulse_ablage::pruefstand::TestAblage` gestellt.

use std::time::Instant;

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::Anspruch;
use pulse_ablage::format::{Grund, Rahmen};
use pulse_ablage::sitzung::{Ankuendiger, Empfaenger, Fortschritt};

use super::Ablageplattform;
use crate::proto::Event;

/// Sichtbar gemachter [`Beobachter`] auf einer Plattform hinter `dyn`.
///
/// `Ankuendiger::beantworte` verlangt `&mut impl Beobachter`, also einen Typ
/// mit bekannter Groesse; `&mut dyn Ablageplattform` ist keiner. Diese Huelle
/// ist der ganze Unterschied — sie leitet beide Methoden unveraendert weiter.
struct Sicht<'a>(&'a mut dyn Ablageplattform);

impl Beobachter for Sicht<'_> {
    fn geaendert(&mut self) -> bool {
        self.0.geaendert()
    }
    fn lesen(&self) -> Option<String> {
        self.0.lesen()
    }
}

/// Was der Player einer Sitzung ausserhalb der Kiste merkt.
pub(crate) struct Ablagelage {
    ankuendiger: Ankuendiger,
    empfaenger: Empfaenger,
    anspruch: Anspruch,
    /// Schalter „Zwischenablage teilen" aus dem Fern-Menue. **Vorgabe an.**
    teilen: bool,
    /// Laeuft ueberhaupt eine Fernsteuerung? Gesetzt von `input_capture`, weil
    /// es keinen eigenen „Sitzung beginnt"-Rahmen gibt — ohne diesen Merker
    /// beobachtete der Player die Zwischenablage des Nutzers auch dann, wenn
    /// niemand fernsteuert.
    wach: bool,
    /// Halten WIR gerade das lokale Eigentum? Entscheidet, ob beim Freigeben
    /// zurueckgeschrieben wird.
    eigentuemer: bool,
    /// Was vor dem ersten Anspruch in der Ablage lag. **Kein Beiwerk:** ein
    /// Anspruch loescht den Vorbestand, und wird nie eingefuegt, waere der
    /// eigene kopierte Pfad des Nutzers durch fremde Aktivitaet still weg.
    vorbestand: Option<String>,
    /// Ein `hol`, dessen Antwort noch auf den Lesevorgang wartet — samt dem
    /// Zeitpunkt, an dem es eintraf.
    ///
    /// **Warum es ueberhaupt wartet:** das Lesen der fremden Auswahl darf
    /// nicht auf der Fensterschleife blockieren (s.
    /// [`super::Ablagequelle::lesen_anstossen`]), also faellt die Antwort
    /// einen Takt spaeter an. `ABRUF_FRIST_MS` (2 s) traegt das muehelos.
    ///
    /// Es kann nur EINES offen sein: die Gegenseite haelt hoechstens einen
    /// laufenden Abruf.
    offener_hol: Option<(Rahmen, u64)>,
    /// Bezugspunkt fuer die Millisekunden, mit denen `Empfaenger` rechnet.
    seit: Instant,
}

/// Wie lange die Antwort auf ein `hol` hoechstens auf den Lesevorgang wartet.
///
/// Deutlich unter `pulse_ablage::sitzung::ABRUF_FRIST_MS` (2 s), damit die
/// Antwort noch innerhalb der Frist des Abrufenden ankommt — und ueber der
/// Lesefrist der Plattform (Wayland: 500 ms), damit ein gesunder Lesevorgang
/// nicht kurz vor dem Ziel abgeschnitten wird.
const HOL_FRIST_MS: u64 = 1_000;

impl Default for Ablagelage {
    fn default() -> Self {
        Self {
            ankuendiger: Ankuendiger::neu(),
            empfaenger: Empfaenger::neu(),
            anspruch: Anspruch::neu(),
            teilen: true,
            wach: false,
            eigentuemer: false,
            vorbestand: None,
            offener_hol: None,
            seit: Instant::now(),
        }
    }
}

impl Ablagelage {
    fn jetzt_ms(&self) -> u64 {
        self.seit.elapsed().as_millis() as u64
    }

    pub(crate) fn teilt(&self) -> bool {
        self.teilen
    }

    /// Eine Fernsteuerung beginnt (`input_capture` an).
    pub(crate) fn beginnen(&mut self) {
        self.wach = true;
    }

    /// Ein Rahmen der Gegenseite. Liefert, was daraufhin hinausgeht.
    pub(crate) fn fern(&mut self, rahmen: &Rahmen, p: &mut dyn Ablageplattform) -> Vec<Rahmen> {
        match rahmen {
            Rahmen::Neu { .. } => {
                // Ohne Teilen wird nichts beansprucht — ein Anspruch, den wir
                // nicht einloesen wollen, kostete den Vorbestand des Nutzers.
                if self.teilen && self.empfaenger.angekuendigt(rahmen) {
                    self.anspruch.anmelden();
                }
                Vec::new()
            }
            Rahmen::Hol { id, .. } => {
                if !self.teilen {
                    // **Antworten, nicht schweigen.** Drueben wartet ein
                    // Einfuegevorgang; ein ausbleibender Rahmen kostete ihn die
                    // volle Abruf-Frist.
                    return vec![Rahmen::Leer { id: *id, grund: Grund::Weg }];
                }
                // **Beantwortet wird im Takt, nicht hier** (s.
                // [`Self::offener_hol`]): der Inhalt muss von der fremden
                // Auswahl geholt werden, und das darf die Fensterschleife
                // nicht anhalten. Der Anstoss ist idempotent.
                p.lesen_anstossen();
                let alt = self.offener_hol.replace((rahmen.clone(), self.jetzt_ms()));
                // Ein zweites `hol` heisst, das erste ist drueben abgelaufen.
                // Es unbeantwortet fallen zu lassen liesse dort einen
                // Einfuegevorgang bis in seine Frist warten.
                match alt {
                    Some((Rahmen::Hol { id, .. }, _)) => {
                        vec![Rahmen::Leer { id, grund: Grund::Weg }]
                    }
                    _ => Vec::new(),
                }
            }
            Rahmen::Stueck { .. } | Rahmen::Leer { .. } => {
                match self.empfaenger.eingang(rahmen) {
                    Fortschritt::Fertig(text) => p.liefern(&text),
                    // **Ein leerer Text ist eine gueltige Antwort** und heisst
                    // „es kam nichts" — besser als ein haengendes Programm.
                    Fortschritt::Leer(_) => p.liefern(""),
                    Fortschritt::Warten => {}
                }
                Vec::new()
            }
        }
    }

    /// `{"t":"neu_bitte"}` — den eigenen Stand erneut ankuendigen.
    ///
    /// Nach einem `remote_reclaim` haelt die Gegenseite sonst eine Generation,
    /// die es hier nicht mehr gibt; jedes Einfuegen antwortete danach
    /// `veraltet`, und die Ablage waere fuer den Rest der Sitzung still tot.
    pub(crate) fn neu_bitte(&mut self) -> Vec<Rahmen> {
        if !self.teilen {
            return Vec::new();
        }
        vec![self.ankuendiger.geaendert()]
    }

    /// `{"t":"ende"}` und das Ende der Erfassung: Eigentum abgeben und den
    /// Vorbestand zurueckschreiben.
    pub(crate) fn ende(&mut self, p: &mut dyn Ablageplattform) {
        self.wach = false;
        self.freigeben(p);
    }

    /// Den Schalter aus dem Fern-Menue umlegen.
    ///
    /// **Ausschalten gibt einen laufenden Anspruch frei**, es unterlaesst nicht
    /// bloss den naechsten: sonst bliebe die Ablage des Nutzers leer, obwohl er
    /// das Teilen gerade abgeschaltet hat — ausgerechnet der Schalter, der
    /// Vertrauen herstellen soll, hinterliesse Schaden.
    pub(crate) fn teilen_setzen(&mut self, an: bool, p: &mut dyn Ablageplattform) {
        if self.teilen == an {
            return;
        }
        self.teilen = an;
        if !an {
            self.freigeben(p);
        }
    }

    /// Eigentum abgeben und den Vorbestand zurueckschreiben.
    ///
    /// **Die Buchfuehrung danach fragt die Plattform, statt zu raten.**
    /// Zurueckschreiben heisst auf jeder Plattform „neue eigene Quelle mit dem
    /// gemerkten Text" (Wayland `set_selection`, Windows `SetClipboardData`,
    /// macOS `declareTypes`) — fremdes Eigentum laesst sich nirgends
    /// zurueckgeben. **Wir bleiben danach Eigentuemer**, und was in der Ablage
    /// liegt, IST der Merkposten.
    ///
    /// Ihn hier trotzdem zu loeschen, war der Fehler: `lesen()` liefert als
    /// Eigentuemer (richtigerweise) `None`, der naechste Anspruch merkte sich
    /// also nichts, und das uebernaechste Freigeben raeumte die Ablage des
    /// Nutzers — zwei Klicks im Schalter genuegten. Test:
    /// `zweimal_umschalten_verliert_den_vorbestand_nicht`.
    fn freigeben(&mut self, p: &mut dyn Ablageplattform) {
        self.anspruch.aufgeben();
        // Ungepruefte Weitergabe: `Eigentum::freigeben` traegt die Pruefung
        // „sind wir ueberhaupt noch Eigentuemer?" selbst und muss sie tragen —
        // nur die Plattform sieht, ob der Nutzer zwischendurch kopiert hat.
        p.freigeben(self.vorbestand.as_deref());
        self.eigentuemer = p.eigentuemer();
        if !self.eigentuemer {
            // Entweder haben wir geraeumt (kein Merkposten da), oder die
            // Ablage gehoert laengst wieder dem Nutzer. In beiden Faellen gibt
            // es nichts mehr aufzuheben.
            self.vorbestand = None;
        }
    }

    /// Ein Durchlauf der Ereignisschleife. Liefert, was hinausgeht.
    ///
    /// Vier Schritte in dieser Reihenfolge: eingereihten Anspruch einloesen,
    /// wartendes Einfuegen abrufen, eigene Aenderung ankuendigen, Frist
    /// pruefen.
    pub(crate) fn takt(&mut self, p: &mut dyn Ablageplattform) -> Vec<Rahmen> {
        if !self.wach {
            return Vec::new();
        }
        let jetzt = self.jetzt_ms();
        let mut hinaus = Vec::new();

        // 0. Ein `hol`, dessen Lesevorgang inzwischen fertig ist (s.
        //    [`Self::offener_hol`]). Die Frist darunter ist das Netz fuer eine
        //    Plattform, die nie fertig meldet — ohne sie haenge der
        //    Einfuegevorgang drueben bis in seine eigene Frist.
        if let Some((offen, seit)) = self.offener_hol.take() {
            if p.lesen_bereit() || jetzt.saturating_sub(seit) >= HOL_FRIST_MS {
                // Der Inhalt wird in `beantworte` gelesen, nicht hier — die
                // Reihenfolge „erst die Aenderung abholen, dann die Generation
                // vergleichen, dann lesen" ist der Sinn jener Signatur, und
                // sie gilt unveraendert: die Aenderungsmeldung wird JETZT
                // abgeholt, nicht beim Eintreffen des `hol`.
                hinaus.extend(self.ankuendiger.beantworte(&offen, &mut Sicht(p)));
            } else {
                self.offener_hol = Some((offen, seit));
            }
        }

        // 1. Der eingereihte Anspruch. `set_selection` verlangt eine
        //    Seriennummer aus einem frischen Eingabeereignis, und ein Klient
        //    OHNE FOKUS kann die Auswahl nicht setzen — der Compositor
        //    verwirft es STILL. Genau der Fall tritt ein, wenn der Nutzer zu
        //    einem lokalen Programm wechselt und drueben kopiert wird.
        //
        //    **Er wird erst eingeloest, wenn der Vorbestand gelesen ist.** Ein
        //    Anspruch loescht ihn; wer vorher beansprucht, hat nichts mehr zu
        //    merken. `Anspruch::seriennummer` verbraucht den Anspruch, darf
        //    also nicht gefragt werden, solange noch gelesen wird.
        let braucht_vorbestand = !(self.eigentuemer && p.eigentuemer());
        if self.anspruch.offen() && braucht_vorbestand && !p.lesen_bereit() {
            p.lesen_anstossen();
        } else if self.anspruch.seriennummer(p.seriennummer()) {
            // **Den Vorbestand VOR dem Anspruch lesen** — aber nur, wenn er
            // nicht ohnehin schon uns gehoert. Beide Bedingungen zaehlen:
            // `self.eigentuemer` heisst „wir haben etwas verdraengt",
            // `p.eigentuemer()` heisst „und es liegt immer noch bei uns". Hat
            // der Nutzer zwischendurch selbst kopiert, faellt die zweite weg,
            // und sein frischer Inhalt wird gemerkt — sonst waere er nach dem
            // naechsten Anspruch still verloren.
            //
            // **Ein `None` ueberschreibt nichts.** Halten wir die Auswahl,
            // liefert `lesen()` bewusst `None` (es waere unser eigener Stand);
            // eine unbedingte Zuweisung loeschte dann genau den Merkposten,
            // den sie retten soll — dieselbe Falle wie das `take()` in
            // `pulse_ablage::pruefstand::TestAblage::beanspruchen`.
            if braucht_vorbestand {
                if let Some(text) = p.lesen() {
                    self.vorbestand = Some(text);
                }
            }
            match p.beanspruchen() {
                Ok(()) => self.eigentuemer = true,
                Err(grund) => eprintln!(
                    "pulse-player: Zwischenablage nicht beansprucht ({grund}) — \
                     ein Einfuegen auf dieser Maschine bleibt leer."
                ),
            }
        }

        // 2. Wartet ein Einfuegevorgang? Erst jetzt geht `hol` hinaus — das
        //    IST das verzoegerte Rendern.
        //
        //    **Auch hier der `teilen`-Riegel** (Review C6). Er war der einzige
        //    der vier Schritte ohne, und das Fenster ist schmal (ein
        //    Schleifendurchlauf zwischen Ausschalten und Freigeben) — die
        //    fehlende Symmetrie zu den anderen dreien ist trotzdem genau die
        //    Stelle, an der ein spaeterer Umbau still etwas hinauslaesst.
        if self.teilen && p.einfuegen_wartet() {
            if let Some(hol) = self.empfaenger.abrufen(jetzt) {
                hinaus.push(hol);
            }
        }

        // 3. Hat sich die eigene Ablage geaendert? Dann nur die Ankuendigung,
        //    ohne Inhalt.
        if self.teilen && p.geaendert() {
            hinaus.push(self.ankuendiger.geaendert());
        }

        // 4. Die Frist eines laufenden Abrufs.
        if let Fortschritt::Leer(_) = self.empfaenger.takt(jetzt) {
            p.liefern("");
        }
        hinaus
    }
}

/// Ein Anstoss, der **nur** vom eigenen Renderer kommt und nie ueber die
/// Leitung geht — `pulse-ablage` kennt ihn nicht und muss ihn nicht kennen.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Anstoss {
    /// `{"t":"neu_bitte"}`
    NeuBitte,
    /// `{"t":"ende"}`
    Ende,
}

/// Die beiden internen Anstoesse erkennen — **vor** [`rahmen_lesen`].
pub(crate) fn anstoss_lesen(v: &serde_json::Value) -> Option<Anstoss> {
    match v.get("t").and_then(serde_json::Value::as_str) {
        Some("neu_bitte") => Some(Anstoss::NeuBitte),
        Some("ende") => Some(Anstoss::Ende),
        _ => None,
    }
}

/// Duenne Huelle um `Rahmen::aus_json`: ein kaputter Rahmen wird still
/// verworfen, statt die Sitzung zu beenden — ein Ablage-Rahmen ist es nicht
/// wert.
pub(crate) fn rahmen_lesen(v: &serde_json::Value) -> Option<Rahmen> {
    Rahmen::aus_json(v).ok()
}

/// Der Ereignisrahmen hinaus. Wie `eingabe_ereignis` in `app/eingabe.rs`
/// gebaut, nur mit `"ablage"` und `data`.
pub(crate) fn ablage_ereignis(id: u64, r: &Rahmen) -> Event {
    Event::new("ablage", serde_json::json!({ "session": id, "data": r.nach_json() }))
}
/// Was ein hereinkommender `data`-Wert bedeutet.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Entscheidung {
    /// Ein interner Anstoss des eigenen Renderers.
    Anstoss(Anstoss),
    /// Ein Rahmen der Gegenseite.
    Fern(Rahmen),
    /// Unlesbar — still verwerfen. Ein Ablage-Rahmen ist es nicht wert, die
    /// Sitzung dafuer zu beenden.
    Verwerfen,
}

/// **Die eine Stelle, an der die Reihenfolge gilt: erst die internen
/// Anstoesse, dann der Rahmen-Parser.**
///
/// Sie stand bis zum ersten Pruefdurchgang im Rumpf von `App::ablage` und war
/// damit von keinem Test beruehrt — wer den Anstoss-Zweig dort entfernte,
/// bekam gruene Tests und zwei wirkungslose Wege, also genau die Fehlerklasse,
/// gegen die die Anstoesse ueberhaupt gebaut sind. Als reine Funktion ist die
/// Reihenfolge pruefbar; `App::ablage` verzweigt nur noch ueber das Ergebnis.
pub(crate) fn deuten(v: &serde_json::Value) -> Entscheidung {
    if let Some(anstoss) = anstoss_lesen(v) {
        return Entscheidung::Anstoss(anstoss);
    }
    match rahmen_lesen(v) {
        Some(r) => Entscheidung::Fern(r),
        None => Entscheidung::Verwerfen,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulse_ablage::eigentum::Eigentum;
    use pulse_ablage::format::Inhaltstyp;
    use pulse_ablage::pruefstand::TestAblage;

    use crate::app::ablage::Ablagequelle;

    /// `TestAblage` plus die beiden Auskuenfte, die `pulse-ablage` nicht
    /// kennt. Ein Wrapper statt eines zweiten Testdoppels: was die Kiste
    /// prueft, soll hier NICHT nachgebaut werden.
    struct Pruefablage {
        inner: TestAblage,
        einfuegen: bool,
        serial: Option<u32>,
        /// Steht ein Lesevorgang schon bereit? Im Doppel sonst immer `true`
        /// (es liest synchron) — abschaltbar, um den Aufschub zu pruefen, den
        /// die echte Plattform erzwingt.
        bereit: bool,
    }

    impl Pruefablage {
        fn neu() -> Self {
            Self {
                inner: TestAblage::neu(),
                einfuegen: false,
                serial: Some(42),
                bereit: true,
            }
        }
    }

    impl Beobachter for Pruefablage {
        fn geaendert(&mut self) -> bool {
            self.inner.geaendert()
        }
        fn lesen(&self) -> Option<String> {
            self.inner.lesen()
        }
    }

    impl Eigentum for Pruefablage {
        fn beanspruchen(&mut self) -> Result<(), String> {
            self.inner.beanspruchen()
        }
        fn liefern(&mut self, text: &str) {
            self.inner.liefern(text);
        }
        fn freigeben(&mut self, zurueck: Option<&str>) {
            self.inner.freigeben(zurueck);
        }
    }

    impl Ablagequelle for Pruefablage {
        fn einfuegen_wartet(&mut self) -> bool {
            self.einfuegen
        }
        fn seriennummer(&self) -> Option<u32> {
            self.serial
        }
        fn eigentuemer(&self) -> bool {
            self.inner.beansprucht()
        }
        fn lesen_anstossen(&mut self) {}
        /// Das Doppel liest synchron — die Verzoegerung ist eine Eigenschaft
        /// der Plattform, nicht des Ablaufs darueber. Fuer den einen Test, der
        /// den Aufschub selbst prueft, laesst sie sich abschalten.
        fn lesen_bereit(&mut self) -> bool {
            self.bereit
        }
    }

    fn wache_lage() -> Ablagelage {
        let mut lage = Ablagelage::default();
        lage.beginnen();
        lage
    }

    /// **Die Reihenfolge an der Stelle, die im Betrieb gilt.** Die beiden
    /// Tests darunter belegen nur, dass der Parser die Anstoesse ablehnt und
    /// der Erkenner sie kennt — wer den Anstoss-Zweig aus [`deuten`]
    /// entfernte, bekaeme davon gruene Tests und zwei wirkungslose Wege, also
    /// genau die Fehlerklasse, gegen die die Anstoesse angetreten sind.
    /// `App::ablage` verzweigt ueber nichts anderes als diese Funktion.
    #[test]
    fn deuten_nimmt_die_anstoesse_vor_dem_rahmen_parser() {
        assert_eq!(
            deuten(&serde_json::json!({"t": "neu_bitte"})),
            Entscheidung::Anstoss(Anstoss::NeuBitte)
        );
        assert_eq!(
            deuten(&serde_json::json!({"t": "ende"})),
            Entscheidung::Anstoss(Anstoss::Ende)
        );
        assert_eq!(
            deuten(&serde_json::json!({"t": "neu", "gen": 1, "typ": "text"})),
            Entscheidung::Fern(Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text })
        );
        assert_eq!(deuten(&serde_json::json!({"t": "erfunden"})), Entscheidung::Verwerfen);
        assert_eq!(deuten(&serde_json::json!({})), Entscheidung::Verwerfen);
    }

    #[test]
    fn ein_rahmen_ohne_sitzung_wird_abgewiesen() {
        // Fail-closed wie im ganzen Fernsteuerungs-Weg: ein Rahmen ohne
        // zugeordnete Sitzung gehoert niemandem.
        assert!(
            rahmen_lesen(&serde_json::json!({"t": "neu", "gen": 1, "typ": "text"})).is_some()
        );
        assert!(rahmen_lesen(&serde_json::json!({"t": "erfunden"})).is_none());
    }

    #[test]
    fn ein_hinausgehender_rahmen_traegt_die_sitzung() {
        let ev = ablage_ereignis(7, &Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text });
        let v = serde_json::to_value(&ev).expect("serialisierbar");
        assert_eq!(v["ev"], "ablage");
        assert_eq!(v["session"], 7);
        assert_eq!(v["data"]["t"], "neu");
        // Der Renderer routet nach Sitzung; ohne sie landete der Rahmen im
        // falschen Fenster, sobald zwei Sitzungen laufen.
        assert!(v["session"].is_number());
    }

    /// **Der Test gegen die stille Wirkungslosigkeit.** `neu_bitte` ist fuer
    /// `Rahmen::aus_json` eine unbekannte Rahmenart — wer ihn nicht VORHER
    /// abfaengt, verwirft ihn, ohne dass irgendetwas rot wird.
    #[test]
    fn neu_bitte_ist_kein_rahmen_und_muss_vorher_abgefangen_werden() {
        let v = serde_json::json!({"t": "neu_bitte"});
        assert!(rahmen_lesen(&v).is_none(), "der Rahmen-Parser kennt ihn NICHT");
        assert_eq!(deuten(&v), Entscheidung::Anstoss(Anstoss::NeuBitte));

        let mut lage = wache_lage();
        let hinaus = lage.neu_bitte();
        assert_eq!(
            hinaus,
            vec![Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }],
            "ohne frische Ankuendigung haelt die Gegenseite eine Generation, \
             die es nicht mehr gibt — jedes Einfuegen antwortete `veraltet`"
        );
    }

    /// Dasselbe fuer das Sitzungsende: der Renderer schickt `{"t":"ende"}`,
    /// und ohne das Abfangen bliebe die Ablage des Nutzers leer.
    #[test]
    fn ende_ist_kein_rahmen_und_gibt_das_eigentum_zurueck() {
        let v = serde_json::json!({"t": "ende"});
        assert!(rahmen_lesen(&v).is_none(), "der Rahmen-Parser kennt ihn NICHT");
        assert_eq!(deuten(&v), Entscheidung::Anstoss(Anstoss::Ende));

        let mut p = Pruefablage::neu();
        p.inner.setzen("mein eigener Pfad");
        p.inner.geaendert(); // die Aenderung ist quittiert
        let mut lage = wache_lage();

        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut p);
        assert!(p.inner.beansprucht(), "die Ankuendigung muss den Anspruch einloesen");
        assert_eq!(p.inner.inhalt(), None, "der Anspruch loescht den Vorbestand");

        lage.ende(&mut p);
        // **Kein `!beansprucht` hier.** Zurueckschreiben heisst auf jeder
        // Plattform „neue eigene Quelle mit dem gemerkten Text" — wir halten
        // die Ablage danach weiter, jetzt aber mit dem Inhalt des Nutzers.
        // Die Zusicherung, auf die es ankommt, ist der INHALT; die frueher
        // hier stehende Eigentums-Zusicherung war nur im zu nachsichtigen
        // Testdoppel wahr.
        assert_eq!(
            p.inner.inhalt().as_deref(),
            Some("mein eigener Pfad"),
            "der Vorbestand muss zurueck — sonst kostet eine fremde Sitzung \
             dem Nutzer still seine eigene Ablage"
        );
    }

    /// Step 5b: **Ausschalten gibt den laufenden Anspruch frei**, es
    /// verhindert nicht bloss den naechsten.
    #[test]
    fn ausschalten_gibt_den_laufenden_anspruch_frei() {
        let mut p = Pruefablage::neu();
        p.inner.setzen("vorher");
        p.inner.geaendert();
        let mut lage = wache_lage();

        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut p);
        assert!(p.inner.beansprucht());

        lage.teilen_setzen(false, &mut p);
        // **Der Beleg dafuer, dass der Anspruch wirklich freigegeben wurde,
        // ist der zurueckgeschriebene Inhalt** — waere nur der naechste
        // Anspruch unterlassen worden, laege die Ablage weiter leer da. Auf
        // „nicht mehr beansprucht" laesst sich das NICHT stuetzen: nach dem
        // Zurueckschreiben halten wir die Ablage weiter, nun mit dem Inhalt
        // des Nutzers (s. `Ablagelage::freigeben`).
        assert_eq!(
            p.inner.inhalt().as_deref(),
            Some("vorher"),
            "sonst hinterliesse ausgerechnet der Vertrauens-Schalter Schaden"
        );
    }

    /// Der Nutzer kopiert waehrend der Sitzung selbst etwas — und verliert
    /// damit nach dem naechsten fremden Anspruch seine Ablage, wenn der
    /// Merkposten nicht nachgezogen wird.
    ///
    /// `TestAblage::setzen` raeumt `beansprucht` mit ab und bildet damit genau
    /// nach, was auf Wayland `wl_data_source.cancelled` meldet.
    #[test]
    fn ein_frisch_kopierter_vorbestand_geht_nicht_verloren() {
        let mut p = Pruefablage::neu();
        p.inner.setzen("alt");
        p.inner.geaendert();
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut p);
        assert!(p.inner.beansprucht());

        // Jetzt kopiert der Nutzer selbst — die Ablage gehoert wieder ihm.
        p.inner.setzen("frisch");
        lage.fern(&Rahmen::Neu { generation: 2, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut p);

        lage.ende(&mut p);
        assert_eq!(
            p.inner.inhalt().as_deref(),
            Some("frisch"),
            "der Merkposten muss der JUENGSTE eigene Inhalt sein, nicht der \
             beim ersten Anspruch verdraengte"
        );
    }

    /// **Zwei Klicks im Schalter, und die Ablage des Nutzers ist leer.**
    ///
    /// Der zweite Durchgang ist der gefaehrliche: nach dem Zurueckschreiben
    /// halten wir die Ablage weiter, `lesen()` liefert dann (richtigerweise)
    /// `None` — wer den Merkposten an dieser Stelle wegwirft, hat beim
    /// naechsten Freigeben nichts mehr zurueckzuschreiben und raeumt die
    /// Auswahl. Dieselbe Kette entsteht ohne den Schalter, allein durch
    /// Fernsteuerung beenden und neu beginnen.
    #[test]
    fn zweimal_umschalten_verliert_den_vorbestand_nicht() {
        let mut p = Pruefablage::neu();
        p.inner.setzen("/home/michael/wichtig.txt");
        p.inner.geaendert();
        let mut lage = wache_lage();

        // Drueben wird kopiert — wir beanspruchen und merken den Pfad.
        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut p);
        assert!(p.inner.beansprucht());

        // Aus: der Pfad kommt zurueck. (Das prueft schon der Test darueber —
        // hier ist es nur die Vorbedingung fuer den zweiten Durchgang.)
        lage.teilen_setzen(false, &mut p);
        assert_eq!(p.inner.inhalt().as_deref(), Some("/home/michael/wichtig.txt"));

        // Wieder ein, und drueben wird erneut kopiert.
        lage.teilen_setzen(true, &mut p);
        lage.fern(&Rahmen::Neu { generation: 2, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut p);

        // Und wieder aus.
        lage.teilen_setzen(false, &mut p);
        assert_eq!(
            p.inner.inhalt().as_deref(),
            Some("/home/michael/wichtig.txt"),
            "der Merkposten muss den zweiten Durchgang ueberleben — sonst \
             raeumt das naechste Freigeben die Ablage des Nutzers"
        );
    }

    #[test]
    fn ohne_teilen_geht_keine_ankuendigung_hinaus() {
        let mut p = Pruefablage::neu();
        let mut lage = wache_lage();
        lage.teilen_setzen(false, &mut p);
        p.inner.setzen("ein Passwort");
        assert!(lage.takt(&mut p).is_empty(), "auch die blosse Ankuendigung bleibt hier");
    }

    #[test]
    fn ohne_teilen_wird_ein_hol_beantwortet_statt_verschluckt() {
        let mut p = Pruefablage::neu();
        let mut lage = wache_lage();
        lage.teilen_setzen(false, &mut p);
        assert_eq!(
            lage.fern(&Rahmen::Hol { generation: 1, id: 5 }, &mut p),
            vec![Rahmen::Leer { id: 5, grund: Grund::Weg }],
            "drueben wartet ein Einfuegevorgang — Schweigen kostete ihn die Frist"
        );
    }

    #[test]
    fn eine_lokale_aenderung_kuendigt_ohne_inhalt_an() {
        let mut p = Pruefablage::neu();
        let mut lage = wache_lage();
        p.inner.setzen("streng geheim");
        let hinaus = lage.takt(&mut p);
        assert_eq!(hinaus, vec![Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }]);
        let j = serde_json::to_string(&hinaus[0].nach_json()).expect("serialisierbar");
        assert!(!j.contains("geheim"), "die Ankuendigung traegt keinen Inhalt: {j}");
    }

    /// Ohne laufende Fernsteuerung wird die Ablage des Nutzers gar nicht erst
    /// beobachtet.
    #[test]
    fn ohne_erfassung_geschieht_nichts() {
        let mut p = Pruefablage::neu();
        let mut lage = Ablagelage::default();
        p.inner.setzen("etwas");
        assert!(lage.takt(&mut p).is_empty());
    }

    /// Das verzoegerte Rendern: **erst wenn jemand einfuegt**, geht `hol`
    /// hinaus — die blosse Ankuendigung loest keine Uebertragung aus.
    #[test]
    fn hol_geht_erst_beim_einfuegen_hinaus() {
        let mut p = Pruefablage::neu();
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text }, &mut p);
        assert!(
            lage.takt(&mut p).iter().all(|r| !matches!(r, Rahmen::Hol { .. })),
            "ohne Einfuegevorgang kostet der haeufigste Fall null Uebertragung"
        );

        p.einfuegen = true;
        assert_eq!(lage.takt(&mut p), vec![Rahmen::Hol { generation: 4, id: 1 }]);
    }

    /// Ohne Seriennummer (Fenster ohne Fokus) bleibt der Anspruch eingereiht
    /// und wird spaeter eingeloest — er verpufft nicht.
    #[test]
    fn ohne_seriennummer_bleibt_der_anspruch_eingereiht() {
        let mut p = Pruefablage::neu();
        p.serial = None;
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut p);
        assert!(!p.inner.beansprucht(), "ohne Nummer verwirft der Compositor es STILL");

        p.serial = Some(7);
        lage.takt(&mut p);
        assert!(p.inner.beansprucht(), "mit der naechsten Nummer wird er eingeloest");
    }

    /// Der Rundlauf bis zum eingefuegten Text.
    #[test]
    fn stuecke_landen_beim_einfuegevorgang() {
        let mut p = Pruefablage::neu();
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text }, &mut p);
        p.einfuegen = true;
        let hol = lage.takt(&mut p);
        let Some(Rahmen::Hol { id, .. }) = hol.first() else { panic!("kein Abruf: {hol:?}") };
        for stueck in pulse_ablage::stueckelung::zerlegen(*id, "hallo").expect("passt") {
            lage.fern(&stueck, &mut p);
        }
        assert_eq!(p.inner.geliefert().as_deref(), Some("hallo"));
    }

    /// **F1:** die Antwort auf ein `hol` faellt einen Takt spaeter an, statt
    /// die Fensterschleife auf den fremden Klienten warten zu lassen.
    #[test]
    fn ein_hol_wartet_auf_den_lesevorgang_statt_die_schleife_anzuhalten() {
        let mut p = Pruefablage::neu();
        p.inner.setzen("mein Text");
        let mut lage = wache_lage();
        assert_eq!(
            lage.takt(&mut p),
            vec![Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }],
            "erst wird angekuendigt"
        );

        p.bereit = false;
        assert!(
            lage.fern(&Rahmen::Hol { generation: 1, id: 5 }, &mut p).is_empty(),
            "die Antwort darf nicht im Eingangsweg entstehen — dort wuerde \
             gelesen, und das haelt Bild und Eingabe an"
        );
        assert!(lage.takt(&mut p).is_empty(), "solange gelesen wird, kommt nichts");

        p.bereit = true;
        let antwort = lage.takt(&mut p);
        assert!(
            matches!(antwort.first(), Some(Rahmen::Stueck { id: 5, .. })),
            "sobald das Ergebnis da ist, geht der Inhalt hinaus: {antwort:?}"
        );
    }

    /// Ein zweites `hol` heisst, das erste ist drueben abgelaufen — es darf
    /// nicht unbeantwortet liegenbleiben, sonst wartet dort ein
    /// Einfuegevorgang bis in seine Frist.
    #[test]
    fn ein_verdraengtes_hol_wird_beantwortet() {
        let mut p = Pruefablage::neu();
        p.inner.setzen("etwas");
        let mut lage = wache_lage();
        lage.takt(&mut p);
        p.bereit = false;
        lage.fern(&Rahmen::Hol { generation: 1, id: 5 }, &mut p);
        assert_eq!(
            lage.fern(&Rahmen::Hol { generation: 1, id: 6 }, &mut p),
            vec![Rahmen::Leer { id: 5, grund: Grund::Weg }]
        );
    }

    /// Ein kaputter Rahmen beendet die Sitzung nicht — er wird still
    /// verworfen.
    #[test]
    fn ein_kaputter_rahmen_wird_still_verworfen() {
        assert!(rahmen_lesen(&serde_json::json!({"t": "hol", "gen": 1})).is_none());
        assert!(rahmen_lesen(&serde_json::json!({})).is_none());
    }
}

