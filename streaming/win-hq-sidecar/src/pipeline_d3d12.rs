//! Zero-Copy-Encode-Pfad für AMD-GPUs (`h264_d3d12va` & Co.) — Phase 2.
//!
//! AMD kann kein D3D11-Zero-Copy (`h264_amf`-Crash, Issue #455). FFmpeg 8.1
//! hat aber native D3D12VA-Encoder, die die AMF-Runtime umgehen. Phase 2 macht
//! den Pfad zero-copy:
//!
//! ```text
//! WGC → ID3D11Texture2D (BGRA)                     [capture/wgc_d3d12.rs]
//!   └─ Shared-NT-Handle (BGRA, D3D11→D3D12)
//!        └─ ID3D12Resource (BGRA)
//!             └─ D3D12-Compute BGRA→NV12           [encode/d3d12_convert.rs]
//!                  └─ h264_d3d12va NV12-Pool-Frame [encode/encoder_d3d12.rs]
//!                       └─ Encode → Mux → Push
//! ```
//!
//! Kein PCIe-Roundtrip, kein CPU-swscale. Die Capture bleibt zwangsläufig
//! D3D11 (Windows hat keine D3D12-Bildschirmaufnahme); alles danach ist
//! D3D12-only. Dispatch: `VideoCodec::encode_path` schickt **AMD mit
//! H.264/HEVC** hierher — AV1 nicht, s. `run`.
//! `PULSE_HQ_DISABLE_ZERO_COPY=1` erzwingt weiterhin den CPU-Pfad
//! (`run_cpu_pipeline`, `h264_amf` mit Software-NV12) — Sicherheitsventil.

use anyhow::{Result, anyhow};
use serde_json::json;
use std::ffi::c_void;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Graphics::Direct3D12::{ID3D12Device, ID3D12Resource};

use crate::audio::AudioCapture;
use crate::capture::wgc::CaptureConfig;
use crate::capture::wgc_d3d12::{D3d12CaptureItem, WgcD3d12Capture};
use crate::encode::d3d12_convert::Nv12Converter;
use crate::encode::{AudioStreamConfig, D3d12EncoderConfig, FfmpegD3d12Encoder, VideoCodec};
use crate::events;
use crate::stream_controller::{StartParams, StreamController, emit_state};
use crate::tick_monitor::{TickMonitor, TickSample};

