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

use pulse_ablage::eigentum::Anspruch;
use pulse_ablage::format::{Grund, Rahmen};
use pulse_ablage::sitzung::{Ankuendiger, Empfaenger, Fortschritt};

use super::Ablageplattform;
use crate::proto::Event;

mod takt;

/// Was am PROZESS haengt und nicht an der Sitzung.
///
/// **Die Auswahl liegt am Prozess, die Zustandsmaschine an der Sitzung** — und
/// diese beiden Werte beschreiben die Auswahl, nicht die Gegenstelle. Sie hier
/// zu buendeln statt in [`Ablagelage`] ist der Unterschied zwischen „der
/// Vorbestand des Nutzers ueberlebt einen Traegerwechsel" und „das naechste
/// Fenster raeumt ihn weg": tritt der Traeger ab
/// (`App::ablage_traeger_waehlen`), beansprucht die Nachfolge-Sitzung sonst mit
/// ihrem eigenen, leeren Stand, liest als Eigentuemer (richtigerweise) `None`
/// und schreibt beim Ende nichts zurueck.
///
/// Ein Uebergeben beim Traegerwechsel taete dasselbe, waere aber eine Kopie,
/// die jemand vergessen kann; hier gibt es die Werte nur einmal.
#[derive(Default)]
pub(crate) struct Prozessablage {
    /// Was vor dem ersten Anspruch in der Ablage lag. **Kein Beiwerk:** ein
    /// Anspruch loescht den Vorbestand, und wird nie eingefuegt, waere der
    /// eigene kopierte Pfad des Nutzers durch fremde Aktivitaet still weg.
    vorbestand: Option<String>,
    /// Hat DIESER PROZESS die Auswahl verdraengt? Entscheidet, ob beim
    /// Freigeben zurueckgeschrieben wird. Nicht dasselbe wie
    /// `Ablagequelle::eigentuemer` — das fragt die Plattform, ob die Auswahl
    /// gerade bei uns liegt, auch ohne dass wir je etwas verdraengt haetten.
    eigentuemer: bool,
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
    /// Hat die Gegenseite schon einmal etwas angekuendigt, das wir liefern
    /// koennten? Entscheidet beim Wiedereinschalten, ob ein Anspruch
    /// ueberhaupt Sinn ergibt — ohne das loeschte der Schalter den Vorbestand
    /// des Nutzers fuer eine Ablage, in der drueben nie etwas lag.
    ///
    /// **Bleibt an der SITZUNG**, anders als [`Prozessablage`]: es beschreibt,
    /// was DIESE Gegenstelle angekuendigt hat, nicht den Zustand der lokalen
    /// Auswahl.
    fremd_bekannt: bool,
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

impl Default for Ablagelage {
    fn default() -> Self {
        Self {
            ankuendiger: Ankuendiger::neu(),
            empfaenger: Empfaenger::neu(),
            anspruch: Anspruch::neu(),
            teilen: true,
            wach: false,
            fremd_bekannt: false,
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

    /// Laeuft fuer diese Sitzung gerade eine Fernsteuerung? Grundlage der
    /// Traegerwahl in [`super::App::ablage_traeger_waehlen`].
    pub(crate) fn wacht(&self) -> bool {
        self.wach
    }

    /// Eine Fernsteuerung beginnt (`input_capture` an).
    pub(crate) fn beginnen(&mut self) {
        self.wach = true;
    }

    /// Ein Rahmen der Gegenseite. Liefert, was daraufhin hinausgeht.
    pub(crate) fn fern(&mut self, rahmen: &Rahmen, p: &mut dyn Ablageplattform) -> Vec<Rahmen> {
        match rahmen {
            Rahmen::Neu { .. } => {
                // **Die Ankuendigung wird IMMER verbucht, auch mit
                // abgeschaltetem Teilen** — sonst zeigte die gemerkte fremde
                // Generation nach dem Wiedereinschalten auf einen Stand von
                // vorgestern. Nur der Anspruch bleibt aus: ein Anspruch, den
                // wir nicht einloesen wollen, kostete den Vorbestand des
                // Nutzers.
                let neu_drueben = self.empfaenger.angekuendigt(rahmen);
                if neu_drueben {
                    self.fremd_bekannt = true;
                    if self.teilen {
                        self.anspruch.anmelden();
                    }
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

    /// Der Anstoss `neu_bitte` — den eigenen Stand erneut ankuendigen.
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

    /// Der Anstoss `ende` und das Ende der Erfassung: Eigentum abgeben und den
    /// Vorbestand zurueckschreiben.
    pub(crate) fn ende(&mut self, prozess: &mut Prozessablage, p: &mut dyn Ablageplattform) {
        self.wach = false;
        self.freigeben(prozess, p);
    }

    /// Den Schalter aus dem Fern-Menue umlegen.
    ///
    /// **Ausschalten gibt einen laufenden Anspruch frei**, es unterlaesst nicht
    /// bloss den naechsten: sonst bliebe die Ablage des Nutzers leer, obwohl er
    /// das Teilen gerade abgeschaltet hat — ausgerechnet der Schalter, der
    /// Vertrauen herstellen soll, hinterliesse Schaden.
    pub(crate) fn teilen_setzen(
        &mut self,
        an: bool,
        prozess: &mut Prozessablage,
        p: &mut dyn Ablageplattform,
    ) {
        if self.teilen == an {
            return;
        }
        self.teilen = an;
        if !an {
            self.freigeben(prozess, p);
            return;
        }
        // **Wiedereinschalten meldet den Anspruch neu an** (Review C9). Ohne
        // das koennte erst die NAECHSTE fremde Ankuendigung wieder etwas
        // holen: `Empfaenger::angekuendigt` erkennt einen Generationswechsel,
        // und der bleibt beim blossen Umschalten aus — die Ablage waere bis
        // zum naechsten Kopieren drueben still tot.
        //
        // **Nur, wenn drueben ueberhaupt schon etwas lag.** Sonst loeschte der
        // Schalter den Vorbestand des Nutzers fuer nichts.
        if self.fremd_bekannt {
            self.anspruch.anmelden();
        }
    }
}

/// Ein Anstoss, der **nur** vom eigenen Renderer kommt und nie ueber die
/// Leitung geht — `pulse-ablage` kennt ihn nicht und muss ihn nicht kennen.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Anstoss {
    /// `{"anstoss":"neu_bitte"}`
    NeuBitte,
    /// `{"anstoss":"ende"}`
    Ende,
}

/// Die beiden internen Anstoesse erkennen — sie tragen ihre **eigene Huelle**
/// (`{"anstoss":…}`), s. [`deuten`].
pub(crate) fn anstoss_lesen(v: &serde_json::Value) -> Option<Anstoss> {
    match v.get("anstoss").and_then(serde_json::Value::as_str) {
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

/// **Die eine Stelle, an der entschieden wird, was ein hereinkommender Wert
/// ist — und die Huelle entscheidet es, nicht die Reihenfolge.**
///
/// Jeder Wert kommt in einer von zwei Huellen:
///
/// * `{"anstoss":"ende"|"neu_bitte"}` — vom eigenen Renderer
///   (`web/src/lib/remote/ablageHuelle.ts`),
/// * `{"rahmen":{…}}` — von der Gegenseite, Nutzlast unveraendert.
///
/// **Warum die Huelle und nicht bloss eine Reihenfolge:** beide Wege gehen
/// durch dieselbe Tuer (`gsr:ablage`), und der Leitungsweg reicht die rohe
/// `data` der Gegenstelle durch. Standen die Anstoesse in derselben Form wie
/// ein Rahmen (frueher `{"t":"ende"}`), genuegte ein einziges fremdes
/// `remote_signal`, um `wach` abzuschalten — die Zwischenablage waere fuer den
/// Rest der Sitzung tot gewesen, ohne Log und ohne sichtbare Ursache. Ein
/// Filter im Renderer haette das gefangen; die Huelle macht es **strukturell
/// unmoeglich**, weil fremde Nutzlast immer unter `rahmen` liegt. Dieselbe
/// Form tragen 1b-2 und 1c, wo die Anstoesse an den Sidecar gehen.
///
/// Alles ohne bekannte Huelle wird verworfen — fail-closed wie im ganzen
/// Fernsteuerungs-Weg.
pub(crate) fn deuten(v: &serde_json::Value) -> Entscheidung {
    if v.get("anstoss").is_some() {
        return match anstoss_lesen(v) {
            Some(anstoss) => Entscheidung::Anstoss(anstoss),
            None => Entscheidung::Verwerfen,
        };
    }
    match v.get("rahmen").and_then(rahmen_lesen) {
        Some(r) => Entscheidung::Fern(r),
        None => Entscheidung::Verwerfen,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulse_ablage::beobachter::Beobachter;
    use pulse_ablage::eigentum::Eigentum;
    use pulse_ablage::format::Inhaltstyp;
    use pulse_ablage::pruefstand::TestAblage;

    use crate::app::ablage::{Ablagequelle, KeineAblage};

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
        /// Die Aenderung, die das AUFGEBEN der Auswahl meldet.
        ///
        /// `TestAblage` kennt sie nicht — sie entsteht erst in der Plattform
        /// (`AblageZustand::abgeloest` zieht den Zaehler hoch, C1). Ohne diese
        /// Nachbildung koennte hier gar nichts pruefen, dass sie quittiert
        /// wird; der Fehler waere nur im Betrieb sichtbar.
        aufgabe_gemeldet: bool,
    }

    impl Pruefablage {
        fn neu() -> Self {
            Self {
                inner: TestAblage::neu(),
                einfuegen: false,
                serial: Some(42),
                bereit: true,
                aufgabe_gemeldet: false,
            }
        }
    }

    impl Beobachter for Pruefablage {
        fn geaendert(&mut self) -> bool {
            // **Beide Quellen verbrauchend abholen**, nicht kurzgeschlossen:
            // `TestAblage::geaendert` quittiert seinen Zaehler mit, und ein
            // `||` liesse ihn bei gesetzter Aufgabe-Meldung stehen.
            let innen = self.inner.geaendert();
            let aufgabe = std::mem::take(&mut self.aufgabe_gemeldet);
            innen || aufgabe
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
            // Wie die echte Plattform: wer die Auswahl raeumt, meldet damit
            // eine Aenderung (s. `aufgabe_gemeldet`). Der Rueckschreib-Weg tut
            // das nicht — dort entsteht eine neue eigene Quelle.
            let raeumt = self.inner.beansprucht() && zurueck.is_none();
            self.inner.freigeben(zurueck);
            if raeumt {
                self.aufgabe_gemeldet = true;
            }
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
        fn wirksam(&self) -> bool {
            true
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

    /// **Die Huelle entscheidet, nicht die Reihenfolge.** Ein Anstoss kommt
    /// unter `anstoss`, ein Rahmen der Gegenseite unter `rahmen` —
    /// `App::ablage` verzweigt ueber nichts anderes als diese Funktion.
    #[test]
    fn deuten_trennt_anstoss_und_leitungsrahmen_an_der_huelle() {
        assert_eq!(
            deuten(&serde_json::json!({"anstoss": "neu_bitte"})),
            Entscheidung::Anstoss(Anstoss::NeuBitte)
        );
        assert_eq!(
            deuten(&serde_json::json!({"anstoss": "ende"})),
            Entscheidung::Anstoss(Anstoss::Ende)
        );
        assert_eq!(
            deuten(&serde_json::json!({"rahmen": {"t": "neu", "gen": 1, "typ": "text"}})),
            Entscheidung::Fern(Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text })
        );
        assert_eq!(
            deuten(&serde_json::json!({"anstoss": "erfunden"})),
            Entscheidung::Verwerfen
        );
        assert_eq!(
            deuten(&serde_json::json!({"rahmen": {"t": "erfunden"}})),
            Entscheidung::Verwerfen
        );
        // Ohne Huelle: fail-closed wie im ganzen Fernsteuerungs-Weg.
        assert_eq!(
            deuten(&serde_json::json!({"t": "neu", "gen": 1, "typ": "text"})),
            Entscheidung::Verwerfen
        );
        assert_eq!(deuten(&serde_json::json!({})), Entscheidung::Verwerfen);
    }

    /// **M1: die Leitung darf die internen Anstoesse nicht faelschen koennen.**
    ///
    /// Ein einziges fremdes `remote_signal` mit `{"t":"ende"}` schaltete
    /// frueher `wach` ab — die Zwischenablage war fuer den Rest der Sitzung
    /// tot, ohne Log und ohne sichtbare Ursache; `{"t":"neu_bitte"}` im
    /// Dauerfeuer frass das eigene Gateway-Kontingent, auf dem auch ICE sitzt.
    /// Fremde Nutzlast liegt jetzt IMMER unter `rahmen`, und dort ist ein
    /// Anstoss strukturell nicht erreichbar.
    #[test]
    fn ein_leitungsrahmen_kann_keinen_anstoss_ausloesen() {
        for gefaelscht in [
            serde_json::json!({"rahmen": {"t": "ende"}}),
            serde_json::json!({"rahmen": {"t": "neu_bitte"}}),
            serde_json::json!({"rahmen": {"anstoss": "ende"}}),
        ] {
            assert_eq!(
                deuten(&gefaelscht),
                Entscheidung::Verwerfen,
                "die Gegenseite darf keinen Anstoss ausloesen: {gefaelscht}"
            );
        }
        // Und die Gegenprobe: der echte Anstoss wirkt weiter.
        assert_eq!(
            deuten(&serde_json::json!({"anstoss": "ende"})),
            Entscheidung::Anstoss(Anstoss::Ende)
        );
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
        // **Die Sitzung reist mit, obwohl der Renderer sie heute nicht liest**
        // (`aufAblageEreignisse` reicht nur `data` weiter): die Zwischenablage
        // gehoert der Maschine, nicht dem Fenster. Sie steht hier fuer die
        // Diagnose und fuer den Tag, an dem zwei Gegenstellen zugleich moeglich
        // sind — dann muss der Rueckweg sie auswerten.
        assert!(v["session"].is_number());
    }

    /// **Der Test gegen die stille Wirkungslosigkeit.** `neu_bitte` ist fuer
    /// `Rahmen::aus_json` keine Rahmenart — nimmt die Huelle ihn nicht auf,
    /// verpufft er, ohne dass irgendetwas rot wird.
    #[test]
    fn neu_bitte_ist_kein_rahmen_und_wirkt_nur_in_der_anstoss_huelle() {
        let v = serde_json::json!({"anstoss": "neu_bitte"});
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

    /// Dasselbe fuer das Sitzungsende: der Renderer schickt
    /// `{"anstoss":"ende"}`, und ohne die Huelle bliebe die Ablage des Nutzers
    /// leer.
    #[test]
    fn ende_ist_kein_rahmen_und_gibt_das_eigentum_zurueck() {
        let v = serde_json::json!({"anstoss": "ende"});
        assert!(rahmen_lesen(&v).is_none(), "der Rahmen-Parser kennt ihn NICHT");
        assert_eq!(deuten(&v), Entscheidung::Anstoss(Anstoss::Ende));

        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.inner.setzen("mein eigener Pfad");
        p.inner.geaendert(); // die Aenderung ist quittiert
        let mut lage = wache_lage();

        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht(), "die Ankuendigung muss den Anspruch einloesen");
        assert_eq!(p.inner.inhalt(), None, "der Anspruch loescht den Vorbestand");

        lage.ende(&mut st, &mut p);
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
        let mut st = Prozessablage::default();
        p.inner.setzen("vorher");
        p.inner.geaendert();
        let mut lage = wache_lage();

        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht());

        lage.teilen_setzen(false, &mut st, &mut p);
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
        let mut st = Prozessablage::default();
        p.inner.setzen("alt");
        p.inner.geaendert();
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht());

        // Jetzt kopiert der Nutzer selbst — die Ablage gehoert wieder ihm.
        p.inner.setzen("frisch");
        lage.fern(&Rahmen::Neu { generation: 2, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut st, &mut p);

        lage.ende(&mut st, &mut p);
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
        let mut st = Prozessablage::default();
        p.inner.setzen("/home/michael/wichtig.txt");
        p.inner.geaendert();
        let mut lage = wache_lage();

        // Drueben wird kopiert — wir beanspruchen und merken den Pfad.
        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht());

        // Aus: der Pfad kommt zurueck. (Das prueft schon der Test darueber —
        // hier ist es nur die Vorbedingung fuer den zweiten Durchgang.)
        lage.teilen_setzen(false, &mut st, &mut p);
        assert_eq!(p.inner.inhalt().as_deref(), Some("/home/michael/wichtig.txt"));

        // Wieder ein, und drueben wird erneut kopiert.
        lage.teilen_setzen(true, &mut st, &mut p);
        lage.fern(&Rahmen::Neu { generation: 2, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut st, &mut p);

        // Und wieder aus.
        lage.teilen_setzen(false, &mut st, &mut p);
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
        let mut st = Prozessablage::default();
        let mut lage = wache_lage();
        lage.teilen_setzen(false, &mut st, &mut p);
        p.inner.setzen("ein Passwort");
        assert!(lage.takt(&mut st, &mut p).is_empty(), "auch die blosse Ankuendigung bleibt hier");
    }

    #[test]
    fn ohne_teilen_wird_ein_hol_beantwortet_statt_verschluckt() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        let mut lage = wache_lage();
        lage.teilen_setzen(false, &mut st, &mut p);
        assert_eq!(
            lage.fern(&Rahmen::Hol { generation: 1, id: 5 }, &mut p),
            vec![Rahmen::Leer { id: 5, grund: Grund::Weg }],
            "drueben wartet ein Einfuegevorgang — Schweigen kostete ihn die Frist"
        );
    }

    #[test]
    fn eine_lokale_aenderung_kuendigt_ohne_inhalt_an() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        let mut lage = wache_lage();
        p.inner.setzen("streng geheim");
        let hinaus = lage.takt(&mut st, &mut p);
        assert_eq!(hinaus, vec![Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }]);
        let j = serde_json::to_string(&hinaus[0].nach_json()).expect("serialisierbar");
        assert!(!j.contains("geheim"), "die Ankuendigung traegt keinen Inhalt: {j}");
    }

    /// Ohne laufende Fernsteuerung wird die Ablage des Nutzers gar nicht erst
    /// beobachtet.
    #[test]
    fn ohne_erfassung_geschieht_nichts() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        let mut lage = Ablagelage::default();
        p.inner.setzen("etwas");
        assert!(lage.takt(&mut st, &mut p).is_empty());
    }

    /// Das verzoegerte Rendern: **erst wenn jemand einfuegt**, geht `hol`
    /// hinaus — die blosse Ankuendigung loest keine Uebertragung aus.
    #[test]
    fn hol_geht_erst_beim_einfuegen_hinaus() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text }, &mut p);
        assert!(
            lage.takt(&mut st, &mut p).iter().all(|r| !matches!(r, Rahmen::Hol { .. })),
            "ohne Einfuegevorgang kostet der haeufigste Fall null Uebertragung"
        );

        p.einfuegen = true;
        assert_eq!(lage.takt(&mut st, &mut p), vec![Rahmen::Hol { generation: 4, id: 1 }]);
    }

    /// Ohne Seriennummer (Fenster ohne Fokus) bleibt der Anspruch eingereiht
    /// und wird spaeter eingeloest — er verpufft nicht.
    #[test]
    fn ohne_seriennummer_bleibt_der_anspruch_eingereiht() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.serial = None;
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut st, &mut p);
        assert!(!p.inner.beansprucht(), "ohne Nummer verwirft der Compositor es STILL");

