//! Zero-Copy-Pipeline für NVIDIA-Pfad (NVENC).
//!
//! WGC liefert ID3D11Texture2D-Frames; wir kopieren sie GPU-intern in einen
//! D3D11VA-Pool, von dem NVENC direkt liest. Kein PCIe-Hin-und-Her, kein
//! BGRA→NV12-swscale auf der CPU.
//!
//! Aktiv für `adapter.vendor() == "nvidia"`. AMD/Intel landen in der
//! CPU-Pipeline in `stream_controller.rs` (AMF/QSV brauchen NV12-Input und
//! ohne GPU-Color-Convert geht das nicht zero-copy). Kill-Switch:
//! `PULSE_HQ_DISABLE_ZERO_COPY=1` → erzwingt den CPU-Pfad auch auf NVIDIA.

use anyhow::{Result, anyhow};
use serde_json::json;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use crate::audio::AudioCapture;
use crate::capture::wgc::CaptureConfig;
use crate::capture::{HwCaptureItem, WgcHwCapture};
use crate::encode::{
    AudioStreamConfig, FfmpegHwEncoder, HwEncoderConfig, VideoCodec,
};
use crate::events;
use crate::stream_controller::{StartParams, StreamController};
use crate::system::dxgi::Adapter;

pub fn run(adapter: Adapter, params: StartParams, stop_rx: Receiver<()>) -> Result<()> {
    let ctrl = StreamController::singleton();

    let fps = params.override_fps.unwrap_or(params.profile.fps);
    let codec = params.override_codec.unwrap_or(match params.profile.codec {
        "h264" => VideoCodec::H264,
        "hevc" => VideoCodec::Hevc,
        "av1" => VideoCodec::Av1,
        _ => VideoCodec::H264,
    });
    let bitrate = params
        .override_bitrate_kbps
        .unwrap_or(params.profile.bitrate_kbps);

    let mut capture = WgcHwCapture::start(
        params.capture.clone(),
        CaptureConfig { max_fps: fps, ..Default::default() },
        8,
    )?;

    // Setup-Item warten (mit erstem Pool-Frame).
    let setup = capture
        .items
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| anyhow!("never got setup item from hw capture: {e}"))?;
    let (hw, width, height, mut first) = match setup {
        HwCaptureItem::Setup { hw, width, height, first } => (hw, width, height, first),
        HwCaptureItem::Frame(_) => return Err(anyhow!("first item was Frame, expected Setup")),
    };
    // Downscale-Target mit Upscale-Schutz. Bei dst==src läuft FfmpegHwEncoder
    // im direkten D3D11→NVENC-Pfad; sonst wird intern ein scale_cuda-Filter
    // zwischengeschoben.
    let (dst_w, dst_h) = match params.override_resolution {
        Some((w, h)) if w <= width && h <= height => (w, h),
        Some((w, h)) => {
            eprintln!(
                "[pipeline-hw] resolution override {}x{} > capture {}x{} — ignored",
                w, h, width, height
            );
            (width, height)
        }
        None => (width, height),
    };
    eprintln!(
        "[pipeline-hw] capture {width}x{height} → encode {dst_w}x{dst_h}@{fps} on {} (vendor=nvidia)",
        adapter.description
    );

    // Audio-Pipeline gleicher Pfad wie CPU-Variante (WASAPI → libopus → 2. Spur).
    let audio_capture: Option<AudioCapture> = params.audio.as_ref().and_then(|src| {
        match AudioCapture::start(src.clone(), 1024) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[pipeline-hw] audio capture failed, video-only: {e:#}");
                None
            }
        }
    });
    let audio_cfg: Option<AudioStreamConfig> = audio_capture.as_ref().map(|_| AudioStreamConfig::DEFAULT);

    let mut encoder = FfmpegHwEncoder::create(
        &HwEncoderConfig {
            codec,
            vendor: adapter.vendor().to_string(),
            fps,
            bitrate_kbps: bitrate,
            src_w: width,
            src_h: height,
            dst_w,
            dst_h,
        },
        &hw,
        audio_cfg,
        &params.push_url,
    )?;

    ctrl.set_state("live");
    super::stream_controller::emit_state("live", true, 0.0);
    encoder.send_hw(&mut first)?;
    drop(first); // gibt Pool-Frame zurück

    let started = Instant::now();
    let mut frames_sent: u64 = 1;
    let mut last_fps_emit = Instant::now();

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        if let Some(ac) = audio_capture.as_ref() {
            while let Ok(chunk) = ac.samples.try_recv() {
                let _ = encoder.send_audio(&chunk);
            }
        }
        let item = match capture.items.recv_timeout(Duration::from_millis(500)) {
            Ok(it) => it,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(anyhow!("hw capture channel disconnected"));
            }
        };
        let mut frame = match item {
            HwCaptureItem::Frame(f) => f,
            HwCaptureItem::Setup { .. } => {
                // Sollte nie passieren — Setup ist one-shot.
                return Err(anyhow!("unexpected Setup item after pipeline init"));
            }
        };
        encoder.send_hw(&mut frame)?;
        drop(frame);
        frames_sent += 1;

        if last_fps_emit.elapsed() >= Duration::from_secs(2) {
            let elapsed = started.elapsed().as_secs_f64();
            let fps_now = frames_sent as f64 / elapsed;
            ctrl.set_fps(fps_now);
            events::emit(json!({"ev": "fps", "fps": fps_now, "uptime_s": elapsed}));
            last_fps_emit = Instant::now();
        }
    }

    capture.stop();
    if let Some(mut ac) = audio_capture {
        ac.stop();
    }
    encoder.finish()?;
    Ok(())
}
