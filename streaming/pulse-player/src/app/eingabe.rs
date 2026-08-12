//! Die Fernsteuerungs-Seite der Sitzungsverwaltung: den Schalter bedienen und
//! die fertigen Frames nach vorne melden.
//!
//! Was uebersetzt wird, steht in [`crate::fernsteuerung`] — das ist reine
//! Rechnung und ohne Fenster pruefbar. Hier steht nur, was davon die SITZUNG
//! betrifft: welcher Zeiger gefangen ist, wann abgeholt wird, und was beim
//! Abbau noch hinausmuss.
//!
//! Als Kindmodul von [`super`] kommt das an die privaten Felder der Sitzung,
//! ohne dafuer Zugaenge zu oeffnen, die sonst niemand braucht.

use super::App;
use crate::fernsteuerung::Abgabe;
use crate::proto::{Event, Request};

impl App {
    /// `input_capture` — Eingabe-Erfassung schalten.
    ///
    /// Der **Zeigerfang** wird hier gleich mit am Fenster vollzogen (fangen,
    /// Zeiger verstecken). Scheitert er, laeuft die Erfassung trotzdem, aber
    /// **ohne** Fang: relative Bewegungen ohne gefangenen Zeiger waeren eine
    /// Maus, die aus dem Fenster laeuft und weiter steuert. Die Antwort sagt
    /// deshalb, was wirklich gilt — nicht, was gewuenscht war.
    pub(super) fn input_capture(&mut self, req: &Request) -> Result<serde_json::Value, String> {
        let session_id = req.session.ok_or("session fehlt")?;
        let aktiv = req.enabled.unwrap_or(false);
        let slot = req.slot.unwrap_or(0);
        let fang_gewuenscht = aktiv && req.pointer_lock.unwrap_or(false);
        let session = self.sessions.get_mut(&session_id).ok_or("unbekannte Sitzung")?;

        let fang = fang_gewuenscht && zeiger_fangen(&session.window, true);
        if !fang_gewuenscht {
            zeiger_fangen(&session.window, false);
        }
        session.window.set_cursor_visible(!fang);
        // Der WUNSCH wird getrennt vom Erreichten aufgehoben: nach einem
        // Fokuswechsel muss er neu vollzogen werden (s. [`Self::fokus_gewechselt`]).
        session.fang_gewuenscht = fang_gewuenscht;
        session.eingabe.setzen(aktiv, slot, fang);
        Ok(serde_json::json!({
            "enabled": aktiv,
            "slot": slot,
            "pointer_lock": fang,
            // Was auf dem Weg verlorengegangen ist, steht in der Antwort statt
            // nur im Log: Bewegungen darf die Flutkontrolle verwerfen, Tasten
            // ohne Scancode-Abbildung koennen wir nicht senden — beides sind
            // aber die einzigen Stellen, an denen eine Eingabe lautlos
            // verschwindet, und wer „meine Taste kommt nicht an" meldet,
            // braucht dafuer eine Zahl.
            "dropped_moves": session.eingabe.verworfene_bewegungen(),
            "unmapped_keys": session.eingabe.unbekannte_tasten(),
        }))
    }

    /// Das Fenster hat den Tastaturfokus bekommen oder verloren.
    ///
    /// **Windows loest `ClipCursor` beim Fokusverlust auf, und winit stellt es
    /// nicht wieder her.** Ohne diese Stelle kam der Nutzer nach Alt+Tab und
    /// zurueck mit einem Zeiger wieder, der frei UND unsichtbar war, waehrend
    /// die Erfassung ihn weiter fuer gefangen hielt und `CursorMoved` deshalb
    /// verwarf — die Bedienleiste im Fenster war damit nicht mehr zu treffen.
    ///
    /// Beim Fokusverlust wird der Griff ausdruecklich abgegeben und der Zeiger
    /// wieder sichtbar gemacht: ein unsichtbarer Zeiger ueber einem Fenster,
    /// das gerade nicht bedient wird, ist ein verlorener Zeiger.
    pub(super) fn fokus_gewechselt(&mut self, id: u64, fokus: bool) {
        let Some(session) = self.sessions.get_mut(&id) else { return };
        if !session.eingabe.aktiv() && !session.fang_gewuenscht {
            return;
        }
        let fang = fokus
            && session.fang_gewuenscht
            && session.eingabe.aktiv()
            && zeiger_fangen(&session.window, true);
        if !fang {
            zeiger_fangen(&session.window, false);
        }
        session.window.set_cursor_visible(!fang);
        session.eingabe.zeigerfang_nachfuehren(fang);
    }

