//! Maskierung von Stream-Keys — die Fassung liegt seit dem 2026-08-20
//! gemeinsam in `pulse-redact`.
//!
//! Dieses Modul bleibt als Re-Export bestehen, damit die Aufrufstellen
//! (`crate::redact::redact_url`) unveraendert bleiben. Wer die Funktion
//! aendern will, tut es in `streaming/pulse-redact/` — sie gilt fuer alle
//! drei Sidecars.

pub use pulse_redact::*;
