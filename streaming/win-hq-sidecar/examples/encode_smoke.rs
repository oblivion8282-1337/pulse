//! End-to-end Capture→Encode-Smoke-Test.
//!
//! Pipeline:
//!
//! ```text
//! [WGC capture] ── BGRA frames ──▶ [swscale BGRA→NV12] ──▶ [h264_nvenc] ──▶ encode_smoke.mp4
//! ```
//!
//! - Capture-Quelle: primärer Monitor
//! - Encoder: NVENC h264 @ 1080p, 30fps, 5 Mbps CBR (DOWN-scale von 4K)
//! - Dauer: 5 Sekunden default, oder das erste CLI-Arg in Sekunden
//!
//! Output: `encode_smoke.mp4` im Sidecar-Root, abspielbar mit jedem Standard-
//! Player. Bestätigt dass die ganze Pipeline (Capture → CPU-Buffer → swscale →
//! NVENC → MP4-Mux) durchläuft.
//!
//! Vendor wird via DXGI-Adapter-Enum aus dem HIGH_PERFORMANCE-Slot gezogen —
//! auf NVIDIA-Systemen wird NVENC genommen, auf AMD AMF, auf Intel QSV.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use pulse_win_hq_sidecar::capture::{
    CaptureSource,
    wgc::{CaptureConfig, WgcCapture},
};
use pulse_win_hq_sidecar::encode::{EncoderConfig, FfmpegEncoder, VideoCodec};
use pulse_win_hq_sidecar::system::dxgi;

const TARGET_FPS: u32 = 30;
// 4K bei 12 Mbps für den Native-Pfad (kein Downscale → BGR0-direct auf NVIDIA).
// Wer 1080p braucht, setzt DOWNSCALE=true und kriegt 5 Mbps + CPU-swscale.
const NATIVE_BITRATE_KBPS: u32 = 12_000;
const DOWNSCALE_BITRATE_KBPS: u32 = 5_000;
const DOWNSCALE_WIDTH: u32 = 1920;
const DOWNSCALE_HEIGHT: u32 = 1080;
/// `true` = 1080p (CPU-swscale), `false` = native res (BGR-direct, fast)
const DOWNSCALE: bool = false;

fn main() -> anyhow::Result<()> {
    let duration_secs: u64 = std::env::args()
        .nth(1)
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    let adapter = dxgi::list_adapters()?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no hardware adapter found"))?;
    println!(
        "[smoke] HIGH_PERFORMANCE adapter: {} (vendor={})",
        adapter.description,
        adapter.vendor()
    );

    println!("[smoke] starting WGC capture of primary monitor");
    let mut capture = WgcCapture::start(
        CaptureSource::PrimaryMonitor,
        CaptureConfig {
            max_fps: TARGET_FPS,
            ..Default::default()
        },
    )?;

    // Warmup: erstes Frame holen um die echte Source-Resolution zu lernen
    // (sonst müssen wir raten — Multi-Monitor-Setups haben unterschiedliche
    // primäre Auflösungen).
    let first = capture
        .frames
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| anyhow::anyhow!("never got first frame: {e}"))?;
    println!("[smoke] capture native: {}x{}", first.width, first.height);

    let (dst_w, dst_h, bitrate) = if DOWNSCALE {
        (DOWNSCALE_WIDTH, DOWNSCALE_HEIGHT, DOWNSCALE_BITRATE_KBPS)
    } else {
        (first.width, first.height, NATIVE_BITRATE_KBPS)
    };
    let fast_path = !DOWNSCALE && adapter.vendor() == "nvidia";
    println!(
        "[smoke] encoder target:  {dst_w}x{dst_h} @ {TARGET_FPS}fps, {bitrate} kbps CBR ({}{})",
        adapter.vendor(),
        if fast_path { ", BGR-direct" } else { ", CPU-swscale" }
    );

    let out_path = PathBuf::from("encode_smoke.mp4");
    let mut encoder = FfmpegEncoder::create(
        &EncoderConfig {
            codec: VideoCodec::H264,
            vendor: adapter.vendor().to_string(),
            src_width: first.width,
            src_height: first.height,
            dst_width: dst_w,
            dst_height: dst_h,
            fps: TARGET_FPS,
            bitrate_kbps: bitrate,
        },
        out_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("non-utf8 output path"))?,
    )?;

    encoder.send(&first)?;
    let started = Instant::now();
    let mut frames_sent = 1usize;

    while started.elapsed().as_secs() < duration_secs {
        let frame = match capture.frames.recv_timeout(Duration::from_secs(2)) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[smoke] capture stalled: {e}");
                break;
            }
        };
        if frame.width != first.width || frame.height != first.height {
            eprintln!(
                "[smoke] capture resolution changed mid-stream {}x{}→{}x{} (skipping frame)",
                first.width, first.height, frame.width, frame.height
            );
            continue;
        }
        encoder.send(&frame)?;
        frames_sent += 1;
        if frames_sent % 30 == 0 {
            let elapsed = started.elapsed().as_secs_f64();
            println!(
                "[smoke] sent {frames_sent} frames in {elapsed:.2}s = {:.1} fps",
                frames_sent as f64 / elapsed
            );
        }
    }

    capture.stop();
    println!("[smoke] flushing encoder…");
    encoder.finish()?;

    let size = std::fs::metadata(&out_path)?.len();
    println!(
        "[smoke] wrote {} ({:.2} MB) — {frames_sent} frames in {:.2}s",
        out_path.display(),
        size as f64 / (1024.0 * 1024.0),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}
