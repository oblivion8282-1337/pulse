//! RTMP-Push-Smoke-Test.
//!
//! Capture → NVENC → RTMP-Push an MediaMTX. Validiert dass die Encode-Pipeline
//! gegen einen Live-Server pushen kann (FLV-Mux, RTMP-Handshake, FFmpeg-Output-
//! Context auf URL statt Datei).
//!
//! Default-URL: `rtmp://localhost:1935/test` (passt zur Default-Config von
//! standalone MediaMTX, ohne Auth, ohne TLS). Overridebar als CLI-Arg.
//!
//! ```text
//! cargo run --release --example rtmp_smoke
//! cargo run --release --example rtmp_smoke -- rtmp://localhost:1935/test 10
//! cargo run --release --example rtmp_smoke -- rtmps://host:1936/path?user=X&pass=Y 30
//! ```
//!
//! Was beim Push passiert (laut FFmpeg-Auto-Detect):
//! - `rtmp://...` → format=flv, plain TCP, port 1935 default
//! - `rtmps://...` → format=flv, TLS via SChannel (BtbN-Build hat `--enable-schannel`)
//!
//! Verifikation: MediaMTX-Log sollte einen Publish-Connect zeigen; via
//! `http://localhost:9997/v3/paths/list` (API) listet er aktive Streams.

use std::time::{Duration, Instant};

use pulse_win_hq_sidecar::capture::{
    CaptureSource,
    wgc::{CaptureConfig, WgcCapture},
};
use pulse_win_hq_sidecar::encode::{EncoderConfig, FfmpegEncoder, VideoCodec};
use pulse_win_hq_sidecar::system::dxgi;

const TARGET_FPS: u32 = 30;
const NATIVE_BITRATE_KBPS: u32 = 12_000;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let url = args
        .next()
        .unwrap_or_else(|| "rtmp://localhost:1935/test".to_string());
    let duration_secs: u64 = args
        .next()
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let adapter = dxgi::list_adapters()?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no hardware adapter found"))?;
    println!(
        "[smoke] HIGH_PERFORMANCE adapter: {} (vendor={})",
        adapter.description,
        adapter.vendor()
    );

    let mut capture = WgcCapture::start(
        CaptureSource::PrimaryMonitor,
        CaptureConfig {
            max_fps: TARGET_FPS,
            ..Default::default()
        },
    )?;

    let first = capture
        .frames
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| anyhow::anyhow!("never got first frame: {e}"))?;
    println!(
        "[smoke] capture native: {}x{} @ {TARGET_FPS}fps",
        first.width, first.height
    );
    println!(
        "[smoke] push target: {url} ({} kbps {} {})",
        NATIVE_BITRATE_KBPS,
        adapter.vendor(),
        if adapter.vendor() == "nvidia" {
            "BGR-direct"
        } else {
            "NV12+swscale"
        }
    );

    // Encoder: native Auflösung (kein Downscale → BGR-direct auf NVIDIA).
    // FFmpeg liest die URL und wählt format=flv automatisch für rtmp/rtmps.
    let mut encoder = FfmpegEncoder::create(
        &EncoderConfig {
            codec: VideoCodec::H264,
            vendor: adapter.vendor().to_string(),
            src_width: first.width,
            src_height: first.height,
            dst_width: first.width,
            dst_height: first.height,
            fps: TARGET_FPS,
            bitrate_kbps: NATIVE_BITRATE_KBPS,
        },
        &url,
    )?;
    println!("[smoke] encoder + RTMP output context opened");

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
            continue;
        }
        encoder.send(&frame)?;
        frames_sent += 1;
        if frames_sent % 30 == 0 {
            let elapsed = started.elapsed().as_secs_f64();
            println!(
                "[smoke] pushed {frames_sent} frames in {elapsed:.2}s = {:.1} fps",
                frames_sent as f64 / elapsed
            );
        }
    }

    capture.stop();
    println!("[smoke] flushing encoder…");
    encoder.finish()?;
    println!(
        "[smoke] done: {frames_sent} frames pushed in {:.2}s",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}
