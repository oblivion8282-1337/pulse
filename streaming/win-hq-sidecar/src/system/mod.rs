//! Win32-API-Wrapper. Hier liegen die `unsafe`-Aufrufe ans `windows`-Crate;
//! Op-Handler in `ops/` rufen nur die `Result<…>`-Wrapper.

pub mod audio_sessions;
pub mod dxgi;
