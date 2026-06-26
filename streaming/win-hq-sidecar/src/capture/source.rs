//! `CaptureSource` — was capturen wir.
//!
//! Resolution: `CaptureSource` → konkrete `Monitor`/`Window` aus
//! `windows-capture` via Enum-Match. Source-Picker-UI ist Pulse's Sache, nicht
//! diese Crate.

use anyhow::{Context, Result, anyhow};
use windows_capture::monitor::Monitor;
use windows_capture::window::Window;

/// Was gecaptured werden soll. Wire-kompatibel mit der GSR-Linux-Form
/// (`"portal"`/`"window"`/`"monitor"` als String) — Übersetzung in den
/// JSON-Layer (`start`/`build_argv`).
#[derive(Debug, Clone)]
pub enum CaptureSource {
    /// Primärer Monitor (= Windows-Default-Display).
    PrimaryMonitor,
    /// Monitor per 1-basiertem Index (Index 1 = primary, falls von Windows so
    /// sortiert — sonst irgendein verbundener Bildschirm).
    MonitorByIndex(usize),
    /// Erstes Fenster dessen Title das Substring matcht (case-sensitiv).
    WindowByTitle(String),
    /// Fenster per HWND (als Zahl aus dem `list_windows`-Picker). Eindeutiger
    /// als der Titel-Match, wenn mehrere Fenster denselben Titel teilen.
    WindowByHwnd(i64),
}

/// Aufgelöstes Capture-Target — entweder Monitor oder Window.
///
/// Beide implementieren `windows_capture::settings::Settings::new`-input, aber
/// die konkreten Typen sind unterschiedlich. `Settings::new` ist generic über
/// das Item; wir branchen am Call-Site.
#[derive(Debug)]
pub enum ResolvedTarget {
    Monitor(Monitor),
    Window(Window),
}

impl CaptureSource {
    pub fn resolve(&self) -> Result<ResolvedTarget> {
        match self {
            CaptureSource::PrimaryMonitor => Ok(ResolvedTarget::Monitor(
                Monitor::primary().context("Monitor::primary failed")?,
            )),
            CaptureSource::MonitorByIndex(idx) => {
                let monitor =
                    Monitor::from_index(*idx).map_err(|e| anyhow!("Monitor::from_index({idx}): {e}"))?;
                Ok(ResolvedTarget::Monitor(monitor))
            }
            CaptureSource::WindowByTitle(needle) => {
                // `Window::from_contains_name` matcht eine Substring; perfekt
                // für Pulse-UI wo der User "Brave" oder "VS Code" eingeben kann.
                let win = Window::from_contains_name(needle)
                    .map_err(|e| anyhow!("Window::from_contains_name({needle:?}): {e}"))?;
                Ok(ResolvedTarget::Window(win))
            }
            CaptureSource::WindowByHwnd(hwnd) => {
                // HWND-Bits zurück in den Pointer. `is_valid()` fängt ein
                // inzwischen geschlossenes Fenster ab (User wählte, schloss es,
                // startete dann) statt erst tief in der Capture zu crashen.
                let win = Window::from_raw_hwnd(*hwnd as usize as *mut std::ffi::c_void);
                if !win.is_valid() {
                    return Err(anyhow!("Fenster (HWND {hwnd}) existiert nicht mehr"));
                }
                Ok(ResolvedTarget::Window(win))
            }
        }
    }
}
