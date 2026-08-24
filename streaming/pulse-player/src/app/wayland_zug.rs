//! Wayland: den Zug ueber die Fenstergrenze anstossen und seine Bewegungen an
//! die tragende Sitzung weiterreichen (s. `crate::fernsteuerung::wayland`).
//! Reine Verdrahtung — was der Zug bedeutet, wie `start_drag`/das Datengeraet
//! funktionieren und welche Kanten offen sind, steht dort und in
//! `wayland::zug`.
//!
//! **Dieselbe Bauart wie [`crate::tastensperre`]:** die Fassade
//! ([`WaylandZug`], `App::wayland_zug_beginnen`/`wayland_zug_nachfassen`) ist
//! **immer** da, portabel und kostenlos auf Nicht-Linux; der Wayland-Teil
//! steckt hinter `#[cfg(target_os = "linux")]` INNERHALB dieser Datei. Damit
//! braucht kein Aufrufer (`window_event`, `eingaben_abgeben`) ein eigenes
//! `#[cfg]` — dieselbe Erleichterung, die `tastensperre::Gemeinsam` fuer
//! `input_capture` schon bietet.
//!
//! Getrennt von `app/mod.rs`, aus demselben Grund wie `eingabe.rs` daneben:
//! die Datei ist ueber der Groessen-Grenze (`PLAN.md` §12.1), und dieser Teil
//! laesst sich sauber abtrennen.
//!
//! **Stolperstein 2 (aus `wayland::zug`-Modulkopf, hier praktisch relevant):**
//! sobald `zug_beginnen` erfolgreich war, liefert winit fuer DIESES Fenster
//! kein `CursorMoved`/`MouseInput` mehr — die komplette Bewegung UND das
//! Loslassen der Maustaste laufen ab dann ausschliesslich ueber
//! [`App::wayland_zug_nachfassen`] (Bewegung: `zeiger_ueber`) bzw. ueber
//! [`crate::fernsteuerung::Erfassung::zug_beendet`] (Loslassen: erkannt an
//! `zeiger_ueber() == None`, NACHDEM schon einmal `Some` kam — ein `None` VOR
//! der ersten Auskunft heisst nur „der Compositor hat noch kein `Enter`
//! geschickt", nicht „der Zug ist zuende", s. [`Innen::laeuft`]).
//!
//! **Ungeprueft, aus demselben Grund wie die beiden Bausteine, auf denen das
//! hier aufsetzt:** es fehlt eine echte Wayland-Sitzung mit zwei
//! Player-Fenstern (s. Bericht). Nachrechenbar bleibt die eine Stelle, an der
//! dieses Vorhaben typischerweise bricht — die Einheit der Koordinaten
//! ([`logisch_zu_physisch`], mit eigenen Tests).

#[cfg(target_os = "linux")]
use std::collections::HashMap;

use super::App;
#[cfg(target_os = "linux")]
use super::Session;

