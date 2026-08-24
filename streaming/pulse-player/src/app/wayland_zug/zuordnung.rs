//! Von der Flaeche, die der Compositor meldet, zum Fenster, das der Player
//! kennt — samt Umrechnung der Koordinaten.
//!
//! Abgetrennt von [`super`], weil dort der ABLAUF steht (wann ein Zug beginnt,
//! wann er endet, wer ihn traegt) und hier die Frage, WOHIN eine gemeldete
//! Lage gehoert. Beides in einer Datei lag ueber der Groessen-Grenze
//! (`PLAN.md` §12.1) — dieselbe Trennung wie `fernsteuerung::ziel` neben
//! `fernsteuerung::strom`.
//!
//! **Ganz `#[cfg(target_os = "linux")]`** (am `mod` in [`super`]): hier steht
//! nichts, was ausserhalb von Wayland einen Sinn haette — anders als bei der
//! Fassade daneben, die auf jeder Plattform ein leeres Nichtstun anbietet.

use std::collections::HashMap;

use crate::app::Session;

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
/// Vorhaben gebaut ist. (Auf dieser Maschine ist der Faktor 1,25 — die
/// Skalierung ist hier also nicht der Ausnahme-, sondern der Normalfall.)
///
/// **`eigene_sitzung` filtert die Kandidaten** (Review I1) — wie beim
/// Desktop-Koordinaten-Weg in `App::window_event`: `aktiv()` (ein Fenster ohne
/// Erfassung hat beim Host keinen Handschlag) UND dieselbe
/// Fernsteuerungs-Sitzung (Fensternummern/Plaetze wiederholen sich zwischen
/// Sitzungen, die Sitzungskennung nicht).
///
/// **Ein Unterschied zu `window_event` bleibt, und er ist gewollt** (Review
/// M-e): dort wird `eigene_sitzung` aus einer Sitzung geholt, die schon durch
/// `filter(|s| s.eingabe.aktiv())` gegangen ist; hier kommt sie ungefiltert
/// aus der Sitzung, die den Zug traegt. Folgenlos, weil ein Zug nur aus einem
/// angenommenen Druck entsteht (und der setzt `aktiv()` voraus) und weil eine
/// inzwischen abgeschaltete Sitzung `sitzung()` nicht veraendert; benannt,
/// damit niemand die beiden Stellen fuer wortgleich haelt.
pub(super) fn ziel_fuer(
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
pub(super) fn logisch_zu_physisch(logisch: f64, skalierung: f64) -> f64 {
    logisch * skalierung
}

/// Winits `wl_surface` DIESES Fensters als reine Kennung — dieselbe
/// Rekonstruktion wie `tastensperre::wayland::flaeche` und
/// `fernsteuerung::wayland::zug::flaeche`, hier ohne `Connection`: gebraucht
/// wird nur die KENNUNG zum Vergleichen, keine benutzbare `wl_surface`.
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

#[cfg(test)]
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

    /// Nicht-ganzzahlige Skalierung (125 %/150 %, in freier Wildbahn haeufig —
    /// die Entwicklungsmaschine selbst laeuft auf 1,25) muss ebenso durchgehen,
    /// nicht nur glatte Faktoren.
    #[test]
    fn bruchteilige_skalierung() {
        assert!((logisch_zu_physisch(200.0, 1.5) - 300.0).abs() < 1e-9);
        assert!((logisch_zu_physisch(406.0, 1.25) - 507.5).abs() < 1e-9);
    }

    #[test]
    fn null_bleibt_null_unabhaengig_von_der_skalierung() {
        assert_eq!(logisch_zu_physisch(0.0, 1.75), 0.0);
    }
}
