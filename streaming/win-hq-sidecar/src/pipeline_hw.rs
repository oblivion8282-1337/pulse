//! Zero-Copy-Pipeline für den GPU-Pfad (NVENC / AMF).
//!
//! WGC liefert ID3D11Texture2D-Frames; wir kopieren sie GPU-intern in einen
//! D3D11VA-Pool, von dem der Encoder direkt liest. Kein PCIe-Hin-und-Her, kein
//! BGRA→NV12-swscale auf der CPU. Downscale per `D3D11Scaler` (VideoProcessor).
//!
//! Aktiv NUR für NVIDIA — h264_nvenc nimmt D3D11-BGRA-Frames direkt. AMD läuft
//! über `pipeline_d3d12` (nativer h264_d3d12va), Intel über die CPU-Pipeline
//! (`run_cpu_pipeline`): h264_amf stürzt auf D3D11-Surface-Input ab
//! (dokumentierter AMD-AMF-Treiber-Bug, AMF-Issue #455). Da `select_adapter()`
//! auf Multi-GPU die dGPU statt der Display-GPU liefern kann, verifiziert
//! `run` die echte WGC-Capture-GPU und delegiert bei !=nvidia selbst an
//! `pipeline_d3d12` bzw. `run_cpu_pipeline`. Kill-Switch
//! `PULSE_HQ_DISABLE_ZERO_COPY=1` → CPU-Pfad.
//!
//! Der Encoder-Vendor wird aus der echten WGC-D3D11-Device-GPU abgeleitet
//! (`device_vendor`), NICHT aus `select_adapter()` — letzteres bevorzugt die
//! dGPU, die WGC-Device-GPU folgt aber dem primären Display.

use anyhow::{Result, anyhow};
use serde_json::json;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::core::Interface;

