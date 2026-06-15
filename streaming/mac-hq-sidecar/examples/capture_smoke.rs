//! Capture smoke test: start an SCStream for ~2s and report frame delivery.
//! Run: `cargo run --release --example capture_smoke` (needs Screen-Recording
//! permission for the invoking terminal). Does NOT push anywhere.

use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use pulse_mac_hq_sidecar::capture::Capturer;

fn main() -> anyhow::Result<()> {
    let (tx, rx) = channel();
    let cap = Capturer::start(1, 1280, 720, 30, true, tx)?;
    let start = Instant::now();
    let mut frames = 0usize;
    let mut last = (0usize, 0usize, 0usize, 0.0_f64);
    while start.elapsed() < Duration::from_secs(2) {
        if let Ok(f) = rx.recv_timeout(Duration::from_millis(500)) {
            frames += 1;
            last = (f.width, f.height, f.bytes_per_row, f.pts_seconds);
            if frames <= 3 {
                eprintln!(
                    "frame {frames}: {}x{} bpr={} bytes={} pts={:.3}s",
                    f.width,
                    f.height,
                    f.bytes_per_row,
                    f.data.len(),
                    f.pts_seconds
                );
            }
        }
    }
    cap.stop();
    eprintln!(
        "captured {frames} frames in ~2s (last {}x{} bpr={} pts={:.3}s)",
        last.0, last.1, last.2, last.3
    );
    if frames == 0 {
        anyhow::bail!("no frames delivered (permission? display index?)");
    }
    Ok(())
}
