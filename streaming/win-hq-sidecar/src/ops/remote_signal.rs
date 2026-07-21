//! `remote_signal` — einen Signaling-Frame vom Controller einspeisen.
//!
//! `{kind, data}`: `kind = "offer"` → Answer wird als `remote_signal`-Event
//! (kind `"answer"`) emittiert; `kind = "ice"` → Remote-Kandidat wird der
//! Session hinzugefügt. Lokale ICE-Kandidaten fließen umgekehrt asynchron über
//! `remote_signal`-Events (kind `"ice"`) raus (Trickle-ICE).

use anyhow::{Result, anyhow};
use serde_json::{Map, Value};

use crate::remote::RemoteController;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("remote_signal: 'kind' ist Pflicht"))?;
    let data = params
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("remote_signal: 'data' ist Pflicht"))?;
    RemoteController::singleton().handle_signal(kind, data)?;
    Ok(Map::new())
}
