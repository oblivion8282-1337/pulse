//! `remote_start` — eine Remote-Control-Session (Modus A) starten.
//!
//! Additiv zum laufenden Stream: der Tee im Encoder beginnt, den H.264-Bitstrom
//! zusätzlich in die WebRTC-Session zu füttern. Params tragen die ICE/TURN-
//! Server (`ice_servers`, WebRTC-`RTCIceServer`-Shape). Antwort ist leer; das
//! Signaling (`offer`/`answer`/`ice`) läuft danach über `remote_signal` +
//! `remote_signal`/`remote_state`-Events.

use anyhow::{Result, anyhow};
use serde_json::{Map, Value};

use crate::remote::RemoteController;
use crate::stream_controller::active_stream_is_h264;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    // Der WebRTC-Track ist hart auf H.264 verhandelt (pulse-remote-webrtc). Ein
    // HEVC/AV1-Stream würde beim Controller als kaputtes Bild ankommen — hier
    // ablehnen, statt still Müll zu teen. Kein aktiver Stream → ebenfalls Fehler
    // (Modus A teet einen LAUFENDEN Stream).
    if !active_stream_is_h264() {
        return Err(anyhow!(
            "remote_start: Fernsteuerung braucht einen laufenden H.264-Stream"
        ));
    }
    RemoteController::singleton().start_session(&params)?;
    Ok(Map::new())
}
