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
//! braucht kein Aufrufer (`window_event`, `eingaben_abgeben`, `exiting`) ein
//! eigenes `#[cfg]` — dieselbe Erleichterung, die `tastensperre::Gemeinsam`
//! fuer `input_capture` schon bietet.
//!
//! Getrennt von `app/mod.rs`, aus demselben Grund wie `eingabe.rs` daneben:
//! die Datei ist ueber der Groessen-Grenze (`PLAN.md` §12.1), und dieser Teil
//! laesst sich sauber abtrennen.
//!
//! **Stolperstein 2 (aus `wayland::zug`-Modulkopf, hier praktisch relevant):**
//! sobald `zug_beginnen` erfolgreich war, liefert winit fuer KEIN Fenster
//! mehr `CursorMoved`/`MouseInput` — die komplette Bewegung UND das
//! Loslassen der Maustaste laufen ab dann ausschliesslich ueber
//! [`App::wayland_zug_nachfassen`]: Bewegung ueber `zeiger_ueber`, Loslassen
//! ueber das EREIGNISGETRIEBENE `zug_zuende` (s. dortige Typ-Doku
//! `Zugende`) — **nicht** ueber eine Momentaufnahme von `zeiger_ueber`.
//! Letzteres war der C2/I3-Befund der ersten Review-Runde: eine Momentaufnahme
//! sieht sowohl einen ganzen, sehr schnellen Zug (Enter->Drop->Leave
//! zwischen zwei Abtastungen) als auch einen blossen Flaechenwechsel
//! (Leave(A)->Enter(B) IM SELBEN Zug) faelschlich als Ende an.
//!
//! **C1 (erste Review-Runde): die Reihenfolge im Ereignisschleifen-Takt.**
//! `window_event` (wo `wayland_zug_beginnen` haengt) laeuft VOR
//! `about_to_wait` -> `eingaben_abgeben` -> `wayland_zug_nachfassen` — die
//! Druck-Seriennummer unseres zweiten Zeigers liegt beim ERSTEN Aufruf von
//! `wayland_zug_beginnen` also noch UNGEDISPATCHT in der Warteschlange.
//! Ohne ein `nachfassen()` VOR `letzte_druck_nummer()` waere sie beim ersten
//! Druck `None` (kein Zug) und bei jedem weiteren die Nummer des VORIGEN,
//! bereits entwerteten Drucks (ein Compositor verwirft eine unpassende
//! Nummer laut Protokolltext still) — der Zug begaenne nie. Deshalb ist
//! `nachfassen()` hier die ERSTE Zeile, nicht `eingaben_abgeben`s Aufgabe
//! allein.
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
    /// Gemeldet, dass die zuletzt bekannte Flaeche keinem Fenster zugeordnet
    /// werden konnte (Review I4)? Nur fuer die EDGE-getriggerte Meldung: sie
    /// soll einmal je Uebergang ins Log, nicht bei jedem Tick, in dem ein
    /// laufender Zug ausserhalb aller eigenen Fenster haengt.
    ziel_fehler_gemeldet: bool,
}

