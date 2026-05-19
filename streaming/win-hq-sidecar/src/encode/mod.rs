//! Encode-Pipeline (Stage 7).
//!
//! BGRA-Frames vom `capture/`-Modul → swscale → NV12 → ffmpeg-next-Encoder
//! (NVENC/AMF/QSV je nach Adapter-Vendor) → Container (FLV/MP4) → Output
//! (Datei oder RTMPS-URL).
//!
//! Stage-7-Spike: CPU-side BGRA→NV12 + Hardware-Encoder. Zero-Copy via
//! D3D11-Hardware-Frames-Context kommt in einer späteren Iteration (das ist
//! der „risk corner" aus WINDOWS_HQ_SIDECAR.md — `ffmpeg-sys-next`-`unsafe`-
//! Verkabelung). System-RAM-NV12 verliert -20-30% Perf, läuft aber stabil.

pub mod audio;
pub mod encoder;

pub use encoder::{AudioStreamConfig, EncoderConfig, FfmpegEncoder, VideoCodec};
