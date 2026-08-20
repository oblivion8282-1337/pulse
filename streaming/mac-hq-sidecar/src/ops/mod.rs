//! Op handlers — one module per JSON-RPC op.
//!
//! Every handler is a free function `fn handle(params) -> Result<Map>`. Sync
//! and stateless in the Day-1 skeleton; a shared StreamController behind a mutex
//! arrives when `start`/`stop`/`state` gain real implementations (see README).
//!
//! Implementation status (mirrors the crate README table):
//!
//! | Op                     | Status          | Real-impl unlocks                       |
//! |------------------------|-----------------|-----------------------------------------|
//! | health                 | static caps     | VideoToolbox codec probe                |
//! | gpu_info               | stub            | Metal device query                      |
//! | list_monitors          | stub (`[]`)     | SCShareableContent.displays             |
//! | list_application_audio | stub (`[]`)     | SCShareableContent.applications         |
//! | build_argv             | real            | diagnostic argv (token-redacted)        |
//! | start                  | stub (error)    | ScreenCaptureKit + VideoToolbox + RTMPS |
//! | stop                   | idempotent      | StreamController                        |
//! | state                  | idle            | StreamController snapshot               |
//! | keyframe               | real            | manual keyframe-on-request trigger      |

pub mod build_argv;
pub mod gpu_info;
pub mod health;
pub mod keyframe;
pub mod list_application_audio;
pub mod list_monitors;
pub mod list_windows;
pub mod start;
pub mod state;
pub mod stop;
