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
pub mod wgc_hw;

pub use source::CaptureSource;
pub use wgc_hw::{HwCaptureItem, WgcHwCapture};
