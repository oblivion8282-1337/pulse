//! `keyframe` — beim naechsten Bild ein Vollbild erzeugen.
//!
//! **Wozu es das gibt.** Nach einem Paketverlust kann der Zuschauer erst wieder
//! ein Bild aufbauen, wenn ein Vollbild kommt. Bei einem Abstand von zwei
//! Sekunden sind das im schlimmsten Fall zwei Sekunden Stillstand — gemessen im
//! Hauptrepo (`verlust-2026-07-28-*.json`), und weder eine Nachlieferung noch
//! ein kuerzerer Abstand loesen das.
//!
//! Der richtige Weg waere, dass der Sender die RTCP-Anforderung des Zuschauers
//! selbst empfaengt. Das setzt einen eigenen WebRTC-Sendeweg voraus (ffmpegs
//! WHIP-Muxer hat keinen Rueckkanal zur Anwendung und kann ohnehin kein AV1).
//! Diese Operation ist die Gegenstelle dazu, von der anderen Seite her: sie
//! macht das Vollbild-auf-Zuruf verfuegbar, BEVOR der Transport dafuer gebaut
//! ist — damit die Wirkung messbar wird und der Bau auf einer Zahl steht statt
//! auf einer Erwartung.
//!
//! Unabhaengig davon nuetzlich: ein neu dazukommender Zuschauer wartet heute bis
//! zu zwei Sekunden auf sein erstes Bild.

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    crate::encode::request_keyframe();
    Ok(Map::new())
}
