//! Capture-Smoke-Test.
//!
//! Startet WGC auf dem primären Monitor, sammelt 60 Frames lang Daten,
//! speichert den ersten Frame als BMP und gibt FPS aus. Wird damit aufgerufen:
//!
//! ```text
//! cargo run --example capture_smoke
//! ```
//!
//! Wenn das durchläuft ist die Capture-Pipeline live; Stage 6+ kann den
//! Frame-Receiver verbinden statt Bytes auf Platte zu schreiben.

use std::path::PathBuf;
use std::time::Instant;

use pulse_win_hq_sidecar::capture::{CaptureSource, wgc::{CaptureConfig, WgcCapture}};

fn main() -> anyhow::Result<()> {
    let target_frames: usize = std::env::args()
        .nth(1)
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);

    println!("[smoke] starting WGC capture of primary monitor; collecting {target_frames} frames");
    let started = Instant::now();
    let mut capture = WgcCapture::start(CaptureSource::PrimaryMonitor, CaptureConfig::default())?;

    let mut seen = 0usize;
    let mut first_saved = false;
    let out_path = PathBuf::from("capture_smoke_first_frame.bmp");

    while seen < target_frames {
        match capture.frames.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(frame) => {
                seen += 1;
                if !first_saved {
                    save_bmp(&out_path, &frame.bgra, frame.width, frame.height)?;
                    first_saved = true;
                    println!(
                        "[smoke] saved frame {}x{} → {}",
                        frame.width,
                        frame.height,
                        out_path.display()
                    );
                }
                if seen % 10 == 0 {
                    let elapsed = started.elapsed().as_secs_f64();
                    println!("[smoke] {seen} frames in {elapsed:.2}s = {:.1} fps", seen as f64 / elapsed);
                }
            }
            Err(e) => {
                eprintln!("[smoke] recv error after {seen} frames: {e}");
                break;
            }
        }
    }

    capture.stop();
    let elapsed = started.elapsed().as_secs_f64();
    println!("[smoke] done: {seen} frames in {elapsed:.2}s = {:.1} fps", seen as f64 / elapsed);
    Ok(())
}

/// Minimal-BMP-Writer (24-bit BGRA → 24-bit BGR, row-padded). Pure Output für
/// den Smoke-Test — kein PNG-Encode-Dep, kein FFmpeg. Format ist verlustlos
/// und in jedem Bild-Viewer öffenbar.
fn save_bmp(path: &std::path::Path, bgra: &[u8], width: u32, height: u32) -> anyhow::Result<()> {
    use std::io::Write;

    let row_bytes_unaligned = width as usize * 3;
    let row_padding = (4 - (row_bytes_unaligned % 4)) % 4;
    let row_bytes = row_bytes_unaligned + row_padding;
    let pixel_data_size = row_bytes * height as usize;
    let file_size = 54 + pixel_data_size;

    let mut f = std::fs::File::create(path)?;
    // BMP file header (14 bytes)
    f.write_all(b"BM")?;
    f.write_all(&(file_size as u32).to_le_bytes())?;
    f.write_all(&[0u8; 4])?; // reserved
    f.write_all(&54u32.to_le_bytes())?; // pixel data offset
    // DIB header (40 bytes)
    f.write_all(&40u32.to_le_bytes())?; // header size
    f.write_all(&(width as i32).to_le_bytes())?;
    f.write_all(&(-(height as i32)).to_le_bytes())?; // negative = top-down
    f.write_all(&1u16.to_le_bytes())?; // planes
    f.write_all(&24u16.to_le_bytes())?; // bits per pixel
    f.write_all(&[0u8; 4])?; // compression: BI_RGB
    f.write_all(&(pixel_data_size as u32).to_le_bytes())?;
    f.write_all(&2835u32.to_le_bytes())?; // x ppm (72 dpi)
    f.write_all(&2835u32.to_le_bytes())?; // y ppm
    f.write_all(&[0u8; 8])?; // colors used + important

    // Pixel data: BGRA → BGR + row padding
    let mut row = Vec::with_capacity(row_bytes);
    for y in 0..height as usize {
        row.clear();
        let src_row_start = y * width as usize * 4;
        for x in 0..width as usize {
            let i = src_row_start + x * 4;
            row.push(bgra[i]);     // B
            row.push(bgra[i + 1]); // G
            row.push(bgra[i + 2]); // R
        }
        for _ in 0..row_padding {
            row.push(0);
        }
        f.write_all(&row)?;
    }
    Ok(())
}
