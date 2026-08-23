//! `remote_input` — Eingabe-Frames der Fernsteuerung einspielen.
//!
//! Die Hülle (Aufbau, Fehlerfälle, Zustandstabelle) und ihre Tests liegen seit
//! dem 2026-08-23 plattformfrei in `pulse_fernsteuerung::huelle` — Windows,
//! macOS und der Player teilen sich dieselbe Prüfung, statt sie mehrfach zu
//! schreiben. **Nicht wieder hierher zurückkopieren.**
//!
//! Was hier bleibt: die eine Sitzung dieses Prozesses holen, die Hülle lesen
//! lassen, einen Protokollfehler in `anyhow` hüllen und die Antwortkarte
//! bauen — die einzige Stelle, die den Prozess kennt.

use anyhow::Result;
use serde_json::{Map, Value};

use crate::remote_input::sitzung;
use pulse_fernsteuerung::huelle::huelle_lesen;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let sitzung = sitzung();
    let (slot, sitzungs_id, frames) = match huelle_lesen(&params) {
        Ok(teile) => teile,
        // Über die Sitzung, nicht als blankes `Err`: ein Protokollfehler legt
        // still UND gibt frei — auch der aus der Hülle.
        Err(grund) => return Err(anyhow::anyhow!(sitzung.protokollfehler(grund))),
    };

    // Fehlt das Feld oder ist es missgeformt, gilt „kein fremder Vorrang" —
    // es kann die Eingabe nur einschränken, und eine ältere Shell schickt es
    // gar nicht erst.
    let fremder_vorrang = params.get("host_active").and_then(Value::as_bool).unwrap_or(false);
    let bericht = sitzung
        .frames(slot, sitzungs_id, &frames, fremder_vorrang)
        .map_err(|e| anyhow::anyhow!(e))?;
    let mut out = Map::new();
    out.insert("processed".to_string(), Value::from(bericht.verarbeitet));
    out.insert("state".to_string(), Value::from(bericht.zustand));
    Ok(out)
}
