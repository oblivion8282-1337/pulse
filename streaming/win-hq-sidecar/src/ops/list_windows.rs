//! `list_windows` — Fenster-Enumeration für den Windows-Fenster-Picker.
//!
//! Windows-only: Linux hat keinen In-App-Picker (der Wayland-Portal-Dialog
//! wählt die Quelle beim Stream-Start). WGC hat keinen Portal-Dialog — ohne
//! diese Op kann der User nur Monitore wählen, keine einzelne App. Shape
//! (deckungsgleich mit dem Frontend-Typ `GsrWindow`):
//!
//! ```jsonc
//! {"ok": true,
//!  "windows": [{"id": 65784, "title": "Repo – Brave", "app": "brave.exe",
//!               "width": 2560, "height": 1440}, ...]}
//! ```
//!
//! `id` ist der HWND als Zahl (Windows-Handles passen auf Win64 in 32 Bit →
//! JS-sicher). Der Renderer schickt die Auswahl als `capture: "window:<id>"`
//! zurück, `start::parse_capture` löst sie via `CaptureSource::WindowByHwnd`
//! auf. `Window::enumerate` liefert nur sichtbare Top-Level-Fenster (kein
//! Tool-/Child-Window, nicht der eigene Prozess); wir filtern zusätzlich
//! Einträge mit leerem Titel raus (Hintergrund-Helfer ohne sinnvollen Namen).

use anyhow::{Result, anyhow};
use serde_json::{Map, Value, json};
use windows_capture::window::Window;

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let windows = Window::enumerate().map_err(|e| anyhow!("Window::enumerate: {e}"))?;

    let list: Vec<Value> = windows
        .iter()
        .filter_map(|w| {
            // Titel ist Pflicht für die UI — leere überspringen.
            let title = w.title().ok().filter(|t| !t.trim().is_empty())?;
            // HWND als Zahl: `as_raw_hwnd()` ist *mut c_void; der Handle-Wert
            // selbst passt auf Win64 in 32 Bit (Windows-Handle-Garantie), also
            // round-trippt er JS-sicher und zurück via `from_raw_hwnd`.
            let id = w.as_raw_hwnd() as isize as i64;
            Some(json!({
                "id": id,
                "title": title,
                // process_name() kann fehlschlagen (Zugriffsrechte) → dann
                // leerer App-Name, die UI zeigt nur den Titel.
                "app": w.process_name().unwrap_or_default(),
                "width": w.width().unwrap_or(0),
                "height": w.height().unwrap_or(0),
            }))
        })
        .collect();

    let mut out = Map::new();
    out.insert("windows".to_string(), Value::Array(list));
    Ok(out)
}
