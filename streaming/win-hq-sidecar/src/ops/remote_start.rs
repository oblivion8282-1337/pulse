//! `remote_start` — eine Remote-Control-Session (Modus A) starten.
//!
//! Additiv zum laufenden Stream: der Tee im Encoder beginnt, den H.264-Bitstrom
//! zusätzlich in die WebRTC-Session zu füttern. Params tragen die ICE/TURN-
//! Server (`ice_servers`, WebRTC-`RTCIceServer`-Shape). Antwort ist leer; das
//! Signaling (`offer`/`answer`/`ice`) läuft danach über `remote_signal` +
//! `remote_signal`/`remote_state`-Events.

use anyhow::Result;
use serde_json::{Map, Value};

use crate::remote::RemoteController;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    RemoteController::singleton().start_session(&params)?;
    Ok(Map::new())
}
