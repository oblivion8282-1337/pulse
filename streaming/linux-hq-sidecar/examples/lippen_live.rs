//! Lippen-Synchronisation am lebenden Strom (Linux/NVENC): Testpattern-Bild
//! + Sinuston über die ECHTEN Wege des Sidecars — HW-Encoder, WHIP-Sender,
//! Opus-Encoder mit PtsTimeline/`whip_dauer` — nach MediaMTX. Beide Spuren
//! zählen ihre Zeitstempel von DEMSELBEN `record_start` (GSR-Modell wie der
//! stream_controller): Bild-pts aus der Wanduhr (`zeitbasis`), Ton-Anker in
//! Samples derselben Uhr. Der Player am anderen Ende misst den Lippenfehler
//! (`pulse-player/src/audio/lippen.rs`) und loggt ihn auf stderr — der
//! Beweis dieses Beispiels.
//!
//! `clip_live` prüft Bild + Clip-Ring; hier ist der TON der Punkt, deshalb
//! kein Ton in `clip_live`.
//!
//! Optionale Tonlücke (beweist Re-Ankern + PTS-Sprung-Dauer statt fester
//! Paketlänge): `PULSE_LIPPEN_LUECKE_SEK=60 PULSE_LIPPEN_LUECKE_MS=250` —
//! ab Sekunde 60 pausiert der Ton 250 ms; der Fehler darf danach zurück auf
//! ~0 gehen, nicht dauerhaft stehen bleiben (das wäre der alte Sender).
//!
//! ```text
//! cargo run --release --example lippen_live -- <whip-url> [sekunden] [fps] [codec]
//! ```

use std::time::{Duration, Instant};

use ffmpeg::ffi::*;
use ffmpeg_next as ffmpeg;

use pulse_linux_hq_sidecar::capture::audio::SAMPLE_RATE;
use pulse_linux_hq_sidecar::encode::{AudioParams, EncoderConfig, VideoEncoder, hw};
use pulse_linux_hq_sidecar::system::drm;
use pulse_linux_hq_sidecar::zeitbasis;

