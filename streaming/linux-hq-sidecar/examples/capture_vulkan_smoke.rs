//! Capture-Vulkan-Smoke: Portal → PipeWire-DMABUF → VulkanImporter
//! (hwmap=derive_device=vulkan → scale_vulkan) → h264_vulkan + COLUMN-Intra-Refresh → Datei.
//!
//! Beweist den Zero-Copy-DMABUF→Vulkan-Pfad mit echtem Screen-Capture.
//! Setzt PULSE_VULKAN_ENCODE=1 + PULSE_INTRA_REFRESH=1 selbst (COLUMN via
//! Patch-0004-Vendor-Workaround). Gegen den Pulse-eigenen FFmpeg-9.0-Bau
//! laufen lassen (LD_LIBRARY_PATH + PKG_CONFIG_PATH, s.u.).
//!
//! ```text
//! PKG_CONFIG_PATH=~/.cache/pulse/ffmpeg-intra-refresh/prefix/lib/pkgconfig \
//! LD_LIBRARY_PATH=~/.cache/pulse/ffmpeg-intra-refresh/prefix/lib \
//! cargo run --release --example capture_vulkan_smoke -- /tmp/vk_capture.mp4
//! ```
//! Portal-Dialog: Quelle wählen. Compositors senden nur bei Damage — Fenster
//! bewegen, sonst läuft der recv-Timeout ab.

use std::time::Duration;

use ffmpeg_next as ffmpeg;
use ffmpeg::ffi::av_frame_free;

use pulse_linux_hq_sidecar::capture::{pipewire_stream::PipewireCapture, portal};
use pulse_linux_hq_sidecar::encode::{EncoderConfig, VideoEncoder, vk_import::VulkanImporter};
use pulse_linux_hq_sidecar::system::drm;

fn main() -> anyhow::Result<()> {
    // Dieses Example IST der Vulkan+COLUMN-Beweis — die Schalter stehen fest.
    unsafe {
        std::env::set_var("PULSE_VULKAN_ENCODE", "1");
        std::env::set_var("PULSE_INTRA_REFRESH", "1");
    }

    let _ = ffmpeg::init();

    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/vk_capture.mp4".to_string());
    let fps: u32 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let n_frames: u64 = std::env::args()
        .nth(3)
        .and_then(|s| s.parse().ok())
        .unwrap_or(120);

    let (vendor, render_node) = drm::detect()
        .ok_or_else(|| anyhow::anyhow!("keine DRM-Render-Node gefunden"))?;
    if !matches!(vendor, drm::Vendor::Nvidia) {
        anyhow::bail!(
            "vendor={:?} — der Vulkan-Import-Pfad ist NVIDIA-only",
            vendor.slug()
        );
    }

    // Portal → PipeWire-DMABUF-Frames.
    let session = match portal::open(true, &std::sync::atomic::AtomicBool::new(false)) {
        Ok(s) => s,
        Err(e) if portal::is_portal_canceled(&e) => {
            eprintln!("[capture_vulkan] Portal abgebrochen → Exit 60");
            std::process::exit(portal::EXIT_PORTAL_CANCELED);
        }
        Err(e) => return Err(e),
    };
    eprintln!(
        "[capture_vulkan] portal: node={} {}x{}",
        session.node_id, session.width, session.height
    );
    let (rx, mut cap) =
        PipewireCapture::start(session.pw_fd, session.node_id, session.width, session.height)?;

    let first = rx
        .wait_take(Duration::from_secs(15))
        .and_then(|o| o.ok_or_else(|| anyhow::anyhow!("kein Frame in 15s")))
        .map_err(|_| anyhow::anyhow!("kein DMABUF-Frame in 15s (Dialog? Damage? — Fenster bewegen)"))?;
    let (w, h) = (first.width, first.height);
    eprintln!(
        "[capture_vulkan] erster Frame: {}x{} fourcc={:#010x} modifier={:#018x} → {n_frames} Frames h264_vulkan@{fps}fps nach {out}",
        w, h, first.drm_fourcc, first.modifier
    );

    // VulkanImporter: DRM-Device am render_node + Filter-Graph
    // (buffer → hwmap derive_device=vulkan → scale_vulkan=nv12 → buffersink).
    let mut importer =
        VulkanImporter::new(&render_node, first.drm_fourcc, w, h, fps, w, h)?;
    eprintln!("[capture_vulkan] VulkanImporter bereit (Filter-Graph steht)");

    // Encoder mit dem Vulkan-frames_ctx DES Importers (derselbe Vulkan-Device,
    // sonst wären Importer und Encoder inkompatibel). h264_vulkan + intra_refresh
    // via PULSE_VULKAN_ENCODE/PULSE_INTRA_REFRESH (s. opts.rs).
    let cfg = EncoderConfig {
        vendor,
        codec: "h264".to_string(),
        fps,
        bitrate_kbps: 8000,
        width: w,
        height: h,
        ten_bit: false,
    };
    let (mut enc, _audio) = unsafe {
        VideoEncoder::create_with_audio(
            &cfg,
            ffmpeg::format::Pixel::VULKAN,
            importer.output_frames_ctx(),
            &out,
            None,
        )?
    };
    eprintln!("[capture_vulkan] h264_vulkan offen, encodiere …");

    let started = std::time::Instant::now();
    let mut frame = first;
    let mut sent: u64 = 0;
    loop {
        let mut hw_frame = importer.import(&frame)?;
        // fds gehören uns — nach dem Import schließen.
        for p in &frame.planes {
            unsafe { libc::close(p.fd) };
        }
        // SAFETY: frisch vom VulkanImporter geliefert, Format=VULKAN, passt zum
        // gebundenen frames_ctx.
        unsafe { enc.send_hw(hw_frame, sent as i64)? };
        unsafe { av_frame_free(&mut hw_frame) };
        sent += 1;
        if sent % 30 == 0 {
            eprintln!("[capture_vulkan] {sent}/{n_frames} frames …");
        }
        if sent >= n_frames {
            break;
        }
        frame = match rx.wait_take(Duration::from_secs(5)).and_then(|o| {
            o.ok_or_else(|| anyhow::anyhow!("Timeout (kein Damage?) oder Quelle beendet"))
        }) {
            Ok(f) => f,
            Err(_) => {
                eprintln!(
                    "[capture_vulkan] 5s ohne Frame (kein Damage?) — beende mit {sent} Frames"
                );
                break;
            }
        };
    }
    let elapsed = started.elapsed().as_secs_f64();
    eprintln!(
        "[capture_vulkan] {sent} Frames in {elapsed:.2}s ({:.1} fps), finalisiere …",
        sent as f64 / elapsed.max(0.001)
    );

    cap.stop();
    enc.finish()?;
    eprintln!("[capture_vulkan] ✅ fertig: {out}");
    eprintln!("[capture_vulkan] prüfen: ffprobe -v error -show_streams {out}");
    Ok(())
}
