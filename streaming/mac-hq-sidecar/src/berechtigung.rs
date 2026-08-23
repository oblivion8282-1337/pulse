//! Berechtigungs-Auskunft: darf dieser Prozess Ereignisse einspielen — und
//! darf er mithoeren?
//!
//! **Das sind ZWEI verschiedene Freigaben, und die Fernsteuerung braucht
//! beide.** Einspielen haengt an den Bedienungshilfen, Mithoeren an der
//! „Eingabeueberwachung" (`kTCCServiceListenEvent`). Der Nutzer erteilt sie
//! getrennt, in getrennten Listen der Systemeinstellungen.
//!
//! Der gefaehrliche Fall ist der asymmetrische: **einspielen ja, mithoeren
//! nein.** Dann wirkt die Fernsteuerung, der Handschlag geht durch — und die
//! Wache, die den Vorrang des Hosts erkennen soll, bekommt keine Ereignisse.
//! Der Host tippt und bekommt seinen Rechner nicht zurueck. Genau das „still
//! etwas Schwaecheres unter demselben Etikett", das der Entwurf verbietet.
//! Gefunden bei der Pruefung am 2026-08-23; bis dahin galt die Annahme, ein
//! Abgriff scheitere ohne Bedienungshilfen-Freigabe von selbst — er scheitert
//! nicht, er bekommt nur nichts.
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

use std::ffi::{c_int, c_void};

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

// `IOHIDCheckAccess` liegt im IOKit-Framework und ist ebenfalls nicht in den
// objc2-Bindings dieser Kiste — dieselbe Selbstdeklaration wie oben.
//
// **Die beiden Aufzaehlungen sind aus dem echten Header abgeschrieben**
// (`IOKit.framework/Headers/hidsystem/IOHIDLib.h`), nicht geraten, und eine
// Reihenfolge darin ist kontraintuitiv: `kIOHIDRequestTypePostEvent` steht
// VORNE (0), `kIOHIDRequestTypeListenEvent` dahinter (1). Wer die Zahl statt
// des Namens einsetzt und dabei der naheliegenden Vermutung folgt, fragt die
// falsche Freigabe ab — und bekommt eine Antwort, die plausibel aussieht.
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOHIDCheckAccess(request_type: c_int) -> c_int;
}

const REQUEST_LISTEN_EVENT: c_int = 1;
const ACCESS_GRANTED: c_int = 0;
const ACCESS_DENIED: c_int = 1;
const ACCESS_UNKNOWN: c_int = 2;

/// Darf dieser Prozess Eingaben **mithoeren**? (`kTCCServiceListenEvent`, in
/// den Systemeinstellungen „Eingabeueberwachung")
///
/// Eine **andere** Freigabe als [`darf_einspielen`] — der Unterschied ist die
/// Sicherheitszusage der Fernsteuerung wert, s. Modulkopf.
///
/// **Fail-closed:** nur `kIOHIDAccessTypeGranted` zaehlt als ja. „Nie gefragt"
/// (`Unknown`) heisst nein, nicht vielleicht.
///
/// **Nicht als Vorbedingung eines Abgriff-Versuchs verwenden.** Solange der
/// Nutzer nie gefragt wurde, liefert die Abfrage `Unknown` — gefragt wird er
/// aber erst, wenn ein Abgriff-Versuch stattfindet. Wer hiermit vorher
/// abriegelt, baut einen Zustand, aus dem ein frisch installiertes Pulse nicht
/// herausfindet: Verweigerung ohne Dialog, ohne Eintrag in der Liste, ohne
/// Haken zum Setzen. Richtige Reihenfolge: erst den Abgriff erstellen, dann
/// hiermit pruefen und bei `false` mit klarer Meldung verweigern.
pub fn darf_mithoeren() -> bool {
    mithoeren_stand() == STAND_ERTEILT
}

