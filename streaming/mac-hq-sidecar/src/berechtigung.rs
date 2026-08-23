//! Berechtigungs-Auskunft: darf dieser Prozess Ereignisse einspielen?
//!
//! `CGEventPost` tut auf macOS ohne Bedienungshilfen-Freigabe **wortlos
//! nichts** — kein Fehler, keine Meldung, die Ereignisse verschwinden. Der
//! Sidecar muss deshalb ehrlich melden, ob er einspielen kann, statt es zu
//! behaupten (`ops::health`, Feld `remote_input`).
//!
//! **Kein eigener Eintrag noetig:** gemessen
//! (`docs/plans/2026-08-23-macos-eingabe-messungen.md`, Messung 1), erbt ein
//! Kindprozess die Freigabe des Programms, das es startet — der Sidecar erbt
//! Pulses Freigabe, ohne selbst in der Bedienungshilfen-Liste zu erscheinen.
//! Genau deshalb ist die Abfrage hier trotzdem sinnvoll: sie prueft, was fuer
//! GENAU DIESEN Prozess gilt, nicht was Pulse allgemein zugesagt wurde.

use std::ffi::c_void;

// `ApplicationServices` ist nicht Teil der objc2-Framework-Bindings dieser
// Kiste (siehe Cargo.toml — nur `objc2-core-graphics` mit `CGDirectDisplay`
// ist eingebunden). Die Funktion wird deshalb selbst deklariert und das
// Framework explizit verlinkt — dasselbe Muster, das `capture/mod.rs` schon
// fuer `CFRelease` und `getppid` benutzt.
//
// `Boolean` ist auf macOS `unsigned char` (0 oder 1), nicht Rusts `bool` —
// der Rueckgabewert kommt deshalb als `u8` herein und wird erst in
// [`darf_einspielen`] umgerechnet, statt sich auf eine zufaellig passende
// ABI-Deckungsgleichheit zu verlassen.
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
}

/// Ob dieser Prozess (der Sidecar) Ereignisse per `CGEventPost` einspielen
/// darf — die Bedienungshilfen-Freigabe fuer Accessibility.
///
/// **Ohne Systemdialog, garantiert:** `options = NULL` entspricht laut Apples
/// Dokumentation zu `kAXTrustedCheckOptionPrompt` genau dem Fall, dass dieser
/// Schluessel fehlt — und dessen Vorgabe ist `false` ("By default, in the
/// absence of this key, the user is not prompted."). Ein Sidecar, der beim
/// Gesundheitscheck ungefragt einen Berechtigungsdialog aufwirft, waere eine
/// Zumutung; der Anstoss dazu gehoert in den Electron-Hauptprozess (spaetere
/// Aufgabe), NIEMALS hierher.
///
/// **Warum live geprueft und nicht wie unter Windows fest behauptet:** dort
/// gehoert das Op zum Programm selbst, die Aussage `true` ist also nicht
/// geraten. Auf dem Mac waere dasselbe falsch — die Freigabe kann der Nutzer
/// jederzeit zurueckziehen, und sie haengt zusaetzlich an der Code-Signatur
/// (das mac-DMG ist nur ad-hoc signiert), faellt also auch bei jedem Update
/// weg. Ein festes `true` liesse einen Mac als fernsteuerbar erscheinen,
/// dessen zugesagte Sitzung beim allerersten Frame wortlos stuerbe.
pub fn darf_einspielen() -> bool {
    unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) != 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Rueckgabewert haengt am Freigabe-Zustand DIESER Maschine — ein
    /// Test darauf waere eine Wette auf die Entwicklermaschine, keine
    /// Pruefung des Codes (mal gruen, mal rot, je nachdem wer den Bau faehrt
    /// und was in dessen Bedienungshilfen-Liste steht). Geprueft wird deshalb
    /// nur, dass der FFI-Aufruf ueberhaupt zustande kommt — Framework
    /// verlinkt, Aufrufkonvention stimmt, kein Absturz — nicht WAS er
    /// liefert. Der Wert selbst bleibt bewusst ungeprueft.
    #[test]
    fn ruft_ohne_abzustuerzen() {
        let _ = darf_einspielen();
    }
}
