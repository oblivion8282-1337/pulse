//! Das Frame-Format der Fernsteuerung liegt seit dem 2026-08-22 gemeinsam in
//! `pulse-fernsteuerung`. Dieses Modul bleibt als Re-Export bestehen, damit die
//! Aufrufstellen (`super::rahmen::…`) unveraendert bleiben.
//!
//! **Nicht wieder hierher zurueckkopieren.** Der Sender baute die Frames
//! vorher aus eigenen Konstanten, der Empfaenger parste sie mit eigenen — und
//! kein Zwillings-Test hielt die beiden zusammen.

pub use pulse_fernsteuerung::base64::{dekodiere, kodiere};
pub use pulse_fernsteuerung::bauen::*;
pub use pulse_fernsteuerung::format::*;
