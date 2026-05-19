//! Encode-Pipeline.
//!
//! Zwei Pfade je nach Adapter:
//!
//! - **NVIDIA Zero-Copy** (`encoder_hw.rs` + `hwctx.rs`): WGC liefert
//!   D3D11-BGRA-Texturen, wir kopieren sie GPU-intern in einen D3D11VA-Pool
//!   (`av_hwframe_get_buffer`), NVENC liest BGRA direkt und macht NV12-Convert
//!   intern. Kein PCIe-Roundtrip, kein CPU-swscale.
//! - **CPU-Fallback** (`encoder.rs`): AMD AMF + Intel QSV wollen NV12-Input;
//!   ohne GPU-Color-Convert geht's nicht zero-copy → swscale BGRA→NV12 auf
//!   der CPU. Gleicher Pfad bei Downscale auf jedem Vendor. Kill-Switch
//!   `PULSE_HQ_DISABLE_ZERO_COPY=1` erzwingt diesen Pfad auch auf NVIDIA.
//!
//! Branch wird in `stream_controller.rs::run_pipeline` entschieden. AMD/Intel
//! Zero-Copy würde einen GPU-Color-Convert vor dem Encoder brauchen (D3D11-
//! Compute-Shader oder `scale_d3d11`-Filter) — kein Scope hier.

pub mod audio;
pub mod encoder;
pub mod encoder_hw;
pub mod hwctx;
pub mod scale_filter;

pub use encoder::{AudioStreamConfig, EncoderConfig, FfmpegEncoder, VideoCodec};
pub use encoder_hw::{FfmpegHwEncoder, HwEncoderConfig};
pub use hwctx::{HwContext, OwnedHwFrame};
pub use scale_filter::{OwnedCudaFrame, ScaleFilter};
