//! `CaptureSource` — was capturen wir.
//!
//! Resolution: `CaptureSource` → konkrete `Monitor`/`Window` aus
//! `windows-capture` via Enum-Match. Source-Picker-UI ist Pulse's Sache, nicht
//! diese Crate.

use anyhow::{Context, Result, anyhow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::IsIconic;
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
                resolve_window_or_monitor(win, needle)
            }
            CaptureSource::WindowByHwnd(hwnd) => {
                // HWND-Bits zurück in den Pointer. `is_valid()` fängt ein
                // inzwischen geschlossenes Fenster ab (User wählte, schloss es,
                // startete dann) statt erst tief in der Capture zu crashen.
                let win = Window::from_raw_hwnd(*hwnd as usize as *mut std::ffi::c_void);
                if !win.is_valid() {
                    return Err(anyhow!("Fenster (HWND {hwnd}) existiert nicht mehr"));
                }
                resolve_window_or_monitor(win, &format!("HWND {hwnd}"))
            }
        }
    }
}

/// FSE-Fallback für Fenster-Quellen. Ein Spiel im **exklusiven Vollbild**
/// (Fullscreen Exclusive) hält sein HWND oft als winzigen Sliver weit OFF-SCREEN
/// (z. B. CS2: 158×26 bei (-21333,-21333)) — die echte Bild-Ausgabe läuft auf
/// dem Monitor, nicht über das Fenster. WGC-Fenster-Capture eines solchen
/// Slivers liefert nichts (kein Frame → Stream geht nicht live, Stop hängt).
///
/// Erkennen wir, dass das Fenster seinen Monitor **nicht mehr überschneidet**
/// (komplett off-screen) → capturere transparent den Monitor. Monitor-Capture
/// (Desktop Duplication API) übersteht exklusives Vollbild. Ein normales Fenster
/// — auch randloses Vollbild, das den Monitor voll überschneidet — bleibt auf
/// Fenster-Capture (DWM kompositet es, WGC capturet es fehlerfrei).
///
/// Bei Abfragefehlern (kein Monitor-/Fenster-Rect) → Fenster-Target (blockt nie).
fn resolve_window_or_monitor(win: Window, label: &str) -> Result<ResolvedTarget> {
    let Some(mon) = win.monitor() else {
        return Ok(ResolvedTarget::Window(win));
    };
    // Minimierte Fenster liegen bei GetWindowRect auf der (-32000,-32000)-
    // Sonderposition — ohne diesen Check griffe der offscreen-Erkennung unten
    // fälschlich der FSE-Fallback und capturete den ganzen Monitor statt des
    // Fensters (Privacy-Problem: User wollte EIN Fenster streamen).
    if unsafe { IsIconic(HWND(win.as_raw_hwnd())) }.as_bool() {
        return Err(anyhow!(
            "Das gewählte Fenster ist minimiert — bitte wiederherstellen und erneut starten"
        ));
    }
    let win_rect = win.rect().ok();
    let mon_rect = monitor_rect_for(&win);
    let offscreen = matches!((win_rect, mon_rect), (Some(w), Some(m)) if !rects_overlap(&w, &m));
    if offscreen {
        eprintln!(
            "[source] Fenster ({label}) liegt off-screen (FSE/versteckt) → capturere Monitor \
             statt Fenster (WGC kann das Fenster-Sliver nicht capturen)"
        );
        return Ok(ResolvedTarget::Monitor(mon));
    }
    Ok(ResolvedTarget::Window(win))
}

/// Monitor-Rechteck in Screen-Koordinaten (Position + Größe) via Win32.
/// `windows_capture::Monitor` liefert nur Breite/Höhe, keine Position — für den
/// Überschneidungs-Check brauchen wir die. `MONITOR_DEFAULTTONEAREST` liefert
/// immer den nächstgelegenen Monitor, auch für ein off-screen-Fenster.
fn monitor_rect_for(win: &Window) -> Option<RECT> {
    let mut info =
        MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let hmon = unsafe { MonitorFromWindow(HWND(win.as_raw_hwnd()), MONITOR_DEFAULTTONEAREST) };
    if unsafe { GetMonitorInfoW(hmon, &mut info) }.as_bool() {
        Some(info.rcMonitor)
    } else {
        None
    }
}

/// Achsenparallele Überschneidung zweier Rechtecke (Fläche > 0).
fn rects_overlap(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}
