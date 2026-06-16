//! Full capture→encode→mux smoke test (to a local file, no network push).
//! Run: `cargo run --release --example encode_smoke -- /tmp/pulse_smoke.mp4`
//! Needs Screen-Recording permission. Verify with `ffprobe` afterwards.

use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use pulse_mac_hq_sidecar::capture::{AudioFrame, AudioScope, Capturer};
use pulse_mac_hq_sidecar::encode::VideoEncoder;

fn main() -> anyhow::Result<()> {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/pulse_smoke.mp4".into());
    // Pass "audio" as the 2nd arg to also capture system audio.
    let with_audio = std::env::args().nth(2).as_deref() == Some("audio");
    let (w, h, fps) = (1280u32, 720u32, 30u32);

    let (tx, rx) = channel();
    let (atx, arx) = channel::<AudioFrame>();
    let cap = Capturer::start(
        1,
        None,
        if with_audio { AudioScope::Desktop { exclude: vec![] } } else { AudioScope::None },
        w as usize,
        h as usize,
        fps,
        true,
        tx,
        if with_audio { Some(atx) } else { None },
    )?;
    let mut enc = VideoEncoder::start(&out, w, h, fps, 4000, "h264", with_audio)?;

    let start = Instant::now();
    let mut n = 0usize;
    let mut a = 0usize;
    while start.elapsed() < Duration::from_secs(3) {
        if with_audio {
            while let Ok(af) = arx.try_recv() {
                enc.push_audio(&af.samples)?;
                a += 1;
            }
        }
        if let Ok(f) = rx.recv_timeout(Duration::from_millis(500)) {
            enc.push_pixel_buffer(f.retained_ptr())?;
            n += 1;
        }
    }
    cap.stop();
    enc.finish()?;
    eprintln!("encoded {n} video frames, {a} audio buffers → {out}");
    Ok(())
}
