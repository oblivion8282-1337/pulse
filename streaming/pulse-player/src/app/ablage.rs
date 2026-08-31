//! Die geteilte Zwischenablage der Fernsteuerung — die Seite des Players.
//!
//! **Achtung, Namensgleichheit:** `crate::ablage` daneben ist etwas voellig
//! anderes (Temp-Pfade fuer Mitschriften). Hier geht es um die Zwischenablage;
//! die Kiste dahinter heisst `pulse_ablage`.
//!
//! **Der Mechanismus ist verzoegertes Rendern** und liegt vollstaendig in
//! `pulse_ablage` — beim Kopieren geht nur eine Ankuendigung hinaus, der
//! Inhalt erst, wenn drueben jemand tatsaechlich einfuegt. Diese Datei ist die
//! Verdrahtung: sie deutet den Rahmen, haelt je Sitzung die beiden
//! Zustandsmaschinen und reicht die zwei Beruehrungspunkte mit dem
//! Betriebssystem ([`Beobachter`], [`Eigentum`]) an die Plattform durch.
//!
//! **Die Plattform ist heute allein Wayland**
//! (`crate::fernsteuerung::wayland::ablage`). Auf X11, Windows und macOS gibt
//! es sie nicht: dort laeuft dieselbe Zustandsmaschine mit [`KeineAblage`]
//! weiter und beruehrt nichts. Der Windows-Host folgt in Plan 1b-2, macOS in
//! 1c.
//!
//! **Zwei Rahmen kommen NICHT von der Gegenseite** und stehen deshalb nicht in
//! `pulse-ablage`: `{"t":"neu_bitte"}` (nach einem `remote_reclaim` erneut
//! ankuendigen) und `{"t":"ende"}` (Eigentum abgeben, Vorbestand
//! zurueckschreiben). Sie gehen nur vom Renderer an die eigene Plattform und
//! werden deshalb **vor** `Rahmen::aus_json` abgefangen — sonst verwuerfe
//! [`rahmen_lesen`] sie still und beide Wege waeren wirkungslos, ohne dass
//! irgendetwas rot wird. Genau dagegen stehen unten zwei Tests.

use std::time::Instant;

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::{Anspruch, Eigentum};
use pulse_ablage::format::{Grund, Rahmen};
use pulse_ablage::sitzung::{Ankuendiger, Empfaenger, Fortschritt};

use super::App;
use crate::proto::{Event, Request};

/// Was die Plattform ausserhalb der beiden Kisten-Traits noch beantworten
/// muss.
///
/// Beides sind Fragen, die `pulse-ablage` bewusst nicht stellt: „wartet ein
/// Einfuegevorgang?" ist auf jeder Plattform ein anderes Ereignis, und die
/// Seriennummer ist eine reine Wayland-Not (s. `Anspruch`).
pub(crate) trait Ablagequelle {
    /// Wartet gerade ein Einfuegevorgang auf Inhalt? Auf Wayland ist das ein
    /// `wl_data_source.send` mit noch offenem Dateideskriptor.
    fn einfuegen_wartet(&mut self) -> bool;

    /// Seriennummer eines frischen Eingabeereignisses, mit der sich die
    /// Auswahl setzen laesst — `None`, solange keine vorliegt. Der Anspruch
    /// bleibt dann eingereiht, statt still zu verpuffen.
    fn seriennummer(&self) -> Option<u32>;

    /// Halten WIR die lokale Ablage gerade?
    ///
    /// **Die Plattform weiss das besser als ein Merker hier**, und darauf
    /// kommt es an: hat der Nutzer zwischendurch selbst kopiert, ist „wir
    /// haben beansprucht" laengst falsch — auf Wayland meldet das
    /// `wl_data_source.cancelled`, und das sieht nur die Plattform. Ohne diese
    /// Auskunft merkte sich [`Ablagelage`] den Vorbestand des Nutzers genau
    /// dann nicht, wenn er frisch ist.
    fn eigentuemer(&self) -> bool;
}

/// Alles zusammen, was eine Plattform-Umsetzung koennen muss.
///
/// **Als Objekt-Trait gefuehrt** (`&mut dyn Ablageplattform`), damit
/// [`App::mit_ablage`] EINE Fassung hat statt einer je Plattform: die
/// Umsetzung unterscheidet sich zwischen Linux und dem Rest, der Ablauf
/// darueber nicht.
pub(crate) trait Ablageplattform: Beobachter + Eigentum + Ablagequelle {}
impl<T: Beobachter + Eigentum + Ablagequelle> Ablageplattform for T {}

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

