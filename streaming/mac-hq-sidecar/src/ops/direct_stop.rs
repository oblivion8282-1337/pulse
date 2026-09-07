//! `direct_stop` — die Direkt-Sitzung abbauen, im Wartezustand bleiben.
//!
//! Gegenstück zu `direct_offer`: PeerConnection schließen, eine bereits
//! mitlaufende Capture-/Encode-Pipeline stoppen und den Sidecar zurück nach
//! `wartend` bringen (`{"ev":"state","running":true,"state":"wartend"}`),
//! wo das nächste Angebot warten kann. Der Prozess bleibt bestehen — das
//! unterscheidet dieses Op vom generischen `stop`, der den Sidecar beendet.
//!
//! Idempotent: ohne ausgehandelte Sitzung ein Ok mit Hinweis (gleiche Haltung
//! wie `stop` ohne Stream). Ein aktiver SERVER-Stream wird sauber verweigert
//! — Stufe 1 ist exklusiv (Begruendung in `crate::direct`).

use anyhow::Result;
use serde_json::{Map, Value};

use crate::direct::sitzung;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    sitzung().stoppen()
}
