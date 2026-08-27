//! Krypto-Kern von Pulse: Gespraeche zu zweit (Olm) und Gruppen (Megolm).
//!
//! Diese Kiste kennt weder Pulse-Datenmodelle noch Netzwerk. Sie kennt
//! Identitaeten, Sitzungen und Umschlaege — mehr nicht.

pub mod fehler;
pub mod identitaet;

pub use fehler::KryptoFehler;
pub use identitaet::{Identitaet, Identitaetsschluessel};