use crate::audio::AudioCapture;
use crate::capture::wgc::CaptureConfig;
use crate::capture::{HwCaptureItem, WgcHwCapture};
use crate::encode::{
    AudioStreamConfig, D3D11Scaler, FfmpegHwEncoder, HwEncoderConfig, OwnedHwFrame, VideoCodec,
};
use crate::events;
use crate::stream_controller::{StartParams, StreamController};
use crate::system::dxgi::Adapter;
use crate::tick_monitor::{TickMonitor, TickSample};

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

    // Capture-D3D11VA-Pool: versorgt Capture-Queue + (im Native-Pfad) die
    // NVENC-In-Flight-Tiefe. Im Downscale-Pfad hat der Scaler einen eigenen
    // Ziel-Pool, dann muss dieser hier nur Capture-Queue + Scaler-Input-Halt
    // bedienen — 24 ist für beide Fälle robust.
    let capture = WgcHwCapture::start(
        params.capture.clone(),
        CaptureConfig { max_fps: fps, include_cursor: params.show_cursor, ..Default::default() },
        24,
    )?;

    // Setup-Item warten (mit erstem Pool-Frame).
    let setup = capture
        .items
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| anyhow!("never got setup item from hw capture: {e}"))?;
    let (hw, width, height, first) = match setup {
        HwCaptureItem::Setup { hw, width, height, first } => (hw, width, height, first),
        HwCaptureItem::Frame(_) => return Err(anyhow!("first item was Frame, expected Setup")),
    };
    // Vendor der ECHTEN Capture/Encode-GPU (WGC-D3D11-Device). `adapter` aus
    // `select_adapter()` kann auf Multi-GPU eine andere GPU sein (dGPU-Default).
    let vendor = device_vendor(hw.device()).unwrap_or_else(|| adapter.vendor());

    // Dieser D3D11-Zero-Copy-Pfad gilt NUR für NVIDIA — h264_amf (AMD) stürzt
    // auf D3D11-Surface-Input ab (AMF-Runtime-Bug, AMF-Issue #455). Ist die
    // echte Capture-GPU nicht NVIDIA → HW-Capture stoppen und delegieren:
    // AMD → `pipeline_d3d12` (nativer h264_d3d12va), sonst → CPU-Pfad.
    if vendor != "nvidia" {
        drop(capture);
        drop(first);
        drop(hw);
        if vendor == "amd" {
            eprintln!("[pipeline-hw] Capture-GPU ist amd — Delegation an pipeline_d3d12");
            return crate::pipeline_d3d12::run(params, stop_rx);
        }
        eprintln!(
            "[pipeline-hw] Capture-GPU ist {vendor}, nicht nvidia/amd — \
             Delegation an den CPU-Pfad"
        );
        return crate::stream_controller::run_cpu_pipeline(params, stop_rx);
    }
    // Downscale-Target mit Upscale-Schutz. Bei dst==src geht der Capture-Frame
    // direkt in den Encoder; sonst skaliert der `D3D11Scaler` per
    // `VideoProcessorBlt` auf der GPU davor.
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
    // NV12 (4:2:0-Chroma) verlangt gerade Breite/Höhe; Fenster-Capture liefert
    // beliebige Client-Größen. Auf gerade abrunden, bevor die Dims in den
    // VideoProcessor/Encoder gehen (#7).
    let (dst_w, dst_h) = (dst_w & !1, dst_h & !1);
    eprintln!(
        "[pipeline-hw] capture {width}x{height} → encode {dst_w}x{dst_h}@{fps} on {} (vendor={vendor})",
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

    // Downscale-Pfad: GPU-Scaler (VideoProcessorBlt) zwischen Capture und
    // Encoder. Der Scaler hat einen eigenen D3D11VA-Ziel-Pool (dst-res, BGRA,
    // +RENDER_TARGET) — der Encoder bindet dann diesen statt des Capture-Pools.
    // Bei dst==src bleibt `scaler` None und der Encoder bindet den Capture-Pool.
    let mut scaler = if (dst_w, dst_h) != (width, height) {
        Some(
            D3D11Scaler::new(
                hw.device().clone(),
                hw.device_context().clone(),
                width,
                height,
                dst_w,
                dst_h,
                fps,
                16,
                hw.lock_ptr(), // Capture-Pool-Lock teilen → eine CS für Copy+Blt+NVENC (#2).
            )
            .map_err(|e| anyhow!("D3D11Scaler::new: {e:#}"))?,
        )
    } else {
        None
    };

    let hw_frames_ref = match &scaler {
        Some(s) => s.dst_frames_ref(),
        None => hw.frames_ref(),
    };
    let mut encoder = FfmpegHwEncoder::create(
        &HwEncoderConfig {
            codec,
            vendor: vendor.to_string(),
            fps,
            bitrate_kbps: bitrate,
            dst_w,
            dst_h,
        },
        hw_frames_ref,
        audio_cfg,
        &params.push_url,
    )?;

    ctrl.set_state("live");
    super::stream_controller::emit_state("live", true, 0.0);

    // Frame-Pacing wie GSR: der Encode-Loop läuft mit fester Kadenz (Ziel-fps),
    // NICHT im Capture-Takt. WGC ist change-driven — bei statischem Bild liefert
    // es 0 Frames; ohne Pacing stockt der RTMP-Push komplett (→ MediaMTX-
    // readTimeout → Verbindungsabbruch). Pro Tick wird der zuletzt gecapturete
    // Frame encodet (dupliziert, wenn kein neuer da ist); die PTS kommt aus der
    // Wanduhr → Stream-Zeit läuft mit Echtzeit statt mit der Capture-Rate.
    let frame_dur = Duration::from_secs_f64(1.0 / fps as f64);
    let started = Instant::now();
    // Audio-PTS am selben Wall-clock-Ursprung wie der Video-PTS verankern.
    encoder.set_audio_origin(started);
    let mut last_frame: Option<OwnedHwFrame> = Some(first);
    let mut last_pts: i64 = -1;
    let mut frames_sent: u64 = 0;
    let mut next_tick = started;
    let mut last_fps_emit = started;
    // Mikro-Stutter-Diagnose — misst pro Tick die einzelnen Stufen, erkennt
    // langsame Ticks/pts-Gaps und loggt sie. Details: `tick_monitor.rs`.
    let mut monitor = TickMonitor::new(fps);
    let mut prev_pts: i64 = 0;

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        // Bis zum nächsten Tick warten. `thread::sleep` nutzt auf Win10+/aktuellem
        // Rust einen High-Resolution-Waitable-Timer (~1 ms genau).
        let planned = next_tick;
        let now = Instant::now();
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        }
        next_tick += frame_dur;
        // Rückstand nicht akkumulieren — sonst Frame-Burst nach einem Stall.
        let now = Instant::now();
        if next_tick < now {
            next_tick = now;
        }

        // Ab hier wird Arbeit gemessen (ohne den Pacing-Sleep): `iter_start`
        // ist der echte Wieder-Aufwach-Zeitpunkt, `wake_jitter` der Verzug
        // gegenüber dem geplanten Tick (Sleep-Überschuss + Vortick-Rückstand).
        let iter_start = Instant::now();
        let wake_jitter = iter_start.saturating_duration_since(planned);

        // Alle wartenden Capture-Frames abholen, nur den neuesten behalten.
        // Ältere droppen → zurück in den Pool. Kommt nichts Neues, bleibt
        // `last_frame` erhalten = Duplizierung bei statischem Bild.
        let t_capture = Instant::now();
        let mut captured: u32 = 0;
        loop {
            match capture.items.try_recv() {
                Ok(HwCaptureItem::Frame(f)) => {
                    last_frame = Some(f);
                    captured += 1;
                }
                Ok(HwCaptureItem::Setup { .. }) => {
                    return Err(anyhow!("unexpected Setup item after pipeline init"));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err(anyhow!("hw capture channel disconnected"));
                }
            }
        }
        let capture_drain = t_capture.elapsed();

        // Audio non-blocking nachziehen.
        let t_audio = Instant::now();
        if let Some(ac) = audio_capture.as_ref() {
            while let Ok(chunk) = ac.samples.try_recv() {
                let _ = encoder.send_audio(&chunk);
            }
        }
        let audio_drain = t_audio.elapsed();

        // Wall-clock-PTS in Encoder-Timebase (1/fps), streng monoton.
        let elapsed = started.elapsed().as_secs_f64();
        let mut pts = (elapsed * fps as f64).round() as i64;
        if pts <= last_pts {
            pts = last_pts + 1;
        }
        // Convert-Zeit: GPU-Scaler bei Downscale, 0 bei Native (NVENC macht
        // den BGRA→NV12-Convert selbst).
        let mut convert = Duration::ZERO;
        if let Some(frame) = last_frame.as_mut() {
            match &mut scaler {
                // Downscale: GPU-Resize in einen frischen Ziel-Pool-Frame,
                // dann den skalierten Frame encoden.
                Some(s) => {
                    let t_conv = Instant::now();
                    let mut scaled = s.scale(frame)?;
                    convert = t_conv.elapsed();
                    encoder.send_hw(&mut scaled, pts)?;
                }
                // Native: Capture-Frame direkt in den Encoder.
                None => encoder.send_hw(frame, pts)?,
            }
            last_pts = pts;
            frames_sent += 1;
        }

        // Tick verbuchen. `send`/`mux` kommen aus dem Encoder (NVENC-Submit
        // bzw. RTMPS-Socket-Write des letzten `send_hw`); `iter` ist die
        // Arbeitszeit ohne Pacing-Sleep, ohne das fps/Summary-Emit unten.
        let iter = iter_start.elapsed();
        monitor.record(&TickSample {
            wake_jitter,
            capture_drain,
            captured,
            audio_drain,
            convert,
            send: Duration::from_micros(encoder.last_send_us()),
            mux: Duration::from_micros(encoder.last_mux_us()),
            iter,
            pts,
            pts_delta: pts - prev_pts,
            capture_drops: capture.dropped(),
        });
        prev_pts = pts;

        if last_fps_emit.elapsed() >= Duration::from_secs(2) {
            let el = started.elapsed().as_secs_f64();
            let fps_now = frames_sent as f64 / el;
            ctrl.set_fps(fps_now);
            events::emit(json!({"ev": "fps", "fps": fps_now, "uptime_s": el}));
            monitor.flush_summary();
            last_fps_emit = Instant::now();
        }
    }

    // Stream finalisieren: FLV-Trailer schreiben, RTMP sauber schließen. Das
    // gibt nichts frei (`finish` nimmt `&mut self`). Das Ergebnis wird ERST NACH
    // den `mem::forget` propagiert: ein `finish()`-Fehler (Netzwerk-Stall /
    // broken pipe) darf die `mem::forget` NICHT per `?` überspringen — sonst
    // werden capture/scaler/hw/encoder gedroppt und die grafische Teardown-
    // Sequenz triggert den Threadpool-Timer-UAF (0xC0000005). Gleiches Muster
    // wie `pipeline_d3d12::run`.
    let finish_result = encoder.finish();

    // KEIN `capture.stop()` / `ac.stop()` / Drop. Die *grafische* Teardown-
    // Sequenz (WGC-FramePool/Session schließen, D3D11-Device + NVENC + Audio-
    // Client freigeben, `nvEncodeAPI64.dll` entladen) ist genau das, was einen
    // treiber-internen Threadpool-Timer dangling zurücklässt — feuert der
    // danach, springt er in freigegebenen Speicher → `0xC0000005` exec-Fault
    // auf einem `TpWaitForTimer`-Thread (mit Audio zuverlässig reproduzierbar).
    //
    // Darum: gar keinen Teardown. Capture-, Audio- und Encoder-Objekte bleiben
    // am Leben (`mem::forget`), die Threads laufen weiter. Der Per-Stream-
    // Sidecar endet unmittelbar nach diesem `stop` (`dispatch`/`main` →
    // Prozess-Exit); `ExitProcess` terminiert ALLE Threads — Capture, WASAPI,
    // Treiber-Threadpool — abrupt, bevor irgendein Timer feuern kann. Das OS
    // gibt GPU-/COM-/Datei-Handles beim Prozess-Ende vollständig frei.
    std::mem::forget(last_frame);
    std::mem::forget(capture);
    std::mem::forget(scaler);
    std::mem::forget(hw);
    std::mem::forget(audio_capture);
    std::mem::forget(encoder);
    finish_result?;
    Ok(())
}

/// Vendor-Slug der GPU hinter einem D3D11-Device — via `IDXGIDevice::GetAdapter`.
/// Maßgeblich ist die GPU, auf der WGC sein Device gebaut hat (= die des
/// primären Displays); der Encoder muss dazu passen (h264_nvenc / h264_amf).
/// `None` wenn die Abfrage fehlschlägt oder der Vendor unbekannt ist.
fn device_vendor(device: &ID3D11Device) -> Option<&'static str> {
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    let dxgi: IDXGIDevice = device.cast().ok()?;
    let adapter = unsafe { dxgi.GetAdapter() }.ok()?;
    let desc = unsafe { adapter.GetDesc() }.ok()?;
    match desc.VendorId {
        0x10DE => Some("nvidia"),
        0x1002 => Some("amd"),
        0x8086 => Some("intel"),
        _ => None,
    }
}