impl App {
    /// Zug anstossen — beim MouseInput-Druck, **nur** wenn diese Sitzung
    /// ferngesteuert erfasst UND der Druck tatsaechlich bei der Erfassung
    /// ankam (Vorpruefung beim Aufrufer, `window_event` — Review I2: ein
    /// Druck auf der Bedienleiste oder ausserhalb des Bildes darf keinen Zug
    /// anstossen, sonst verliert der Griff waehrend einer Fernsteuerung
    /// seinen eigenen Zeigerfokus). Nichtstun, wenn Wayland es nicht hergibt
    /// (X11, kein Compositor mit dem Protokoll) — dann bleibt es beim
    /// Verhalten von vor diesem Vorhaben.
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_beginnen(&mut self, id: u64) {
        let Some(session) = self.sessions.get(&id) else { return };
        if !self.wayland_zug.inner.versucht {
            self.wayland_zug.inner.versucht = true;
            // Erfolg UND Fehlschlag werden gemeldet, genau einmal (Review
            // I4) — dieselbe Begruendung wie
            // `tastensperre::wayland::Gemeinsam::anfordern`: ohne das Log
            // sieht „der Compositor kann es nicht" genauso aus wie „es hat
            // geklappt, aber etwas Nachgelagertes scheitert still" — zwei
            // Befunde mit voellig verschiedenen Antworten. Ein fehlendes Log
            // genau hier haette den C1-Befund der ersten Review-Runde
            // vermutlich schon beim ersten Handlauf sichtbar gemacht.
            match crate::fernsteuerung::wayland::aufbauen(&session.window) {
                Ok(verbindung) => {
                    eprintln!("pulse-player: Zug ueber die Fenstergrenze (Wayland) bereit.");
                    self.wayland_zug.inner.verbindung = Some(verbindung);
                }
                Err(grund) => {
                    eprintln!(
                        "pulse-player: Zug ueber die Fenstergrenze nicht verfuegbar ({grund}) \
                         — Ziehen bleibt auf das eigene Fenster beschraenkt."
                    );
                }
            }
        }
        let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
        // C1: erst nachfassen, DANN die Druck-Seriennummer lesen — sie liegt
        // beim ALLERERSTEN Aufruf (und bei jedem weiteren, dessen `button`-
        // Ereignis noch nicht dispatcht wurde) sonst ungedispatcht in unserer
        // eigenen Warteschlange, s. Modulkopf.
        verbindung.nachfassen();
        if verbindung.zug_beginnen(&session.window) {
            self.wayland_zug.inner.session = Some(id);
        } else {
            // Review I4: still zu bleiben war genau die Stelle, an der der
            // C1-Befund sich verstecken konnte.
            eprintln!(
                "pulse-player: Zug ueber die Fenstergrenze nicht gestartet \
                 (kein frischer Druck oder Fenster ohne Wayland-Flaeche)."
            );
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn wayland_zug_beginnen(&mut self, _id: u64) {}

    /// Warteschlange des Datengeraets leeren (`Gastverbindung::nachfassen`,
    /// s. dortiger Modulkopf „Warum das noetig ist") und, falls ein Zug
    /// laeuft, seine Bewegung an die tragende Sitzung weiterreichen — oder,
    /// falls er gerade endete (ereignisgetrieben, s. Modulkopf), ihren
    /// gehaltenen Mausknopf loslassen.
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_nachfassen(&mut self) {
        let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
        verbindung.nachfassen();
        let Some(id) = self.wayland_zug.inner.session else { return };

        // Bewegung zuerst: eine letzte Position kurz vor dem Ende soll noch
        // ankommen, wenn eine da ist.
        if let Some((flaeche, x, y)) = verbindung.zeiger_ueber() {
            // Review I1: dieselben zwei Filter wie beim Desktop-Koordinaten-
            // Weg in `window_event` (aktive Erfassung UND dieselbe
            // Fernsteuerungs-Sitzung) — sonst koennte ein Fenster OHNE
            // Handschlag beim Host eine Nachricht bekommen (die der Host
            // verwirft und dabei ALLES Gedrueckte freigibt), oder ein
            // Fenster einer FREMDEN Steuerung eine Platznummer beisteuern,
            // die drueben einen anderen Bildschirm meint.
            let eigene_sitzung = self.sessions.get(&id).and_then(|s| s.eingabe.sitzung());
            match ziel_fuer(&self.sessions, eigene_sitzung, &flaeche, x, y) {
                Some((slot, lage, px, py)) => {
                    self.wayland_zug.inner.ziel_fehler_gemeldet = false;
                    if let Some(session) = self.sessions.get_mut(&id) {
                        session.eingabe.wayland_ziel_setzen(Some((slot, lage)));
                        session.eingabe.zeigerposition(lage, px, py);
                    }
                }
                None if !self.wayland_zug.inner.ziel_fehler_gemeldet => {
                    // Review I4, EDGE-getriggert (s. Feld-Doc
                    // `ziel_fehler_gemeldet`): kein Tick-Spam, aber auch
                    // nicht mehr komplett still.
                    self.wayland_zug.inner.ziel_fehler_gemeldet = true;
                    eprintln!(
                        "pulse-player: Wayland-Zug — gemeldete Flaeche gehoert zu keinem \
                         erfassenden Fenster derselben Sitzung, Bewegung verworfen."
                    );
                }
                None => {}
            }
        }

        // Danach das Ende — EREIGNISGETRIEBEN (s. `Zugende`/Modulkopf „C2/
        // I3"), nicht aus einer Momentaufnahme von `zeiger_ueber()`.
        if verbindung.zug_zuende() {
            self.wayland_zug.inner.session = None;
            self.wayland_zug.inner.ziel_fehler_gemeldet = false;
            if let Some(session) = self.sessions.get_mut(&id) {
                session.eingabe.wayland_ziel_setzen(None);
                session.eingabe.zug_beendet();
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn wayland_zug_nachfassen(&mut self) {}
}

impl WaylandZug {
    /// Die Verbindung abbauen, solange winits Anzeige noch lebt — muss aus
    /// `App::exiting()` kommen (Review C3). Dieselbe Zusage wie
    /// `tastensperre::wayland::Gemeinsam::schliessen`/[`Drop`]: `main.rs`
    /// legt `App` VOR `run_app` an, `run_app` gibt winits `wl_display` frei,
    /// `App` faellt danach — ohne dieses Rufziel wuerden `Connection`,
    /// `EventQueue` und alle Proxys ihre Zerstoerung auf einer Anzeige
    /// versuchen, die es nicht mehr gibt.
    #[cfg(target_os = "linux")]
    pub(super) fn schliessen(&mut self) {
        self.inner.verbindung = None;
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn schliessen(&mut self) {}
}

#[cfg(target_os = "linux")]
impl Drop for WaylandZug {
    /// **Der Abbau gehoert in [`Self::schliessen`], nicht hierher** —
    /// dasselbe Netz wie `tastensperre::wayland::Gemeinsam::drop`: kommt
    /// `schliessen()` nicht zum Zug (Panik vor `App::exiting()`), wird hier
    /// lieber liegengelassen als eine Anzeige angefasst, die es nicht mehr
    /// gibt. Kostet am Prozessende eine Warteschlange und eine Handvoll
    /// Objekte — der Prozess endet ohnehin.
    fn drop(&mut self) {
        std::mem::forget(self.inner.verbindung.take());
    }
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
///
/// **`eigene_sitzung` filtert die Kandidaten** (Review I1) — dieselben zwei
/// Bedingungen wie beim Desktop-Koordinaten-Weg in `App::window_event`:
/// `aktiv()` (ein Fenster ohne Erfassung hat beim Host keinen Handschlag)
/// UND dieselbe Fernsteuerungs-Sitzung (Fensternummern/Plaetze wiederholen
/// sich zwischen Sitzungen, die Sitzungskennung nicht).
#[cfg(target_os = "linux")]
fn ziel_fuer(
    sessions: &HashMap<u64, Session>,
    eigene_sitzung: Option<&str>,
    flaeche: &wayland_backend::sys::client::ObjectId,
    x: f64,
    y: f64,
) -> Option<(u32, crate::fernsteuerung::Bildlage, f64, f64)> {
    let treffer = sessions.values().find(|s| {
        s.eingabe.aktiv()
            && s.eingabe.sitzung() == eigene_sitzung
            && flaeche_id(&s.window).as_ref() == Some(flaeche)
    })?;
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