/// Die Plattform, die es (noch) nicht gibt: X11, Windows, macOS.
///
/// **Kein Fehlerfall.** Die Zustandsmaschine laeuft trotzdem — sie meldet nie
/// eine Aenderung, beansprucht nichts und liefert nichts. Damit gibt es genau
/// EINEN Kontrollfluss statt eines zweiten, plattformfreien Zweigs, den
/// niemand pflegt.
pub(crate) struct KeineAblage;

impl Beobachter for KeineAblage {
    fn geaendert(&mut self) -> bool {
        false
    }
    fn lesen(&self) -> Option<String> {
        None
    }
}

impl Eigentum for KeineAblage {
    fn beanspruchen(&mut self) -> Result<(), String> {
        Err("auf dieser Plattform gibt es noch keine Zwischenablage-Umsetzung".into())
    }
    fn liefern(&mut self, _text: &str) {}
    fn freigeben(&mut self, _zurueck: Option<&str>) {}
}

impl Ablagequelle for KeineAblage {
    fn einfuegen_wartet(&mut self) -> bool {
        false
    }
    fn seriennummer(&self) -> Option<u32> {
        None
    }
    fn eigentuemer(&self) -> bool {
        false
    }
}

/// Was der Player einer Sitzung ausserhalb der Kiste merkt.
pub(super) struct Ablagelage {
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
            eigentuemer: false,
            vorbestand: None,
            seit: Instant::now(),
        }
    }
}

impl Ablagelage {
    pub(super) fn teilt(&self) -> bool {
        self.teilen
    }

    /// Eine Fernsteuerung beginnt (`input_capture` an).
    pub(super) fn beginnen(&mut self) {
        self.wach = true;
    }

