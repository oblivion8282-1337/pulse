//! Zero-Copy-Pipeline für den GPU-Pfad (NVENC / AMF).
//!
//! WGC liefert ID3D11Texture2D-Frames; wir kopieren sie GPU-intern in einen
//! D3D11VA-Pool, von dem der Encoder direkt liest. Kein PCIe-Hin-und-Her, kein
//! BGRA→NV12-swscale auf der CPU. Downscale per `D3D11Scaler` (VideoProcessor).
//!
//! Aktiv für **NVIDIA (alle Codecs)** und für **AMD, aber nur AV1**:
//! `h264_nvenc` wie `av1_amf` nehmen D3D11-BGRA-Frames direkt entgegen.
//! AMD-H.264/HEVC läuft über `pipeline_d3d12` (nativer `h264_d3d12va`), Intel
//! über die CPU-Pipeline (`run_cpu_pipeline`).
//!
//! **Warum AMD hier nur mit AV1 steht.** Über D3D12 ist AV1 auf AMD nicht
//! benutzbar (`av1_d3d12va` liefert einen Bitstrom, den kein Decoder liest —
//! Messung in `pipeline_d3d12::run`), und der frühere Ausweg über die
//! CPU-Pipeline kostete gemessen 113 % einer CPU-Kerne und 42 übersprungene
//! Bilder in 20 s. Über diesen Pfad sind daraus 9 % und 2 geworden.
//! Voraussetzung ist der **Einzeltextur-Pool** für AMD (`hwctx.rs`): über den
//! Texture-Array-Pool, den NVIDIA nutzt, liefert AMF ein zerrissenes Bild
//! (Standbild-A/B und Herleitung am Wert in `HwContext::new`). Für
//! AMD-H.264 gibt es dagegen keinen Anlass umzustellen: `h264_d3d12va`
//! funktioniert, und `h264_amf` hat mit D3D11-Eingang die Vorgeschichte aus
//! AMF-Issue #455 (`SubmitInput`-Integer-Divide-by-Zero). Auf der Radeon 780M
//! mit dem Treiber vom Juli 2026 ist der Crash nicht mehr reproduzierbar —
//! das ist eine Maschine, kein Beleg.
//!
//! Da `select_adapter()` auf Multi-GPU die dGPU statt der Display-GPU liefern
//! kann, verifiziert `run` die echte WGC-Capture-GPU und delegiert bei einer
//! unpassenden Vendor/Codec-Kombination selbst an `pipeline_d3d12` bzw.
//! `run_cpu_pipeline`. Kill-Switch `PULSE_HQ_DISABLE_ZERO_COPY=1` → CPU-Pfad.
//!
//! Der Encoder-Vendor wird aus der echten WGC-D3D11-Device-GPU abgeleitet
//! (`device_vendor`), NICHT aus `select_adapter()` — letzteres bevorzugt die
//! dGPU, die WGC-Device-GPU folgt aber dem primären Display.

use anyhow::{Result, anyhow};
use serde_json::json;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;

use crate::audio::AudioCapture;
use crate::capture::wgc::CaptureConfig;
use crate::capture::{HwCaptureItem, WgcHwCapture};
use crate::encode::{
    AudioStreamConfig, D3D11Scaler, EncodePath, FfmpegHwEncoder, HwEncoderConfig, OwnedHwFrame,
    VideoCodec,
};
use crate::events;
use crate::stream_controller::{StartParams, StreamController};
use crate::system::dxgi::Adapter;
use crate::tick_monitor::{TickMonitor, TickSample};

