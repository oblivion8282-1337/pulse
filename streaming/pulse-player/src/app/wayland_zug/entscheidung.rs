//! Wann ein Zug endet, wie man es erkennt — und **der eine Abbau dahinter**.
//!
//! Abgetrennt von [`super`], wo der Aufbau steht (Verbindung, Zugbeginn,
//! Nachfassen im Takt). Dieselbe Groessen-Begruendung wie bei
//! [`super::zuordnung`] daneben (`PLAN.md` §12.1), aber auch eine inhaltliche:
//! hier haengt das Ende an der SITZUNG, die es traegt — die Kopplung, in der
//! Review-Befund C-1 lag —, und hier steht der Beweis, um den es in I-B ging.
//!
//! ## Ein Trichter, ein Schalter
//!
//! „Der Zug ist vorbei" hatte bis zur vierten Runde ZWEI Ausgaenge, die
//! verschiedene Teilmengen desselben Zustands raeumten: Beenden raeumte
//! Sitzung, Fehler-Merker, `wayland_ziel` und liess los; Aufgeben raeumte
//! Sitzung, Fehler-Merker, den Wayland-Merker — und `wayland_ziel` **nicht**.
//! Dass das jahrelang nicht auffiel, lag daran, dass zwei der drei Aufrufer es
//! zufaellig anderswo mitmachten; der dritte (Fokusverlust) nicht, und dort
//! zeigte dann jeder Klick im eigenen Fenster auf den fremden Bildschirm.
//!
//! Deshalb gibt es jetzt genau eine Abbau-Stelle — [`App::wayland_zug_abbau`]
//! — mit genau einem Parameter: ob dabei freigegeben wird. **Was zu einem Zug
//! gehoert, steht dort einmal und nirgends sonst.** Beenden ist
//! `abbau(true)`, Aufgeben ist `abbau(false)`; ein kuenftiges Feld kann in
//! keinem der Wege mehr vergessen werden, weil es keine zwei Wege mehr gibt.
//!
//! Die drei Wege dorthin:
//! * **Ende** ([`Zugschluss::Beendet`]) — `Drop`, Beweisweg oder Notfrist.
//! * **Verfall** ([`Zugschluss::Verfallen`]) — die Anlauf-Frist.
//! * **Abbruch** ([`App::wayland_zug_abbrechen`]) — Fokusverlust, Erfassung
//!   aus, Fenster zu.

use super::App;
#[cfg(target_os = "linux")]
use crate::fernsteuerung::wayland::Zugschluss;
#[cfg(target_os = "linux")]
use winit::event::{ElementState, WindowEvent};

/// Was der Abbau an der `Erfassung` zu tun hat — die eine Entscheidung, die
/// sich ohne Wayland, ohne Fenster und ohne Compositor nachrechnen laesst.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Abbauplan {
    /// Keine Sitzung traegt den Zug: an der `Erfassung` ist nichts zu tun. Der
    /// Verbindungs-Zustand wird trotzdem geraeumt — ein liegengebliebenes Ende
    /// waere die Ladung fuer den naechsten Zug (Review C-1).
    Nichts,
    /// Diese Sitzung traegt ihn: **das Wayland-Ziel wird immer geloescht**, und
    /// `freigeben` sagt, ob zusaetzlich alles Gedrueckte hinausgeht.
    Sitzung { id: u64, freigeben: bool },
}

/// Der Abbauplan als reine Funktion.
///
/// **Die Zeile, die Review-Befund C-1 der vierten Runde strukturell erledigt:**
/// `Sitzung` entsteht unabhaengig von `freigeben`. Das Ziel zu loeschen gehoert
/// zu JEDEM Abbau — beim Aufgeben genauso wie beim Beenden. Bleibt es stehen,
/// zielt die Erfassung weiter auf Platz und Bildlage eines Fensters, in dem der
/// Zeiger laengst nicht mehr ist.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn abbauplan(freigeben: bool, session: Option<u64>) -> Abbauplan {
    match session {
        None => Abbauplan::Nichts,
        Some(id) => Abbauplan::Sitzung { id, freigeben },
    }
}

