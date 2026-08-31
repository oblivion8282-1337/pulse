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
//! **Drei Teile, an den Naehten geschnitten, die die Tests ohnehin ziehen:**
//! die reine Rechnung steht in [`lage`] (Zustandsmaschine, Deutung eines
//! Rahmens, das Ereignisformat — alles ohne Fenster pruefbar), die Traits, die
//! eine Plattform erfuellen muss, in [`plattform`] (die zwei Beruehrungspunkte
//! mit dem Betriebssystem — `Beobachter` und `Eigentum` aus `pulse-ablage` —
//! plus die dritte Auskunft, die die Kiste bewusst nicht stellt,
//! [`Ablagequelle`]); hier steht nur noch die Verdrahtung an [`App`] (welche
//! Sitzung, welche Plattform, wohin die Antwort).
//!
//! **Die Plattform ist heute allein Wayland**
//! (`crate::fernsteuerung::wayland::ablage`). Auf X11, Windows und macOS gibt
//! es sie nicht: dort laeuft dieselbe Zustandsmaschine mit [`KeineAblage`]
//! weiter und beruehrt nichts. Der Windows-Host folgt in Plan 1b-2, macOS in
//! 1c.
//!
//! **Zwei Anstoesse kommen NICHT von der Gegenseite** und stehen deshalb nicht
//! in `pulse-ablage`: `neu_bitte` (nach einem `remote_reclaim` erneut
//! ankuendigen) und `ende` (Eigentum abgeben, Vorbestand zurueckschreiben). Sie
//! gehen nur vom Renderer an die eigene Plattform.
//!
//! **Sie tragen deshalb eine eigene Huelle** (`{"anstoss":…}`), waehrend ein
//! Rahmen der Gegenseite unter `{"rahmen":…}` ankommt. Das ist keine Kosmetik:
//! beide Wege gehen durch dieselbe Tuer (`gsr:ablage`), und der Leitungsweg
//! reicht die rohe Nutzlast der Gegenstelle durch. Haetten die Anstoesse
//! dieselbe Form wie ein Rahmen, koennte die Gegenseite sie senden. Die
//! Zuordnung steht als reine Funktion in [`lage::deuten`] und ist genau deshalb
//! pruefbar.

mod lage;
mod plattform;

pub(crate) use lage::{Ablagelage, Prozessablage};
pub(crate) use plattform::{Ablageplattform, Ablagequelle, KeineAblage};
use lage::{ablage_ereignis, deuten, Anstoss, Entscheidung};

use pulse_ablage::format::Rahmen;

use super::App;
use crate::proto::Request;

