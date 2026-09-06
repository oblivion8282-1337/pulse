//! Pulse macOS HQ-streaming sidecar — library crate.
//!
//! `main.rs` is a thin binary over these modules (matches the layout of
//! `streaming/win-hq-sidecar/`). See the crate README for the porting roadmap
//! and `streaming/README.md` for the wire protocol.

pub mod ablage;
pub mod berechtigung;
pub mod caps;
pub mod capture;
pub mod dispatch;
pub mod encode;
pub mod events;
pub(crate) mod keyframe;
pub mod ops;
pub mod profiles;
pub mod proto;
pub mod redact;
pub mod remote_input;
pub mod stream_controller;
pub mod whip;
pub mod zeitbasis;
