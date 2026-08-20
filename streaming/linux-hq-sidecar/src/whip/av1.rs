//! AV1-Teil des Sendewegs — liegt seit dem 2026-08-20 gemeinsam in
//! `pulse-whip`. Dieses Modul bleibt als Re-Export bestehen, damit die
//! Aufrufstellen (`crate::whip::av1::...`) unveraendert bleiben. Wer etwas
//! aendern will, tut es in `streaming/pulse-whip/` — es gilt fuer alle drei
//! Sidecars.

pub use pulse_whip::av1::*;
