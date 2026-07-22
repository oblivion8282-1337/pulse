//! Diagnose-Probe: was Windows über ein (ggf. minimiertes) Fenster meldet.
//!
//! Hintergrund: `capture/source.rs::resolve_window_or_monitor` muss zwei Fälle
//! unterscheiden, die beide `IsIconic == true` liefern:
//!
//!   a) Vollbild-Spiel, das beim Fokus-Verlust minimiert wurde → Monitor-Capture
//!      ist richtig (und zeigt das Spiel, sobald der User zurückwechselt).
//!   b) Normales kleines Fenster, das der User minimiert hat → Monitor-Capture
//!      wäre ein Privacy-Unfall (streamt den ganzen Desktop statt EINES Fensters).
//!
//! `GetWindowRect` taugt zur Unterscheidung nicht: minimierte Fenster melden
//! beide die Sonderposition ≈(-32000,-32000). `GetWindowPlacement` liefert
//! dagegen `rcNormalPosition` — das Rechteck im *wiederhergestellten* Zustand,
//! das auch während der Minimierung gültig bleibt. Diese Probe dumpt beides
//! plus die daraus berechnete Monitor-Abdeckung, damit der Schwellwert im
//! Resolver auf gemessenen Zahlen steht und nicht auf einer Vermutung.
//!
//! Aufruf (Spiel starten, in FSE wechseln, dann per Alt-Tab weg → minimiert):
//!   cargo run --release --example probe_window_placement
//!   cargo run --release --example probe_window_placement -- <titel-substring>

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, IsIconic, WINDOWPLACEMENT};
use windows_capture::window::Window;

fn main() {
    let needle = std::env::args().nth(1);
    let windows = match Window::enumerate() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("Window::enumerate fehlgeschlagen: {e}");
            return;
        }
    };

    for win in &windows {
        let Some(title) = win.title().ok().filter(|t| !t.trim().is_empty()) else {
            continue;
        };
        if let Some(n) = &needle {
            if !title.to_lowercase().contains(&n.to_lowercase()) {
                continue;
            }
        }

        let hwnd = HWND(win.as_raw_hwnd());
        let iconic = unsafe { IsIconic(hwnd) }.as_bool();
        // Nur die interessanten Fenster, wenn ohne Filter aufgerufen: alles
        // Minimierte plus alles, was einen Monitor voll abdeckt. Sonst rauscht
        // die Ausgabe mit 40 Hintergrund-Fenstern zu.
        let mon_rect = monitor_rect_for(win);
        let win_rect = win.rect().ok();
        let normal = placement_normal_rect(hwnd);
        let coverage = match (normal, mon_rect) {
            (Some(n), Some(m)) => coverage_pct(&n, &m),
            _ => -1.0,
        };
        if needle.is_none() && !iconic && coverage < 95.0 {
            continue;
        }

        println!("─── {title}");
        println!("  app            : {}", win.process_name().unwrap_or_default());
        println!("  hwnd           : {}", win.as_raw_hwnd() as isize);
        println!("  IsIconic       : {iconic}");
        println!("  GetWindowRect  : {}", fmt_rect(win_rect));
        println!("  rcNormalPos    : {}", fmt_rect(normal));
        println!("  showCmd        : {}", fmt_show_cmd(hwnd));
        println!("  Monitor-Rect   : {}", fmt_rect(mon_rect));
        println!("  Abdeckung      : {}", fmt_coverage(coverage));
        // Was `capture/source.rs::resolve_window_or_monitor` daraus machen würde.
        println!(
            "  → Resolver     : {}",
            if iconic {
                if coverage >= 98.0 {
                    "minimiert + füllt Monitor → MONITOR-Capture (+ Privacy-Maske)"
                } else {
                    "minimiert + kleines Fenster → FEHLER (bitte wiederherstellen)"
                }
            } else {
                match (win_rect, mon_rect) {
                    (Some(w), Some(m)) if !rects_overlap(&w, &m) =>
                        "off-screen (FSE) → MONITOR-Capture (+ Privacy-Maske)",
                    (Some(_), Some(_)) => "überschneidet Monitor → FENSTER-Capture",
                    _ => "Rect unbekannt → FENSTER-Capture",
                }
            }
        );
        println!();
    }
}

/// `rcNormalPosition` — Fenster-Rechteck im wiederhergestellten Zustand.
/// Bleibt gültig, während das Fenster minimiert ist; genau darum geht es hier.
fn placement_normal_rect(hwnd: HWND) -> Option<RECT> {
    let mut wp = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    unsafe { GetWindowPlacement(hwnd, &mut wp) }.ok()?;
    Some(wp.rcNormalPosition)
}

fn fmt_show_cmd(hwnd: HWND) -> String {
    let mut wp = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    if unsafe { GetWindowPlacement(hwnd, &mut wp) }.is_err() {
        return "?".into();
    }
    let n = wp.showCmd;
    let name = match n {
        0 => "SW_HIDE",
        1 => "SW_SHOWNORMAL",
        2 => "SW_SHOWMINIMIZED",
        3 => "SW_SHOWMAXIMIZED",
        7 => "SW_SHOWMINNOACTIVE",
        _ => "andere",
    };
    format!("{n} ({name})")
}

fn monitor_rect_for(win: &Window) -> Option<RECT> {
    let mut info =
        MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let hmon = unsafe { MonitorFromWindow(HWND(win.as_raw_hwnd()), MONITOR_DEFAULTTONEAREST) };
    unsafe { GetMonitorInfoW(hmon, &mut info) }
        .as_bool()
        .then_some(info.rcMonitor)
}

/// Anteil der Monitorfläche, den `win` abdeckt (0–100).
fn coverage_pct(win: &RECT, mon: &RECT) -> f64 {
    let iw = (win.right.min(mon.right) - win.left.max(mon.left)).max(0) as f64;
    let ih = (win.bottom.min(mon.bottom) - win.top.max(mon.top)).max(0) as f64;
    let mon_area = ((mon.right - mon.left) as f64) * ((mon.bottom - mon.top) as f64);
    if mon_area <= 0.0 { 0.0 } else { iw * ih / mon_area * 100.0 }
}

fn rects_overlap(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

fn fmt_rect(r: Option<RECT>) -> String {
    match r {
        Some(r) => format!(
            "{}x{} @ ({},{})",
            r.right - r.left,
            r.bottom - r.top,
            r.left,
            r.top
        ),
        None => "—".into(),
    }
}

fn fmt_coverage(pct: f64) -> String {
    if pct < 0.0 { "—".into() } else { format!("{pct:.1}% des Monitors") }
}
