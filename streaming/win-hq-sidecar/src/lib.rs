//! Pulse Windows HQ-streaming sidecar — Library-Surface.
//!
//! Die Module sind public damit `examples/`-Smoke-Tests + (in Zukunft)
//! Integration-Tests direkt drauf zugreifen können. Wire-Protokoll-Loop selbst
//! lebt in `src/main.rs`.

pub mod audio;
pub mod capture;
pub mod dispatch;
pub mod encode;
pub mod env;
pub mod events;
pub mod ops;
pub mod pipeline_d3d12;
pub mod pipeline_hw;
pub mod profiles;
pub mod proto;
pub mod redact;
pub mod stream_controller;
pub mod system;
pub mod tick_monitor;
