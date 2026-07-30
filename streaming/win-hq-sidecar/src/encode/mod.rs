//! Encode-Pipeline.
//!
//! Zwei Pfade je nach Adapter:
//!
//! - **NVIDIA Zero-Copy** (`encoder_hw.rs` + `hwctx.rs`): WGC liefert
//!   D3D11-BGRA-Texturen, wir kopieren sie GPU-intern in einen D3D11VA-Pool
//!   (`av_hwframe_get_buffer`), NVENC liest BGRA direkt und macht NV12-Convert
//!   intern. Kein PCIe-Roundtrip, kein CPU-swscale. Downscale läuft über
//!   `d3d11_scale.rs` (`ID3D11VideoProcessor`) — ebenfalls rein auf der GPU.
//! - **CPU-Fallback** (`encoder.rs`): AMD AMF + Intel QSV wollen NV12-Input;
//!   ohne GPU-Color-Convert geht's nicht zero-copy → swscale BGRA→NV12 auf
//!   der CPU. Gleicher Pfad bei Downscale auf jedem Vendor. Kill-Switch
//!   `PULSE_HQ_DISABLE_ZERO_COPY=1` erzwingt diesen Pfad auch auf NVIDIA.
//!
//! Branch wird in `stream_controller.rs::run_pipeline` entschieden. AMD/Intel
//! Zero-Copy würde einen GPU-Color-Convert vor dem Encoder brauchen (D3D11-
//! Compute-Shader oder `scale_d3d11`-Filter) — kein Scope hier.

pub mod audio;
pub mod d3d11_scale;
pub mod d3d12_convert;
pub mod encoder;
pub mod encoder_d3d12;
pub mod extradata;
pub mod encoder_hw;
pub mod hwctx;
pub mod latency;
pub mod mux_writer;
pub mod opts;
pub mod output;

/// Meldet, WELCHER Encoder wirklich offen ist — von allen drei Encoder-Pfaden
/// direkt nach `open_with` gerufen.
///
/// Die argv-Zeile der `start`-Antwort meldet den GEWUENSCHTEN Codec; bis dahin
/// koennen zwei Ruecknahmen dazwischengekommen sein (WHIP traegt nur H.264;
/// AV1 verlaesst den d3d12va-Pfad mangels extradata). Ohne diese Zeile stand
/// nirgends, was am Ende lief — und eine Messung unter falschem Etikett sieht
/// vollkommen plausibel aus.
pub fn log_encoder_open(
    codec_name: &str,
    vendor: &str,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: u32,
) {
    eprintln!(
        "[encode] Encoder offen: {codec_name} (vendor={vendor}, {width}x{height}@{fps}, {bitrate_kbps} kbps)"
    );
}

pub use d3d11_scale::D3D11Scaler;
pub use encoder::{AudioStreamConfig, EncoderConfig, FfmpegEncoder, VideoCodec};
pub use encoder_d3d12::{D3d12EncoderConfig, FfmpegD3d12Encoder};
pub use encoder_hw::{FfmpegHwEncoder, HwEncoderConfig};
pub use hwctx::{HwContext, OwnedHwFrame};
