//! `list_monitors` — Display-Enumeration für den Windows-Bildschirm-Picker.
//!
//! Windows-only: Linux hat keinen In-App-Picker (der Wayland-Portal-Dialog
//! wählt die Quelle beim Stream-Start). WGC hat keinen Portal-Dialog — ohne
//! diese Op bekäme der User immer den Primärmonitor. Shape:
//!
//! ```jsonc
//! {"ok": true,
//!  "monitors": [{"index": 1, "name": "DELL U2720Q", "primary": true,
//!                "width": 3840, "height": 2160, "refresh_hz": 60}, ...]}
//! ```
//!
//! `index` ist 1-basiert und entspricht der Position in `Monitor::enumerate()`
//! — exakt das, was `Monitor::from_index` erwartet. Der Renderer schickt die
//! Auswahl als `capture: "Monitor: <index>"` zurück, `start::parse_capture`
//! löst sie via `CaptureSource::MonitorByIndex` auf.

use anyhow::{Result, anyhow};
use serde_json::{Map, Value, json};
use windows_capture::monitor::Monitor;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let monitors = Monitor::enumerate().map_err(|e| anyhow!("Monitor::enumerate: {e}"))?;
    // `primary()` darf fehlschlagen (headless / RDP) — dann ist eben keiner als
    // primär markiert, der Renderer fällt auf den ersten Eintrag zurück.
    let primary = Monitor::primary().ok();

    let list: Vec<Value> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let index = i + 1;
            // `name()` = freundlicher EDID-Name ("DELL U2720Q"). Fällt auf den
            // GDI-Device-Namen (`\\.\DISPLAY1`) zurück, wenn die DisplayConfig-
            // API nichts liefert (manche Treiber / virtuelle Displays).
            let name = m
                .name()
                .or_else(|_| m.device_name())
                .unwrap_or_else(|_| format!("Monitor {index}"));
            json!({
                "index": index,
                "name": name,
                "primary": primary.as_ref() == Some(m),
                "width": m.width().unwrap_or(0),
                "height": m.height().unwrap_or(0),
                "refresh_hz": m.refresh_rate().unwrap_or(0),
            })
        })
        .collect();

    let mut out = Map::new();
    out.insert("monitors".to_string(), Value::Array(list));
    Ok(out)
}
