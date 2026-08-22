//! Bildmarke — die laufende Bildnummer liegt gemeinsam in `pulse-bildmarke`.
//! Dieses Modul bleibt als Re-Export bestehen, damit die Aufrufstellen
//! (`crate::whip::bildmarke::…`) denen der anderen beiden Sidecars gleichen.

pub use pulse_bildmarke::*;
