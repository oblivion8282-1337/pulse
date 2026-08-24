//! Full capture→encode→mux smoke test (to a local file, no network push).
//! Run: `cargo run --release --example encode_smoke -- /tmp/pulse_smoke.mp4`
//! Needs Screen-Recording permission. Verify with `ffprobe` afterwards.

use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::{Duration, Instant};

use pulse_mac_hq_sidecar::capture::{AudioFrame, AudioScope, Capturer, Postfach};
use pulse_mac_hq_sidecar::encode::VideoEncoder;

fn main() -> anyhow::Result<()> {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/pulse_smoke.mp4".into());
    // Pass "audio" as the 2nd arg to also capture system audio.
    let with_audio = std::env::args().nth(2).as_deref() == Some("audio");
    let (w, h, fps) = (1280u32, 720u32, 30u32);

    let bildpost = Arc::new(Postfach::neu());
    let (atx, arx) = channel::<AudioFrame>();
    let cap = Capturer::start(
        1,
        None,
        if with_audio { AudioScope::Desktop { exclude: vec![] } } else { AudioScope::None },
        w as usize,
        h as usize,
        fps,
        true,
        bildpost.clone(),
        if with_audio { Some(atx) } else { None },
    )?;
    let mut enc = VideoEncoder::start(&out, w, h, fps, 4000, "h264", with_audio)?;

    let start = Instant::now();
    let mut n = 0usize;
    let mut a = 0usize;
    while start.elapsed() < Duration::from_secs(3) {
        if with_audio {
            while let Ok(af) = arx.try_recv() {
                let anchor = (start.elapsed().as_secs_f64() * 48_000.0) as i64;
                enc.push_audio(&af.samples, anchor)?;
                a += 1;
            }
        }
        if let Some(f) = bildpost.warten_bis(Instant::now() + Duration::from_millis(500)) {
            let pts = (start.elapsed().as_secs_f64() * fps as f64) as i64;
            enc.push_pixel_buffer(f.retained_ptr(), pts)?;
            n += 1;
        }
    }
    cap.stop();
    enc.finish()?;
    eprintln!("encoded {n} video frames, {a} audio buffers → {out}");
    Ok(())
}
