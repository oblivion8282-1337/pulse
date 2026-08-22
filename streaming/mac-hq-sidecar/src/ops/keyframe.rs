//! `keyframe` — beim naechsten Bild ein Vollbild erzeugen.
//!
//! **Wozu es das gibt.** Nach einem Paketverlust kann der Zuschauer erst wieder
//! ein Bild aufbauen, wenn ein Vollbild kommt. Der richtige Weg ist, dass der
//! Sender die RTCP-Anforderung des Zuschauers selbst empfaengt — den gibt es
//! seit dem eigenen WHIP-Sendeweg (`crate::whip`). Diese Operation ist die
//! Gegenstelle dazu **von Hand**: sie loest dasselbe aus, ohne dass ein echter
//! Zuschauer und ein Verlustprofil zusammenkommen muessen. Genau deshalb steht
//! sie hier und nicht nur im Labor — Windows und Linux haben dieselbe Operation
//! aus demselben Grund (`ops/keyframe.rs` in beiden Sidecars).
//!
//! Ohne laufenden Stream ist sie folgenlos: `take_keyframe_request()` wird
//! beim naechsten Bild abgefragt, und ohne Stream kommt kein naechstes Bild.

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    crate::keyframe::request_keyframe();
    Ok(Map::new())
}