fn main() -> anyhow::Result<()> {
    let _ = ffmpeg::init();

    let url = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("whip-url als erstes Argument"))?;
    let sekunden: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(180);
    let fps: u32 = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let codec = std::env::args().nth(4).unwrap_or_else(|| "h264".into());
    let (width, height) = (1280u32, 720u32);

    let (vendor, render_node) = drm::detect()
        .ok_or_else(|| anyhow::anyhow!("keine DRM-Render-Node gefunden"))?;
    eprintln!("[lippen_live] vendor={:?} codec={codec} {width}x{height}@{fps} für {sekunden}s", vendor.slug());

    let kind = hw::kind_for(vendor);
    let dev_arg = if matches!(kind, hw::HwDeviceKind::Vaapi) { Some(render_node.as_str()) } else { None };
    let hw_ctx = hw::HwContext::create(kind, dev_arg, width, height, AVPixelFormat::AV_PIX_FMT_NV12)?;

    let cfg = EncoderConfig { vendor, codec, fps, bitrate_kbps: 4000, width, height, ten_bit: false };
    // Sendeweg anmelden wie `ops::start`: sonst waehlt `opus_frame_ms()` die
    // 5-ms-FLV-Rasterung (libopus warnt dann "less than 10ms", CELT-only).
    pulse_linux_hq_sidecar::encode::audio::setze_sendeweg(true);
    // Ton-Encoder muss VOR dem WHIP-Aufbau stehen (keine Nachverhandlung,
    // s. `VideoEncoder::create_whip`) — deshalb `create_with_audio`, nicht
    // der tonlose `create`-Wrapper.
    // SAFETY: Pixelformat und Frames-Kontext stammen aus demselben `HwContext`
    // wie beim sicheren `create`-Wrapper.
    let (mut enc, audio_enc) = unsafe {
        VideoEncoder::create_with_audio(
            &cfg,
            hw_ctx.ffmpeg_pixel(),
            hw_ctx.frames_ref(),
            &url,
            Some(AudioParams { sample_rate: SAMPLE_RATE, bitrate_kbps: 128 }),
        )?
    };
    let mut audio_enc =
        audio_enc.ok_or_else(|| anyhow::anyhow!("WHIP ohne Ton-Encoder"))?;
    eprintln!("[lippen_live] Encoder + WHIP offen, sende …");

    // Gemeinsamer Nullpunkt BEIDER Spuren — genau das, was die Lippen-Messung
    // im Player voraussetzt (Bild folgt seinen RTP-Stempeln, Ton der RTP-Uhr;
    // beide sind nur vergleichbar, weil sie denselben Start teilen).
    let record_start = Instant::now();

    // --- Ton: Sinus 440 Hz in 20-ms-Batches, Anker = Wanduhr in Samples ---
    let luecke_sek: u64 = std::env::var("PULSE_LIPPEN_LUECKE_SEK").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let luecke_ms: u64 = std::env::var("PULSE_LIPPEN_LUECKE_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(250);
    let senke_ton = enc.ton_senke()?;
    let (ton_tx, ton_rx) = std::sync::mpsc::channel::<String>();
    let ton_handle = std::thread::Builder::new()
        .name("lippen-ton".into())
        .spawn(move || {
            let schritt = 2.0 * std::f32::consts::PI * 440.0 / SAMPLE_RATE as f32;
            let batch_frames = 960usize; // 20 ms — wie ein PipeWire-Quantum-Bereich
            let mut phase = 0f32;
            let mut naechste = Instant::now() + Duration::from_millis(20);
            let ende = Instant::now() + Duration::from_secs(sekunden);
            let mut luecke_genommen = luecke_sek == 0; // 0 = keine Lücke fällig
            loop {
                let jetzt = Instant::now();
                if jetzt >= ende {
                    break;
                }
                // Einmalige Tonlücke: Anker läuft weiter, Zeitlinie hinkt
                // hinterher — PtsTimeline re-ankert (>100 ms), whip_dauer
                // trägt den Sprung in den RTP-Stempel.
                if !luecke_genommen && jetzt.saturating_duration_since(record_start).as_secs() >= luecke_sek {
                    eprintln!("[lippen-ton] Lücke {luecke_ms} ms ab Sekunde {luecke_sek}");
                    std::thread::sleep(Duration::from_millis(luecke_ms));
                    naechste = Instant::now() + Duration::from_millis(20);
                    luecke_genommen = true;
                    continue;
                }
                // Anker wie der PW-Callback: CAPTURE-Zeit des Batches, nicht
                // Sendezeit (Consumer-Stau wäre sonst eine Lüge als Lücke).
                let anchor =
                    (jetzt.saturating_duration_since(record_start).as_secs_f64() * SAMPLE_RATE as f64) as i64;
                let mut samples = Vec::with_capacity(batch_frames * 2);
                for _ in 0..batch_frames {
                    phase += schritt;
                    let v = (phase.sin() * 0.2).clamp(-1.0, 1.0);
                    samples.push(v);
                    samples.push(v);
                }
                if let Err(e) = audio_enc.push(&samples, &senke_ton, anchor) {
                    let _ = ton_tx.send(format!("[lippen-ton] push: {e:#}"));
                    return;
                }
                naechste += Duration::from_millis(20);
                if naechste > Instant::now() {
                    std::thread::sleep(naechste - Instant::now());
                } else {
                    naechste = Instant::now();
                }
            }
            if let Err(e) = audio_enc.flush(&senke_ton) {
                let _ = ton_tx.send(format!("[lippen-ton] flush: {e:#}"));
            }
        })
        .map_err(|e| anyhow::anyhow!("spawn lippen-ton: {e}"))?;

    // --- Bild: Testpattern, pts aus der WANDUHR (nicht dem Bildindex) —
    // nur so ist der Video-RTP-Stempel wanduhr-echt und mit dem Ton-Anker
    // vergleichbar (stream_controller tut dasselbe). ---
    let mut scaler = ffmpeg::software::scaling::Context::get(
        ffmpeg::format::Pixel::BGRA, width, height,
        ffmpeg::format::Pixel::NV12, width, height,
        ffmpeg::software::scaling::Flags::BILINEAR,
    )?;
    let interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
    let mut naechstes = record_start + interval;
    let mut last_pts: i64 = 0;
    let ende_bild = record_start + Duration::from_secs(sekunden);
    let mut i: u64 = 0;
    loop {
        if Instant::now() >= ende_bild {
            break;
        }
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
        let clock_pts =
            zeitbasis::pts_aus_sekunden(naechstes.saturating_duration_since(record_start).as_secs_f64());
        let pts = clock_pts.max(last_pts + 1);
        last_pts = pts;
        bgra.set_pts(Some(pts));
        let mut nv12 = ffmpeg::frame::Video::empty();
        scaler.run(&bgra, &mut nv12)?;
        let mut hw_frame = hw_ctx.upload_swframe(&nv12, pts)?;
        // SAFETY: frisch von `upload_swframe`, Format passt zum Frames-Kontext.
        unsafe { enc.send_hw(hw_frame, pts)? };
        unsafe { av_frame_free(&mut hw_frame) };

        i += 1;
        naechstes += interval;
        let jetzt = Instant::now();
        if naechstes > jetzt {
            std::thread::sleep(naechstes - jetzt);
        } else {
            naechstes = jetzt;
        }
    }

    eprintln!("[lippen_live] Sendephase fertig — warte auf Ton-Faden …");
    ton_handle.join().map_err(|_| anyhow::anyhow!("Ton-Faden panikte"))?;
    if let Ok(e) = ton_rx.try_recv() {
        anyhow::bail!("{e}");
    }
    drop(enc);
    println!("{{\\\"lippen_live\\\": true, \\\"sekunden\\\": {sekunden}}}");
    Ok(())
}
