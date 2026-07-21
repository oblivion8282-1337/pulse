//! `remote_stop` — die Remote-Control-Session beenden.
//!
//! Schaltet den Tee sofort ab (der Stream läuft unverändert weiter), schließt
//! die PeerConnection und beendet den Feed-Task. Idempotent — ohne aktive
//! Session ein No-op.

use anyhow::Result;
use serde_json::{Map, Value};

use crate::remote::RemoteController;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    RemoteController::singleton().stop_session()?;
    Ok(Map::new())
}
