//! CPU-Encode-Pfad: WGC-CPU-Readback → swscale BGRA→NV12 → FFmpeg-Encoder
//! (`encoder.rs`). Zuständig für Intel (QSV) und für jeden Vendor unter
//! `PULSE_HQ_DISABLE_ZERO_COPY=1`; `pipeline_hw` delegiert hierher, wenn
//! `encode_path` für die echte Capture-GPU [`EncodePath::Cpu`] sagt.
//!
//! **Der teuerste Weg im Sidecar**, und das ist gemessen: der swscale
//! BGRA→NV12 kostete bei 1440p-Capture → 1080p60 eine volle CPU-Kerne und ließ
//! den Pacing-Loop in 20 s 42 Bilder überspringen. Wo ein GPU-Pfad zur
//! Verfügung steht, gehört der Stream dorthin.

use anyhow::{Result, anyhow};
use serde_json::json;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use crate::audio::AudioCapture;
use crate::capture::wgc::{CaptureConfig, CapturedFrame, WgcCapture};
use crate::encode::{AudioStreamConfig, EncoderConfig, FfmpegEncoder, VideoCodec};
use crate::events;
use crate::system::gpu_wahl;
use crate::tick_monitor::{TickMonitor, TickSample};

use super::{StartParams, StreamController, emit_state, fit_within_box, select_adapter};
use crate::zeitbasis;

