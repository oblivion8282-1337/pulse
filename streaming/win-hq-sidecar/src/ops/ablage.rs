//! `ablage` — ein Wert der geteilten Zwischenablage.
//!
//! ```jsonc
//! {"op":"ablage", "id":9, "params":{"data":{"rahmen":{"t":"neu","gen":1,"typ":"text"}}}}
//! {"op":"ablage", "id":9, "params":{"data":{"anstoss":"beginn"}}}
//! ```
//!
//! Antwort: `{"ok":true}`. Die Rahmen, die daraufhin hinausgehen, kommen
//! **nicht** als Antwort zurueck, sondern als Ereignisse (`{"ev":"ablage",…}`)
//! — sie entstehen zum Teil erst Takte spaeter (ein `hol` wird beantwortet,
//! sobald der Lesevorgang durch ist).
//!
//! **Diese Datei deutet den Wert nicht.** Das Format lebt an genau einer
//! Stelle im Baum (`streaming/pulse-ablage`), und eine zweite Fassung hier
//! liefe auseinander — dieselbe Linie wie „der Gateway parst Frames nicht" und
//! wie bei `remote_input`, dessen Huelle ebenfalls plattformfrei liegt.
//!
//! Ein unbrauchbarer Wert ist **kein Fehler der Operation**: er wird still
//! verworfen (`Entscheidung::Verwerfen`). Ein Ablage-Rahmen ist es nicht wert,
//! eine Fernsteuerungs-Sitzung dafuer zu beenden — anders als bei
//! `remote_input`, wo ein Protokollfehler fail-closed alles stilllegt, kostet
//! ein verworfener Rahmen hier ein Einfuegen.

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let data = params.get("data").ok_or_else(|| anyhow::anyhow!("data fehlt"))?;
    crate::ablage::verarbeiten(data);
    Ok(Map::new())
}
