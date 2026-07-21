//! Frame-Capture-Pipeline (Stage 5).
//!
//! Zwei Pfade aus `windows-capture` v2:
//!
//! - **WGC** (`wgc.rs`) — Windows Graphics Capture, primärer Pfad. Win10 1903+;
//!   sieht Game-Fenster + Desktop, kein Border-Flicker auf Win11. Per-Window
//!   und Per-Monitor.
//! - **DXGI-DDA** (`dxgi_dda.rs`, später) — Desktop Duplication API als Fallback.
//!   Nur Per-Monitor, älter, robuster auf Random-Edge-Cases (Hyper-V,
//!   bestimmte HDR-Modi). Nicht im Day-3-Spike.
//!
//! Eingangs-Quelle wird per `CaptureSource` ausgewählt — die UI in Pulse weiß
//! das schon, der Picker-Dialog aus `windows-capture::graphics_capture_picker`
//! wird *nicht* benutzt.

pub mod source;
pub mod wgc;
pub mod wgc_d3d12;
pub mod wgc_hw;

pub use source::CaptureSource;
pub use wgc_d3d12::{D3d12CaptureItem, WgcD3d12Capture};
pub use wgc_hw::{HwCaptureItem, WgcHwCapture};

use windows::Foundation::Metadata::ApiInformation;
use windows::core::HSTRING;
use windows_capture::settings::{
    CursorCaptureSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
};

/// Zeitlimit fürs Joinen eines Capture-Workers beim Stoppen.
const JOIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Capture-Worker auslaufen lassen — mit Zeitlimit, danach **detachen**.
///
/// Der Worker sieht sein Stop-Signal nur in `on_frame_arrived`. Liefert WGC nie
/// einen Frame (totes oder minimiertes Target, verweigerte Permission,
/// HDR-Edge-Case), kommt der Callback nie dran und ein unbegrenztes `join()`
/// wartet für immer. Das traf ausgerechnet den Fehlerpfad: die Pipelines geben
/// nach 5 s ohne ersten Frame auf und droppen die Capture — der Drop blockierte
/// dann genau in der Situation, die der Timeout eigentlich melden soll, und die
/// fertige Fehlermeldung erreichte den Renderer nie.
///
/// Nach Ablauf lassen wir den Thread laufen: der Per-Stream-Sidecar endet
/// ohnehin gleich, `ExitProcess` räumt ihn ab (gleiche Überlegung wie der
/// bewusst unterlassene Teardown in `pipeline_hw::run`).
pub(crate) fn join_or_detach(handle: std::thread::JoinHandle<Result<(), String>>, label: &str) {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    if std::thread::Builder::new()
        .name("capture-joiner".into())
        .spawn(move || {
            let _ = handle.join();
            let _ = done_tx.send(());
        })
        .is_err()
    {
        // Kein Thread frei — nicht warten. `handle` ist mit der Closure
        // gedroppt, der Worker läuft damit detached weiter.
        return;
    }
    if done_rx.recv_timeout(JOIN_TIMEOUT).is_err() {
        eprintln!("[capture] {label}: Worker nach {JOIN_TIMEOUT:?} nicht beendet — detached");
    }
}

/// Hat `GraphicsCaptureSession` auf DIESEM Windows die Property?
///
/// Die Settings-Enums der Crate sind nicht abwärtskompatibel: jedes
/// Nicht-`Default` fasst die Session-Property an, und die Crate bricht hart ab,
/// wenn das OS sie nicht kennt. `IsBorderRequired` gibt es erst ab Build
/// 20348/Win11 — Windows-10-Clients starben deshalb VOR dem ersten Frame mit
/// "Toggling the capture border is not supported …" (Support-Fall 2026-07-20,
/// RTX-2080-User; die GPU war unbeteiligt). Fehlt die Property, degradieren
/// die Helfer unten auf `Default` (= Property gar nicht anfassen).
fn session_has(prop: &str) -> bool {
    ApiInformation::IsPropertyPresent(
        &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
        &HSTRING::from(prop),
    )
    .unwrap_or(false)
}

/// Cursor an/aus. `IsCursorCaptureEnabled` gibt es seit Win10 1903 (= WGC-
/// Minimum) — der Guard ist reine Vorsicht, gleiche Bauart wie beim Border.
pub(crate) fn cursor_settings(include_cursor: bool) -> CursorCaptureSettings {
    if !session_has("IsCursorCaptureEnabled") {
        eprintln!("[capture] IsCursorCaptureEnabled fehlt auf diesem Windows — Cursor-Einstellung ignoriert");
        return CursorCaptureSettings::Default;
    }
    if include_cursor {
        CursorCaptureSettings::WithCursor
    } else {
        CursorCaptureSettings::WithoutCursor
    }
}

/// Gelber Capture-Rahmen an/aus. Auf Windows 10 existiert der Rahmen gar
/// nicht — `Default` ist dort verlustfrei identisch mit "aus".
pub(crate) fn border_settings(draw_border: bool) -> DrawBorderSettings {
    if !session_has("IsBorderRequired") {
        eprintln!("[capture] IsBorderRequired fehlt auf diesem Windows (10?) — Border-Einstellung ignoriert");
        return DrawBorderSettings::Default;
    }
    if draw_border {
        DrawBorderSettings::WithBorder
    } else {
        DrawBorderSettings::WithoutBorder
    }
}

/// Frame-Takt-Deckel der Capture. `MinUpdateInterval` gibt es erst ab Win11
/// 24H2 (Build 26100) — davor liefert WGC ungedrosselt und der Pacing-Loop
/// taktet selbst (das Intervall ist eine Optimierung, keine Korrektheit).
pub(crate) fn min_interval_settings(max_fps: u32) -> MinimumUpdateIntervalSettings {
    // Defensiv: 1.0/max_fps würde bei 0 als Duration::from_secs_f64(inf) panicken.
    // Die eigentliche Validierung passiert beim Parsen der CLI-Args — dieser
    // Helfer darf trotzdem nie selbst abstürzen.
    if max_fps == 0 {
        return MinimumUpdateIntervalSettings::Default;
    }
    if max_fps == 60 {
        return MinimumUpdateIntervalSettings::Default;
    }
    if !session_has("MinUpdateInterval") {
        eprintln!("[capture] MinUpdateInterval fehlt auf diesem Windows (< 24H2) — Capture ungedrosselt, Pacing-Loop taktet");
        return MinimumUpdateIntervalSettings::Default;
    }
    // min update interval = 1/fps; bei 30fps z.B. ~33ms. Crate clampt wenn nötig.
    MinimumUpdateIntervalSettings::Custom(std::time::Duration::from_secs_f64(1.0 / max_fps as f64))
}
