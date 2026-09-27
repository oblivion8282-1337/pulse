//! `clip_save` — die letzten Sekunden des SENDENDEN Stroms in eine Datei
//! sichern (ShadowPlay-Prinzip, ohne Neukodierung).
//!
//! Der Clip-Ring (`crate::clip`) laeuft immer mit, solange gesendet wird;
//! diese Operation schneidet daraus und schreibt. Der Zielpfad kommt vom
//! HAUPTPROZESS der App (Sicherheitsschichtung wie beim Player: der
//! Renderer haelt nie einen Pfad in der Hand), `seconds` ist auf die
//! Ring-Groesse gedeckelt.

use anyhow::{bail, Result};
use serde_json::{Map, Value};

use crate::clip;

pub fn handle(params: Map<String, Value>) -> Result<Map<String, Value>> {
    let Some(Value::String(path)) = params.get("path") else {
        bail!("path fehlt");
    };
    let sekunden = match params.get("seconds") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(30.0),
        _ => 30.0,
    };
    let einheiten = clip::clip_speichern(
        std::path::Path::new(path),
        sekunden.clamp(1.0, clip::RING_SECONDS as f64),
    )?;
    Ok(Map::from_iter([
        ("path".into(), Value::String(path.clone())),
        ("units".into(), Value::from(einheiten)),
    ]))
}
