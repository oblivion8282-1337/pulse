//! Pulse Windows HQ-streaming sidecar — Library-Surface.
//!
//! Die Module sind public damit `examples/`-Smoke-Tests + (in Zukunft)
//! Integration-Tests direkt drauf zugreifen können. Wire-Protokoll-Loop selbst
//! lebt in `src/main.rs`.

pub mod audio;
pub mod capture;
pub mod dispatch;
pub mod encode;
pub mod ops;
pub mod profiles;
pub mod proto;
pub mod system;