impl App {
    /// Zustandsmaschine EINER Sitzung, der Prozess-Stand und die Plattform
    /// zusammen ausleihen.
    ///
    /// Drei disjunkte Felder von `self` — deshalb als Feldzugriff und nicht
    /// als Methodentrio, das der Compiler als drei Ausleihen von `self` saehe.
    #[cfg(target_os = "linux")]
    fn mit_ablage<R>(
        &mut self,
        id: u64,
        f: impl FnOnce(&mut Ablagelage, &mut Prozessablage, &mut dyn Ablageplattform) -> R,
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
        let prozess = &mut self.ablage_stand;
        Some(match self.wayland_zug.ablage_plattform().filter(|_| traeger) {
            Some(p) => f(lage, prozess, p),
            // Kein Traeger, X11, oder ein Compositor ohne das Datengeraet: die
            // Verbindung steht nicht, der Ablauf laeuft trotzdem — und
            // beruehrt nichts.
            None => f(lage, prozess, &mut KeineAblage),
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn mit_ablage<R>(
        &mut self,
        id: u64,
        f: impl FnOnce(&mut Ablagelage, &mut Prozessablage, &mut dyn Ablageplattform) -> R,
    ) -> Option<R> {
        let lage = &mut self.sessions.get_mut(&id)?.ablage;
        Some(f(lage, &mut self.ablage_stand, &mut KeineAblage))
    }

    /// `ablage` — ein Rahmen der geteilten Zwischenablage.
    ///
    /// Die Rolle hat der Hauptprozess schon ausgewertet (`ablageWeiche.ts`);
    /// hier kommen nur noch `session` und `data` an.
    ///
    /// **Gearbeitet wird auf dem TRAEGER, nicht auf der adressierten Sitzung**
    /// — die Frage „welche Sitzung haelt die Ablage" wird damit an genau einer
    /// Stelle beantwortet, hier im Player. Der Renderer adressierte bis dahin
    /// das erste Player-Fenster der Sitzung und traf den Traeger nur, solange
    /// beide dasselbe meinten: die Erfassung darf fuer ein einzelnes Fenster
    /// scheitern (`RemoteControllerInput.svelte`, „ein einzelnes darf
    /// scheitern, die uebrigen tragen weiter"), und dann ist Fenster 0 kein
    /// Traeger. Jeder hereinkommende Rahmen lief danach ins Leere — kein
    /// Anspruch, kein `hol`, kein Fehler, waehrend ausgehend alles
    /// weiterfunktionierte („Einfuegen tut nichts, Kopieren schon").
    ///
    /// Die adressierte Sitzung wird trotzdem geprueft: ein Rahmen ohne
    /// zugeordnete Sitzung gehoert niemandem (fail-closed wie im ganzen
    /// Fernsteuerungs-Weg). Gibt es keinen Traeger, bleibt es bei ihr — sie
    /// laeuft dann gegen [`KeineAblage`] und beruehrt nichts.
    ///
    /// **Was das voraussetzt:** dass alle Sitzungen dieses Prozesses zu
    /// derselben Gegenstelle gehoeren. Heute ist das so — der Renderer haelt
    /// genau eine Fernsteuerungs-Sitzung, und der Rueckweg ignoriert die
    /// Fensternummer bereits (`aufAblageEreignisse` reicht nur `data` weiter).
    /// Kaeme je eine zweite Gegenstelle dazu, muesste hier die Zuordnung
    /// Sitzung -> Gegenstelle mitentscheiden.
    pub(super) fn ablage(&mut self, req: &Request) -> Result<(), String> {
        let session_id = req.session.ok_or("session fehlt")?;
        if !self.sessions.contains_key(&session_id) {
            return Err("unbekannte Sitzung".into());
        }
        let ziel = self.ablage_traeger.unwrap_or(session_id);
        let data = req.data.clone().ok_or("data fehlt")?;
        // **Gedeutet wird in `lage::deuten`, nicht hier** — dort ist die
        // Reihenfolge „erst die Anstoesse, dann der Rahmen-Parser" pruefbar
        // (s. dortiger Doc-Kommentar). Diese Stelle verzweigt nur noch.
        let hinaus = self
            .mit_ablage(ziel, |lage, prozess, p| match deuten(&data) {
                Entscheidung::Anstoss(Anstoss::NeuBitte) => lage.neu_bitte(),
                Entscheidung::Anstoss(Anstoss::Ende) => {
                    lage.ende(prozess, p);
                    Vec::new()
                }
                Entscheidung::Fern(r) => lage.fern(&r, p),
                Entscheidung::Verwerfen => Vec::new(),
            })
            .unwrap_or_default();
        self.ablage_melden(ziel, &hinaus);
        Ok(())
    }

    /// Ein Durchlauf je Sitzung — gerufen aus `eingaben_abgeben`, also einmal
    /// je Schleifendurchlauf, an derselben Stelle wie `wayland_zug_nachfassen`
    /// (die Warteschlange des Datengeraets ist dort gerade geleert worden).
    pub(super) fn ablage_takt(&mut self) {
        let ids: Vec<u64> = self.sessions.keys().copied().collect();
        for id in ids {
            let hinaus =
                self.mit_ablage(id, |lage, prozess, p| lage.takt(prozess, p)).unwrap_or_default();
            self.ablage_melden(id, &hinaus);
        }
    }

    /// `input_capture` schaltet die Zwischenablage mit: an heisst „ab jetzt
    /// beobachten", aus heisst „Eigentum abgeben und den Vorbestand
    /// zurueckschreiben". Es gibt keinen eigenen Rahmen fuer den Beginn einer
    /// Sitzung, und der Anstoss `ende` aus dem Renderer kommt nicht,
    /// wenn dessen Verbindung vorher abreisst.
    pub(super) fn ablage_erfassung(&mut self, id: u64, aktiv: bool) {
        if aktiv {
            // Traeger wird, wer zuerst kommt (s. `mit_ablage`).
            if self.ablage_traeger.is_none() {
                self.ablage_traeger = Some(id);
            }
            self.mit_ablage(id, |lage, _, _| lage.beginnen());
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
        self.mit_ablage(id, |lage, prozess, p| lage.ende(prozess, p));
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
        let hinaus = self.mit_ablage(id, |lage, _, _| lage.neu_bitte()).unwrap_or_default();
        self.ablage_melden(id, &hinaus);
        // **Der Schalter wandert mit.** Ohne diese Zeile bliebe er im
        // Nachfolge-Fenster dauerhaft unsichtbar (`ablage_verfuegbar` steht auf
        // der Vorgabe `false`) — und zwar genau ab dem Moment, in dem er dort
        // wirkt.
        self.ablage_overlay_nachziehen(id);
    }

    /// Der Schalter „Zwischenablage teilen" aus dem Fern-Menue.
    pub(super) fn ablage_teilen_setzen(&mut self, id: u64, an: bool) {
        self.mit_ablage(id, |lage, prozess, p| lage.teilen_setzen(an, prozess, p));
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
            self.mit_ablage(id, |lage, _, p| (lage.teilt(), p.wirksam()))
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
