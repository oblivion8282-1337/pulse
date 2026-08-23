//! Fernsteuerung, macOS-Haelfte.
//!
//! Der plattformfreie Kern (Frame-Format, Sitzungs-Zustandsmaschine,
//! Klemmrechnung, Bewegungsschwelle) liegt in `pulse-fernsteuerung` — siehe
//! `streaming/win-hq-sidecar/src/remote_input/mod.rs` fuer die erste
//! Anbindung. Hier beginnt der zweite Host mit dem einen Stueck, das nur
//! macOS kennt.
//!
//! **Der Schnitt laeuft zwischen Rechnung und Wirkung**, und zwar mit Absicht:
//! [`tasten`] (Scancode Satz 1 -> `kVK_*`), [`abbildung`] (Frame-Bestandteil ->
//! CoreGraphics-Ereignistyp, Knopfnummer, Kennzeichnung, Zeilen) und
//! [`klickzaehler`] (der wievielte Klick) sind rein und stehen in Unit-Tests;
//! [`injektion`] feuert ab und laesst sich nur an einem echten Ziel abnehmen —
//! dafuer gibt es den Pruefling `examples/probe_injektor/`.

pub mod abbildung;
pub mod injektion;
pub mod klickzaehler;
pub mod tasten;