pub(crate) fn run_cpu_pipeline(params: StartParams, stop_rx: Receiver<()>) -> Result<()> {
    let ctrl = StreamController::singleton();
    (|| -> Result<()> {
        // Im CPU-Pfad gehen Software-NV12-Frames in den Encoder — die GPU lädt
        // sie selbst hoch, sie muss kein Display treiben.
        //
        // **Die Entscheidung des Verteilers nachschlagen, nicht neu herleiten.**
        // `params.gpu` trägt die bereits gefallene Wahl; sie noch einmal aus
        // `gpu_wunsch` abzuleiten käme zwar zum selben Ergebnis, wäre aber eine
        // zweite Herleitung derselben Sache — und die zweite ist es, die eines
        // Tages abweicht. Nur wenn nichts entschieden wurde (dieser Weg ist
        // auch ohne Verteiler erreichbar), fragt der Aufruf selbst.
        let wunsch = match params.gpu {
            Some((vendor_id, device_id)) => gpu_wahl::Wunsch::Genau { vendor_id, device_id },
            None => params.gpu_wunsch.clone(),
        };
        let adapter = select_adapter(&wunsch)?;
        let mut capture = WgcCapture::start(
            params.capture.clone(),
            CaptureConfig {
                max_fps: params.override_fps.unwrap_or(params.profile.fps),
                include_cursor: params.show_cursor,
                // Auf DERSELBEN Karte aufnehmen, die der Verteiler gewählt hat.
                gpu: params.gpu,
                ..Default::default()
            },
        )?;

        // Warmup-Frame für native Dimensions. Bei Disconnect den echten
        // Capture-Fehler aus dem Worker ziehen (`join_error`) — sonst bleibt
        // nur die wertlose „channel disconnected"-Meldung (s. pipeline_hw).
        let first = match capture.frames.recv_timeout(Duration::from_secs(5)) {
            Ok(f) => f,
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
        };
        // Wall-clock-Zeitpunkt des Video-Origins (≈ first.qpc). Audio-Chunks
        // ohne QPC ankern hieran — NICHT an `started` (liegt erst NACH der
        // Encoder-Erzeugung, der Setup-Versatz würde zum konstanten A/V-Offset).
        let origin_instant = Instant::now();

        let mut codec = params.codec();
        // WHIP-Ziel (App-gehostete Instanz): FFmpegs WHIP-Muxer trägt nur
        // H.264-Video → ausweichen statt beim write_header hart zu scheitern
        // (wie Linux/Mac-Sidecar).
        //
        // **Nur wenn wirklich jener Muxer das Ziel ist.** Ist ein eigener
        // Sendeweg angemeldet (`encode::senke`), gilt die Einschränkung nicht —
        // der trägt AV1. Ein Rückfall hier wäre dann eine stille Codec-
        // Änderung: der Stream liefe, und jede Messung stünde unter falschem
        // Etikett. Genau das ist auf der Linux-Seite am 2026-07-30 passiert.
        if crate::encode::output::is_whip_url(&params.push_url)
            && !crate::encode::senke::zustaendig(&params.push_url)
            && !matches!(codec, VideoCodec::H264)
        {
            eprintln!("[stream-pipeline] Codec {codec:?} über WHIP nicht verfügbar → Fallback auf H264");
            codec = VideoCodec::H264;
        }
        let fps = params.override_fps.unwrap_or(params.profile.fps);
        let bitrate = params
            .override_bitrate_kbps
            .unwrap_or(params.profile.bitrate_kbps);

        // Audio-Pipeline: WASAPI-Capture + libopus-Encode + zweite FLV-Spur.
        // Wenn `params.audio = None` (mode=Aus) oder die Capture fehlschlägt,
        // läuft der Stream video-only weiter.
        let audio_capture: Option<AudioCapture> = params.audio.as_ref().and_then(|src| {
            match AudioCapture::start(src.clone(), crate::encode::audio::capture_chunk_frames()) {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("[stream-pipeline] audio capture failed, continuing video-only: {e:#}");
                    None
                }
            }
        });
        let audio_cfg: Option<AudioStreamConfig> = audio_capture.as_ref().map(|_| AudioStreamConfig {
            av_offset_ms: params.av_offset_ms,
            ..AudioStreamConfig::DEFAULT
        });

        // dst_width/dst_height: Capture aspektwahrend in die Override-Box einpassen
        // (kein Upscale; Box ≥ Capture → native Maße). Bei dst==src degeneriert
        // swscale zu reinem Format-Convert; sonst triggert `FfmpegEncoder::create`
        // automatisch den Downscale-Pfad.
        let (dst_w, dst_h) = match params.override_resolution {
            Some((box_w, box_h)) => fit_within_box(first.width, first.height, box_w, box_h),
            None => (first.width, first.height),
        };
        if (dst_w, dst_h) != (first.width, first.height) {
            eprintln!(
                "[stream-pipeline] downscale {}x{} -> {}x{} (aspektwahrend)",
                first.width, first.height, dst_w, dst_h
            );
        }
        let encoder = FfmpegEncoder::create(
            &EncoderConfig {
                codec,
                vendor: adapter.vendor().to_string(),
                src_width: first.width,
                src_height: first.height,
                dst_width: dst_w,
                dst_height: dst_h,
                fps,
                bitrate_kbps: bitrate,
            },
            audio_cfg,
            &params.push_url,
        )?;

        // Ab hier NIE mehr droppen — Begründung + Mechanik: `pipeline_hw::run`.
        // Am Binding festgemacht (nicht erst per `mem::forget` am Ende), damit
        // die Zusage auch für jeden Fehler-Ausgang aus dem Pacing-Loop gilt.
        let mut capture = std::mem::ManuallyDrop::new(capture);
        let audio_capture = std::mem::ManuallyDrop::new(audio_capture);
        let mut encoder = std::mem::ManuallyDrop::new(encoder);

        ctrl.set_state("live");
        emit_state("live", true, 0.0);

        // Frame-Pacing wie GSR (Details: `pipeline_hw.rs`). WGC ist change-
        // driven — der Encode-Loop läuft mit fester Kadenz und dupliziert bei
        // statischem Bild den letzten Frame, statt im Capture-Takt zu encoden.
        // Ohne das stockt der RTMP-Push und MediaMTX killt die Verbindung.
        let frame_dur = Duration::from_secs_f64(1.0 / fps as f64);
        let expected = (first.width, first.height);
        let first_qpc = first.qpc;
        let started = Instant::now();
        // A/V-Sync über echte Hardware-Timestamps (QPC) — s. pipeline_hw.
        // Fallback Wall-clock wenn qpc_sync aus / origin_qpc==0.
        // Kill-Switch: PULSE_HQ_NO_AV_OFFSET=1.
        let qpc_sync = !crate::env::flag("PULSE_HQ_NO_AV_OFFSET") && first_qpc != 0;
        let origin_qpc = first_qpc;
        crate::syncprobe::video_origin(origin_qpc);
        let mut newest_qpc = first_qpc;
        // Anker muss zum tatsächlichen Video-Origin passen: mit QPC-Sync ist
        // PTS 0 der erste Frame (origin_instant), ohne QPC-Sync die Wanduhr-
        // Basis der Pacing-Loop (started).
        encoder.set_audio_origin(
            if qpc_sync { origin_instant } else { started },
            if qpc_sync { Some(origin_qpc) } else { None },
        );
        let mut last_frame: Option<CapturedFrame> = Some(first);
        let mut last_pts: i64 = -1;
        let mut audio_dead = false;
        // Resize-Handling wie im HW-/D3D12-Pfad (`RESIZE_RESTART_THRESHOLD` in
        // wgc_hw.rs/wgc_d3d12.rs, gleicher Wert): der CPU-Pfad filtert
        // abweichende Maße hier im Loop (Encoder ist auf `expected` allokiert)
        // — ohne Zähler wäre ein Fenster-Resize ein stilles Dauer-Standbild.
        const RESIZE_RESTART_THRESHOLD: u32 = 120;
        let mut resize_mismatches: u32 = 0;
        let mut frames_sent: u64 = 0;
        let mut next_tick = started;
        let mut last_fps_emit = started;
        // Mikro-Stutter-Diagnose — identische Instrumentierung wie der
        // NVIDIA-Pfad (`pipeline_hw.rs`), s. `tick_monitor.rs`.
        let mut monitor = TickMonitor::new(fps);
        let mut prev_pts: i64 = 0;

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            // Bis zum nächsten Tick warten (High-Res-Sleep auf Win10+/Rust).
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

            // Ab hier wird Arbeit gemessen (ohne den Pacing-Sleep).
            let iter_start = Instant::now();
            let wake_jitter = iter_start.saturating_duration_since(planned);

            // Capture-Frames abholen, neuesten passenden behalten; ältere
            // verwerfen. Nichts Neues → `last_frame` bleibt (Duplizierung).
            let t_capture = Instant::now();
            let mut captured: u32 = 0;
            loop {
                match capture.frames.try_recv() {
                    Ok(f) => {
                        if (f.width, f.height) == expected {
                            if f.qpc != 0 {
                                newest_qpc = f.qpc;
                            }
                            last_frame = Some(f);
                            captured += 1;
                            resize_mismatches = 0;
                        } else {
                            // Größe hat sich geändert (Fenster-Resize/DPI):
                            // Frame verwerfen, aber zählen + einmalig loggen;
                            // nach der Karenz sauber beenden statt für immer
                            // ein Standbild zu streamen.
                            resize_mismatches += 1;
                            if resize_mismatches == 1 {
                                eprintln!(
                                    "[stream-pipeline] capture size changed: {}x{} -> {}x{}",
                                    expected.0, expected.1, f.width, f.height
                                );
                            }
                            if resize_mismatches >= RESIZE_RESTART_THRESHOLD {
                                return Err(anyhow!(
                                    "{}: {}x{} -> {}x{} — stream must be restarted",
                                    crate::capture::RESIZE_ERROR_MARKER,
                                    expected.0,
                                    expected.1,
                                    f.width,
                                    f.height
                                ));
                            }
                        }
                    }
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

            // Audio non-blocking nachziehen — leert den Channel auch bei
            // `audio_cfg = None`, damit WASAPI weiter buffern kann.
            let t_audio = Instant::now();
            if let Some(ac) = audio_capture.as_ref() {
                loop {
                    match ac.samples.try_recv() {
                        // Audio-Fehler NICHT verschlucken (#3) — s. pipeline_hw.
                        Ok(chunk) => encoder
                            .send_audio(&chunk)
                            .map_err(|e| anyhow!("send_audio: {e:#}"))?,
                        Err(std::sync::mpsc::TryRecvError::Empty) => break,
                        // WASAPI-Worker gestorben (Gerät weg/invalidiert): der
                        // Stream läuft video-only weiter — aber EINMAL sichtbar
                        // melden statt für immer still zu verstummen.
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            if !audio_dead {
                                audio_dead = true;
                                eprintln!("[stream-pipeline] audio capture beendet — Stream läuft ohne Ton weiter");
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
            // In Takten der Video-Zeitbasis, NICHT in Bildplaetzen — die echte
            // Aufnahmezeit bleibt damit erhalten (Begruendung in `crate::zeitbasis`).
            // Duplikate (`captured == 0`) kommen aus dem ZAEHLER: sie haben keine
            // eigene Aufnahmezeit, `newest_qpc` steht still. In Takten waere die
            // Monotonie-Untergrenze nur 11 us — ein Standbild schrumpfte damit im
            // Strom zusammen. Ausfuehrlich an derselben Stelle in `pipeline_hw`.
            let mut pts = if captured > 0 {
                zeitbasis::pts_aus_sekunden(elapsed)
            } else {
                last_pts + zeitbasis::takte_je_bild(fps)
            };
            if pts <= last_pts {
                pts = last_pts + 1;
            }
            if let Some(frame) = last_frame.as_ref() {
                encoder.send(frame, pts)?;
                last_pts = pts;
                frames_sent += 1;
            }

            // Tick verbuchen. `convert`/`send`/`mux` kommen aus dem Encoder
            // (swscale, AMF/QSV-Submit, Queue-Einreihung); `iter` ist die
            // Arbeitszeit ohne Pacing-Sleep.
            let iter = iter_start.elapsed();
            monitor.record(&TickSample {
                wake_jitter,
                capture_drain,
                captured,
                audio_drain,
                convert: Duration::from_micros(encoder.last_convert_us()),
                send: Duration::from_micros(encoder.last_send_us()),
                mux: Duration::from_micros(encoder.last_mux_us()),
                iter,
                pts,
                pts_delta: pts - prev_pts,
                capture_drops: capture.dropped(),
                // Nur der D3D11-Weg misst das, s. `pipeline_d3d12`.
                rueckruf: Default::default(),
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

        // Stream finalisieren (Trailer/RTMP-Close); `finish` gibt nichts frei.
        // capture/audio_capture/encoder sind `ManuallyDrop` (s.o.) und werden
        // hier bewusst weder gestoppt noch freigegeben.
        encoder.finish()?;
        Ok(())
    })()
}