    /// Fertige Eingabe-Frames aller Sitzungen nach vorne melden.
    ///
    /// Gibt den fruehesten Zeitpunkt zurueck, zu dem noch etwas ansteht — der
    /// Aufrufer legt ihn in den Kontrollfluss der Fensterschleife. Ohne das
    /// bliebe die letzte Bewegung einer Geste liegen, bis zufaellig das
    /// naechste Ereignis eintrifft.
    pub(super) fn eingaben_abgeben(
        &mut self,
        jetzt: std::time::Instant,
    ) -> Option<std::time::Instant> {
        // Den Schreiber vorher ausleihen: `send` nimmt `&self`, und darunter
        // laeuft eine veraenderliche Schleife ueber die Sitzungen.
        let stdout = self.stdout.clone();
        let mut frueheste: Option<std::time::Instant> = None;
        for (id, session) in self.sessions.iter_mut() {
            match session.eingabe.abholen(jetzt) {
                Abgabe::Nichts => {}
                Abgabe::Spaeter(t) => {
                    frueheste = Some(frueheste.map_or(t, |f: std::time::Instant| f.min(t)));
                }
                Abgabe::Jetzt(frames) => {
                    stdout.send(&eingabe_ereignis(*id, session.eingabe.slot(), frames));
                }
            }
        }
        frueheste
    }

    /// Was noch in der Warteschlange steht, bevor eine Sitzung verschwindet.
    ///
    /// Wichtig fuer die Hoch-Ereignisse aus `Erfassung::setzen(false, ..)`:
    /// gingen die mit dem Fenster verloren, bliebe beim Host eine Taste
    /// gedrueckt, bis er selbst aufraeumt.
    pub(super) fn eingabe_raeumen(&mut self, id: u64) {
        let stdout = self.stdout.clone();
        let Some(session) = self.sessions.get_mut(&id) else { return };
        session.fang_gewuenscht = false;
        if session.eingabe.aktiv() {
            session.eingabe.setzen(false, session.eingabe.slot(), false);
        }
        if let Some(frames) = session.eingabe.raeumen() {
            stdout.send(&eingabe_ereignis(id, session.eingabe.slot(), frames));
        }
        // Bilanz am Ende der Erfassung — die beiden einzigen Stellen, an denen
        // eine Eingabe lautlos verschwindet.
        let (bewegungen, tasten) =
            (session.eingabe.verworfene_bewegungen(), session.eingabe.unbekannte_tasten());
        if bewegungen > 0 || tasten > 0 {
            eprintln!(
                "pulse-player: Sitzung {id}: Eingabe — {bewegungen} Bewegungen verworfen, \
                 {tasten} Tasten ohne Scancode-Abbildung"
            );
        }
    }
}

/// Der Ereignisrahmen, den die Electron-Seite (`desktop/electron/remoteInput.ts`)
/// in die `remote_input`-Huelle giesst. An EINER Stelle, weil ihn zwei Wege
/// absetzen (Takt und Abbau) und ein abweichendes Feld dort still verschwaende.
fn eingabe_ereignis(id: u64, slot: u32, frames: Vec<String>) -> Event {
    Event::new(
        "player:input",
        serde_json::json!({ "session": id, "slot": slot, "frames": frames }),
    )
}

/// Zeiger fangen oder freigeben. Liefert, ob er jetzt gefangen IST.
///
/// **Zwei Betriebsarten, und keine ist ueberall zu haben:** `Locked` (der Zeiger
/// steht still, es kommen nur noch Differenzen) gibt es unter Windows nicht,
/// `Confined` (der Zeiger bleibt im Fenster) nicht unter macOS. Deshalb wird der
/// Reihe nach probiert statt eine Art vorauszusetzen — die relativen Bewegungen
/// kommen ohnehin aus `DeviceEvent::MouseMotion` und nicht aus der Fangart.
fn zeiger_fangen(window: &winit::window::Window, fangen: bool) -> bool {
    use winit::window::CursorGrabMode;
    if !fangen {
        let _ = window.set_cursor_grab(CursorGrabMode::None);
        return false;
    }
    [CursorGrabMode::Locked, CursorGrabMode::Confined]
        .into_iter()
        .any(|art| window.set_cursor_grab(art).is_ok())
}
