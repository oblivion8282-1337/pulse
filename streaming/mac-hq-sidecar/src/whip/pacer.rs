//! Paket-Verteilung — liegt seit dem 2026-08-22 gemeinsam in
//! `pulse-whip::pacer`. Dieses Modul bleibt als Re-Export bestehen, damit die
//! Aufrufstellen unveraendert bleiben.
//!
//! Die frueheren beiden Fassungen (Linux und macOS) rechneten Zeichen fuer
//! Zeichen gleich und unterschieden sich nur darin, wohin die Soll/Ist-Zeile
//! ging. Dafuer nimmt `Pacer::start` jetzt einen [`Melder`] entgegen.
//!
//! **Der Windows-Sidecar hat weiterhin seinen eigenen** — dort ist der
//! Zuschnitt des Sendefensters absichtlich anders, und welcher besser ist,
//! ist nicht gemessen. Begruendung im Modulkopf der gemeinsamen Fassung.

pub use pulse_whip::pacer::*;
