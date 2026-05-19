//! Audio-Smoke-Test.
//!
//! Capturet 3 Sekunden Default-Desktop-Audio und schreibt's als WAV. Wenn
//! nichts spielt sind die Samples Silence — das ist von WASAPI-Loopback so
//! gewollt (vs. Mikrofon, wo's echtes Rauschen wäre).
//!
//! ```text
//! cargo run --example audio_smoke               # 3s Desktop
//! cargo run --example audio_smoke -- mic        # 3s Mikrofon
//! cargo run --example audio_smoke -- app 12345  # 3s Process-Loopback von PID 12345
//! ```

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use pulse_win_hq_sidecar::audio::{AudioCapture, AudioFormat, AudioSource};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (source, label): (AudioSource, &str) = match args.first().map(String::as_str) {
        None | Some("desktop") => (AudioSource::DefaultDesktop, "desktop"),
        Some("mic") => (AudioSource::DefaultMicrophone, "mic"),
        Some("app") => {
            let pid: u32 = args
                .get(1)
                .ok_or_else(|| anyhow::anyhow!("usage: audio_smoke app <PID>"))?
                .parse()?;
            (
                AudioSource::Application { pid, include_tree: true },
                "app",
            )
        }
        Some(other) => anyhow::bail!("unknown source: {other}"),
    };

    let duration_secs = 3.0_f64;
    let out_path = PathBuf::from(format!("audio_smoke_{label}.wav"));
    println!("[smoke] capturing {duration_secs:.1}s of {label} audio → {}", out_path.display());

    let mut capture = AudioCapture::start(source, 1024)?;
    let format = capture.format();
    let started = Instant::now();
    let mut all_bytes: Vec<u8> = Vec::with_capacity(
        (duration_secs * format.sample_rate as f64 * format.block_align() as f64) as usize,
    );

    while started.elapsed().as_secs_f64() < duration_secs {
        match capture
            .samples
            .recv_timeout(std::time::Duration::from_secs(2))
        {
            Ok(chunk) => {
                all_bytes.extend_from_slice(&chunk.bytes);
            }
            Err(e) => {
                eprintln!("[smoke] recv error: {e}");
                break;
            }
        }
    }
    capture.stop();

    let frames = (all_bytes.len() / format.block_align() as usize) as u32;
    let actual_secs = frames as f64 / format.sample_rate as f64;
    let peak = peak_amplitude(&all_bytes);
    println!(
        "[smoke] captured {} bytes = {} frames = {:.2}s (peak amplitude: {:.4})",
        all_bytes.len(),
        frames,
        actual_secs,
        peak
    );

    write_wav(&out_path, &all_bytes, format)?;
    println!("[smoke] wrote {}", out_path.display());
    Ok(())
}

/// Peak |sample| über alle interleaved Float-Samples — schnell, sagt aus ob
/// echte Audio-Daten oder reines Silence.
fn peak_amplitude(bytes: &[u8]) -> f32 {
    let mut peak = 0.0_f32;
    for chunk in bytes.chunks_exact(4) {
        let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if v.abs() > peak {
            peak = v.abs();
        }
    }
    peak
}

/// Schreibt ein WAV File mit IEEE-Float-Format (Format-Tag 3, 32-bit). Standard
/// RIFF-Header; geöffnet von Audacity/foobar/Audition/VLC ohne Stutzen.
fn write_wav(path: &std::path::Path, pcm: &[u8], format: AudioFormat) -> anyhow::Result<()> {
    let mut f = File::create(path)?;
    let byte_rate = format.sample_rate * format.block_align() as u32;
    let data_size = pcm.len() as u32;
    let riff_size = 36 + data_size;

    f.write_all(b"RIFF")?;
    f.write_all(&riff_size.to_le_bytes())?;
    f.write_all(b"WAVE")?;

    // fmt-Chunk (16 Bytes Payload für PCM/Float)
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&3u16.to_le_bytes())?; // WAVE_FORMAT_IEEE_FLOAT
    f.write_all(&format.channels.to_le_bytes())?;
    f.write_all(&format.sample_rate.to_le_bytes())?;
    f.write_all(&byte_rate.to_le_bytes())?;
    f.write_all(&format.block_align().to_le_bytes())?;
    f.write_all(&format.bits_per_sample.to_le_bytes())?;

    // data-Chunk
    f.write_all(b"data")?;
    f.write_all(&data_size.to_le_bytes())?;
    f.write_all(pcm)?;
    Ok(())
}