    /// Ein Rahmen der Gegenseite. Liefert, was daraufhin hinausgeht.
    pub(super) fn fern(&mut self, rahmen: &Rahmen, p: &mut dyn Ablageplattform) -> Vec<Rahmen> {
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
                // Der Inhalt wird in `beantworte` gelesen, nicht hier — die
                // Reihenfolge „erst die Aenderung abholen, dann die Generation
                // vergleichen, dann lesen" ist der Sinn jener Signatur.
                self.ankuendiger.beantworte(rahmen, &mut Sicht(p))
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
    pub(super) fn neu_bitte(&mut self) -> Vec<Rahmen> {
        if !self.teilen {
            return Vec::new();
        }
        vec![self.ankuendiger.geaendert()]
    }

    /// `{"t":"ende"}` und das Ende der Erfassung: Eigentum abgeben und den
    /// Vorbestand zurueckschreiben.
    pub(super) fn ende(&mut self, p: &mut dyn Ablageplattform) {
        self.wach = false;
        self.freigeben(p);
    }

    /// Den Schalter aus dem Fern-Menue umlegen.
    ///
    /// **Ausschalten gibt einen laufenden Anspruch frei**, es unterlaesst nicht
    /// bloss den naechsten: sonst bliebe die Ablage des Nutzers leer, obwohl er
    /// das Teilen gerade abgeschaltet hat — ausgerechnet der Schalter, der
    /// Vertrauen herstellen soll, hinterliesse Schaden.
    pub(super) fn teilen_setzen(&mut self, an: bool, p: &mut dyn Ablageplattform) {
        if self.teilen == an {
            return;
        }
        self.teilen = an;
        if !an {
            self.freigeben(p);
        }
    }

    fn freigeben(&mut self, p: &mut dyn Ablageplattform) {
        self.anspruch.aufgeben();
        if self.eigentuemer {
            p.freigeben(self.vorbestand.as_deref());
            self.eigentuemer = false;
        }
        self.vorbestand = None;
    }

    /// Ein Durchlauf der Ereignisschleife. Liefert, was hinausgeht.
    ///
    /// Vier Schritte in dieser Reihenfolge: eingereihten Anspruch einloesen,
    /// wartendes Einfuegen abrufen, eigene Aenderung ankuendigen, Frist
    /// pruefen.
    pub(super) fn takt(&mut self, p: &mut dyn Ablageplattform) -> Vec<Rahmen> {
        if !self.wach {
            return Vec::new();
        }
        let jetzt = self.seit.elapsed().as_millis() as u64;
        let mut hinaus = Vec::new();

        // 1. Der eingereihte Anspruch. `set_selection` verlangt eine
        //    Seriennummer aus einem frischen Eingabeereignis, und ein Klient
        //    OHNE FOKUS kann die Auswahl nicht setzen — der Compositor
        //    verwirft es STILL. Genau der Fall tritt ein, wenn der Nutzer zu
        //    einem lokalen Programm wechselt und drueben kopiert wird.
        if self.anspruch.seriennummer(p.seriennummer()) {
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
            if !(self.eigentuemer && p.eigentuemer()) {
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
        if p.einfuegen_wartet() {
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
pub(super) enum Anstoss {
    /// `{"t":"neu_bitte"}`
    NeuBitte,
    /// `{"t":"ende"}`
    Ende,
}

/// Die beiden internen Anstoesse erkennen — **vor** [`rahmen_lesen`].
pub(super) fn anstoss_lesen(v: &serde_json::Value) -> Option<Anstoss> {
    match v.get("t").and_then(serde_json::Value::as_str) {
        Some("neu_bitte") => Some(Anstoss::NeuBitte),
        Some("ende") => Some(Anstoss::Ende),
        _ => None,
    }
}

/// Duenne Huelle um `Rahmen::aus_json`: ein kaputter Rahmen wird still
/// verworfen, statt die Sitzung zu beenden — ein Ablage-Rahmen ist es nicht
/// wert.
pub(super) fn rahmen_lesen(v: &serde_json::Value) -> Option<Rahmen> {
    Rahmen::aus_json(v).ok()
}

/// Der Ereignisrahmen hinaus. Wie `eingabe_ereignis` in `app/eingabe.rs`
/// gebaut, nur mit `"ablage"` und `data`.
pub(super) fn ablage_ereignis(id: u64, r: &Rahmen) -> Event {
    Event::new("ablage", serde_json::json!({ "session": id, "data": r.nach_json() }))
}

impl App {
    /// Zustandsmaschine EINER Sitzung und die Plattform zusammen ausleihen.
    ///
    /// Zwei disjunkte Felder von `self` — deshalb als Feldzugriff und nicht
    /// als Methodenpaar, das der Compiler als zwei Ausleihen von `self` saehe.
    #[cfg(target_os = "linux")]
    fn mit_ablage<R>(
        &mut self,
        id: u64,
        f: impl FnOnce(&mut Ablagelage, &mut dyn Ablageplattform) -> R,
    ) -> Option<R> {
        let lage = &mut self.sessions.get_mut(&id)?.ablage;
        Some(match self.wayland_zug.ablage_plattform() {
            Some(p) => f(lage, p),
            // X11 oder ein Compositor ohne das Datengeraet: die Verbindung
            // steht nicht, der Ablauf laeuft trotzdem — und beruehrt nichts.
            None => f(lage, &mut KeineAblage),
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn mit_ablage<R>(
        &mut self,
        id: u64,
        f: impl FnOnce(&mut Ablagelage, &mut dyn Ablageplattform) -> R,
    ) -> Option<R> {
        let lage = &mut self.sessions.get_mut(&id)?.ablage;
        Some(f(lage, &mut KeineAblage))
    }

    /// `ablage` — ein Rahmen der geteilten Zwischenablage.
    ///
    /// Die Rolle hat der Hauptprozess schon ausgewertet (`ablageWeiche.ts`);
    /// hier kommen nur noch `session` und `data` an.
    pub(super) fn ablage(&mut self, req: &Request) -> Result<(), String> {
        let session_id = req.session.ok_or("session fehlt")?;
        if !self.sessions.contains_key(&session_id) {
            return Err("unbekannte Sitzung".into());
        }
        let data = req.data.clone().ok_or("data fehlt")?;
        let hinaus = self
            .mit_ablage(session_id, |lage, p| match anstoss_lesen(&data) {
                // **Vor dem Rahmen-Parser**, s. Modulkopf.
                Some(Anstoss::NeuBitte) => lage.neu_bitte(),
                Some(Anstoss::Ende) => {
                    lage.ende(p);
                    Vec::new()
                }
                None => match rahmen_lesen(&data) {
                    Some(r) => lage.fern(&r, p),
                    None => Vec::new(),
                },
            })
            .unwrap_or_default();
        self.ablage_melden(session_id, &hinaus);
        Ok(())
    }

    /// Ein Durchlauf je Sitzung — gerufen aus `eingaben_abgeben`, also einmal
    /// je Schleifendurchlauf, an derselben Stelle wie `wayland_zug_nachfassen`
    /// (die Warteschlange des Datengeraets ist dort gerade geleert worden).
    pub(super) fn ablage_takt(&mut self) {
        let ids: Vec<u64> = self.sessions.keys().copied().collect();
        for id in ids {
            let hinaus = self.mit_ablage(id, |lage, p| lage.takt(p)).unwrap_or_default();
            self.ablage_melden(id, &hinaus);
        }
    }

    /// `input_capture` schaltet die Zwischenablage mit: an heisst „ab jetzt
    /// beobachten", aus heisst „Eigentum abgeben und den Vorbestand
    /// zurueckschreiben". Es gibt keinen eigenen Rahmen fuer den Beginn einer
    /// Sitzung, und das Ende ueber den Renderer (`{"t":"ende"}`) kommt nicht,
    /// wenn dessen Verbindung vorher abreisst.
    pub(super) fn ablage_erfassung(&mut self, id: u64, aktiv: bool) {
        let teilt = self.mit_ablage(id, |lage, p| {
            if aktiv {
                lage.beginnen();
            } else {
                lage.ende(p);
            }
            lage.teilt()
        });
        // **Der Schalter im Fern-Menue zeigt den Stand der SITZUNG**, nicht
        // seinen eigenen. Er ueberlebt das Ende einer Fernsteuerung
        // ausdruecklich: wer das Teilen abgeschaltet hat, will es nicht beim
        // naechsten Handschlag stillschweigend wieder an haben.
        if let (Some(teilt), Some(session)) = (teilt, self.sessions.get_mut(&id)) {
            if let Some(overlay) = session.overlay.as_mut() {
                overlay.set_ablage_teilen(teilt);
            }
        }
    }

    /// Der Schalter „Zwischenablage teilen" aus dem Fern-Menue.
    pub(super) fn ablage_teilen_setzen(&mut self, id: u64, an: bool) {
        self.mit_ablage(id, |lage, p| lage.teilen_setzen(an, p));
        if let Some(session) = self.sessions.get_mut(&id) {
            if let Some(overlay) = session.overlay.as_mut() {
                overlay.set_ablage_teilen(an);
            }
            session.window.request_redraw();
        }
    }

    fn ablage_melden(&self, id: u64, hinaus: &[Rahmen]) {
        for r in hinaus {
            self.stdout.send(&ablage_ereignis(id, r));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulse_ablage::format::Inhaltstyp;
    use pulse_ablage::pruefstand::TestAblage;

    /// `TestAblage` plus die beiden Auskuenfte, die `pulse-ablage` nicht
    /// kennt. Ein Wrapper statt eines zweiten Testdoppels: was die Kiste
    /// prueft, soll hier NICHT nachgebaut werden.
    struct Pruefablage {
        inner: TestAblage,
        einfuegen: bool,
        serial: Option<u32>,
    }

    impl Pruefablage {
        fn neu() -> Self {
            Self { inner: TestAblage::neu(), einfuegen: false, serial: Some(42) }
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
    }

    fn wache_lage() -> Ablagelage {
        let mut lage = Ablagelage::default();
        lage.beginnen();
        lage
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
        assert_eq!(anstoss_lesen(&v), Some(Anstoss::NeuBitte));

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
        assert_eq!(anstoss_lesen(&v), Some(Anstoss::Ende));

        let mut p = Pruefablage::neu();
        p.inner.setzen("mein eigener Pfad");
        p.inner.geaendert(); // die Aenderung ist quittiert
        let mut lage = wache_lage();

        lage.fern(&Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text }, &mut p);
        lage.takt(&mut p);
        assert!(p.inner.beansprucht(), "die Ankuendigung muss den Anspruch einloesen");
        assert_eq!(p.inner.inhalt(), None, "der Anspruch loescht den Vorbestand");

        lage.ende(&mut p);
        assert!(!p.inner.beansprucht());
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
        assert!(!p.inner.beansprucht(), "der Anspruch muss weg sein, nicht nur der naechste");
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

    /// Ein kaputter Rahmen beendet die Sitzung nicht — er wird still
    /// verworfen.
    #[test]
    fn ein_kaputter_rahmen_wird_still_verworfen() {
        assert!(rahmen_lesen(&serde_json::json!({"t": "hol", "gen": 1})).is_none());
        assert!(rahmen_lesen(&serde_json::json!({})).is_none());
    }
}