/// `codec` kommt vom Aufrufer, nicht aus `params`: nach einem Rückfall aus
/// `pipeline_hw` läuft hier ein anderer Codec als der angeforderte, und diese
/// Abweichung soll an der Aufrufstelle sichtbar sein statt hier drin zu
/// entstehen.
pub fn run(params: StartParams, stop_rx: Receiver<()>, codec: VideoCodec) -> Result<()> {
    // **AV1 gehört nicht auf diesen Pfad, und der Grund ist schwerwiegender als
    // lange angenommen.** Bislang stand hier, `av1_d3d12va` liefere keine
    // extradata und für AV1 (OBUs statt NALs) lasse sich kein avcC bauen. Das
    // stimmt, ist aber nur das erste Hindernis. Am 2026-07-30 auf einer
    // Radeon 780M (Treiber 32.0.31035.1003, FFmpeg n8.1.1) gemessen:
    //
    // 1. `av1_d3d12va` öffnet nur bei **Breite % 64 == 0 und Höhe % 16 == 0**
    //    (AMDs `64x16`-Ausrichtung). 1920x1080 scheitert schon am Anlegen des
    //    Encoder-Heaps, 1920x1088 läuft. 21 Auflösungen geprüft, die Regel sagt
    //    alle korrekt vorher.
    // 2. Wo er öffnet, ist der **Bitstrom unbrauchbar**: dav1d („Error parsing
    //    frame header"), libaom („Corrupt frame detected") und FFmpegs nativer
    //    AV1-Decoder lehnen ihn ab — in zwei Containern, bei 720p wie 1088p,
    //    schon beim Keyframe. Die OBU-Struktur ist dabei gültig und der
    //    Sequence-Header parst sauber; es sind die Bilddaten selbst.
    //    `h264_d3d12va` und `hevc_d3d12va` aus derselben Encoder-Familie
    //    dekodieren fehlerfrei — es liegt also nicht am Weg hierher.
    //
    // **Wer hier landet, ist nicht der Regelfall.** AV1 auf AMD geht seit dem
    // 2026-07-30 über den D3D11-Zero-Copy-Weg (`av1_amf`), und der ist der
    // Standard. Hierher kommt AV1 nur noch über den Auffangweg aus
    // `pipeline_hw` — also dann, wenn der AMF-Open über D3D11 gescheitert ist
    // (die Konstellation aus AMF-Issue #455).
    //
    // Bleibt dann der CPU-Pfad, und der ist teuer: gemessen 113 % einer
    // CPU-Kerne und 42 übersprungene Bilder in 20 s (1440p-Capture → 1080p60).
    // Teuer und richtig schlägt billig und falsch — die Alternative wäre, den
    // Codec still auf H.264 zu wechseln.
    //
    // **Hier stand, AV1 über D3D11 sei „geprüft und verworfen, er liefert ein
    // sichtbar zerrissenes Bild".** Das galt für den Texture-Array-Pool; seit
    // dem Einzeltextur-Pool (`hwctx.rs`) ist das Bild dort sauber, und genau
    // deshalb ist dieser Weg heute der Standard. Der Satz stammt vom
    // 2026-07-30, aus den Tagen vor dem Fix.
    if matches!(codec, VideoCodec::Av1) {
        eprintln!(
            "[pipeline-d3d12] AV1 ist über d3d12va auf AMD unbrauchbar — Fallback auf CPU-Pfad (av1_amf)"
        );
        return crate::stream_controller::run_cpu_pipeline(params, stop_rx);
    }

    let ctrl = StreamController::singleton();

    let fps = params.override_fps.unwrap_or(params.profile.fps);
    let bitrate = params
        .override_bitrate_kbps
        .unwrap_or(params.profile.bitrate_kbps);

    // ── Capture-Bridge: WGC → teilbare D3D11-BGRA-Texturen.
    let capture = WgcD3d12Capture::start(
        params.capture.clone(),
        CaptureConfig {
            max_fps: fps,
            include_cursor: params.show_cursor,
            ..Default::default()
        },
    )?;

    // Auf `Setup` warten — liefert Capture-Dimensionen + die Ring-NT-Handles.
    let (cap_w, cap_h, handles) = loop {
        match capture.items.recv_timeout(Duration::from_secs(5)) {
            Ok(D3d12CaptureItem::Setup { width, height, handles }) => break (width, height, handles),
            Ok(D3d12CaptureItem::Frame { slot, .. }) => {
                // Vor Setup nicht möglich — defensiv: Slot zurückgeben.
                let _ = capture.free_tx.send(slot);
            }
            Err(e) => return Err(anyhow!("never got capture setup: {e}")),
        }
    };

    // Capture aspektwahrend in die Override-Box einpassen (`fit_within_box`:
    // kein Upscale, gerade Maße — deckt auch die NV12-/hwframes-Pool-Anforderung
    // #7 ab).
    let (dst_w, dst_h) = match params.override_resolution {
        Some((box_w, box_h)) => {
            crate::stream_controller::fit_within_box(cap_w, cap_h, box_w, box_h)
        }
        // Native: nur die NV12-Gerade-Rundung (Fenster-Capture liefert
        // beliebige Client-Größen), sonst unverändert.
        None => (cap_w & !1, cap_h & !1),
    };
    eprintln!(
        "[pipeline-d3d12] zero-copy: capture {cap_w}x{cap_h} → encode {dst_w}x{dst_h}@{fps} via {}",
        codec.d3d12va_name()
    );

    // ── Audio-Pipeline (WASAPI → libopus → zweite FLV-Spur).
    let audio_capture: Option<AudioCapture> = params.audio.as_ref().and_then(|src| {
        match AudioCapture::start(src.clone(), crate::encode::audio::capture_chunk_frames()) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[pipeline-d3d12] audio capture failed, video-only: {e:#}");
                None
            }
        }
    });
    let audio_cfg: Option<AudioStreamConfig> = audio_capture.as_ref().map(|_| AudioStreamConfig {
        av_offset_ms: params.av_offset_ms,
        ..AudioStreamConfig::DEFAULT
    });

    // ── Encoder (erzeugt D3D12-Device + UAV-fähigen NV12-Pool).
    let encoder = FfmpegD3d12Encoder::create(
        &D3d12EncoderConfig {
            codec,
            src_width: cap_w,
            src_height: cap_h,
            dst_width: dst_w,
            dst_height: dst_h,
            fps,
            bitrate_kbps: bitrate,
        },
        audio_cfg,
        &params.push_url,
    )?;

    // ── Ring-Handles auf FFmpegs D3D12-Device öffnen + Converter bauen.
    // Explizite Schleife statt `collect::<Result<_>>()`: Letzteres bricht beim
    // ersten Fehler ab und ruft `open_shared_bgra` (das seinen Handle immer
    // schließt) für die restlichen Einträge nie auf — deren NT-Handles blieben
    // für die Prozess-Lebensdauer offen.
    let device = encoder.device();
    let mut bgra_resources: Vec<ID3D12Resource> = Vec::with_capacity(handles.len());
    let mut open_err: Option<anyhow::Error> = None;
    for &h in &handles {
        if open_err.is_none() {
            match open_shared_bgra(&device, h) {
                Ok(r) => bgra_resources.push(r),
                Err(e) => open_err = Some(e),
            }
        } else {
            unsafe {
                let _ = CloseHandle(HANDLE(h as *mut c_void));
            }
        }
    }
    if let Some(e) = open_err {
        return Err(e);
    }
    let converter = Nv12Converter::new(device, dst_w, dst_h)?;

    // Ab hier wird NICHTS mehr gedroppt — Begründung + Mechanik ausführlich in
    // `pipeline_hw::run`. Am Binding statt per `mem::forget` am Funktionsende,
    // damit die Zusage auch für die Fehler-Ausgänge gilt (Capture-Disconnect,
    // Encoder-Fehler im Pacing-Loop) und nicht nur für den Erfolgspfad.
    let mut capture = std::mem::ManuallyDrop::new(capture);
    let audio_capture = std::mem::ManuallyDrop::new(audio_capture);
    let mut encoder = std::mem::ManuallyDrop::new(encoder);
    let mut converter = std::mem::ManuallyDrop::new(converter);

    // Auf den ersten echten Capture-Frame warten. Bei Disconnect den echten
    // Capture-Fehler aus dem Worker ziehen (`join_error`) — sonst bleibt nur
    // die wertlose „channel disconnected"-Meldung (s. pipeline_hw).
    let (mut current_slot, first_qpc): (usize, i64) = loop {
        match capture.items.recv_timeout(Duration::from_secs(5)) {
            Ok(D3d12CaptureItem::Frame { slot, qpc }) => break (slot, qpc),
            Ok(D3d12CaptureItem::Setup { .. }) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(anyhow!("never got first capture frame: timeout"));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let worker_err = capture.join_error();
                return Err(anyhow!(
                    "capture exit vor dem ersten Frame{}",
                    crate::capture::worker_err_suffix(
                        worker_err,
                        "Thread clean beendet, nie ein Frame geliefert"
                    )
                ));
            }
        }
    };
    // Wall-clock-Zeitpunkt des Video-Origins (≈ first_qpc) für den Audio-
    // Anker ohne QPC — s. pipeline_hw.
    let origin_instant = Instant::now();

    ctrl.set_state("live");
    emit_state("live", true, 0.0);

    // ── Frame-Pacing wie GSR. Fixe Kadenz; bei statischem Bild wird derselbe
    // Ring-Slot erneut konvertiert+encodet (Frame-Duplizierung) — sonst stockt
    // der RTMP-Push und MediaMTX kappt die Verbindung. Der aktuelle Slot bleibt
    // beim Pacing-Loop, bis ein neuerer ankommt (dann geht der alte zurück in
    // den Ring) — so kann der Capture-Thread die anderen Slots befüllen.
    let frame_dur = Duration::from_secs_f64(1.0 / fps as f64);
    let started = Instant::now();
    // A/V-Sync über echte Hardware-Timestamps (QPC) — s. pipeline_hw. Fallback
    // auf Wall-clock wenn qpc_sync aus / origin_qpc==0. Kill: PULSE_HQ_NO_AV_OFFSET=1.
    let qpc_sync = !crate::env::flag("PULSE_HQ_NO_AV_OFFSET") && first_qpc != 0;
    let origin_qpc = first_qpc;
    crate::syncprobe::video_origin(origin_qpc);
    let mut newest_qpc = first_qpc;
    // Anker muss zum tatsächlichen Video-Origin passen — s. pipeline_hw.
    encoder.set_audio_origin(
        if qpc_sync { origin_instant } else { started },
        if qpc_sync { Some(origin_qpc) } else { None },
    );
    let mut last_pts: i64 = -1;
    let mut audio_dead = false;
    let mut frames_sent: u64 = 0;
    let mut next_tick = started;
    let mut last_fps_emit = started;
    let mut monitor = TickMonitor::new(fps);
    let mut prev_pts: i64 = 0;

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        let planned = next_tick;
        let now = Instant::now();
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        }
        next_tick += frame_dur;
        let now = Instant::now();
        if next_tick < now {
            next_tick = now;
        }

        let iter_start = Instant::now();
        let wake_jitter = iter_start.saturating_duration_since(planned);

        // Neue Capture-Frames abholen, neuesten Slot behalten; ältere Slots
        // zurück in den Ring. Nichts Neues → `current_slot` bleibt (Dup).
        let t_capture = Instant::now();
        let mut captured: u32 = 0;
        loop {
            match capture.items.try_recv() {
                Ok(D3d12CaptureItem::Frame { slot, qpc }) => {
                    let old = std::mem::replace(&mut current_slot, slot);
                    let _ = capture.free_tx.send(old);
                    if qpc != 0 {
                        newest_qpc = qpc;
                        crate::syncprobe::video_frame_age(qpc);
                    }
                    captured += 1;
                }
                Ok(D3d12CaptureItem::Setup { .. }) => {}
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    // Echte Root-Cause aus dem Worker ziehen — s. pipeline_hw.
                    let worker_err = capture.join_error();
                    return Err(anyhow!(
                        "capture channel disconnected mid-stream{}",
                        crate::capture::worker_err_suffix(
                            worker_err,
                            "clean exit, keine Fehlermeldung"
                        )
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
                    // Audio-Fehler NICHT verschlucken (#3) — s. pipeline_hw.
                    Ok(chunk) => encoder
                        .send_audio(&chunk)
                        .map_err(|e| anyhow!("send_audio: {e:#}"))?,
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    // WASAPI-Worker gestorben: video-only weiter, EINMAL melden.
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        if !audio_dead {
                            audio_dead = true;
                            eprintln!("[pipeline-d3d12] audio capture beendet — Stream läuft ohne Ton weiter");
                            events::emit(json!({"ev": "log", "line": "Audio-Aufnahme abgebrochen (Gerät entfernt?) — Stream läuft ohne Ton weiter"}));
                        }
                        break;
                    }
                }
            }
        }
        let audio_drain = t_audio.elapsed();

        // Video-PTS aus dem HW-Capture-Timestamp (QPC) relativ zum origin;
        // Fallback Wall-clock. Streng monoton.
        let elapsed = if qpc_sync {
            (newest_qpc - origin_qpc) as f64 / 10_000_000.0
        } else {
            started.elapsed().as_secs_f64()
        };
        let mut pts = (elapsed * fps as f64).round() as i64;
        if pts <= last_pts {
            pts = last_pts + 1;
        }

        // Zero-Copy: Pool-Frame holen → Compute-Convert BGRA→NV12 direkt rein
        // → encoden. `convert` ist synchron (GPU-Fence-Wait).
        let t_convert = Instant::now();
        let mut hw = encoder.acquire_frame()?;
        let nv12 = hw.resource()?;
        converter.convert(&bgra_resources[current_slot], &nv12)?;
        let convert = t_convert.elapsed();

        encoder.send_frame(&mut hw, pts)?;
        last_pts = pts;
        frames_sent += 1;

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

    // Stream finalisieren (Trailer/RTMP-Close). Kein Teardown: Capture,
    // Encoder und Converter sind `ManuallyDrop` (s.o.) — ohne das triggert die
    // grafische Freigabe den Threadpool-Timer-UAF bzw. `avcodec_free_context`
    // crasht. `ExitProcess` räumt nach dem `stop` sauber auf.
    encoder.finish()?;
    Ok(())
}

/// Öffnet einen Capture-Ring-NT-Handle auf FFmpegs D3D12-Device.
fn open_shared_bgra(device: &ID3D12Device, handle_val: isize) -> Result<ID3D12Resource> {
    let handle = HANDLE(handle_val as *mut c_void);
    let mut res: Option<ID3D12Resource> = None;
    let open_result = unsafe { device.OpenSharedHandle(handle, &mut res) };
    // D3D12 hält nach OpenSharedHandle eine eigene Referenz auf die Resource —
    // der ursprüngliche NT-Handle (aus CreateSharedHandle in wgc_d3d12.rs) wird
    // jetzt nicht mehr gebraucht und muss geschlossen werden, sonst leakt pro
    // Ring-Slot ein Handle. Auf allen Pfaden schließen (auch bei Open-Fehler).
    unsafe {
        let _ = CloseHandle(handle);
    }
    open_result.map_err(|e| anyhow!("OpenSharedHandle(BGRA-Ring-Slot): {e}"))?;
    res.ok_or_else(|| anyhow!("D3D12-BGRA-Resource NULL"))
}