impl App {
    /// **Der eine Abbau** (s. Modulkopf): alles vergessen, was zu einem Zug
    /// gehoert. `freigeben` ist der einzige Unterschied zwischen Beenden und
    /// Aufgeben.
    ///
    /// Drei Haelften, und das ist die vollstaendige Liste:
    /// 1. **Verbindung** — Merker, Bestaetigung, Zugehoerigkeit, Anlauf-Frist,
    ///    Ende, Zug-Lage (`Gastverbindung::zug_aufgeben`).
    /// 2. **App** — welche Sitzung den Zug traegt, und der Melde-Merker fuer
    ///    die nicht zuzuordnende Flaeche.
    /// 3. **Erfassung** — das Wayland-Ziel; und **nur bei `freigeben`** die
    ///    Hoch-Ereignisse fuer alles Gedrueckte.
    ///
    /// **Freigeben heisst: die Maustaste geht am fernen Rechner hoch.** Das ist
    /// richtig, wenn der Zug wirklich zu Ende ist (der Nutzer hat losgelassen,
    /// wir sehen es nur ueber das Datengeraet). Es ist falsch, wenn wir bloss
    /// aufhoeren zuzusehen — dann haelt der Nutzer die Taste womoeglich noch,
    /// und die Freigabe waere der schlimmste Ausgang dieses Vorhabens. Deshalb
    /// gibt jeder Aufrufer den Schalter ausdruecklich mit.
    #[cfg(target_os = "linux")]
    pub(in crate::app) fn wayland_zug_abbau(&mut self, freigeben: bool) {
        if let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() {
            verbindung.zug_aufgeben();
        }
        self.wayland_zug.inner.ziel_fehler_gemeldet = false;
        match abbauplan(freigeben, self.wayland_zug.inner.session.take()) {
            Abbauplan::Nichts => {}
            Abbauplan::Sitzung { id, freigeben } => {
                if let Some(session) = self.sessions.get_mut(&id) {
                    session.eingabe.wayland_ziel_setzen(None);
                    if freigeben {
                        session.eingabe.zug_beendet();
                    }
                }
            }
        }
    }

    /// Einen abgeholten [`Zugschluss`] anwenden — die Uebersetzung „warum"
    /// nach „mit welchem Schalter".
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_schluss_anwenden(&mut self, schluss: Zugschluss) {
        match schluss {
            Zugschluss::Offen => {}
            // Der Zug ist wirklich vorbei — die Taste ist physisch los, auch
            // wenn dafuer nie ein `MouseInput` ankam.
            Zugschluss::Beendet { .. } => self.wayland_zug_abbau(true),
            // Nur wir hoeren auf zuzusehen (die Anlauf-Frist ist verfallen).
            // Der Knopf haengt weiter am gewoehnlichen `MouseInput`-Weg.
            Zugschluss::Verfallen => self.wayland_zug_abbau(false),
        }
    }

