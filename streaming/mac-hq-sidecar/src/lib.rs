//! Pulse macOS HQ-streaming sidecar — library crate.
//!
//! `main.rs` is a thin binary over these modules (matches the layout of
//! `streaming/win-hq-sidecar/`). See the crate README for the porting roadmap
//! and `streaming/README.md` for the wire protocol.

pub mod dispatch;
pub mod events;
pub mod ops;
pub mod profiles;
pub mod proto;
