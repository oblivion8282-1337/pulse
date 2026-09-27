//! Live-Clip-Smoke: synthetische Frames → echter HW-Encoder (NVENC/VAAPI) →
//! eigener WHIP-Sendeweg nach MediaMTX — und der Clip-Ring (`crate::clip`)
//! läuft über denselben `drain_video`-Tee wie im Betrieb. Am Ende wird ein
//! Clip der letzten Sekunden geschrieben.
//!
//! Das ist die Integrationsebene unterhalb des Portals: echter Encoder,
//! echter WHIP-Sender, echter Ring, echter Muxer — nur die Bildquelle ist
//! ein Testpattern statt ScreenCast. Ohne diesen Weg waere der Ring nur
//! gegen Dumpfdaten geprüft.
//!
//! ```text
//! cargo run --release --example clip_live -- <whip-url> <clip-pfad> [codec] [sekunden] [fps]
//! ```

use ffmpeg::ffi::*;
use ffmpeg_next as ffmpeg;

use pulse_linux_hq_sidecar::clip;
use pulse_linux_hq_sidecar::encode::{EncoderConfig, VideoEncoder, hw};
use pulse_linux_hq_sidecar::system::drm;

fn main() -> anyhow::Result<()> {
    let _ = ffmpeg::init();

    let url = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("whip-url als erstes Argument"))?;
    let clip_pfad = std::env::args()
        .nth(2)
        .ok_or_else(|| anyhow::anyhow!("Clip-Zielpfad als zweites Argument"))?;
    let codec = std::env::args().nth(3).unwrap_or_else(|| "h264".into());
    let sekunden: u64 = std::env::args().nth(4).and_then(|s| s.parse().ok()).unwrap_or(20);
    let fps: u32 = std::env::args().nth(5).and_then(|s| s.parse().ok()).unwrap_or(30);
    let (width, height) = (1280u32, 720u32);

    let (vendor, render_node) = drm::detect()
        .ok_or_else(|| anyhow::anyhow!("keine DRM-Render-Node gefunden"))?;
    eprintln!("[clip_live] vendor={:?} codec={codec} {width}x{height}@{fps} für {sekunden}s", vendor.slug());

    let kind = hw::kind_for(vendor);
    let dev_arg = if matches!(kind, hw::HwDeviceKind::Vaapi) { Some(render_node.as_str()) } else { None };
    let hw_ctx = hw::HwContext::create(kind, dev_arg, width, height, AVPixelFormat::AV_PIX_FMT_NV12)?;

    let cfg = EncoderConfig { vendor, codec, fps, bitrate_kbps: 4000, width, height, ten_bit: false };
    let mut enc = VideoEncoder::create(&cfg, &hw_ctx, &url)?;
    eprintln!("[clip_live] Encoder + WHIP offen, sende …");

    let mut scaler = ffmpeg::software::scaling::Context::get(
        ffmpeg::format::Pixel::BGRA, width, height,
        ffmpeg::format::Pixel::NV12, width, height,
        ffmpeg::software::scaling::Flags::BILINEAR,
    )?;

    let interval = std::time::Duration::from_secs_f64(1.0 / fps.max(1) as f64);
    let mut naechstes = std::time::Instant::now();
    let frames = sekunden * fps as u64;
    // pts in der Encoder-Zeitbasis (1/90000, `zeitbasis::VIDEO_HZ`) — wie der
    // stream_controller. Der erste Lauf nahm den Bildindex und verdrehte
    // damit Ring-Zeitstempel, WHIP-RTP-Marken und die Bildraten-Messung des
    // Players (Median-Delta 1 Tick statt 3000).
    let pro_bild = 90_000i64 / fps.max(1) as i64;
    for i in 0..frames {
        let mut bgra = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, width, height);
        let stride = bgra.stride(0);
        let data = bgra.data_mut(0);
        let phase = (i % 60) as u8;
        for y in 0..height as usize {
            for x in 0..width as usize {
                let off = y * stride + x * 4;
                if off + 3 < data.len() {
                    data[off] = (x as u8).wrapping_add(phase);
                    data[off + 1] = (y as u8).wrapping_add(phase);
                    data[off + 2] = ((x + y) as u8).wrapping_add(phase);
                    data[off + 3] = 255;
                }
            }
        }
        let pts = i as i64 * pro_bild;
        bgra.set_pts(Some(pts));
        let mut nv12 = ffmpeg::frame::Video::empty();
        scaler.run(&bgra, &mut nv12)?;
        let mut hw_frame = hw_ctx.upload_swframe(&nv12, pts)?;
        // SAFETY: frisch von `upload_swframe`, Format passt zum Frames-Kontext.
        unsafe { enc.send_hw(hw_frame, pts)? };
        unsafe { av_frame_free(&mut hw_frame) };

        naechstes += interval;
        let jetzt = std::time::Instant::now();
        if naechstes > jetzt {
            std::thread::sleep(naechstes - jetzt);
        } else {
            naechstes = jetzt;
        }
    }
    eprintln!("[clip_live] Sendephase fertig — schreibe Clip …");
    let sekunden_clip = (sekunden as f64 * 0.8).min(30.0);
    let einheiten = clip::clip_speichern(std::path::Path::new(&clip_pfad), sekunden_clip)?;
    println!(
        "{{\\\"clip\\\": true, \\\"units\\\": {einheiten}, \\\"path\\\": \\\"{clip_pfad}\\\"}}"
    );
    eprintln!("[clip_live] ✅ Clip mit {einheiten} Einheiten: {clip_pfad}");
    Ok(())
}
