//! Win32-API-Wrapper. Hier liegen die `unsafe`-Aufrufe ans `windows`-Crate;
//! Op-Handler in `ops/` rufen nur die `Result<…>`-Wrapper.

pub mod app_name;
pub mod audio_sessions;
pub mod codec_probe;
pub mod dxgi;
pub mod gpu_wahl;
pub mod hdr;
