//! `list_windows` — capturable on-screen windows for the source picker.
//!
//! Shape: `{ok, windows: [{id, title, app, width, height}, ...]}`. `id` is the
//! CoreGraphics window id; the renderer sends it back as the
//! `capture: "window:<id>"` token, which `start::parse_window_id` resolves to a
//! desktop-independent `SCContentFilter`. Missing Screen-Recording permission
//! degrades to an empty list rather than failing the op.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::capture;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let windows = capture::list_capture_windows().unwrap_or_else(|e| {
        eprintln!("[mac-hq-sidecar] list_windows failed: {e:#}");
        Vec::new()
    });
    let list: Vec<Value> = windows
        .into_iter()
        .map(|w| {
            json!({
                "id": w.window_id,
                "title": w.title,
                "app": w.app,
                "width": w.width,
                "height": w.height,
            })
        })
        .collect();

    let mut out = Map::new();
    out.insert("windows".to_string(), Value::Array(list));
    Ok(out)
}
