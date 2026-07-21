//! Pulse Remote-Control — Windows-Input-PoC (M0).
//!
//! Beweist die kniffligste Stelle der Fernsteuerung: Maus-Injection über
//! `SendInput`, die auf einem **Multi-Monitor-Setup mit gemischter DPI**
//! (z.B. Monitor 1 = 125 %, Monitor 2 = 100 %) auf JEDEM Monitor exakt trifft.
//!
//! Zwei bekannte Fallen, beide hier korrekt gelöst:
//!   1. `MOUSEEVENTF_VIRTUALDESK` — ohne dieses Flag mappt Windows die
//!      absoluten 0..65535-Koordinaten nur auf den PRIMÄRmonitor; Klicks auf
//!      dem Zweitmonitor landen falsch.
//!   2. Per-Monitor-DPI-Awareness (`PER_MONITOR_AWARE_V2`) — ohne sie liefern
//!      die Koordinaten-APIs bei gemischter Skalierung virtualisierte
//!      (skalierte) Werte → systematischer Klick-Versatz.
//!
//! Selbstverifizierend: setzt den Cursor auf die Mitte jedes Monitors und
//! liest per `GetCursorPos` zurück, ob er dort gelandet ist. Kein zweiter
//! Rechner nötig.
//!
//! Bauen/Starten auf Windows:  `cargo run --release`

use std::{thread, time::Duration};

use windows::core::BOOL;
use windows::Win32::Foundation::{LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetProcessDpiAwarenessContext,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

struct Monitor {
    rect: RECT,
    dpi: u32,
    primary: bool,
}

/// Grenzen des virtuellen Desktops (alle Monitore zusammen), in physischen Pixeln.
struct VirtualDesktop {
    x: i32,
    y: i32,
    cx: i32,
    cy: i32,
}

fn virtual_desktop() -> VirtualDesktop {
    // SetProcessDpiAwarenessContext lief bereits → diese Werte sind physisch.
    unsafe {
        VirtualDesktop {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            cx: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            cy: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

extern "system" fn collect_monitor(
    hmon: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let monitors = unsafe { &mut *(lparam.0 as *mut Vec<Monitor>) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetMonitorInfoW(hmon, &mut info) };
    if ok.as_bool() {
        let mut dpi_x = 96u32;
        let mut dpi_y = 96u32;
        // Effektive DPI dieses Monitors (96 = 100 %). Fehler → Default 96.
        let _ = unsafe { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
        monitors.push(Monitor {
            rect: info.rcMonitor,
            dpi: dpi_x,
            primary: (info.dwFlags & 1) != 0, // MONITORINFOF_PRIMARY
        });
    }
    BOOL(1) // weiter aufzählen (TRUE)
}

fn enumerate_monitors() -> Vec<Monitor> {
    let mut monitors: Vec<Monitor> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }
    monitors
}

/// Cursor an eine absolute Position (physische Pixel) über den GESAMTEN
/// virtuellen Desktop setzen. Normierung auf 0..65535 mit VIRTUALDESK-Flag.
fn move_absolute(x: i32, y: i32, vd: &VirtualDesktop) {
    // Normieren relativ zum virtuellen Desktop, nicht zum Primärmonitor.
    let nx = ((x - vd.x) as i64 * 65535 / (vd.cx - 1).max(1) as i64) as i32;
    let ny = ((y - vd.y) as i64 * 65535 / (vd.cy - 1).max(1) as i64) as i32;
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: nx,
                dy: ny,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}

fn click() {
    let flags = [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP];
    for f in flags {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: f,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }
}

fn cursor_pos() -> (i32, i32) {
    let mut p = POINT::default();
    let _ = unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

fn main() {
    // MUSS als Erstes laufen — sonst sind alle folgenden Koordinaten skaliert.
    let dpi_ok = unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_ok()
    };

    let vd = virtual_desktop();
    let monitors = enumerate_monitors();

    println!("== Pulse Windows-Input-PoC ==");
    println!(
        "Per-Monitor-DPI-Awareness gesetzt: {}",
        if dpi_ok { "ja" } else { "NEIN (Fallback)" }
    );
    println!(
        "Virtueller Desktop: Ursprung ({}, {}), Größe {}x{} px\n",
        vd.x, vd.y, vd.cx, vd.cy
    );

    if monitors.is_empty() {
        println!("Keine Monitore gefunden.");
        return;
    }

    println!("Setze den Cursor nacheinander in die Mitte jedes Monitors:\n");
    let mut worst = 0i32;
    for (i, m) in monitors.iter().enumerate() {
        let target_x = (m.rect.left + m.rect.right) / 2;
        let target_y = (m.rect.top + m.rect.bottom) / 2;
        move_absolute(target_x, target_y, &vd);
        thread::sleep(Duration::from_millis(120));
        let (ax, ay) = cursor_pos();
        let dx = (ax - target_x).abs();
        let dy = (ay - target_y).abs();
        let delta = dx.max(dy);
        worst = worst.max(delta);
        let scale = m.dpi as f64 / 96.0 * 100.0;
        println!(
            "Monitor {}{}  DPI {:.0}%  Ziel ({},{})  Ist ({},{})  Δ {} px  {}",
            i + 1,
            if m.primary { " [Primär]" } else { "        " },
            scale,
            target_x,
            target_y,
            ax,
            ay,
            delta,
            if delta <= 2 { "OK" } else { "FAIL" },
        );
    }

    println!(
        "\nGrößte Abweichung über alle Monitore: {} px  →  {}",
        worst,
        if worst <= 2 {
            "Injektion trifft auf allen Monitoren präzise (auch bei gemischter DPI)."
        } else {
            "ABWEICHUNG — Fallen prüfen (VIRTUALDESK-Flag? DPI-Awareness?)."
        }
    );

    // Optional-Demo: 5 s Countdown, dann Linksklick am aktuellen Punkt.
    // (Tastatur-Injection ist Layout-/Scancode-Thema — bewusst separat.)
    println!("\nIn 5 s ein Linksklick auf dem zuletzt gesetzten Punkt (Ctrl+C zum Abbrechen)…");
    thread::sleep(Duration::from_secs(5));
    click();
    println!("Klick gesendet.");
}
