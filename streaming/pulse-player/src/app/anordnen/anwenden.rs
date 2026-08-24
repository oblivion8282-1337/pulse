//! Was die Rechnung aus [`super`] am echten Fenster anrichtet: Zielflaeche
//! bestimmen, Fenster suchen, Lage setzen — und die Auskunft, ob die
//! Oberflaeche das ueberhaupt zulaesst.
//!
//! Getrennt von der Rechnung, damit die ohne Fenster pruefbar bleibt (dasselbe
//! Muster wie `overlay::schirmkarte::{rechnung, zeichnung}`). Hier drin steht
//! deshalb kein Test: jede Zeile braucht ein echtes `Window`.

use winit::dpi;
use winit::monitor::MonitorHandle;
use winit::window::Window;

use super::{Fensterlage, Schirmlage, anordenbar, anordnen};
use crate::app::{App, Session};

/// Kann diese Oberflaeche Fenster ueberhaupt setzen?
///
/// **Unter Wayland nicht.** `Window::set_outer_position` ist dort ein stiller
/// Leerlauf (winit 0.30.13, `platform_impl/linux/wayland/window/mod.rs:273-275`,
/// woertlich „Not possible on Wayland") — ein Klient darf seine Fenster dort
/// nicht selbst platzieren. Der Knopf wird deshalb gar nicht erst angeboten;
/// einer, der wortlos nichts tut, ist schlimmer als keiner.
///
/// **Nur unter Linux eine echte Frage.** Derselbe Bau laeuft dort unter X11
/// UND Wayland — ein `cfg(target_os)` allein kann die beiden nicht
/// unterscheiden, die Antwort muss zur LAUFZEIT fallen. Sie kommt ueber das
/// Anzeige-Handle (`RawDisplayHandle::Wayland` = nein, `Xlib`/`Xcb` = ja) —
/// genau das Muster, das `crate::tastensperre::wayland::aufbauen` fuer die
/// Tastenkuerzel-Sperre schon nutzt. Auf Windows und macOS gibt es kein
/// Wayland, dort ist die Antwort immer ja; ein zweites `cfg(target_os)`
/// erspart dort jede Laufzeit-Abfrage — dasselbe Muster wie
/// `crate::app::skalierung_taugt`.
///
/// Ein fehlgeschlagenes Anzeige-Handle zaehlt als NEIN: lieber fehlt der
/// Knopf, als dass er auf einer ungeklaerten Oberflaeche wortlos nichts tut.
#[cfg(target_os = "linux")]
pub(crate) fn fenster_setzen_moeglich(fenster: &Window) -> bool {
    use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
    fenster.display_handle().is_ok_and(|h| !matches!(h.as_raw(), RawDisplayHandle::Wayland(_)))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn fenster_setzen_moeglich(_fenster: &Window) -> bool {
    true
}

/// Die Flaeche, in die eingepasst wird: der Bildschirm, auf dem das
/// ausloesende Fenster liegt.
///
/// **Zielflaeche ist der GANZE Monitor, nicht seine Arbeitsflaeche.** Der
/// Entwurf sagt „proportional in die Arbeitsflaeche"; winit 0.30 hat dafuer
/// keine Auskunft — weder `MonitorHandle` noch `Window` kennen einen
/// Arbeitsbereich, und eine geratene Randbreite waere auf dem naechsten Aufbau
/// falsch. Bewusst in Kauf genommene Folge: das unterste Fenster liegt auf
/// Windows hinter der Taskleiste, auf macOS reicht das oberste unter die
/// Menueleiste. Wer das aendert, braucht eine echte Quelle fuer den
/// Arbeitsbereich, keine Konstante.
///
/// **Einheit ist die, in der die Oberflaeche EINEN gemeinsamen
/// Koordinatenraum hat** — und das ist nicht ueberall dieselbe:
///
/// * Windows und X11: physische Bildpunkte. `MonitorHandle::position` und
///   `Window::set_outer_position` teilen sich denselben globalen Pixelraum,
///   die Umrechnung im Setzer ist die Identitaet (winit 0.30.13,
///   `windows/window.rs:188`, `x11/window.rs:1238` — `to_physical` auf einer
///   `PhysicalPosition`).
/// * macOS: Punkte. `MonitorHandle::position` gibt `CGDisplayBounds` MAL der
///   Skalierung DES MONITORS heraus (`macos/monitor.rs:242-249`),
///   `set_outer_position` rechnet mit `to_logical` der Skalierung DES FENSTERS
///   zurueck (`macos/window_delegate.rs:934-935`). Physisch zu rechnen waere
///   dort nur bei gleicher Skalierung richtig — MacBook (2x) plus externer
///   Monitor (1x) ist aber genau die Aufstellung, in der dieser Knopf gedrueckt
///   wird: ein Fenster, das gerade auf dem externen Schirm liegt, bekaeme
///   „physisch 1440,0" und landete auf „logisch 1440,0", also doppelt so weit
///   rechts und doppelt so gross.
///
/// **Warum hier umgerechnet und nicht — wie beim Ziehen ueber die
/// Fenstergrenze (`crate::app::skalierung_taugt`) — der ganze Weg gesperrt
/// wird:** dort werden ZEIGERlagen zweier Fenster voneinander abgezogen, und
/// winit gibt die je in der Skalierung des jeweiligen Fensters heraus. Es gibt
/// dort keinen Monitor, an dem sich das verankern liesse, also bleibt nur der
/// Riegel. Hier liegt die Skalierung des Zielmonitors vor und die Umrechnung
/// ist exakt; ein Riegel wuerde den Knopf auf dem verbreitetsten Mac-Aufbau
/// ueberhaupt abschalten.
#[cfg(not(target_os = "macos"))]
fn zielflaeche(monitor: &MonitorHandle) -> (i32, i32, u32, u32) {
    let pos = monitor.position();
    let groesse = monitor.size();
    (pos.x, pos.y, groesse.width, groesse.height)
}

#[cfg(target_os = "macos")]
fn zielflaeche(monitor: &MonitorHandle) -> (i32, i32, u32, u32) {
    let skalierung = monitor.scale_factor();
    let pos: dpi::LogicalPosition<f64> = monitor.position().to_logical(skalierung);
    let groesse: dpi::LogicalSize<f64> = monitor.size().to_logical(skalierung);
    (
        pos.x.round() as i32,
        pos.y.round() as i32,
        groesse.width.round() as u32,
        groesse.height.round() as u32,
    )
}

/// Rahmen und Titelleiste dieses Fensters, in physischen Bildpunkten je Achse.
///
/// Gebraucht wird das, weil [`fenster_setzen`] die AEUSSERE Lage setzt, aber
/// nur die INNERE Groesse verlangen kann. Ohne Abzug ragt jedes Fenster um
/// seine Dekoration ueber das ihm zugedachte Rechteck hinaus: bei zwei
/// gestapelten Host-Monitoren steht das untere Fenster rund eine Titelleiste zu
/// tief, nebeneinander liegende ueberlappen um die Rahmenbreite. Das ist genau
/// die Ueberlappung, die der Knopf beseitigen soll — und um Groessenordnungen
/// mehr als die Rundung, gegen die die Einpassung in [`super::anordnen`]
/// abgesichert ist.
///
/// Die Fenster sind dekoriert (`App::open` setzt nichts anderes); auf einem
/// Aufbau ohne Dekoration kommt hier schlicht `(0, 0)` heraus.
fn dekoration(fenster: &Window) -> (u32, u32) {
    let aussen = fenster.outer_size();
    let innen = fenster.inner_size();
    (aussen.width.saturating_sub(innen.width), aussen.height.saturating_sub(innen.height))
}

/// Ein Fenster auf sein Rechteck legen — in derselben Einheit, in der
/// [`zielflaeche`] gemessen hat.
#[cfg(not(target_os = "macos"))]
fn fenster_setzen(fenster: &Window, lage: &Fensterlage) {
    vollbild_verlassen(fenster);
    let (deko_x, deko_y) = dekoration(fenster);
    fenster.set_outer_position(dpi::PhysicalPosition::new(lage.x, lage.y));
    let _ = fenster.request_inner_size(dpi::PhysicalSize::new(
        lage.breite.saturating_sub(deko_x).max(1),
        lage.hoehe.saturating_sub(deko_y).max(1),
    ));
}

#[cfg(target_os = "macos")]
fn fenster_setzen(fenster: &Window, lage: &Fensterlage) {
    vollbild_verlassen(fenster);
    // Die Dekoration kommt physisch heraus, gerechnet wird hier in Punkten.
    let skalierung = fenster.scale_factor();
    let (deko_x, deko_y) = dekoration(fenster);
    fenster.set_outer_position(dpi::LogicalPosition::new(f64::from(lage.x), f64::from(lage.y)));
    let _ = fenster.request_inner_size(dpi::LogicalSize::new(
        (f64::from(lage.breite) - f64::from(deko_x) / skalierung).max(1.0),
        (f64::from(lage.hoehe) - f64::from(deko_y) / skalierung).max(1.0),
    ));
}

/// **Vollbild zuerst verlassen**, sonst ignoriert das Fenster die neue Lage
/// stillschweigend: `set_outer_position` nimmt auf Windows nur `MAXIMIZED`
/// zurueck (winit 0.30.13, `windows/window.rs:193-197`), Vollbild nicht.
///
/// Ungemessen: auf macOS ist das Verlassen des Vollbilds animiert — ob das
/// unmittelbar danach gesetzte Rechteck die Animation ueberlebt, ist hier nicht
/// geprueft.
fn vollbild_verlassen(fenster: &Window) {
    if fenster.fullscreen().is_some() {
        fenster.set_fullscreen(None);
    }
}

impl App {
    /// Die Fernsteuerungs-Sitzung, fuer die dieses Fenster gerade erfasst.
    ///
    /// `None` deckt drei Faelle ab und behandelt sie gleich: Fenster
    /// unbekannt, Erfassung aus, oder Kennung unbekannt.
    ///
    /// **Der dritte ist der, den man leicht uebersieht.**
    /// `Erfassung::einschalten` laesst `sitzung: None` ausdruecklich zu
    /// (`fernsteuerung/strom.rs`, „wer nicht weiss, wem er etwas schickt,
    /// schickt es nicht"). Ein spaeterer Vergleich `None == None` waere ein
    /// TREFFER und damit das Gegenteil von fail-closed — deshalb faellt der
    /// Fall schon hier heraus, statt bei den Aufrufern.
    fn sitzung_von(&self, id: u64) -> Option<&str> {
        let session = self.sessions.get(&id)?;
        if !session.eingabe.aktiv() {
            return None;
        }
        session.eingabe.sitzung()
    }

    /// Das Fenster, das `monitor` in DERSELBEN Fernsteuerungs-Sitzung wie `id`
    /// zeigt.
    ///
    /// **Sitzung und laufende Erfassung gehoeren zum Zielkriterium**, nicht nur
    /// die Bildschirmnummer: Fenster- und Platznummern wiederholen sich
    /// zwischen Sitzungen, die Sitzungskennung nicht (dieselbe Begruendung wie
    /// beim Einsammeln der Nachbarschaft in `App::window_event`). Ohne diese
    /// beiden holte eine Sitzung, deren `input_capture`-Aus nie ankam, ein
    /// fremdes Fenster nach vorn — und ein `focus_window()` loest im
    /// verlassenen Fenster `alles_loslassen()` aus.
    pub(in crate::app) fn fenster_fuer_schirm(&self, id: u64, monitor: u32) -> Option<&Session> {
        let sitzung = self.sitzung_von(id)?;
        self.sessions.values().find(|s| {
            s.eingabe.aktiv()
                && s.eingabe.sitzung() == Some(sitzung)
                && s.fern_schirme.iter().any(|sch| sch.dieses_fenster && sch.index == monitor)
        })
    }

    /// Die Schirme, mit denen [`anordnen`] rechnen wird: je Fenster dieser
    /// Sitzung der Bildschirm, den es zeigt — und nur, wenn er eine
    /// vollstaendige Lage traegt.
    ///
    /// **Erst ALLE sammeln, dann rechnen** — und zwar nicht wegen der Ausleihe,
    /// sondern weil [`anordnen`] einen GEMEINSAMEN Massstab ueber alle Schirme
    /// legt: es muss die gesamte Anordnung des Hosts kennen, bevor es das erste
    /// Fenster setzen kann.
    ///
    /// Der Gateway darf jede der vier Lagezahlen einzeln weglassen, und eine
    /// aeltere Gegenstelle laesst alle vier weg — dann bleibt die Liste kurz
    /// oder leer, und [`anordenbar`] faengt das ab.
    fn schirme_der_sitzung(&self, sitzung: &str) -> Vec<Schirmlage> {
        self.sessions
            .values()
            .filter(|s| s.eingabe.aktiv() && s.eingabe.sitzung() == Some(sitzung))
            .filter_map(|s| s.fern_schirme.iter().find(|schirm| schirm.dieses_fenster))
            .filter_map(|schirm| {
                Some(Schirmlage {
                    index: schirm.index,
                    x: schirm.x?,
                    y: schirm.y?,
                    breite: schirm.width?,
                    hoehe: schirm.height?,
                })
            })
            .collect()
    }

    /// Wuerde der Knopf „Fenster wie drueben anordnen" etwas bewirken?
    ///
    /// **Dieselben Daten wie die Wirkung**, absichtlich: dieselbe Sammlung
    /// ([`Self::schirme_der_sitzung`]) und dasselbe Tor ([`anordenbar`], das
    /// [`anordnen`] auch selbst noch einmal durchlaeuft). Vorher war die
    /// Sichtbarkeit unabhaengig davon formuliert („mehr als ein offener
    /// Schirm"), und der Knopf stand in drei Faellen da, in denen er
    /// nachweislich nichts tun konnte: aeltere Gegenstelle ohne Lagen,
    /// mehrdeutige Zuordnung Strom-zu-Bildschirm (dann traegt kein Eintrag
    /// `dieses_fenster`), und nur EIN Fenster mit vollstaendiger Lage.
    ///
    /// Die zweite Haelfte der Sichtbarkeit — [`fenster_setzen_moeglich`] —
    /// bleibt beim Fenster selbst: sie haengt an der Oberflaeche, nicht an den
    /// Schirmen, und `fenster_anordnen` prueft sie ebenfalls erneut.
    fn anordnen_moeglich(&self, id: u64) -> bool {
        let Some(sitzung) = self.sitzung_von(id) else { return false };
        anordenbar(&self.schirme_der_sitzung(sitzung))
    }

    /// Die Antwort ins Overlay dieses Fensters tragen, damit der Knopf
    /// erscheint oder verschwindet.
    ///
    /// **Vor jedem Durchgang neu**, statt bei jeder Aenderung angestossen: die
    /// Antwort haengt an ALLEN Fenstern der Sitzung, ein Anstoss muesste
    /// deshalb bei jedem Oeffnen, Schliessen, `remote_screens` und
    /// `input_capture` jedes anderen Fensters mitlaufen — vier Stellen, an
    /// denen genau eine vergessen genuegt, damit der Knopf falsch steht. Die
    /// Rechnung laeuft ueber eine Handvoll Sitzungen und ist billiger als das.
    pub(in crate::app) fn anordnen_bereitschaft_nachziehen(&mut self, id: u64) {
        let moeglich = self.anordnen_moeglich(id);
        if let Some(overlay) = self.sessions.get_mut(&id).and_then(|s| s.overlay.as_mut()) {
            overlay.set_fern_anordenbar(moeglich);
        }
    }

    /// Knopf „Fenster wie drueben anordnen": legt alle offenen Fenster
    /// DIESER Fernsteuerungs-Sitzung auf dem Bildschirm, auf dem das
    /// AUSLOESENDE Fenster (`id`) liegt, so an, wie die Host-Monitore
    /// zueinander liegen.
    ///
    /// Einmalig — danach merkt sich niemand etwas, wer von Hand nachzieht,
    /// behaelt seine Anordnung (s. Modulkopf von [`super`]).
    pub(in crate::app) fn fenster_anordnen(&self, id: u64) {
        let Some(session) = self.sessions.get(&id) else { return };
        // Wayland: der Knopf war ohnehin nicht sichtbar (s.
        // `fenster_setzen_moeglich`) — hier nur die zweite, billige
        // Absicherung gegen einen veralteten Frame.
        if !fenster_setzen_moeglich(&session.window) {
            return;
        }
        // `current_monitor` liefert `None`, wenn winit ihn nicht ermitteln kann
        // — dann bleibt nichts anderes uebrig, als nichts zu tun: es gibt keine
        // Flaeche, in die sich etwas einpassen liesse.
        let Some(monitor) = session.window.current_monitor() else { return };
        let Some(sitzung) = self.sitzung_von(id) else { return };

        let schirme = self.schirme_der_sitzung(sitzung);
        for lage in anordnen(&schirme, zielflaeche(&monitor)) {
            let Some(ziel) = self.fenster_fuer_schirm(id, lage.index) else { continue };
            fenster_setzen(&ziel.window, &lage);
        }
    }
}