    /// **Der Beweis von der anderen Seite** (Review I-B): winit liefert wieder
    /// `CursorMoved`/`MouseInput` — also hat der Compositor seinen Zug-Griff
    /// aufgegeben (gemessen: waehrend eines laufenden Zugs kommt kein einziges
    /// `wl_pointer`-Ereignis, s. [`super`]-Modulkopf). Das loest ein `Leave`
    /// auf, das sonst bis zum Ablauf der Notfrist offen bliebe — ein Abbruch
    /// mit Esc etwa meldet uns gar nichts. **Einen Zug ohne offenes `Leave`
    /// beendet es NICHT** (Begruendung an `wayland::ende::Zugende::griff_vorbei`).
    ///
    /// Derselbe Beweis stellt bei einem noch unbestaetigten Zug die
    /// Anlauf-Frist neu (`anlauf_bezeugen`): solange winit zustellt, ist der
    /// Merker nachweislich nicht verwaist, und die Frist soll Stille messen,
    /// nicht Zeit (Review I-1 der vierten Runde).
    ///
    /// **Nur bei BESTAETIGTEM Zug wird beendet** — das zweite Schloss neben dem
    /// `Unklar`. Vor der Bestaetigung ist ein Zeigerereignis mehrdeutig: der
    /// Compositor kann Bewegungen abgeschickt haben, bevor er unser
    /// `start_drag` verarbeitet hat, und winit reicht sie noch im selben
    /// Durchlauf weiter.
    ///
    /// **Ein Loslassen VOR der Bestaetigung heisst etwas anderes** und fuehrt
    /// deshalb zum Abbau OHNE Freigabe: der Knopf haengt noch am gewoehnlichen
    /// `MouseInput`-Weg, der ihn gleich danach ordentlich loslaesst; eine
    /// Freigabe von hier gaebe ihn ein zweites Mal frei.
    ///
    /// **Hier steht bewusst KEIN Log.** Dieser Zweig ist nicht der
    /// Ausnahmefall, sondern der haeufigste ueberhaupt: ein gewoehnlicher KLICK
    /// (druecken, loslassen, ohne zu bewegen) laeuft genau hier durch —
    /// gemessen am 2026-08-24 beginnt ein Zug erst mit der ersten Bewegung NACH
    /// dem `start_drag`, bis dahin behaelt winit den Zeigerfokus. Eine Meldung
    /// „der Zug hat nicht gegriffen" waere bei jedem normalen Klick fachlich
    /// falsch; der eine Fall, der wirklich ein Defekt waere, laesst sich von
    /// hier aus nicht davon unterscheiden.
    ///
    /// **Muss VOR `Erfassung::on_window_event` laufen** (Aufrufer:
    /// `App::window_event`). Andernfalls stuende ein Druck, der einen neuen Zug
    /// beginnt, schon in `knoepfe_unten`, wenn der Abbau des alten Zugs „alles
    /// Gedrueckte" freigibt — und der frische Druck ginge am fernen Rechner
    /// sofort wieder hoch (Review C-A). Das ist die eine Reihenfolge-Regel
    /// dieses Moduls, die sich **nicht** durch Typen erzwingen liess: sie
    /// haengt an der Reihenfolge zweier Aufrufe in `window_event`, und beide
    /// Aufrufer sind fremde Nachbarn. Sie steht deshalb auch dort im Klartext.
    #[cfg(target_os = "linux")]
    pub(in crate::app) fn wayland_zug_griff_pruefen(&mut self, ereignis: &WindowEvent) {
        if !matches!(ereignis, WindowEvent::CursorMoved { .. } | WindowEvent::MouseInput { .. }) {
            return;
        }
        // **Bei einem DRUCK zuerst dispatchen und einen offenen Schluss
        // anwenden** (Review C-A) — unabhaengig davon, ob wir gerade einen Zug
        // fuehren. Das gehoerte bis zur dritten Runde in
        // `wayland_zug_beginnen`, und das laeuft NACH
        // `Erfassung::on_window_event`: Loslassen und neuer Druck koennen im
        // selben winit-Umlauf eintreffen (unter Last leicht 15-30 ms).
        // Zugleich ist das die C1-Auflage der ersten Runde — `nachfassen()`
        // muss VOR `letzte_druck_nummer()` laufen, sonst liegt die
        // Druck-Seriennummer noch ungedispatcht in unserer Warteschlange.
        if matches!(ereignis, WindowEvent::MouseInput { state: ElementState::Pressed, .. }) {
            let schluss = {
                let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
                verbindung.nachfassen()
            };
            self.wayland_zug_schluss_anwenden(schluss);
        }
        let (angefordert, bestaetigt) = {
            let Some(verbindung) = self.wayland_zug.inner.verbindung.as_ref() else { return };
            (verbindung.zug_angefordert(), verbindung.zug_bestaetigt())
        };
        if !angefordert {
            return;
        }
        if bestaetigt {
            let schluss = {
                let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
                verbindung.griff_vorbei()
            };
            self.wayland_zug_schluss_anwenden(schluss);
            return;
        }
        if let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() {
            verbindung.anlauf_bezeugen();
        }
        if matches!(ereignis, WindowEvent::MouseInput { state: ElementState::Released, .. }) {
            self.wayland_zug_abbau(false);
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(in crate::app) fn wayland_zug_griff_pruefen(
        &mut self,
        _ereignis: &winit::event::WindowEvent,
    ) {
    }

    /// Einen laufenden Zug **abbrechen**, weil die Grundlage weggefallen ist:
    /// Fokusverlust, Erfassung aus, Fenster zu.
    ///
    /// **Warum das sein muss** (Review C-B): der Merker „eigener Zug" hatte nur
    /// zwei Ausgaenge — ein abgeholtes Ende und das Aufgeben beim Loslassen.
    /// Wer zwischen Druck und Loslassen den Fokus verliert (Alt-Tab; der
    /// Compositor bricht die implizite Ergreifung ab, das Loslassen erreicht
    /// uns nie) oder dessen Fenster zugeht, sah beides nie. Der Merker blieb
    /// dann fuer den Rest der Prozesslaufzeit stehen — und ab da sprach **jeder
    /// fremde Zug wieder fuer uns**.
    ///
    /// **Abbrechen heisst aufgeben, nicht beenden** — es wird nichts
    /// losgelassen. Alle drei Aufrufer geben das Gedrueckte ohnehin selbst frei
    /// (`Focused(false)` -> `alles_loslassen`, `input_capture(false)`/
    /// `eingabe_raeumen` -> `ausschalten`); eine zweite Freigabe von hier waere
    /// bestenfalls ueberfluessig.
    ///
    /// **Das WAYLAND-ZIEL raeumt dagegen nur dieser Weg** — und genau daran
    /// fehlte es (Review C-1 der vierten Runde): zwei der drei Aufrufer nehmen
    /// es ueber `Erfassung::ausschalten` mit, der Fokusverlust nicht. Blieb es
    /// stehen, zeigte danach jeder Klick im eigenen Fenster auf Platz und
    /// Bildlage des anderen. Seit es EINEN Abbau gibt, kann das nicht mehr an
    /// einem Weg vorbeigehen.
    ///
    /// **Nur fuer die Sitzung, die den Zug traegt.** Ein anderes Fenster, das
    /// den Fokus verliert, geht diesen Zug nichts an.
    #[cfg(target_os = "linux")]
    pub(in crate::app) fn wayland_zug_abbrechen(&mut self, id: u64) {
        if self.wayland_zug.inner.session != Some(id) {
            return;
        }
        self.wayland_zug_abbau(false);
    }

    #[cfg(not(target_os = "linux"))]
    pub(in crate::app) fn wayland_zug_abbrechen(&mut self, _id: u64) {}
}

#[cfg(test)]
mod tests {
    use super::{abbauplan, Abbauplan};

    /// **Der C-1-Fall der vierten Runde, als Test:** das Wayland-Ziel wird in
    /// BEIDEN Abbau-Arten geraeumt. Blieb es beim Aufgeben stehen, zeigte jeder
    /// spaetere Klick im eigenen Fenster auf den fremden Bildschirm — und der
    /// Trichter, der es sonst geraeumt haette, war ab da unerreichbar.
    #[test]
    fn geraeumt_wird_in_beiden_faellen_freigegeben_nur_auf_ansage() {
        assert_eq!(
            abbauplan(true, Some(7)),
            Abbauplan::Sitzung { id: 7, freigeben: true },
            "Beenden: raeumen UND freigeben"
        );
        assert_eq!(
            abbauplan(false, Some(7)),
            Abbauplan::Sitzung { id: 7, freigeben: false },
            "Aufgeben: raeumen, aber NICHT freigeben"
        );
    }

    /// Ohne tragende Sitzung gibt es an der `Erfassung` nichts zu tun — der
    /// Verbindungs-Zustand wird trotzdem geraeumt (das steht im Trichter, nicht
    /// im Plan).
    #[test]
    fn ohne_sitzung_ist_an_der_erfassung_nichts_zu_tun() {
        assert_eq!(abbauplan(true, None), Abbauplan::Nichts);
        assert_eq!(abbauplan(false, None), Abbauplan::Nichts);
    }
}
