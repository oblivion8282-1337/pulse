//! Die geteilte Zwischenablage der Fernsteuerung — die Seite des Players.
//!
//! **Achtung, Namensgleichheit:** `crate::ablage` daneben ist etwas voellig
//! anderes (Temp-Pfade fuer Mitschriften). Hier geht es um die Zwischenablage;
//! die Kiste dahinter heisst `pulse_ablage`.
//!
//! **Der Mechanismus ist verzoegertes Rendern** und liegt vollstaendig in
//! `pulse_ablage` — beim Kopieren geht nur eine Ankuendigung hinaus, der
//! Inhalt erst, wenn drueben jemand tatsaechlich einfuegt.
//!
//! **Zwei Haelften, an der Naht geschnitten, die die Tests ohnehin ziehen:**
//! die reine Rechnung steht in [`lage`] (Zustandsmaschine, Deutung eines
//! Rahmens, das Ereignisformat — alles ohne Fenster pruefbar), hier steht die
//! Verdrahtung an [`App`] (welche Sitzung, welche Plattform, wohin die
//! Antwort). Was hier bleibt, sind die zwei Beruehrungspunkte mit dem
//! Betriebssystem ([`Beobachter`], [`Eigentum`]) plus die dritte Auskunft, die
//! `pulse-ablage` bewusst nicht stellt ([`Ablagequelle`]).
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
//! werden deshalb **vor** `Rahmen::aus_json` abgefangen — sonst verwuerfe der
//! Parser sie still und beide Wege waeren wirkungslos, ohne dass irgendetwas
//! rot wird. Die Reihenfolge steht als reine Funktion in [`lage::deuten`] und
//! ist genau deshalb pruefbar.

mod lage;

pub(crate) use lage::Ablagelage;
use lage::{ablage_ereignis, deuten, Anstoss, Entscheidung};

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::Eigentum;
use pulse_ablage::format::Rahmen;

use super::App;
use crate::proto::Request;

/// Was die Plattform ausserhalb der beiden Kisten-Traits noch beantworten
/// muss.
///
/// Alles drei sind Fragen, die `pulse-ablage` bewusst nicht stellt: „wartet
/// ein Einfuegevorgang?" ist auf jeder Plattform ein anderes Ereignis, die
/// Seriennummer ist eine reine Wayland-Not (s. `Anspruch`), und wer die Ablage
/// gerade haelt, weiss nur das Betriebssystem.
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
    /// `wl_data_source.cancelled`, und das sieht nur die Plattform.
    fn eigentuemer(&self) -> bool;

    /// Beruehrt diese Umsetzung ueberhaupt eine Zwischenablage?
    ///
    /// Nur dafuer da, dass die Oberflaeche nichts verspricht, was nicht
    /// stattfindet ([`KeineAblage`] liefert `false`). **An der tatsaechlichen
    /// Verfuegbarkeit, nicht an `cfg`** — dann traegt der Schalter auch, wenn
    /// Plan 1b-2 und 1c die uebrigen Plattformen nachreichen, und er
    /// verschwindet auf einem Linux-Rechner ohne Wayland-Datengeraet.
    fn wirksam(&self) -> bool;

    /// Das Lesen der FREMDEN Auswahl eroeffnen, ohne darauf zu warten.
    ///
    /// **Warum das getrennt ist:** ob der fremde Eigentuemer je schreibt, sagt
    /// kein Protokoll zu — auf Wayland liefert `wl_data_offer.receive` einen
    /// Deskriptor, aus dem gelesen werden muss. Auf der Fensterschleife
    /// gelesen stuenden waehrenddessen Bild UND Eingabe. Die Plattform holt
    /// den Inhalt deshalb nebenher; [`Beobachter::lesen`] gibt nur noch das
    /// fertige Ergebnis heraus und blockiert nie.
    ///
    /// Idempotent: ein zweiter Anstoss waehrend eines laufenden Vorgangs tut
    /// nichts.
    fn lesen_anstossen(&mut self);

    /// Liegt ein Ergebnis vor (auch „nichts zu holen")? Nur dann ist
    /// [`Beobachter::lesen`] aussagekraeftig.
    fn lesen_bereit(&mut self) -> bool;
}