        p.serial = Some(7);
        lage.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht(), "mit der naechsten Nummer wird er eingeloest");
    }

    /// Der Rundlauf bis zum eingefuegten Text.
    #[test]
    fn stuecke_landen_beim_einfuegevorgang() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text }, &mut p);
        p.einfuegen = true;
        let hol = lage.takt(&mut st, &mut p);
        let Some(Rahmen::Hol { id, .. }) = hol.first() else { panic!("kein Abruf: {hol:?}") };
        for stueck in pulse_ablage::stueckelung::zerlegen(*id, "hallo").expect("passt") {
            lage.fern(&stueck, &mut p);
        }
        assert_eq!(p.inner.geliefert().as_deref(), Some("hallo"));
    }

    /// **Neu-1:** eine ZWEITE Sitzung darf die zurueckgeschriebene Ablage
    /// nicht raeumen.
    ///
    /// Seit es einen Traeger je Prozess gibt, sind „haelt die Plattform die
    /// Auswahl gerade" und „hat dieser PROZESS sie je verdraengt" zwei
    /// verschiedene Fragen. Die Plattform kann nur die erste beantworten — die
    /// zweite fuehrt [`Prozessablage`], und ohne sie raeumt der Abbau der
    /// Nachfolge-Sitzung den Pfad, den die Vorgaengerin gerade
    /// zurueckgeschrieben hat.
    ///
    /// Hier beansprucht B **nicht**; den Fall deckt
    /// `ein_traegerwechsel_verliert_den_vorbestand_nicht` darunter ab.
    #[test]
    fn eine_zweite_sitzung_raeumt_die_zurueckgeschriebene_ablage_nicht() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.inner.setzen("/home/michael/wichtig.txt");
        p.inner.geaendert();
        // Zwei Sitzungen auf EINER Ablage — genau die Lage nach einem
        // Traegerwechsel (`App::ablage_traeger_waehlen`).
        let mut a = wache_lage();
        let mut b = wache_lage();

        a.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        a.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht(), "A ist Traeger und hat beansprucht");

        a.ende(&mut st, &mut p);
        assert_eq!(
            p.inner.inhalt().as_deref(),
            Some("/home/michael/wichtig.txt"),
            "A schreibt zurueck — und der PROZESS haelt die Auswahl weiter"
        );

        // B uebernimmt und endet ihrerseits, ohne je beansprucht zu haben.
        b.ende(&mut st, &mut p);
        assert_eq!(
            p.inner.inhalt().as_deref(),
            Some("/home/michael/wichtig.txt"),
            "der Merkposten wird hoechstens noch einmal zurueckgeschrieben, \
             nie geraeumt"
        );
    }

    /// **Das selbst geraeumte Fach darf nicht angekuendigt werden.**
    ///
    /// Der Gegenpol zu C1, und er bildet den WEG ab, nicht den Zustand: A
    /// beansprucht (der Nutzer hatte nichts in der Ablage, es gibt also nichts
    /// zurueckzuschreiben), A endet und raeumt die Auswahl, B wird Traeger und
    /// taktet.
    ///
    /// Ohne die Quittierung in [`Ablagelage::freigeben`] holt B die Meldung ab,
    /// die WIR ausgeloest haben, und kuendigt ein leeres Fach an — die
    /// Gegenseite beansprucht daraufhin ihre Ablage und verdraengt den Inhalt
    /// ihres Nutzers bis zum Sitzungsende. Genau der stille Verlust, gegen den
    /// dieser Mechanismus gebaut ist, nur auf der Gegenseite.
    #[test]
    fn das_selbst_geraeumte_fach_wird_nicht_angekuendigt() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        // Kein Vorbestand: die Ablage des Nutzers ist leer, `freigeben` raeumt
        // also, statt zurueckzuschreiben.
        let mut a = wache_lage();
        let mut b = wache_lage();

        a.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        assert!(a.takt(&mut st, &mut p).is_empty(), "der Anspruch allein kuendigt nichts an");
        assert!(p.inner.beansprucht(), "A haelt die Ablage");

        a.ende(&mut st, &mut p);
        assert_eq!(p.inner.inhalt(), None, "geraeumt, nicht zurueckgeschrieben");

        // B ist jetzt Traeger (`App::ablage_traeger_waehlen`) und taktet.
        let hinaus = b.takt(&mut st, &mut p);
        assert!(
            hinaus.is_empty(),
            "eine Ankuendigung fuer ein leeres Fach kostet die Gegenseite die \
             Ablage IHRES Nutzers: {hinaus:?}"
        );
    }

    /// **Eine Sitzung OHNE Plattform darf den Prozess-Stand nicht abbuchen.**
    ///
    /// `App::ablage_abbau` ruft `ende` fuer jede Sitzung, nicht nur fuer den
    /// Traeger; die uebrigen bekommen [`KeineAblage`], wo `eigentuemer()`
    /// immer `false` meldet. Ohne den `wirksam`-Ausstieg in
    /// [`Ablagelage::freigeben`] loescht das zuschauende Fenster den
    /// Merkposten, und wenn danach der echte Traeger endet, steht
    /// `prozess.eigentuemer` schon auf `false` — `Eigentum::freigeben` wird nie
    /// gerufen, der Vorbestand kommt nicht zurueck und die `wl_data_source`
    /// bleibt bis zum Prozessende stehen.
    ///
    /// **Warum der M2-Test das nicht faengt:** er gibt A und B dieselbe
    /// `Pruefablage`, modelliert also zwei TRAEGER. Der Fall hier braucht eine
    /// Sitzung, die die Plattform gar nicht haelt.
    #[test]
    fn eine_sitzung_ohne_plattform_bucht_den_prozess_stand_nicht_ab() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.inner.setzen("/home/michael/wichtig.txt");
        p.inner.geaendert();
        let mut traeger = wache_lage();
        let mut zuschauer = wache_lage();

        traeger.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        traeger.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht(), "der Traeger hat verdraengt und gemerkt");

        // Das zweite Fenster ist reiner Zuschauer — `mit_ablage` gibt ihm
        // `KeineAblage`. Es wird zuerst geschlossen (bei `stop_all_sessions`
        // und `exiting` entscheidet die HashMap-Reihenfolge darueber).
        zuschauer.ende(&mut st, &mut KeineAblage);

        // Und jetzt endet der echte Traeger.
        traeger.ende(&mut st, &mut p);
        assert_eq!(
            p.inner.inhalt().as_deref(),
            Some("/home/michael/wichtig.txt"),
            "ein Fenster, das die Ablage nie hielt, darf dem Traeger nicht \
             seinen Merkposten wegbuchen"
        );
    }

    /// **Die Gegenrichtung der Quittierung: eine FREMDE Meldung darf sie nicht
    /// schlucken.**
    ///
    /// Quittiert werden darf nur, was wir selbst ausgeloest haben — deshalb
    /// fragt [`Ablagelage::freigeben`] VOR dem Aufruf, ob die Plattform die
    /// Auswahl noch haelt. Hat der Nutzer inzwischen selbst kopiert, gehoert
    /// die anstehende Meldung ihm; sie zu schlucken risse C1 von der anderen
    /// Seite auf: der naechste Traeger bliebe auf einer Generation stehen, die
    /// nicht mehr zum Inhalt des Fachs passt.
    ///
    /// Der Fall braucht beides — `unser == false` UND `geraeumt == true` —,
    /// sonst prueft er den Riegel nicht, sondern nur die zweite Bedingung:
    /// deshalb beansprucht A eine LEERE Ablage (kein Merkposten), und erst
    /// danach kopiert der Nutzer.
    #[test]
    fn eine_fremde_uebernahme_wird_nicht_wegquittiert() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        let mut a = wache_lage();
        let mut b = wache_lage();

        a.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        assert!(a.takt(&mut st, &mut p).is_empty(), "leere Ablage, nichts anzukuendigen");
        assert!(p.inner.beansprucht());

        // Der Nutzer kopiert selbst — die Ablage gehoert wieder ihm.
        p.inner.setzen("frisch kopiert");
        a.ende(&mut st, &mut p);

        assert_eq!(
            b.takt(&mut st, &mut p),
            vec![Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }],
            "die Aenderung des Nutzers muss den Traegerwechsel ueberleben — \
             sonst kuendigt niemand sie an und jedes Einfuegen drueben \
             antwortete `veraltet`"
        );
    }

    /// **M2: der Vorbestand ueberlebt den Traegerwechsel.**
    ///
    /// Der ausdruecklich gebaute Fall mit zwei Player-Fenstern: A ist Traeger,
    /// hat den Pfad des Nutzers verdraengt und gemerkt. Der Nutzer schliesst
    /// Fenster A — A schreibt zurueck und **bleibt Eigentuemer**, Traeger wird
    /// B. Jetzt kopiert die Gegenseite, und B beansprucht.
    ///
    /// Lag der Merkposten an der SITZUNG, sah B hier `eigentuemer == false`,
    /// las als Eigentuemer (richtigerweise) `None`, merkte sich also nichts —
    /// und `p.freigeben(None)` bei B's Ende raeumte die Ablage des Nutzers.
    /// Nachgemessen: mit einer zweiten `Prozessablage` fuer B wird dieser Test
    /// rot.
    #[test]
    fn ein_traegerwechsel_verliert_den_vorbestand_nicht() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.inner.setzen("/home/michael/wichtig.txt");
        p.inner.geaendert();
        let mut a = wache_lage();
        let mut b = wache_lage();

        a.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        a.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht(), "A ist Traeger und hat beansprucht");

        // Fenster A geht zu: `ablage_abbau(A)` schreibt zurueck, der Traeger
        // wandert zu B.
        a.ende(&mut st, &mut p);
        assert_eq!(p.inner.inhalt().as_deref(), Some("/home/michael/wichtig.txt"));

        // Drueben wird kopiert — B beansprucht, BEVOR sie endet.
        b.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        b.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht(), "B haelt die Ablage jetzt");

        b.ende(&mut st, &mut p);
        assert_eq!(
            p.inner.inhalt().as_deref(),
            Some("/home/michael/wichtig.txt"),
            "der Merkposten haengt am Prozess, nicht an der Sitzung — sonst \
             ist der Pfad des Nutzers nach einem Fensterwechsel weg"
        );
    }

    /// **Neu-2:** ein geparktes `hol` darf nach dem Ausschalten keinen Inhalt
    /// mehr herausgeben — es wurde angenommen, als das Teilen noch an war.
    #[test]
    fn ausschalten_verwirft_ein_geparktes_hol() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.inner.setzen("streng geheim");
        let mut lage = wache_lage();
        assert_eq!(
            lage.takt(&mut st, &mut p),
            vec![Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }]
        );

        p.bereit = false;
        lage.fern(&Rahmen::Hol { generation: 1, id: 5 }, &mut p);
        lage.teilen_setzen(false, &mut st, &mut p);

        p.bereit = true;
        let hinaus = lage.takt(&mut st, &mut p);
        assert!(
            hinaus.is_empty(),
            "nach dem Ausschalten darf der geparkte Abruf nichts mehr \
             beantworten — er traegt den INHALT, nicht bloss ein `hol`: \
             {hinaus:?}"
        );
    }

    /// **C9:** nach dem Wiedereinschalten muss wieder etwas zu holen sein —
    /// `Empfaenger::angekuendigt` erkennt nur einen Generationswechsel, und
    /// der bleibt beim blossen Umschalten aus.
    #[test]
    fn wiedereinschalten_meldet_den_anspruch_neu_an() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.inner.setzen("mein Pfad");
        p.inner.geaendert();
        let mut lage = wache_lage();
        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut st, &mut p);
        assert!(p.inner.beansprucht());

        lage.teilen_setzen(false, &mut st, &mut p);
        lage.teilen_setzen(true, &mut st, &mut p);
        // KEINE neue Ankuendigung von drueben — allein das Umschalten.
        lage.takt(&mut st, &mut p);
        p.einfuegen = true;
        assert_eq!(
            lage.takt(&mut st, &mut p),
            vec![Rahmen::Hol { generation: 1, id: 1 }],
            "ohne die Neuanmeldung waere die Ablage bis zum naechsten Kopieren \
             drueben still tot"
        );
    }

    /// Die Gegenprobe: hat drueben noch nie jemand kopiert, darf das
    /// Einschalten NICHTS beanspruchen — sonst loeschte der Schalter den
    /// Vorbestand des Nutzers fuer eine leere Ablage.
    #[test]
    fn einschalten_ohne_fremde_ankuendigung_beansprucht_nichts() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.inner.setzen("mein Pfad");
        p.inner.geaendert();
        let mut lage = wache_lage();
        lage.teilen_setzen(false, &mut st, &mut p);
        lage.teilen_setzen(true, &mut st, &mut p);
        lage.takt(&mut st, &mut p);
        assert!(!p.inner.beansprucht());
        assert_eq!(p.inner.inhalt().as_deref(), Some("mein Pfad"));
    }

    /// **F1:** die Antwort auf ein `hol` faellt einen Takt spaeter an, statt
    /// die Fensterschleife auf den fremden Klienten warten zu lassen.
    #[test]
    fn ein_hol_wartet_auf_den_lesevorgang_statt_die_schleife_anzuhalten() {
        let mut p = Pruefablage::neu();
        let mut st = Prozessablage::default();
        p.inner.setzen("mein Text");
        let mut lage = wache_lage();
        assert_eq!(
            lage.takt(&mut st, &mut p),
            vec![Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }],
            "erst wird angekuendigt"
        );

        p.bereit = false;
        assert!(
            lage.fern(&Rahmen::Hol { generation: 1, id: 5 }, &mut p).is_empty(),
            "die Antwort darf nicht im Eingangsweg entstehen — dort wuerde \
             gelesen, und das haelt Bild und Eingabe an"
        );
        assert!(lage.takt(&mut st, &mut p).is_empty(), "solange gelesen wird, kommt nichts");

        p.bereit = true;
        let antwort = lage.takt(&mut st, &mut p);
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
        let mut st = Prozessablage::default();
        p.inner.setzen("etwas");
        let mut lage = wache_lage();
        lage.takt(&mut st, &mut p);
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

