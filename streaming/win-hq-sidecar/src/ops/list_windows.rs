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
//!               "app_display": "Brave Browser",
//!               "width": 2560, "height": 1440}, ...]}
//! ```
//!
//! `app_display` ist der lesbare Anwendungsname aus der Versions-Resource der
//! EXE (`system::app_name`) — das, was auch der Task-Manager anzeigt. Der
//! Picker stellt ihn statt des Dateinamens dar. Fehlt er (kein Versions-Block,
//! keine Rechte), lässt der Sidecar das Feld weg und das Frontend fällt auf
//! einen aufgeräumten `app` zurück.
//!
//! `id` ist der HWND als Zahl (Windows-Handles passen auf Win64 in 32 Bit →
//! JS-sicher). Der Renderer schickt die Auswahl als `capture: "window:<id>"`
//! zurück, `start::parse_capture` löst sie via `CaptureSource::WindowByHwnd`
//! auf. `Window::enumerate` liefert nur sichtbare Top-Level-Fenster (kein
//! Tool-/Child-Window, nicht der eigene Prozess); wir filtern zusätzlich
//! Einträge mit leerem Titel raus (Hintergrund-Helfer ohne sinnvollen Namen).
//!
//! `width`/`height` ist die ANGEZEIGTE Echtgröße: bei minimierten Fenstern aus
//! `rcNormalPosition` statt dem GetWindowRect-Stummel (Vollbild-Spiel nach
//! Fokus-Verlust an Pulse — s. `window_size` unten).

use anyhow::{Result, anyhow};
use serde_json::{Map, Value, json};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::UI::WindowsAndMessaging::IsIconic;
use windows_capture::window::Window;

use crate::capture::source::placement_normal_rect;
use crate::system::app_name::display_name_for_pid;

/// Ist das Fenster von DWM „cloaked" (= komponiert, aber unsichtbar)?
///
/// Windows' Shell hält eine Reihe von Hilfsfenstern, die technisch sichtbare
/// Top-Level-Fenster sind und deshalb in `Window::enumerate` landen, für den
/// User aber nicht existieren — gemessen 2026-07-22 z.B. `TextInputHost.exe`
/// („Windows-Eingabeerfahrung", volle Monitorgröße) und suspendierte
/// UWP-Apps. DWM markiert genau die als cloaked; das ist ein präziseres
/// Kriterium als eine Namensliste, die bei jedem Windows-Update veralten würde.
///
/// **Nicht** cloaked sind minimierte Fenster — wichtig, denn ein Vollbild-Spiel
/// ist beim Öffnen des Pickers aus Pulse heraus immer minimiert (s.
/// `capture/source.rs::resolve_minimized`) und muss wählbar bleiben.
///
/// Schlägt die Abfrage fehl (altes Windows, kein DWM), gilt das Fenster als
/// sichtbar — der Filter darf nie mehr wegnehmen als er sicher weiß.
fn is_cloaked(w: &Window) -> bool {
    let mut cloaked: u32 = 0;
    let ok = unsafe {
        DwmGetWindowAttribute(
            HWND(w.as_raw_hwnd()),
            DWMWA_CLOAKED,
            std::ptr::from_mut(&mut cloaked).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    ok.is_ok() && cloaked != 0
}

/// Angezeigte Fenstergröße in Pixeln.
///
/// `w.width()/height()` (GetWindowRect) ist für minimierte Fenster unbrauchbar:
/// Windows parkt die bei ≈(-32000,-32000) mit Stummelgröße (~160×32). Ein
/// Vollbild-Spiel ist beim Öffnen des Pickers aus Pulse heraus aber IMMER
/// minimiert — seine echte Größe steht nur im wiederhergestellten Rekt
/// (gleiche Quelle wie der Resolver, `capture::source::resolve_minimized`).
/// Schlägt die Abfrage fehl: 0/0 (= „unbekannt") statt einer Falschgröße —
/// Kachel-Untertitel und Auflösungs-Override-Labels behandeln 0 schon.
fn window_size(w: &Window) -> (i32, i32) {
    let hwnd = HWND(w.as_raw_hwnd());
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return placement_normal_rect(hwnd)
            .map(|r| (r.right - r.left, r.bottom - r.top))
            .unwrap_or((0, 0));
    }
    (w.width().unwrap_or(0), w.height().unwrap_or(0))
}

pub fn handle(_params: Map<String, Value>) -> Result<Map<String, Value>> {
    let windows = Window::enumerate().map_err(|e| anyhow!("Window::enumerate: {e}"))?;

    let list: Vec<Value> = windows
        .iter()
        .filter_map(|w| {
            // Titel ist Pflicht für die UI — leere überspringen.
            let title = w.title().ok().filter(|t| !t.trim().is_empty())?;
            // Unsichtbare Shell-/UWP-Hilfsfenster raushalten (s. `is_cloaked`).
            if is_cloaked(w) {
                return None;
            }
            // HWND als Zahl: `as_raw_hwnd()` ist *mut c_void; der Handle-Wert
            // selbst passt auf Win64 in 32 Bit (Windows-Handle-Garantie), also
            // round-trippt er JS-sicher und zurück via `from_raw_hwnd`.
            let id = w.as_raw_hwnd() as isize as i64;
            let (width, height) = window_size(w);
            let mut entry = json!({
                "id": id,
                "title": title,
                // process_name() kann fehlschlagen (Zugriffsrechte) → dann
                // leerer App-Name, die UI zeigt nur den Titel.
                "app": w.process_name().unwrap_or_default(),
                "width": width,
                "height": height,
            });
            // Lesbarer Name (Task-Manager-Schreibweise); nur setzen wenn
            // vorhanden — das Frontend unterscheidet „fehlt" von „leer".
            if let Some(display) = w.process_id().ok().and_then(display_name_for_pid) {
                entry["app_display"] = json!(display);
            }
            Some(entry)
        })
        .collect();

    let mut out = Map::new();
    out.insert("windows".to_string(), Value::Array(list));
    Ok(out)
}