/// Alles zusammen, was eine Plattform-Umsetzung koennen muss.
///
/// **Als Objekt-Trait gefuehrt** (`&mut dyn Ablageplattform`), damit
/// [`App::mit_ablage`] EINE Fassung hat statt einer je Plattform: die
/// Umsetzung unterscheidet sich zwischen Linux und dem Rest, der Ablauf
/// darueber nicht.
pub(crate) trait Ablageplattform: Beobachter + Eigentum + Ablagequelle {}
impl<T: Beobachter + Eigentum + Ablagequelle> Ablageplattform for T {}

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
    fn wirksam(&self) -> bool {
        false
    }
    fn lesen_anstossen(&mut self) {}
    /// **Immer bereit** — es gibt nichts zu holen und nichts zu warten. Ein
    /// `false` hier liesse jeden Anspruch fuer immer eingereiht liegen.
    fn lesen_bereit(&mut self) -> bool {
        true
    }
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
        // **Genau EINE Sitzung haelt die Ablage** (Review C7) — die Spiegelung
        // der Host-Regel „ein Traeger je Maschine" aus dem Entwurf. Der
        // Wayland-Zustand haengt an der VERBINDUNG (eine je Prozess), die
        // Zustandsmaschine an der SITZUNG; steuert der Nutzer zwei Rechner
        // gleichzeitig, teilten sich beide Sitzungen sonst denselben
        // Aenderungszaehler (die erste Abfrage schluckt die Aenderung, die
        // zweite Sitzung kuendigt nie an), dieselbe Auswahl und dieselben
        // wartenden Einfuegevorgaenge (`liefern` nimmt ALLE). Die uebrigen
        // Sitzungen laufen deshalb gegen [`KeineAblage`] und tun nichts.
        let traeger = self.ablage_traeger == Some(id);
        let lage = &mut self.sessions.get_mut(&id)?.ablage;
        Some(match self.wayland_zug.ablage_plattform().filter(|_| traeger) {
            Some(p) => f(lage, p),
            // Kein Traeger, X11, oder ein Compositor ohne das Datengeraet: die
            // Verbindung steht nicht, der Ablauf laeuft trotzdem — und
            // beruehrt nichts.
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
        // **Gedeutet wird in `lage::deuten`, nicht hier** — dort ist die
        // Reihenfolge „erst die Anstoesse, dann der Rahmen-Parser" pruefbar
        // (s. dortiger Doc-Kommentar). Diese Stelle verzweigt nur noch.
        let hinaus = self
            .mit_ablage(session_id, |lage, p| match deuten(&data) {
                Entscheidung::Anstoss(Anstoss::NeuBitte) => lage.neu_bitte(),
                Entscheidung::Anstoss(Anstoss::Ende) => {
                    lage.ende(p);
                    Vec::new()
                }
                Entscheidung::Fern(r) => lage.fern(&r, p),
                Entscheidung::Verwerfen => Vec::new(),
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
        if aktiv {
            // Traeger wird, wer zuerst kommt (s. `mit_ablage`).
            if self.ablage_traeger.is_none() {
                self.ablage_traeger = Some(id);
            }
            self.mit_ablage(id, |lage, _| lage.beginnen());
        } else {
            self.ablage_abbau(id);
        }
        self.ablage_overlay_nachziehen(id);
    }

    /// **Der eine Trichter fuer das Ende.** Vier Wege fuehren hierher:
    /// `input_capture false`, das Schliessen eines Fensters, `stop_all_sessions`
    /// und `exiting`.
    ///
    /// Ohne die letzten drei (Review C3) blieb bei einem waehrend der
    /// Fernsteuerung geschlossenen Fenster die `wl_data_source` bestehen,
    /// waehrend niemand mehr taktet: **jedes Einfuegen irgendwo auf dem
    /// Desktop haenge**, weil der Deskriptor liegenbleibt und weder
    /// geschrieben noch geschlossen wird — und der Vorbestand des Nutzers
    /// waere weg.
    pub(super) fn ablage_abbau(&mut self, id: u64) {
        self.mit_ablage(id, |lage, p| lage.ende(p));
        if self.ablage_traeger == Some(id) {
            self.ablage_traeger = None;
            self.ablage_traeger_waehlen();
        }
    }

    /// Traegt niemand die Ablage, waehlt die naechste wache Sitzung sie.
    ///
    /// Welche das ist, wenn mehrere in Frage kommen, ist nicht festgelegt (die
    /// Reihenfolge einer `HashMap`) — sie sind gleichwertig. Der neue Traeger
    /// kuendigt seinen Stand frisch an: die Gegenseite haelt sonst eine
    /// Generation, die von der Zustandsmaschine der vorigen Sitzung stammt,
    /// und jedes Einfuegen antwortete `veraltet`.
    fn ablage_traeger_waehlen(&mut self) {
        if self.ablage_traeger.is_some() {
            return;
        }
        let Some(id) =
            self.sessions.iter().find(|(_, s)| s.ablage.wacht()).map(|(id, _)| *id)
        else {
            return;
        };
        self.ablage_traeger = Some(id);
        let hinaus = self.mit_ablage(id, |lage, _| lage.neu_bitte()).unwrap_or_default();
        self.ablage_melden(id, &hinaus);
        // **Der Schalter wandert mit.** Ohne diese Zeile bliebe er im
        // Nachfolge-Fenster dauerhaft unsichtbar (`ablage_verfuegbar` steht auf
        // der Vorgabe `false`) — und zwar genau ab dem Moment, in dem er dort
        // wirkt.
        self.ablage_overlay_nachziehen(id);
    }

    /// Der Schalter „Zwischenablage teilen" aus dem Fern-Menue.
    pub(super) fn ablage_teilen_setzen(&mut self, id: u64, an: bool) {
        self.mit_ablage(id, |lage, p| lage.teilen_setzen(an, p));
        self.ablage_overlay_nachziehen(id);
        if let Some(session) = self.sessions.get(&id) {
            session.window.request_redraw();
        }
    }

    /// **Der Schalter im Fern-Menue zeigt den Stand der SITZUNG**, nicht
    /// seinen eigenen — und er erscheint nur, wo die Plattform ihn auch
    /// einloest (Review C8).
    ///
    /// Dass er das Ende einer Fernsteuerung ueberlebt, ist Absicht: wer das
    /// Teilen abgeschaltet hat, will es nicht beim naechsten Handschlag
    /// stillschweigend wieder an haben. Ein still widerrufener
    /// Datenschutz-Schalter waere der schlimmere der beiden Fehler.
    fn ablage_overlay_nachziehen(&mut self, id: u64) {
        let Some((teilt, wirksam)) =
            self.mit_ablage(id, |lage, p| (lage.teilt(), p.wirksam()))
        else {
            return;
        };
        if let Some(session) = self.sessions.get_mut(&id) {
            if let Some(overlay) = session.overlay.as_mut() {
                overlay.set_ablage_teilen(teilt);
                overlay.set_ablage_verfuegbar(wirksam);
            }
        }
    }

    fn ablage_melden(&self, id: u64, hinaus: &[Rahmen]) {
        for r in hinaus {
            self.stdout.send(&ablage_ereignis(id, r));
        }
    }
}
