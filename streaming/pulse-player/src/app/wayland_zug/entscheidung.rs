//! Wann ein Zug ENDET: den Beweis dafuer erkennen, und das Ende anwenden.
//!
//! Abgetrennt von [`super`], wo der Aufbau steht (Verbindung, Zugbeginn,
//! Nachfassen im Takt). Dieselbe Groessen-Begruendung wie bei
//! [`super::zuordnung`] daneben (`PLAN.md` §12.1), aber auch eine inhaltliche:
//! hier haengt das Ende an der SITZUNG, die es traegt — die Kopplung, in der
//! Review-Befund C-1 lag (ein Ende ohne Sitzung wurde nie abgeholt und traf
//! dann den naechsten Zug) — und hier steht der Beweis, um den es in I-B ging
//! (woran man ein Ende ueberhaupt erkennt). Ein Stueck, das man ohne
//! Compositor durchrechnen kann, gehoert an eine Stelle, an der man es sieht.

use super::App;
#[cfg(target_os = "linux")]
use winit::event::{ElementState, WindowEvent};

/// Was aus einem abgeholten Ende folgt — die eine Entscheidung, die in dieser
/// Datei ohne Wayland, ohne Fenster und ohne Compositor nachrechenbar ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Endentscheidung {
    /// Kein Ende gemeldet.
    Nichts,
    /// Ein Ende ist gemeldet, aber keine Sitzung traegt es. **Trotzdem
    /// abgeholt** (das ist der Kern von C-1), nur ohne Wirkung: es gibt
    /// niemanden, fuer den etwas losgelassen werden koennte, und ein
    /// stehengelassenes Ende faende der naechste Zug vor.
    NurVergessen,
    /// Ein Ende ist gemeldet und DIESE Sitzung traegt es: Ziel loeschen, alles
    /// Gedrueckte freigeben.
    Loslassen(u64),
}

/// Die Ende-Entscheidung als reine Funktion (Review M-d).
///
/// **Warum sie herausgezogen ist:** die zwoelf Tests der ersten Fassung fuhren
/// `Zugende` durch seine eigenen Setter und bewiesen ueber die Kopplung an die
/// Sitzung gar nichts — genau in dieser Kopplung lag aber C-1. Hier ist sie
/// eine Zeile, die ein Test sehen kann.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ende_entscheiden(zuende: bool, session: Option<u64>) -> Endentscheidung {
    match (zuende, session) {
        (false, _) => Endentscheidung::Nichts,
        (true, None) => Endentscheidung::NurVergessen,
        (true, Some(id)) => Endentscheidung::Loslassen(id),
    }
}

