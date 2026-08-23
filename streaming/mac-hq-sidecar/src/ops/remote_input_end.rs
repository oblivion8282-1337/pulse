//! `remote_input_end` — Eingabe-Sitzung schliessen.
//!
//! ```jsonc
//! {"op":"remote_input_end", "id":8}
//! ```
//!
//! Antwort: `{"ok":true, "state":"ended", "released":<n>}` — `released` ist die
//! Zahl der Tasten und Knoepfe, die noch gedrueckt waren und jetzt losgelassen
//! wurden.
//!
//! **Wozu es die Operation gibt.** „Alles loslassen beim Ende" braucht einen
//! Ausloeser. Ueber den Serverweg gibt es keinen Verbindungsabbruch, an dem der
//! Sidecar das Ende erkennen koennte — die stdio-Leitung zu Electron lebt
//! weiter, egal was die Fernsteuerung tut. Also sagt es der Host ausdruecklich,
//! sobald die Sitzung endet (Beenden, Ablehnen, Gegenueber weg).
//!
//! Drei weitere Wege enden ebenfalls hier, damit keiner davon eine Taste haengen
//! laesst: ein Sitzungswechsel (neue `session_id` in `remote_input`),
//! fail-closed, und das Prozessende (`main.rs`).
//!
//! Idempotent — ohne laufende Sitzung folgenlos, meldet `released: 0`.

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let freigegeben = crate::remote_input::sitzung().beenden();
    let mut out = Map::new();
    out.insert("state".to_string(), Value::from("ended"));
    out.insert("released".to_string(), Value::from(freigegeben));
    Ok(out)
}