pub fn run(adapter: Adapter, params: StartParams, stop_rx: Receiver<()>) -> Result<()> {
    let ctrl = StreamController::singleton();

    let fps = params.override_fps.unwrap_or(params.profile.fps);
    let codec = params.codec();
    let bitrate = params
        .override_bitrate_kbps
        .unwrap_or(params.profile.bitrate_kbps);

    // Capture-D3D11VA-Pool: versorgt Capture-Queue + (im Native-Pfad) die
    // NVENC-In-Flight-Tiefe. Im Downscale-Pfad hat der Scaler einen eigenen
    // Ziel-Pool, dann muss dieser hier nur Capture-Queue + Scaler-Input-Halt
    // bedienen — 24 ist für beide Fälle robust.
    let mut capture = WgcHwCapture::start(
        params.capture.clone(),
        CaptureConfig { max_fps: fps, include_cursor: params.show_cursor, ..Default::default() },
        24,
    )?;

    // Setup-Item warten (mit erstem Pool-Frame). Bei Disconnect den echten
    // Capture-Fehler aus dem Worker-JoinHandle ziehen (`join_error`) — sonst
    // geht die Root-Cause (WGC-Close ohne Frame / HwContext::new-Fehler / …)
    // verloren und nur „channel disconnected" bleibt übrig. Timeout vs.
    // Disconnected trennen: Ersteres = WGC liefert nie (Target/Permission/HDR),
    // Zweiteres = Capture-Thread ist tatsächlich gecrasht/zu Ende.
    let setup = match capture.items.recv_timeout(Duration::from_secs(5)) {
        Ok(item) => item,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            return Err(anyhow!(
                "hw capture lieferte innerhalb von 5 s keinen ersten Frame \
                 (WGC-Capture startete, aber lieferte nichts — Target/Permission/HDR-Verdacht)"
            ));
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let worker_err = capture.join_error();
            return Err(anyhow!(
                "hw capture exit vor dem ersten Frame{}",
                worker_err
                    .map(|s| format!(": {s}"))
                    .unwrap_or_else(|| " (Thread clean beendet, nie ein Frame geliefert)".into())
            ));
        }
    };
    // Wall-clock-Zeitpunkt des Video-Origins (≈ first_qpc). Audio-Chunks ohne
    // QPC ankern hieran — NICHT an `started` (das liegt erst NACH der Encoder-
    // Erzeugung; der Setup-Versatz würde zum konstanten A/V-Offset).
    let origin_instant = Instant::now();
    let (hw, width, height, first, first_qpc) = match setup {
        HwCaptureItem::Setup { hw, width, height, first, first_qpc } => {
            (hw, width, height, first, first_qpc)
        }
        HwCaptureItem::Frame { .. } => return Err(anyhow!("first item was Frame, expected Setup")),
    };
    // Vendor der ECHTEN Capture/Encode-GPU (WGC-D3D11-Device). `adapter` aus
    // `select_adapter()` kann auf Multi-GPU eine andere GPU sein (dGPU-Default).
    let vendor = device_vendor(hw.device()).unwrap_or_else(|| adapter.vendor());

    // `encode_path` hier ein zweites Mal auswerten — jetzt mit dem ECHTEN
    // Vendor der WGC-Capture-GPU. Der Dispatcher entscheidet auf
    // `select_adapter()`, und das kann auf Multi-GPU die dGPU sein. Die Regel
    // selbst steht nur einmal (`encode/encoder.rs`).
    // Wohin delegiert wird, sagt `encode_path` selbst — die Zuordnung wird hier
    // NICHT ein zweites Mal ausgeschrieben. Genau das war der Fehler, den die
    // Zusammenführung in `encode_path` beseitigen sollte: zwei Fassungen
    // derselben Regel laufen auseinander, sobald eine Zelle dazukommt.
    let path = codec.encode_path(vendor);
    if path != EncodePath::D3d11ZeroCopy {
        drop(capture);
        drop(first);
        drop(hw);
        eprintln!(
            "[pipeline-hw] Capture-GPU ist {vendor}, Codec {codec:?} — Delegation an {path:?}"
        );
        return match path {
            EncodePath::D3d12ZeroCopy => crate::pipeline_d3d12::run(params, stop_rx, codec),
            _ => crate::stream_controller::run_cpu_pipeline(params, stop_rx),
        };
    }
    // Capture aspektwahrend in die Override-Box einpassen (`fit_within_box`:
    // kein Upscale, gerade Maße — deckt auch die NV12-Anforderung #7 ab). Bei
    // dst==src geht der Capture-Frame direkt in den Encoder; sonst skaliert der
    // `D3D11Scaler` per `VideoProcessorBlt` auf der GPU davor.
    let (dst_w, dst_h) = match params.override_resolution {
        Some((box_w, box_h)) => {
            crate::stream_controller::fit_within_box(width, height, box_w, box_h)
        }
        // Native: nur die NV12-Gerade-Rundung (Fenster-Capture liefert
        // beliebige Client-Größen), sonst unverändert.
        None => (width & !1, height & !1),
    };
    eprintln!(
        "[pipeline-hw] capture {width}x{height} → encode {dst_w}x{dst_h}@{fps} on {} (vendor={vendor})",
        adapter.description
    );

    // Audio-Pipeline gleicher Pfad wie CPU-Variante (WASAPI → libopus → 2. Spur).
    let audio_capture: Option<AudioCapture> = params.audio.as_ref().and_then(|src| {
        match AudioCapture::start(src.clone(), crate::encode::audio::capture_chunk_frames()) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[pipeline-hw] audio capture failed, video-only: {e:#}");
                None
            }
        }
    });
    let audio_cfg: Option<AudioStreamConfig> = audio_capture.as_ref().map(|_| AudioStreamConfig {
        av_offset_ms: params.av_offset_ms,
        ..AudioStreamConfig::DEFAULT
    });

    // Downscale-Pfad: GPU-Scaler (VideoProcessorBlt) zwischen Capture und
    // Encoder. Der Scaler hat einen eigenen D3D11VA-Ziel-Pool (dst-res, BGRA,
    // +RENDER_TARGET) — der Encoder bindet dann diesen statt des Capture-Pools.
    // Bei dst==src bleibt `scaler` None und der Encoder bindet den Capture-Pool.
    let scaler = if (dst_w, dst_h) != (width, height) {
        Some(
            D3D11Scaler::new(
                hw.device().clone(),
                // Safety: nur ein Clone (atomarer COM-AddRef), kein GPU-Befehl —
                // der Lock ist hier nicht nötig (s. `HwContext::device_context`).
                unsafe { hw.device_context() }.clone(),
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
    let make = |codec| {
        FfmpegHwEncoder::create(
            &HwEncoderConfig {
                codec,
                vendor: vendor.to_string(),
                fps,
                bitrate_kbps: bitrate,
                dst_w,
                dst_h,
            },
            hw_frames_ref,
            audio_cfg.clone(),
            &params.push_url,
        )
    };
    let encoder = match make(codec) {
        Ok(enc) => enc,
        // AMD steht hier regulär nur mit AV1 (s. `encode_path`). Ein Rückfall
        // auf H.264 darf deshalb NICHT hier stattfinden: H.264 hieße
        // `h264_amf` mit D3D11-Eingang, und genau dafür gibt es AMF-Issue #455.
        // AMD hat für H.264 einen erprobten eigenen Weg — dorthin abgeben.
        // (Gilt auch unter `PULSE_HQ_AMD_D3D11=1`: scheitert der Open dort, ist
        // der D3D12-Weg die richtige Antwort, nicht ein zweiter Versuch.)
        Err(e) if vendor == "amd" => {
            eprintln!(
                "[pipeline-hw] av1_amf nicht über D3D11 öffenbar ({e:#}) — \
                 Delegation an pipeline_d3d12 (H.264)"
            );
            // `audio_capture` MUSS mit weg. Ohne das liefe der WASAPI-Thread
            // die ganze Laufzeit des delegierten Streams weiter, während
            // `pipeline_d3d12` sich eine zweite Aufnahme startet — der
            // verwaiste Kanal läuft voll und der Worker dreht danach dauerhaft
            // in seiner Sende-Warteschleife.
            drop(scaler);
            drop(capture);
            drop(first);
            drop(hw);
            drop(audio_capture);
            return crate::pipeline_d3d12::run(params, stop_rx, VideoCodec::H264);
        }
        // AV1-NVENC gibt es erst ab Ada (RTX 40); ältere NVIDIA/Treiber liefern
        // beim Öffnen "function not implemented" → H.264 statt Abbruch.
        Err(e) if matches!(codec, VideoCodec::Av1) => {
            eprintln!("[pipeline-hw] av1 HW encoder nicht verfügbar ({e:#}) → Fallback H.264");
            make(VideoCodec::H264)?
        }
        Err(e) => return Err(e),
    };

    // ── Ab hier wird NICHTS mehr gedroppt ────────────────────────────────────
    // Die *grafische* Teardown-Sequenz (WGC-FramePool/Session schließen,
    // D3D11-Device + NVENC + Audio-Client freigeben, `nvEncodeAPI64.dll`
    // entladen) lässt einen treiber-internen Threadpool-Timer dangling zurück —
    // feuert der danach, springt er in freigegebenen Speicher → `0xC0000005`
    // exec-Fault auf einem `TpWaitForTimer`-Thread (mit Audio zuverlässig
    // reproduzierbar). Darum: gar kein Teardown. Capture-, Audio- und
    // Encoder-Objekte bleiben am Leben, ihre Threads laufen weiter. Der
    // Per-Stream-Sidecar endet unmittelbar nach dem `stop` (`dispatch`/`main` →
    // Prozess-Exit); `ExitProcess` terminiert ALLE Threads abrupt, bevor
    // irgendein Timer feuern kann, und gibt GPU-/COM-/Datei-Handles vollständig
    // frei.
    //
    // `ManuallyDrop` am Binding statt `mem::forget` am Funktionsende: Letzteres
    // deckte nur den Erfolgspfad ab. Jedes `?` im Pacing-Loop (Encoder-Fehler
    // bei RTMP-Stall, Capture-Disconnect) lief daran vorbei und droppte doch —
    // also genau der Crash, den die Konstruktion verhindern soll, und zwar
    // BEVOR `worker_finished` das `error`-Event senden konnte (der Renderer sah
    // einen toten Prozess statt einer Fehlermeldung). Am Binding gilt die
    // Zusage für JEDEN Ausgang, auch für später hinzukommende.
    let mut capture = std::mem::ManuallyDrop::new(capture);
    // `_hw`: wird ab hier nicht mehr gelesen, muss aber gebunden bleiben —
    // der Pool trägt die Frames, die noch durch den Loop laufen.
    let _hw = std::mem::ManuallyDrop::new(hw);
    let audio_capture = std::mem::ManuallyDrop::new(audio_capture);
    let mut scaler = std::mem::ManuallyDrop::new(scaler);
    let mut encoder = std::mem::ManuallyDrop::new(encoder);

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
    // A/V-Sync über echte Hardware-Timestamps (QPC): Video-PTS aus dem WGC-QPC
    // relativ zum QPC des ersten Frames (origin_qpc); Audio am selben origin
    // verankert → exakter Offset ohne Kalibrierung. qpc_sync aus / origin_qpc==0
    // (Timestamp n/a) → Fallback auf reine Wall-clock. Kill: PULSE_HQ_NO_AV_OFFSET=1.
    let qpc_sync = !crate::env::flag("PULSE_HQ_NO_AV_OFFSET") && first_qpc != 0;
    let origin_qpc = first_qpc;
    let mut newest_qpc = first_qpc;
    // Anker muss zum tatsächlichen Video-Origin passen: mit QPC-Sync ist PTS 0
    // der erste Frame (origin_instant), ohne die Wanduhr-Basis der Loop.
    encoder.set_audio_origin(
        if qpc_sync { origin_instant } else { started },
        if qpc_sync { Some(origin_qpc) } else { None },
    );
    let mut last_frame: Option<OwnedHwFrame> = Some(first);
    let mut last_pts: i64 = -1;
    let mut audio_dead = false;
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
                Ok(HwCaptureItem::Frame { frame: f, qpc }) => {
                    last_frame = Some(f);
                    if qpc != 0 {
                        newest_qpc = qpc;
                    }
                    captured += 1;
                }
                Ok(HwCaptureItem::Setup { .. }) => {
                    return Err(anyhow!("unexpected Setup item after pipeline init"));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    let worker_err = capture.join_error();
                    return Err(anyhow!(
                        "hw capture channel disconnected mid-stream{}",
                        worker_err
                            .map(|s| format!(": {s}"))
                            .unwrap_or_else(|| " (clean exit, keine Fehlermeldung)".into())
                    ));
                }
            }
        }
        let capture_drain = t_capture.elapsed();

        // Audio non-blocking nachziehen.
        let t_audio = Instant::now();
        if let Some(ac) = audio_capture.as_ref() {
            loop {
                match ac.samples.try_recv() {
                    // Audio-Fehler NICHT verschlucken (#3): bricht die Audio-Spur
                    // weg, stockt der 2-Stream-Muxer (rw_timeout) und der Stream
                    // stirbt ohnehin — dann lieber mit klarer Fehlermeldung.
                    Ok(chunk) => encoder
                        .send_audio(&chunk)
                        .map_err(|e| anyhow!("send_audio: {e:#}"))?,
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    // WASAPI-Worker gestorben (Gerät weg/invalidiert): video-only
                    // weiterlaufen, aber EINMAL sichtbar melden.
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        if !audio_dead {
                            audio_dead = true;
                            eprintln!("[pipeline-hw] audio capture beendet — Stream läuft ohne Ton weiter");
                            events::emit(json!({"ev": "log", "line": "Audio-Aufnahme abgebrochen (Gerät entfernt?) — Stream läuft ohne Ton weiter"}));
                        }
                        break;
                    }
                }
            }
        }
        let audio_drain = t_audio.elapsed();

        // Video-PTS aus dem Hardware-Capture-Timestamp (QPC) relativ zum origin;
        // Fallback auf Wall-clock. Streng monoton.
        let elapsed = if qpc_sync {
            (newest_qpc - origin_qpc) as f64 / 10_000_000.0
        } else {
            started.elapsed().as_secs_f64()
        };
        let mut pts = (elapsed * fps as f64).round() as i64;
        if pts <= last_pts {
            pts = last_pts + 1;
        }
        // Convert-Zeit: GPU-Scaler bei Downscale, 0 bei Native (NVENC macht
        // den BGRA→NV12-Convert selbst).
        let mut convert = Duration::ZERO;
        if let Some(frame) = last_frame.as_mut() {
            match &mut *scaler {
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
            enc_latency: encoder.take_encode_latency(),
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
    // gibt nichts frei (`finish` nimmt `&mut self`); capture/hw/scaler/encoder
    // sind `ManuallyDrop` (s.o.) und werden weder gestoppt noch freigegeben.
    // `last_frame` ist kein eigenes Binding oben, weil es im Loop neu zugewiesen
    // wird (der alte Frame MUSS dabei in den Pool zurück); nur der allerletzte
    // wird hier vom Teardown ausgenommen.
    std::mem::forget(last_frame);
    encoder.finish()?;
    Ok(())
}

/// Vendor-Slug der GPU hinter einem D3D11-Device — via `IDXGIDevice::GetAdapter`.
/// Maßgeblich ist die GPU, auf der WGC sein Device gebaut hat (= die des
/// primären Displays); der Encoder muss dazu passen (h264_nvenc / h264_amf).
/// `None` wenn die Abfrage fehlschlägt oder der Vendor unbekannt ist.
fn device_vendor(device: &ID3D11Device) -> Option<&'static str> {
    crate::system::dxgi::device_vendor(device)
}
