//! Ein Fehler sagt, WAS schiefging — nie, WOMIT.
//!
//! Die Ursprungsfehler von vodozemac werden bewusst nicht durchgereicht:
//! einige tragen Schluesselmaterial oder Teile des Klartexts in ihrer
//! Display-Ausgabe, und diese Ausgabe landet erfahrungsgemaess irgendwann in
//! einem Log. Wer hier `#[from]` ergaenzt, hebt diese Zusicherung auf.

use core::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum KryptoFehler {
    /// Ein Schluessel liess sich nicht lesen (falsches Format, falsche Laenge).
    SchluesselUnlesbar,
    /// Ein Umschlag liess sich nicht lesen.
    UmschlagUnlesbar,
    /// Entschluesseln schlug fehl — falsche Sitzung, oder verfaelscht.
    EntschluesselnFehlgeschlagen,
    /// Verschluesseln schlug fehl.
    VerschluesselnFehlgeschlagen,
    /// Eine Sitzung liess sich nicht aufbauen.
    SitzungsaufbauFehlgeschlagen,
    /// Eingefrorener Zustand liess sich nicht auftauen (meist falscher Schluessel).
    AuftauenFehlgeschlagen,
    /// Ein Umschlag wurde als laufende Nachricht erwartet, war aber ein
    /// Sitzungsaufbau — oder umgekehrt.
    FalscheUmschlagart,
}

impl fmt::Display for KryptoFehler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::SchluesselUnlesbar => "Schluessel unlesbar",
            Self::UmschlagUnlesbar => "Umschlag unlesbar",
            Self::EntschluesselnFehlgeschlagen => "Entschluesseln fehlgeschlagen",
            Self::VerschluesselnFehlgeschlagen => "Verschluesseln fehlgeschlagen",
            Self::SitzungsaufbauFehlgeschlagen => "Sitzungsaufbau fehlgeschlagen",
            Self::AuftauenFehlgeschlagen => "Auftauen fehlgeschlagen",
            Self::FalscheUmschlagart => "falsche Umschlagart",
        };
        f.write_str(text)
    }
}

impl std::error::Error for KryptoFehler {}
