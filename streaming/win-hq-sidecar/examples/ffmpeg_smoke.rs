//! FFmpeg-Link-Smoke-Test.
//!
//! Beweist dass:
//! 1. ffmpeg-sys-next die LGPL-Headers + Libs findet (über FFMPEG_DIR
//!    aus `.cargo/config.toml`)
//! 2. avcodec.dll / avformat.dll / avutil.dll / swresample.dll / swscale.dll
//!    zur Laufzeit erreichbar sind (= entweder neben der .exe oder im PATH)
//! 3. Die Hardware-Encoder wirklich aus FFmpeg ansprechbar sind
//! 4. Der AMF-Intra-Refresh-Patch in **diesem** FFmpeg steckt
//!
//! Fehlt (4), endet das Programm mit einem Fehler — es ist damit als Gegenprobe
//! nach einem FFmpeg-Austausch benutzbar und nicht nur zum Zusehen.
//!
//! Die Muxer prüft es NICHT: ffmpeg-next 8.x hat kein „liste alle Muxer"-API.
//! Das erledigt `scripts/build-ffmpeg-patched.ps1` am fertigen Paket
//! (`ffmpeg -muxers`), bevor es eingesetzt wird.
//!
//! Aufruf:
//! ```text
//! cargo run --release --example ffmpeg_smoke
//! ```

use ffmpeg_next as ffmpeg;
use pulse_win_hq_sidecar::encode::auffrischung;

fn main() -> anyhow::Result<()> {
    ffmpeg::init()?;

    println!("[smoke] FFmpeg version: {:?}", ffmpeg::util::version());
    println!("[smoke] License:        {}", ffmpeg::util::license());
    println!("[smoke] Configuration:  {} bytes", ffmpeg::util::configuration().len());

    let want_encoders = [
        "h264_nvenc", "hevc_nvenc", "av1_nvenc",
        "h264_amf", "hevc_amf", "av1_amf",
        "h264_qsv", "hevc_qsv", "av1_qsv",
        "libopus",
    ];
    println!("[smoke] === Encoder probe ===");
    for name in want_encoders {
        match ffmpeg::codec::encoder::find_by_name(name) {
            Some(c) => println!("  {:14} ok — {}", name, c.description()),
            None => println!("  {:14} MISSING", name),
        }
    }

    // **Die Frage, die kein `ffmpeg.exe -h` beantwortet:** ob das FFmpeg, das
    // DIESES Programm geladen hat, die Optionen aus Patch 0002 kennt. Windows
    // sucht DLLs zuerst neben der `.exe` — ein frisch gebautes Paket im
    // `ffmpeg-dist/` und alte DLLs neben der exe sehen von außen gleich aus, und
    // `ffmpeg.exe -h encoder=av1_amf` befragt dann das falsche FFmpeg.
    //
    // Gefragt wird über denselben Weg, den auch der Start nimmt: `anwenden`
    // liefert genau dann Ok, wenn die Optionen wirklich da sind.
    println!("[smoke] === Intra-Refresh-Probe (Patch 0002) ===");
    auffrischung::setzen(true);
    let mut opts = ffmpeg::Dictionary::new();
    let ergebnis = auffrischung::anwenden(&mut opts, "av1_amf", 60);
    auffrischung::setzen(false);
    ergebnis?;
    println!(
        "  av1_amf ok — intra_refresh_mode={} intra_refresh_stripes={}",
        opts.get("intra_refresh_mode").unwrap_or("?"),
        opts.get("intra_refresh_stripes").unwrap_or("?"),
    );

    Ok(())
}
