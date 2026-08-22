//! `remote_input_end` — Eingabe-Sitzung schließen.
//!
//! ```jsonc
//! {"op":"remote_input_end", "id":8}
//! ```
//!
//! Antwort: `{"ok":true, "state":"ended", "released":<n>}` — `released` ist die
//! Zahl der Tasten und Knöpfe, die noch gedrückt waren und jetzt losgelassen
//! wurden.
//!
//! **Wozu es die Operation gibt.** „Alles loslassen beim Ende" braucht einen
//! Auslöser. Über den Serverweg gibt es keinen Verbindungsabbruch, an dem der
//! Sidecar das Ende erkennen könnte — die stdio-Leitung zu Electron lebt weiter,
//! egal was die Fernsteuerung tut. Also sagt es der Host ausdrücklich, sobald
//! die Sitzung endet (Beenden, Ablehnen, Gegenüber weg).
//!
//! Drei weitere Wege enden ebenfalls hier, damit keiner davon eine Taste hängen
//! lässt: ein Sitzungswechsel (neue `session_id` in `remote_input`), fail-closed,
//! und das Prozessende (`main.rs`).
//!
//! Idempotent — ohne laufende Sitzung ist es folgenlos und meldet `released: 0`.

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let freigegeben = crate::remote_input::sitzung().beenden();
    let mut out = Map::new();
    out.insert("state".to_string(), Value::from("ended"));
    out.insert("released".to_string(), Value::from(freigegeben));
    Ok(out)
}