impl App {
    /// **Der Beweis von der anderen Seite** (Review I-B): winit liefert wieder
    /// `CursorMoved`/`MouseInput` — also hat der Compositor seinen Zug-Griff
    /// aufgegeben (gemessen: waehrend eines laufenden Zugs kommt kein einziges
    /// `wl_pointer`-Ereignis, s. Modulkopf). Das loest ein `Leave` auf, das
    /// sonst bis zum Ablauf der Notfrist offen bliebe — ein Abbruch mit Esc
    /// etwa meldet uns gar nichts. **Einen Zug ohne offenes `Leave` beendet es
    /// NICHT** (Begruendung an `wayland::ende::Zugende::griff_vorbei`).
    ///
    /// **Nur bei BESTAETIGTEM Zug** (erstes `Enter` gesehen) — das zweite
    /// Schloss neben dem `Unklar` oben. Vor der Bestaetigung ist ein
    /// Zeigerereignis mehrdeutig: der Compositor kann Bewegungen abgeschickt
    /// haben, bevor er unser `start_drag` verarbeitet hat, und winit reicht
    /// sie noch im selben Durchlauf weiter. Allein wuerde das heute nichts
    /// aendern (ohne `Leave` gibt es kein `Unklar`, und ohne `Unklar` tut
    /// `griff_vorbei` nichts) — es steht hier, weil die Kosten einer
    /// Fehlannahme ueber die Reihenfolge eine Maustaste sind, die mitten in
    /// der Geste hochgeht.
    ///
    /// **Ein Loslassen VOR der Bestaetigung heisst etwas anderes** und wird
    /// deshalb getrennt behandelt: der Zug wird **aufgegeben, nicht beendet**.
    /// Aufgeben heisst, den Merker zu raeumen, ohne etwas loszulassen — der
    /// Knopf haengt noch am gewoehnlichen `MouseInput`-Weg, der ihn gleich
    /// danach ordentlich loslaesst; ein gemeldetes Ende gaebe ihn ein zweites
    /// Mal frei. Ohne das Aufgeben bliebe der Merker stehen, und der naechste
    /// FREMDE Zug spraeche wieder fuer uns (C-1).
    ///
    /// **Hier steht bewusst KEIN Log** (anders als bei den drei Stellen aus
    /// Review I4). Dieser Zweig ist naemlich nicht der Ausnahmefall, sondern
    /// der haeufigste ueberhaupt: ein gewoehnlicher KLICK (druecken,
    /// loslassen, ohne zu bewegen) laeuft genau hier durch — gemessen am
    /// 2026-08-24 beginnt ein Zug erst mit der ersten Bewegung NACH dem
    /// `start_drag`, bis dahin behaelt winit den Zeigerfokus. Eine Meldung
    /// „der Zug hat nicht gegriffen" waere bei jedem normalen Klick fachlich
    /// falsch. Der eine Fall, der wirklich ein Defekt waere (`start_drag`
    /// hinausgegangen, Compositor verwirft es wegen unpassender
    /// Seriennummer), laesst sich von hier aus nicht davon unterscheiden.
    ///
    /// **Muss VOR `Erfassung::on_window_event` laufen** (Aufrufer:
    /// `App::window_event`). Andernfalls haette ein Druck, der einen neuen Zug
    /// beginnt, schon in `knoepfe_unten` gestanden, wenn das Ende des alten
    /// Zugs „alles Gedrueckte" freigibt — und der frische Druck ginge am
    /// fernen Rechner sofort wieder hoch.
    #[cfg(target_os = "linux")]
    pub(in crate::app) fn wayland_zug_griff_pruefen(&mut self, ereignis: &WindowEvent) {
        if !matches!(ereignis, WindowEvent::CursorMoved { .. } | WindowEvent::MouseInput { .. }) {
            return;
        }
        // **Bei einem DRUCK zuerst dispatchen und ein offenes Ende abholen**
        // (Review C-A, 2026-08-25) — und zwar unabhaengig davon, ob wir gerade
        // einen Zug fuehren. Das gehoerte bis dahin in `wayland_zug_beginnen`,
        // und das laeuft NACH `Erfassung::on_window_event`: das Loslassen des
        // vorigen Zugs und der neue Druck koennen im selben winit-Umlauf
        // eintreffen (unter Last, mit 4K-Dekode zwischen zwei Reads, sind das
        // leicht 15-30 ms). Dann stand der frische Druck schon in
        // `knoepfe_unten`, wenn das nachgeholte `Drop` „alles Gedrueckte"
        // freigab — der neue Zug lief ohne gedrueckte Taste weiter: keine
        // klemmende Taste, aber eine tote Geste ohne jede Meldung. Der
        // C1-Auflage der ersten Runde (`nachfassen()` vor
        // `letzte_druck_nummer()`) ist damit weiter genuege getan; sie rueckt
        // nur frueher im selben `window_event`.
        if matches!(ereignis, WindowEvent::MouseInput { state: ElementState::Pressed, .. }) {
            let zuende = {
                let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
                verbindung.nachfassen();
                verbindung.zug_zuende()
            };
            self.wayland_zug_ende_anwenden(zuende);
        }
        let (angefordert, bestaetigt) = {
            let Some(verbindung) = self.wayland_zug.inner.verbindung.as_ref() else { return };
            (verbindung.zug_angefordert(), verbindung.zug_bestaetigt())
        };
        if !angefordert {
            return;
        }
        if bestaetigt {
            let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
            verbindung.griff_vorbei();
            let zuende = verbindung.zug_zuende();
            self.wayland_zug_ende_anwenden(zuende);
            return;
        }
        if !matches!(ereignis, WindowEvent::MouseInput { state: ElementState::Released, .. }) {
            return;
        }
        let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
        verbindung.zug_aufgeben();
        self.wayland_zug.inner.session = None;
        self.wayland_zug.inner.ziel_fehler_gemeldet = false;
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
    /// **Warum das sein muss** (Review C-B, 2026-08-25): der Merker „eigener
    /// Zug" hatte nur zwei Ausgaenge — ein abgeholtes Ende und das Aufgeben
    /// beim Loslassen. Wer zwischen Druck und Loslassen den Fokus verliert
    /// (Alt-Tab; der Compositor bricht die implizite Ergreifung ab, das
    /// Loslassen erreicht uns nie) oder dessen Fenster zugeht, sah beides nie.
    /// Der Merker blieb dann fuer den Rest der Prozesslaufzeit stehen — und ab
    /// da sprach **jeder fremde Zug wieder fuer uns**: sein `Motion` schickte
    /// den fernen Zeiger dorthin, wo ein Fremder eine Datei zieht, und sein
    /// `Leave` gab am fernen Rechner frei, was der Nutzer gerade haelt. Das
    /// ist genau der Schaden, gegen den C-1 angetreten war.
    ///
    /// **Abbrechen heisst aufgeben, nicht beenden** — es wird nichts
    /// losgelassen. Alle drei Aufrufer geben das Gedrueckte ohnehin selbst
    /// frei (`Focused(false)` -> `alles_loslassen`, `input_capture(false)`/
    /// `eingabe_raeumen` -> `ausschalten`); ein zweites Freigeben von hier
    /// waere bestenfalls ueberfluessig.
    ///
    /// **Nur fuer die Sitzung, die den Zug traegt.** Ein anderes Fenster, das
    /// den Fokus verliert, geht diesen Zug nichts an.
    #[cfg(target_os = "linux")]
    pub(in crate::app) fn wayland_zug_abbrechen(&mut self, id: u64) {
        if self.wayland_zug.inner.session != Some(id) {
            return;
        }
        if let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() {
            verbindung.zug_aufgeben();
        }
        self.wayland_zug.inner.session = None;
        self.wayland_zug.inner.ziel_fehler_gemeldet = false;
    }

    #[cfg(not(target_os = "linux"))]
    pub(in crate::app) fn wayland_zug_abbrechen(&mut self, _id: u64) {}

    /// Ein abgeholtes Ende anwenden — der eine Trichter fuer alle drei Wege,
    /// auf denen ein Zug endet (`Drop`, Beweisweg, Notfrist).
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_ende_anwenden(&mut self, zuende: bool) {
        match ende_entscheiden(zuende, self.wayland_zug.inner.session) {
            Endentscheidung::Nichts => {}
            Endentscheidung::NurVergessen => {
                self.wayland_zug.inner.ziel_fehler_gemeldet = false;
            }
            Endentscheidung::Loslassen(id) => {
                self.wayland_zug.inner.session = None;
                self.wayland_zug.inner.ziel_fehler_gemeldet = false;
                if let Some(session) = self.sessions.get_mut(&id) {
                    session.eingabe.wayland_ziel_setzen(None);
                    session.eingabe.zug_beendet();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ende_entscheiden, Endentscheidung};

    #[test]
    fn ohne_gemeldetes_ende_passiert_nichts() {
        assert_eq!(ende_entscheiden(false, Some(7)), Endentscheidung::Nichts);
        assert_eq!(ende_entscheiden(false, None), Endentscheidung::Nichts);
    }

    #[test]
    fn ein_ende_mit_tragender_sitzung_laesst_los() {
        assert_eq!(ende_entscheiden(true, Some(7)), Endentscheidung::Loslassen(7));
    }

    /// **Der C-1-Fall, den kein Test der ersten Fassung sehen konnte:** ein
    /// Ende ohne tragende Sitzung. Es MUSS abgeholt werden (sonst holt es der
    /// naechste Zug ab und deutet es als sein eigenes Ende — die gerade
    /// gedrueckte Maustaste ginge am fernen Rechner sofort wieder hoch), darf
    /// aber nichts loslassen.
    #[test]
    fn ein_ende_ohne_sitzung_wird_abgeholt_aber_laesst_nichts_los() {
        assert_eq!(ende_entscheiden(true, None), Endentscheidung::NurVergessen);
    }
}