/// Was die App sich ueber den laufenden Zug merkt. Leer und kostenlos auf
/// Nicht-Linux (s. Modulkopf).
#[derive(Default)]
pub(super) struct WaylandZug {
    #[cfg(target_os = "linux")]
    inner: Innen,
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct Innen {
    verbindung: Option<crate::fernsteuerung::wayland::Gastverbindung>,
    /// Aufbau schon versucht? Ein Fehlschlag (kein Wayland, kein Compositor
    /// mit dem Protokoll, kein `wl_seat`) aendert sich waehrend eines
    /// Prozesslebens nicht — dieselbe Begruendung wie
    /// `tastensperre::Gemeinsam::versucht`, kein Grund, ihn bei jedem Druck
    /// erneut zu zahlen.
    versucht: bool,
    /// Welche Sitzung den laufenden Zug gestartet hat — dorthin gehen seine
    /// Bewegungen, bis er endet.
    session: Option<u64>,
    /// Kam seit `zug_beginnen` schon MINDESTENS eine Auskunft vom
    /// Datengeraet? Erst dann bedeutet ein erneutes `zeiger_ueber() == None`
    /// „der Zug ist zuende" (s. Modulkopf „Stolperstein 2").
    laeuft: bool,
}

impl App {
    /// Zug anstossen — beim MouseInput-Druck, **nur** wenn diese Sitzung
    /// ferngesteuert erfasst (Vorpruefung beim Aufrufer, `window_event`).
    /// Nichtstun, wenn Wayland es nicht hergibt (X11, kein Compositor mit dem
    /// Protokoll) — dann bleibt es beim Verhalten von vor diesem Vorhaben.
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_beginnen(&mut self, id: u64) {
        let Some(session) = self.sessions.get(&id) else { return };
        if !self.wayland_zug.inner.versucht {
            self.wayland_zug.inner.versucht = true;
            self.wayland_zug.inner.verbindung =
                crate::fernsteuerung::wayland::aufbauen(&session.window).ok();
        }
        let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
        if verbindung.zug_beginnen(&session.window) {
            self.wayland_zug.inner.session = Some(id);
            self.wayland_zug.inner.laeuft = false;
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn wayland_zug_beginnen(&mut self, _id: u64) {}

    /// Warteschlange des Datengeraets leeren (`Gastverbindung::nachfassen`,
    /// s. dortiger Modulkopf „Warum das noetig ist") und, falls ein Zug
    /// laeuft, seine Bewegung an die tragende Sitzung weiterreichen — oder,
    /// falls er gerade endete, ihren gehaltenen Mausknopf loslassen.
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_nachfassen(&mut self) {
        let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
        verbindung.nachfassen();
        let Some(id) = self.wayland_zug.inner.session else { return };
        let Some((flaeche, x, y)) = verbindung.zeiger_ueber() else {
            if self.wayland_zug.inner.laeuft {
                // Echtes Ende (Drop/Leave, s. `wayland::zug`-Modulkopf) — vor
                // der ersten Auskunft waere dieser Zweig verfrueht (s.
                // Feld-Doc `Innen::laeuft`).
                self.wayland_zug.inner.laeuft = false;
                self.wayland_zug.inner.session = None;
                if let Some(session) = self.sessions.get_mut(&id) {
                    session.eingabe.wayland_ziel_setzen(None);
                    session.eingabe.zug_beendet();
                }
            }
            return;
        };
        self.wayland_zug.inner.laeuft = true;
        let Some((slot, lage, px, py)) = ziel_fuer(&self.sessions, &flaeche, x, y) else {
            return;
        };
        let Some(session) = self.sessions.get_mut(&id) else { return };
        session.eingabe.wayland_ziel_setzen(Some((slot, lage)));
        session.eingabe.zeigerposition(lage, px, py);
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn wayland_zug_nachfassen(&mut self) {}
}

/// Welches Fenster gehoert zur gemeldeten Flaeche, und was folgt daraus: Platz,
/// Bildlage und PHYSISCHE Punkte DIESES Fensters.
///
/// **Logisch -> physisch genau HIER, mit dem Skalierungsfaktor DES
/// GEFUNDENEN FENSTERS.** `zeiger_ueber` liefert flaechenlokale, LOGISCHE
/// Koordinaten und kennt das Fenster bewusst nicht (s. Modulkopf an
/// [`crate::fernsteuerung::wayland::zug::Gastverbindung::zeiger_ueber`]);
/// `Bildlage::anteil` verlangt PHYSISCHE. Erst hier, nachdem die Flaeche
/// einem Fenster zugeordnet ist, laesst sich dessen `scale_factor()`
/// ueberhaupt erst nachschlagen — vorher wuesste niemand, welcher Faktor
/// gemeint ist. Ungerechnet liesse: auf einem Fenster mit Skalierung != 1
/// einen Klick am falschen Ort, still — der Fehler, gegen den dieses ganze
/// Vorhaben gebaut ist.
#[cfg(target_os = "linux")]
fn ziel_fuer(
    sessions: &HashMap<u64, Session>,
    flaeche: &wayland_backend::sys::client::ObjectId,
    x: f64,
    y: f64,
) -> Option<(u32, crate::fernsteuerung::Bildlage, f64, f64)> {
    let treffer = sessions.values().find(|s| flaeche_id(&s.window).as_ref() == Some(flaeche))?;
    let skalierung = treffer.window.scale_factor();
    let fenster = treffer.window.inner_size();
    let lage = crate::fernsteuerung::Bildlage::neu(
        (fenster.width, fenster.height),
        (treffer.stats.width, treffer.stats.height),
        crate::render::zoom_ausschnitt(&treffer.options),
    )?;
    let (px, py) = (logisch_zu_physisch(x, skalierung), logisch_zu_physisch(y, skalierung));
    Some((treffer.eingabe.slot(), lage, px, py))
}

/// Logische Wayland-Koordinate * winits Skalierungsfaktor = physischer
/// Fensterpunkt.
///
/// **Genau hier sitzt die Falle dieser Aufgabe** (s. Modulkopf an
/// [`crate::fernsteuerung::wayland::zug::Gastverbindung::zeiger_ueber`]):
/// eine stillschweigend falsche Einheit ergibt einen Klick am falschen Ort.
/// Eine eigene, benannte Funktion nur fuer diese eine Multiplikation macht
/// die Umrechnung unuebersehbar UND fuer sich pruefbar, ohne Fenster und ohne
/// Wayland-Verbindung.
#[cfg(target_os = "linux")]
fn logisch_zu_physisch(logisch: f64, skalierung: f64) -> f64 {
    logisch * skalierung
}

/// Winits `wl_surface` DIESES Fensters als reine Kennung — dieselbe
/// Rekonstruktion wie `tastensperre::wayland::flaeche` und
/// `fernsteuerung::wayland::zug::flaeche`, hier ohne `Connection`: gebraucht
/// wird nur die KENNUNG zum Vergleichen (s. Aufgabenstellung „vergleiche ueber
/// die Kennung, nicht ueber Zeigergleichheit"), keine benutzbare `wl_surface`.
#[cfg(target_os = "linux")]
fn flaeche_id(fenster: &winit::window::Window) -> Option<wayland_backend::sys::client::ObjectId> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use wayland_client::Proxy;

    let handle = fenster.window_handle().ok()?;
    let RawWindowHandle::Wayland(handle) = handle.as_raw() else { return None };
    // SICHERHEIT: wie in den beiden Vorbildern — der Zeiger kommt aus winits
    // Fenster-Handle und zeigt auf einen gueltigen `wl_proxy` der
    // Schnittstelle `wl_surface`. Er bleibt gueltig, solange `fenster` lebt —
    // hier eine `&Window`-Ausleihe aus `sessions`, die laenger lebt als
    // dieser Aufruf.
    unsafe {
        wayland_backend::sys::client::ObjectId::from_ptr(
            wayland_client::protocol::wl_surface::WlSurface::interface(),
            handle.surface.as_ptr().cast(),
        )
    }
    .ok()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::logisch_zu_physisch;

    #[test]
    fn unskaliert_bleibt_unveraendert() {
        assert_eq!(logisch_zu_physisch(454.6, 1.0), 454.6);
    }

    /// Der Fall, gegen den dieses ganze Vorhaben gebaut ist: ohne diese
    /// Multiplikation kaeme auf einem 2x-Fenster jeder Klick um den Faktor 2
    /// daneben.
    #[test]
    fn doppelte_skalierung_verdoppelt_den_physischen_punkt() {
        assert_eq!(logisch_zu_physisch(100.0, 2.0), 200.0);
    }

    /// Nicht-ganzzahlige Skalierung (125 %/150 %, in freier Wildbahn haeufig)
    /// muss ebenso durchgehen, nicht nur glatte Faktoren.
    #[test]
    fn bruchteilige_skalierung() {
        assert!((logisch_zu_physisch(200.0, 1.5) - 300.0).abs() < 1e-9);
    }

    #[test]
    fn null_bleibt_null_unabhaengig_von_der_skalierung() {
        assert_eq!(logisch_zu_physisch(0.0, 1.75), 0.0);
    }
}
