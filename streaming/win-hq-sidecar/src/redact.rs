//! Maskierung von Stream-Keys — die Fassung liegt seit dem 2026-08-20
//! gemeinsam in `pulse-redact`.
//!
//! Dieses Modul bleibt als Re-Export bestehen, damit die Aufrufstellen
//! unveraendert bleiben. Wer die Funktion aendern will, tut es in
//! `streaming/pulse-redact/` — sie gilt fuer alle drei Sidecars.

pub use pulse_redact::*;

/// Der alte Name dieser Funktion unter Windows.
///
/// Bleibt bestehen, weil `../win-hq-labor` ihn an drei Stellen benutzt
/// (`pulse_win_hq_sidecar::redact::secrets`). Das Labor gehoert nicht zum
/// Auslieferumfang und soll fuer diesen Umbau nicht angefasst werden muessen.
pub fn secrets(s: &str) -> String {
    redact_url(s)
}
