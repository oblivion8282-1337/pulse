//! `remote_input` — Eingabe-Frames der Fernsteuerung einspielen.
//!
//! Die Huelle (Aufbau, Fehlerfaelle, Zustandstabelle) und ihre Tests liegen
//! plattformfrei in `pulse_fernsteuerung::huelle` — Windows, macOS und der
//! Player teilen sich dieselbe Pruefung. **Nicht hierher kopieren:** darin
//! stecken zwei Fehler, die im Projekt schon einmal passiert sind (`slot: "0"`
//! lief still auf Platz 0; kaputtes Base64 legte die Sitzung nicht still).
//!
//! Was hier bleibt: die eine Sitzung dieses Prozesses holen, die Huelle lesen
//! lassen, einen Protokollfehler in `anyhow` huellen und die Antwortkarte
//! bauen — die einzige Stelle, die den Prozess kennt.

use anyhow::Result;
use serde_json::{Map, Value};

use crate::remote_input::sitzung;
use pulse_fernsteuerung::huelle::huelle_lesen;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let sitzung = sitzung();
    let (slot, sitzungs_id, frames) = match huelle_lesen(&params) {
        Ok(teile) => teile,
        // Ueber die Sitzung, nicht als blankes `Err`: ein Protokollfehler legt
        // still UND gibt frei — auch der aus der Huelle.
        Err(grund) => return Err(anyhow::anyhow!(sitzung.protokollfehler(grund))),
    };

    // Fehlt das Feld oder ist es missgeformt, gilt „kein fremder Vorrang" — es
    // kann die Eingabe nur einschraenken, und eine aeltere Shell schickt es gar
    // nicht erst.
    let fremder_vorrang = params.get("host_active").and_then(Value::as_bool).unwrap_or(false);
    let bericht = sitzung
        .frames(slot, sitzungs_id, &frames, fremder_vorrang)
        .map_err(|e| anyhow::anyhow!(e))?;
    let mut out = Map::new();
    out.insert("processed".to_string(), Value::from(bericht.verarbeitet));
    out.insert("state".to_string(), Value::from(bericht.zustand));
    Ok(out)
}

#[cfg(test)]
#[path = "remote_input_tests.rs"]
mod remote_input_tests;
