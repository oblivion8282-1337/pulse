//! Die Uebersetzung der winit-Typen in die Zahlen der Leitung.
//!
//! Getrennt von [`super`], weil das reine Zuordnungen sind — keine kennt
//! den Zustand der Erfassung, und jede ist fuer sich pruefbar. Die
//! Vorzeichen des Rades sind der Grund, warum es diese Datei ueberhaupt
//! gibt: sie stimmen NICHT mit denen der Browser-Fassung ueberein, und das
//! faellt beim Lesen nicht auf.

use winit::event::{MouseButton, MouseScrollDelta};

use super::rahmen::Knopf;

/// winit-Knopf -> Knopf der Leitung. `Other` faellt weg: ein unbekannter Knopf
/// beendet beim Host die Sitzung, also wird er gar nicht erst gesendet.
pub(super) fn knopf_von_winit(button: MouseButton) -> Option<Knopf> {
    match button {
        MouseButton::Left => Some(Knopf::Links),
        MouseButton::Right => Some(Knopf::Rechts),
        MouseButton::Middle => Some(Knopf::Mitte),
        MouseButton::Back => Some(Knopf::X1),
        MouseButton::Forward => Some(Knopf::X2),
        MouseButton::Other(_) => None,
    }
}

pub(super) fn knopf_aus_nummer(nummer: u8) -> Option<Knopf> {
    match nummer {
        0 => Some(Knopf::Links),
        1 => Some(Knopf::Rechts),
        2 => Some(Knopf::Mitte),
        3 => Some(Knopf::X1),
        4 => Some(Knopf::X2),
        _ => None,
    }
}

/// winit-Radbewegung -> Zeilen in Windows-Vorzeichen `(senkrecht, waagerecht)`.
///
/// **Zeilen, nicht Rasten.** Gerundet wird erst im [`super::rahmen::Rastensammler`],
/// weil das nur mit dem Rest der vorigen Ereignisse richtig geht: hier
/// aufgerundet wurde aus jedem 0,33-Schritt eines Praezisions-Touchpads eine
/// volle Raste (s. dort).
///
/// **Die Vorzeichen sind nicht dieselben wie im Browser.** winit: positive Werte
/// heissen „der Inhalt soll sich nach rechts und unten bewegen". Windows:
/// `dv > 0` heisst „vom Nutzer weg gedreht" — das bewegt den Inhalt ebenfalls
/// nach unten, also **stimmt die senkrechte Achse ueberein**. Waagerecht
/// dagegen heisst `MOUSEEVENTF_HWHEEL > 0` „nach rechts gekippt", und das
/// schiebt den Inhalt nach LINKS — dort muss das Vorzeichen also gedreht
/// werden. (Die Browser-Fassung dreht genau umgekehrt, weil `deltaY > 0` dort
/// „nach unten gescrollt" heisst.)
///
/// Pixel (Touchpad) werden mit rund 100 px je Raste in Zeilen umgerechnet — die
/// Naeherung, die Chromium fuer dieselbe Umrechnung benutzt.
pub(super) fn rad_von_winit(delta: MouseScrollDelta) -> (f64, f64) {
    let (waagerecht, senkrecht) = match delta {
        MouseScrollDelta::LineDelta(x, y) => (f64::from(x), f64::from(y)),
        MouseScrollDelta::PixelDelta(p) => (p.x / 100.0, p.y / 100.0),
    };
    (senkrecht, -waagerecht)
}
