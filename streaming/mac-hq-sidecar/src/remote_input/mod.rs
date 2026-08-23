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
//!
//! [`wache`] steht auf derselben Seite wie [`injektion`]: sie haengt an einem
//! systemweiten Ereignis-Abgriff und stellt im Testbau keinen auf. Was an ihr
//! rein ist — die Bewegungsschwelle, die Fristrechnung — liegt schon in
//! `pulse-fernsteuerung` und wird dort geprueft; ihre Wirkung am echten System
//! belegt `examples/probe_wache.rs` (samt Gegenprobe, denn eine Wache, die
//! nichts sieht, ist ebenso still wie eine, die richtig filtert).

pub mod abbildung;
pub mod injektion;
pub mod klickzaehler;
pub mod tasten;
pub mod wache;
pub mod ziel;
