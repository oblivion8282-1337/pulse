//! `keyframe` — beim naechsten Bild ein Vollbild erzeugen.
//!
//! **Wozu es das gibt.** Nach einem Paketverlust kann der Zuschauer erst wieder
//! ein Bild aufbauen, wenn ein Vollbild kommt. Bei einem Abstand von zwei
//! Sekunden sind das im schlimmsten Fall zwei Sekunden Stillstand — gemessen in
//! `streaming/testbench/profiles/verlust-2026-07-28-*.json`, und weder eine
//! Nachlieferung noch ein kuerzerer Abstand loesen das.
//!
//! Der richtige Weg ist, dass der Sender die RTCP-Anforderung des Zuschauers
//! selbst empfaengt — den gibt es seit dem eigenen WHIP-Sendeweg
//! (`encode::senke`). Diese Operation ist die Gegenstelle dazu **von Hand**:
//! sie loest dasselbe aus, ohne dass ein echter Zuschauer, ein Verlustprofil
//! und der MediaMTX-Patch zusammenkommen muessen.
//!
//! Genau deshalb steht sie hier und nicht nur im Labor: die Wirkung eines
//! Vollbilds laesst sich damit messen, BEVOR die ganze Kette steht — und eine
//! Zahl schlaegt eine Erwartung.
//!
//! Ohne laufenden Stream ist sie folgenlos: der Merker wird beim naechsten
//! `start` zurueckgesetzt (s. [`crate::keyframe`]).

use anyhow::Result;
use serde_json::{Map, Value};

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    crate::keyframe::request_keyframe();
    Ok(Map::new())
}
