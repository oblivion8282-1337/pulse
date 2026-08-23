//! Fernsteuerung, macOS-Haelfte.
//!
//! Der plattformfreie Kern (Frame-Format, Sitzungs-Zustandsmaschine,
//! Klemmrechnung, Bewegungsschwelle) liegt in `pulse-fernsteuerung` — siehe
//! `streaming/win-hq-sidecar/src/remote_input/mod.rs` fuer die erste
//! Anbindung. Hier beginnt der zweite Host mit dem einen Stueck, das nur
//! macOS kennt: [`tasten`] uebersetzt die Windows-Scancodes der Leitung
//! (Satz 1) auf die Carbon-Virtualcodes (`kVK_*`), die `CGEvent` fuer die
//! Tasteninjektion braucht.

pub mod tasten;