/// Derselbe Wert ausfuehrlich — fuer den Gesundheitscheck und die
/// Fehlermeldung.
///
/// „Verweigert" und „nie gefragt" fuehren den Nutzer an **verschiedene**
/// Stellen: einmal einen Haken entfernen und neu setzen, einmal ueberhaupt
/// erst einen Versuch ausloesen. Ein gemeinsames „nein" verschwiege das.
///
/// `"unbekannt"` kann nur auftreten, wenn Apple die Aufzaehlung erweitert oder
/// die Aufrufkonvention nicht mehr passt — dann soll es auffallen, statt sich
/// als „nie gefragt" zu tarnen.
pub fn mithoeren_stand() -> &'static str {
    match unsafe { IOHIDCheckAccess(REQUEST_LISTEN_EVENT) } {
        ACCESS_GRANTED => STAND_ERTEILT,
        ACCESS_DENIED => "denied",
        ACCESS_UNKNOWN => "ungefragt",
        _ => "unbekannt",
    }
}

/// Der Stand, der als Ja zaehlt. Einmal benannt, weil an ihm zwei
/// Auskuenfte und die Faehigkeit haengen.
pub const STAND_ERTEILT: &str = "granted";

/// Aus den beiden Freigaben die eine Aussage: **ist dieser Rechner
/// fernsteuerbar, und wenn nein, woran liegt es?**
///
/// **Rein gerechnet, mit den Freigaben als Argumenten** — und das ist kein
/// Selbstzweck. Solange die Aussage direkt aus den FFI-Aufrufen entstand, war
/// sie nur auf einer Maschine pruefbar, auf der genau die richtige Kombination
/// von Freigaben fehlte. Nachgemessen am 2026-08-23: zwei Mutationen an der
/// Verknuepfung (das Mithoeren weglassen, die Faehigkeit fest verneinen)
/// ueberlebten jeden Test — nicht weil die Tests schlecht waren, sondern weil
/// auf dem Entwicklerrechner beide Freigaben erteilt sind. So gebaut faellt
/// jede der beiden Mutationen sofort auf.
///
/// Der Grund ist leer, solange alles erteilt ist. Fehlen **beide**, wird die
/// Bedienungshilfen-Freigabe genannt: sie ist die erste, die der Nutzer
/// setzen muss, und ohne sie ist die zweite ohnehin wirkungslos.
pub fn faehigkeit(einspielen: bool, mithoeren_stand: &str) -> (bool, String) {
    if !einspielen {
        return (false, "bedienungshilfen".to_string());
    }
    if mithoeren_stand != STAND_ERTEILT {
        return (false, format!("eingabeueberwachung:{mithoeren_stand}"));
    }
    (true, String::new())
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
        let _ = darf_mithoeren();
    }

    /// Anders als beim Wert selbst laesst sich hier etwas pruefen, das **nicht**
    /// vom Freigabe-Zustand dieser Maschine abhaengt: dass die Antwort
    /// ueberhaupt in der Aufzaehlung vorkommt, die der Header nennt. Ein
    /// `"unbekannt"` hiesse, dass die Aufrufkonvention nicht mehr passt oder
    /// Apple die Werte erweitert hat — beides soll rot werden und nicht als
    /// „nie gefragt" durchgehen.
    #[test]
    fn stand_ist_einer_der_bekannten() {
        let stand = mithoeren_stand();
        assert!(
            ["granted", "denied", "ungefragt"].contains(&stand),
            "unerwarteter Stand: {stand}"
        );
    }

    /// Alle vier Kombinationen — die Pruefung, die auf der Maschine selbst
    /// unmoeglich ist, weil dort immer nur eine Lage gilt.
    #[test]
    fn faehigkeit_verlangt_beide_freigaben() {
        assert_eq!(faehigkeit(true, STAND_ERTEILT), (true, String::new()));

        let (kann, grund) = faehigkeit(true, "denied");
        assert!(!kann, "ohne Eingabeueberwachung darf es kein Ja geben");
        assert_eq!(grund, "eingabeueberwachung:denied");

        let (kann, grund) = faehigkeit(true, "ungefragt");
        assert!(!kann, "nie gefragt ist kein Ja");
        assert_eq!(grund, "eingabeueberwachung:ungefragt");

        // Fehlt beides, fuehrt der Grund an die erste Stelle, die zu setzen ist.
        assert_eq!(faehigkeit(false, "denied"), (false, "bedienungshilfen".to_string()));
        assert_eq!(faehigkeit(false, STAND_ERTEILT), (false, "bedienungshilfen".to_string()));
    }
}
