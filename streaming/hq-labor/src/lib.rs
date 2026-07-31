//! Pulse Linux HQ-streaming sidecar — library crate.
//!
//! Wire-äquivalent zu `streaming/gsr-sidecar/control.py` (Linux/Python) und
//! `streaming/{win,mac}-hq-sidecar/` (Rust): eine JSON-Zeile pro stdin = Request,
//! eine JSON-Zeile pro stdout = Response (spiegelt `id`) oder Event (`{"ev":...}`,
//! kein `id`). Siehe `streaming/README.md` für das Protokoll.
//!
//! Stack: PipeWire/Portal-Capture (Wayland) → VAAPI (AMD/Intel) / NVENC (Nvidia)
//! via ffmpeg-next als Bibliothek → FLV-Mux → RTMPS-Push an MediaMTX. Kein
//! externes `gpu-screen-recorder`-Binary mehr (der Umweg des Python-GSR-Sidecars).
//!
//! `main.rs` ist ein dünner Binary-Wrapper über diesen Modulen (Layout wie
//! mac-hq-sidecar). Siehe den Plan und das README für die Roadmap.

// Geteilt mit dem ausgelieferten Sidecar — hier NICHT kopiert, sondern aus
// seiner Bibliothek uebernommen. Ein `crate::capture::...` in den Dateien
// unten trifft damit denselben Code, den auch Nutzer fahren.
pub use pulse_linux_hq_sidecar::{caps, capture, events, logging, profiles, proto, redact, system};

// Eigener Zweig des Messstands. Nur diese Dateien weichen vom ausgelieferten
// Stand ab; `ops` und `stream_controller` muessen zusammen hier liegen, weil
// `start`/`stop` sonst verschiedene Zustaende ansprechen wuerden.
pub mod dispatch;
pub mod encode;
pub mod ops;
pub mod stream_controller;
pub mod whip;
