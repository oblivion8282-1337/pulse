//! Op handlers — one module per JSON-RPC op.
//!
//! Every handler is a free function `fn handle(params) -> Result<Map>`. Sync,
//! pure-ish (no global state in the Day-1 skeleton); the streaming pipeline
//! adds a shared StreamController behind a mutex when `start`/`stop`/`state`
//! gain real implementations.
//!
//! Implementation status mirrors the WINDOWS_HQ_SIDECAR.md plan:
//!
//! | Op                       | Status     | Real-impl unlocks |
//! |--------------------------|------------|-------------------|
//! | health                   | placeholder| Stage 2 (DXGI enum + encoder probe) |
//! | gpu_info                 | stub       | Stage 2 (DXGI adapter enum) |
//! | list_profiles            | real       | Day 1 — port from profiles.py |
//! | list_monitors            | real       | Windows-only display picker |
//! | list_application_audio   | stub       | Stage 3 (`wasapi` process enum) |
//! | build_argv               | stub       | Stage 4 (after encode pipeline shape settles) |
//! | start                    | stub       | Stages 5-8 (capture + audio + encode + RTMPS) |
//! | stop                     | stub       | Stage 8 |
//! | state                    | stub       | Stage 8 |

pub mod build_argv;
pub mod gpu_info;
pub mod health;
pub mod list_application_audio;
pub mod list_monitors;
pub mod list_profiles;
pub mod start;
pub mod state;
pub mod stop;
