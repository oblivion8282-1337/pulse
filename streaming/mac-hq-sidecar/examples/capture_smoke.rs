//! Capture smoke test: start an SCStream for ~2s and report frame delivery.
//! Run: `cargo run --release --example capture_smoke` (needs Screen-Recording
//! permission for the invoking terminal). Does NOT push anywhere.

use std::sync::Arc;
use std::time::{Duration, Instant};

use pulse_mac_hq_sidecar::capture::{AudioScope, Capturer, Postfach};

fn main() -> anyhow::Result<()> {
    let bildpost = Arc::new(Postfach::neu());
    let cap = Capturer::start(1, None, AudioScope::None, 1280, 720, 30, true, bildpost.clone(), None)?;
    let start = Instant::now();
    let mut frames = 0usize;
    let mut last = (0usize, 0usize, 0.0_f64);
    while start.elapsed() < Duration::from_secs(2) {
        if let Some(f) = bildpost.warten_bis(Instant::now() + Duration::from_millis(500)) {
            frames += 1;
            last = (f.width, f.height, f.pts_seconds);
            if frames <= 3 {
                eprintln!("frame {frames}: {}x{} pts={:.3}s", f.width, f.height, f.pts_seconds);
            }
        }
    }
    cap.stop();
    eprintln!(
        "captured {frames} frames in ~2s (last {}x{} pts={:.3}s)",
        last.0, last.1, last.2
    );
    if frames == 0 {
        anyhow::bail!("no frames delivered (permission? display index?)");
    }
    Ok(())
}
