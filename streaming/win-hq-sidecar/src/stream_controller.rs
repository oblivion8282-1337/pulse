//! Stream-Controller — verwaltet den Capture-Encode-Push-Worker-Thread.
//!
//! Singleton (`StreamController::singleton()`) → genau eine aktive Stream-
//! Session zur Zeit (1:1 wie `gsr-sidecar/stream_controller.py`). Methoden:
//!
//! - `start(params)` — spawnt Worker, returnt sofort mit redaktierter argv
//!   (analog Linux). Worker emittiert `state`-Events (`starting`→`live`→
//!   `stopped`), `fps`-Events alle paar Sekunden, `log`/`error`-Events bei
//!   Bedarf.
//! - `stop()` — signalisiert dem Worker zu beenden. Worker schließt RTMP-
//!   Verbindung sauber (`encoder.finish()` schreibt FLV-Trailer).
//! - `state()` — gibt den aktuellen Zustand zurück (für `state`-Op).
//!
//! Threading-Modell: jede Methode hält den `state`-Mutex nur kurz; der Worker-
//! Thread läuft daneben und published Events asynchron via `crate::events::emit`.

use anyhow::{Context, Result, anyhow};
use serde_json::json;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::audio::{AudioCapture, AudioSource};
use crate::capture::CaptureSource;
use crate::capture::wgc::{CaptureConfig, CapturedFrame, WgcCapture};
use crate::encode::{AudioStreamConfig, EncoderConfig, FfmpegEncoder, VideoCodec};
use crate::events;
use crate::profiles::StreamProfile;
use crate::system::dxgi;
use crate::tick_monitor::{TickMonitor, TickSample};

/// Wie lange `stop()` maximal auf das Auslaufen des Worker-Threads wartet,
/// bevor es ihn aufgibt. Der Worker terminiert nach dem Stop-Signal selbst
/// (`rw_timeout` im Encoder kappt jeden Netzwerk-Stall auf ~10 s) — dieser
/// Wert ist nur ein Sicherheitsnetz gegen einen wider Erwarten wedged Worker.
/// Bewusst unter dem `stop`-Op-Timeout in `sidecar.ts` (15 s).
const STOP_JOIN_TIMEOUT: Duration = Duration::from_secs(13);

/// Snapshot des Stream-Zustandes — was die `state`-Op zurückliefert.
#[derive(Debug, Clone)]
pub struct StreamSnapshot {
    pub running: bool,
    pub state: &'static str, // "idle" | "starting" | "live" | "error" | "stopped"
    pub fps: Option<f64>,
    pub uptime_s: Option<f64>,
    pub argv_redacted: Option<Vec<String>>,
}

impl StreamSnapshot {
    fn idle() -> Self {
        Self {
            running: false,
            state: "idle",
            fps: None,
            uptime_s: None,
            argv_redacted: None,
        }
    }
}

/// Felder die `start` aus dem JSON-Request bekommt (analog zu `start` in
/// `gsr-sidecar/control.py`).
#[derive(Debug, Clone)]
pub struct StartParams {
    /// Encoder-Sockel für alle nicht gesetzten Overrides (`profiles::BASELINE`).
    pub profile: &'static StreamProfile,
    /// Reines Etikett aus der `start`-Anfrage — taucht nur in der Diagnose-argv
    /// auf und beeinflusst die Encoder-Konfiguration nicht.
    pub profile_name: String,
    pub channel_id: String,
    pub token: String,
    pub push_url: String,
    pub capture: CaptureSource,
    pub audio: Option<AudioSource>,
    pub override_codec: Option<VideoCodec>,
    pub override_bitrate_kbps: Option<u32>,
    pub override_fps: Option<u32>,
    /// Auflösungs-BOX (z.B. 1920x1080), in die das Capture-Bild aspektwahrend
    /// eingepasst wird (`fit_within_box`) — ein 21:9-Monitor wird bei "1080p"
    /// also 1920x804, nicht auf 16:9 gestaucht. `None` = capture-native.
    /// Upscale gibt es nie (Box größer als Capture → native Maße).
    pub override_resolution: Option<(u32, u32)>,
    /// Mauszeiger im Stream zeigen. Default `true` (entspricht GSRs `-cursor yes`).
    /// `false` → WGC `CursorCaptureSettings::WithoutCursor`.
    pub show_cursor: bool,
    /// Konstanter A/V-Trim in ms (>0 = Audio später) aus dem UI-Slider. 0 =
    /// neutral. Reicht bis in die `AudioPipeline` durch (dort Sample-Offset).
    pub av_offset_ms: i32,
}

pub struct StreamController {
    inner: Mutex<Inner>,
}

struct Inner {
    snapshot: StreamSnapshot,
    stop_tx: Option<Sender<()>>,
    worker: Option<JoinHandle<()>>,
    started_at: Option<Instant>,
}

impl StreamController {
    pub fn singleton() -> &'static StreamController {
        static INSTANCE: OnceLock<StreamController> = OnceLock::new();
        INSTANCE.get_or_init(|| StreamController {
            inner: Mutex::new(Inner {
                snapshot: StreamSnapshot::idle(),
                stop_tx: None,
                worker: None,
                started_at: None,
            }),
        })
    }

    pub fn state(&self) -> StreamSnapshot {
        let mut inner = self.inner.lock().unwrap();
        // Live-Uptime aktualisieren ohne Worker zu blockieren.
        if let Some(started_at) = inner.started_at {
            inner.snapshot.uptime_s = Some(started_at.elapsed().as_secs_f64());
        }
        inner.snapshot.clone()
    }

    pub fn start(&self, params: StartParams) -> Result<Vec<String>> {
        let mut inner = self.inner.lock().unwrap();
        if inner.snapshot.running {
            return Err(anyhow!("a stream is already running; stop it first"));
        }

        let (stop_tx, stop_rx) = channel();
        let argv = build_argv_redacted(&params);

        inner.snapshot = StreamSnapshot {
            running: true,
            state: "starting",
            fps: None,
            uptime_s: Some(0.0),
            argv_redacted: Some(argv.clone()),
        };
        inner.stop_tx = Some(stop_tx);
        inner.started_at = Some(Instant::now());

        // Worker spawnen — der hält den ganzen Pipeline-State, wir behalten
        // hier nur ein Stop-Signal + JoinHandle.
        let worker = thread::Builder::new()
            .name("stream-pipeline".into())
            .spawn(move || run_pipeline(params, stop_rx))
            .context("spawn stream-pipeline thread")?;
        inner.worker = Some(worker);

        // state-Event sofort emittieren, ohne den Mutex gehalten zu haben.
        drop(inner);
        emit_state("starting", true, 0.0);
        Ok(argv)
    }

    pub fn stop(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.snapshot.running {
            return Ok(()); // No-op; aufrufer-seitig ist das idempotent.
        }
        if let Some(tx) = inner.stop_tx.take() {
            let _ = tx.send(());
        }
        let worker = inner.worker.take();
        drop(inner);

        // Worker auslaufen lassen — aber NICHT unbegrenzt blockierend. Der
        // Dispatch-Loop ist single-threaded (`main.rs`); ein direktes `join()`
        // hier fror den ganzen Sidecar ein, wenn der Worker auf Netzwerk-I/O
        // blockierte (toter RTMPS-Connect). Das `join()` läuft jetzt auf einem
        // Hilfsthread, wir warten nur mit Timeout. Der Worker terminiert nach
        // dem Stop-Signal selbst (`rw_timeout` im Encoder kappt jeden Stall auf
        // ~10 s); `STOP_JOIN_TIMEOUT` ist nur das Sicherheitsnetz.
        if let Some(w) = worker {
            let (done_tx, done_rx) = channel();
            let _ = thread::Builder::new()
                .name("stream-joiner".into())
                .spawn(move || {
                    let _ = w.join();
                    let _ = done_tx.send(());
                });
            if done_rx.recv_timeout(STOP_JOIN_TIMEOUT).is_err() {
                eprintln!(
                    "[stream-controller] Worker nicht in {STOP_JOIN_TIMEOUT:?} beendet — \
                     aufgegeben (Sidecar bleibt responsiv)"
                );
            }
        }
        // Worker hat im Erfolgsfall schon einen `stopped`-Event emittiert;
        // hier ist nur Aufräumen. Nicht "error" überschreiben — worker_finished
        // kann diesen State während des join-Windows setzen.
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.running = false;
        if inner.snapshot.state != "error" {
            inner.snapshot.state = "stopped";
        }
        inner.started_at = None;
        Ok(())
    }

    /// Vom Worker-Thread aufgerufen wenn die Pipeline beendet (regular oder Fehler).
    fn worker_finished(&self, error: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        // Uptime ablesen BEVOR `started_at` auf None gesetzt wird.
        let uptime = inner
            .started_at
            .take()
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        inner.snapshot.running = false;
        inner.snapshot.state = if error.is_some() { "error" } else { "stopped" };
        inner.snapshot.fps = None;
        drop(inner);
        if let Some(msg) = error {
            // Fehlerfall: NUR error-Events. KEIN nachfolgendes "stopped" — das
            // würde im Renderer-Reducer den error-State überschreiben
            // (state → 'stopped'), ein Crash wäre dann nicht mehr von einem
            // sauberen Stopp unterscheidbar. Gleiche Disziplin wie der
            // Linux-Sidecar (`if self._state != "error"`). Der `state`-Frame mit
            // `"error"` treibt den reaktiven Renderer-State (#5).
            emit_state("error", false, uptime);
            // Redigiert: scheitert der Push-Start, trägt die Fehlerkette die
            // volle Ziel-URL inklusive Stream-Key — und Electron schreibt jede
            // stdout-Zeile in eine persistente Log-Datei (s. `crate::redact`).
            events::emit(json!({"ev": "error", "message": crate::redact::secrets(&msg)}));
        } else {
            emit_state("stopped", false, uptime);
            events::emit(json!({"ev": "stopped"}));
        }
    }

    pub(crate) fn set_fps(&self, fps: f64) {
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.fps = Some(fps);
    }

    pub(crate) fn set_state(&self, state: &'static str) {
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.state = state;
    }
}

// ── Worker-Thread ───────────────────────────────────────────────────────────

fn run_pipeline(params: StartParams, stop_rx: Receiver<()>) {
    let ctrl = StreamController::singleton();
    // `catch_unwind`: ein Panic in der Pipeline (statt eines `Err`) würde sonst
    // an `worker_finished` VORBEI unwinden — kein `error`-Event, `running`
    // bliebe für immer `true`, der Renderer sähe einen Stream, der wortlos in
    // „starting"/„live" hängt. Der Linux-Sidecar hat diese Garantie über sein
    // generisches `except`; hier stellt sie dieses Netz her. Die geleakten
    // Pipeline-Objekte (`ManuallyDrop`) werden vom Unwind nicht angefasst —
    // der Teardown-Crash-Schutz gilt also auch auf dem Panic-Pfad.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
        let adapter = select_adapter()?;

        // Encoder-Pfad nach Vendor:
        // - NVIDIA → `pipeline_hw`: WGC → D3D11-Pool → VideoProcessor → NVENC
        //   direkt (Zero-Copy). h264_nvenc frisst D3D11-Frames sauber.
        // - AMD → `pipeline_d3d12`: nativer `h264_d3d12va`-Encoder. h264_amf
        //   crasht reproduzierbar auf D3D11-Surface-Input (AMF-Runtime-Bug,
        //   `SubmitInput`-Integer-Divide-by-Zero, Issue #455); der d3d12va-
        //   Encoder umgeht die AMF-Runtime komplett (D3D12 Video Encode API).
        // - Intel/sonst → CPU-Pfad (`run_cpu_pipeline`, h264_qsv).
        // `select_adapter()` liefert auf Multi-GPU evtl. die dGPU statt der
        // Display-GPU; `pipeline_hw` verifiziert die echte WGC-GPU selbst und
        // delegiert nötigenfalls an `pipeline_d3d12`/`run_cpu_pipeline`.
        // Kill-Switch `PULSE_HQ_DISABLE_ZERO_COPY=1` erzwingt den CPU-Pfad
        // (für AMD = Fallback auf das funktionierende h264_amf).
        let disable_zc = std::env::var("PULSE_HQ_DISABLE_ZERO_COPY")
            .map(|v| !v.is_empty() && v != "0")
            .unwrap_or(false);
        if !disable_zc {
            match adapter.vendor() {
                "nvidia" => return crate::pipeline_hw::run(adapter, params, stop_rx),
                "amd" => return crate::pipeline_d3d12::run(params, stop_rx),
                _ => {}
            }
        }
        run_cpu_pipeline(params, stop_rx)
    }))
    .unwrap_or_else(|payload| Err(anyhow!("pipeline worker panicked: {}", panic_message(&payload))));

    let error_msg = result.err().map(|e| format!("{e:#}"));
    ctrl.worker_finished(error_msg);
}

/// Panic-Payload → lesbarer Text. `panic!`-Payloads sind praktisch immer
/// `&str` oder `String`; alles andere bekommt einen Platzhalter.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("<non-string panic payload>")
}

/// CPU-Encode-Pfad: WGC-CPU-Readback → swscale BGRA→NV12 → FFmpeg-Encoder
/// (`encoder.rs`). Aktiv für AMD/Intel sowie für NVIDIA unter
/// `PULSE_HQ_DISABLE_ZERO_COPY=1`. `pipeline_hw` delegiert hierher, wenn die
/// echte Capture-GPU (WGC-D3D11-Device) nicht NVIDIA ist.
pub(crate) fn run_cpu_pipeline(params: StartParams, stop_rx: Receiver<()>) -> Result<()> {
    let ctrl = StreamController::singleton();
    (|| -> Result<()> {
        // Encoder-Vendor aus dem HIGH_PERFORMANCE-Adapter. Im CPU-Pfad gehen
        // Software-NV12-Frames in den Encoder — die GPU lädt sie selbst hoch,
        // sie muss kein Display treiben. Auf Multi-GPU ist das die dGPU.
        let adapter = select_adapter()?;
        let mut capture = WgcCapture::start(
            params.capture.clone(),
            CaptureConfig {
                max_fps: params.override_fps.unwrap_or(params.profile.fps),
                include_cursor: params.show_cursor,
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
                    worker_err
                        .map(|s| format!(": {s}"))
                        .unwrap_or_else(|| " (Thread clean beendet, nie ein Frame geliefert)".into())
                ));
            }
        };
        // Wall-clock-Zeitpunkt des Video-Origins (≈ first.qpc). Audio-Chunks
        // ohne QPC ankern hieran — NICHT an `started` (liegt erst NACH der
        // Encoder-Erzeugung, der Setup-Versatz würde zum konstanten A/V-Offset).
        let origin_instant = Instant::now();

        let mut codec = params.override_codec.unwrap_or(match params.profile.codec {
            "h264" => VideoCodec::H264,
            "hevc" => VideoCodec::Hevc,
            "av1" => VideoCodec::Av1,
            _ => VideoCodec::H264,
        });
        // WHIP-Ziel (App-gehostete Instanz): FFmpegs WHIP-Muxer trägt nur
        // H.264-Video → ausweichen statt beim write_header hart zu scheitern
        // (wie Linux/Mac-Sidecar).
        if crate::encode::encoder::url_format_hint(&params.push_url) == Some("whip")
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
            match AudioCapture::start(src.clone(), 1024) {
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
        let qpc_sync = std::env::var("PULSE_HQ_NO_AV_OFFSET")
            .map(|v| v.is_empty() || v == "0")
            .unwrap_or(true)
            && first_qpc != 0;
        let origin_qpc = first_qpc;
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
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        // Echte Root-Cause aus dem Worker ziehen — s. pipeline_hw.
                        let worker_err = capture.join_error();
                        return Err(anyhow!(
                            "capture channel disconnected mid-stream{}",
                            worker_err
                                .map(|s| format!(": {s}"))
                                .unwrap_or_else(|| " (clean exit, keine Fehlermeldung)".into())
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
            let mut pts = (elapsed * fps as f64).round() as i64;
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Adapter-Auswahl: per default der HIGH_PERFORMANCE-Slot (dGPU bevorzugt).
/// Test/Diagnose-Override: `PULSE_HQ_ADAPTER_VENDOR=nvidia|amd|intel` filtert
/// erst nach Vendor, dann wird der erste Treffer genommen. Nützlich auf
/// Multi-GPU-Systemen (dGPU+iGPU) um den AMF/QSV-Pfad zu validieren ohne den
/// HIGH_PERFORMANCE-Default umzustellen.
fn select_adapter() -> Result<dxgi::Adapter> {
    let adapters = dxgi::list_adapters()?;
    let adapter = match std::env::var("PULSE_HQ_ADAPTER_VENDOR").ok().as_deref() {
        Some(want) if !want.is_empty() => adapters
            .into_iter()
            .find(|a| a.vendor() == want)
            .ok_or_else(|| anyhow!("no DXGI adapter with vendor={want}"))?,
        _ => adapters
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("no DXGI adapter for encode"))?,
    };
    eprintln!(
        "[stream-pipeline] encode adapter: {} (vendor={})",
        adapter.description,
        adapter.vendor()
    );
    Ok(adapter)
}

pub(crate) fn emit_state(state: &str, running: bool, uptime_s: f64) {
    events::emit(json!({
        "ev": "state",
        "state": state,
        "running": running,
        "uptime_s": uptime_s,
    }));
}

/// Pseudo-argv für die `start`-Response — wie auf Linux gibt's das nur zur
/// Diagnose im Renderer, ohne den Stream-Key. Wenig informativ, aber shape-
/// kompatibel zu `gsr-sidecar`'s argv-Form.
pub(crate) fn build_argv_redacted(params: &StartParams) -> Vec<String> {
    vec![
        "pulse-win-hq-sidecar.exe".to_string(),
        "--profile".into(),
        params.profile_name.clone(),
        "--codec".into(),
        params.profile.codec.to_string(),
        "--fps".into(),
        params
            .override_fps
            .unwrap_or(params.profile.fps)
            .to_string(),
        "--bitrate".into(),
        format!(
            "{}k",
            params
                .override_bitrate_kbps
                .unwrap_or(params.profile.bitrate_kbps)
        ),
        "--audio-codec".into(),
        params.profile.audio_codec.to_string(),
        "--container".into(),
        params.profile.container.to_string(),
        "--out".into(),
        crate::redact::secrets(&params.push_url),
    ]
}

/// Capture-Maße aspektwahrend in eine Box einpassen — nie hochskalieren, Maße
/// auf gerade Werte runden (4:2:0-Encoder-Anforderung). Gleiche Semantik wie
/// `ResolutionRequest::target_for` im Linux-Rust-Sidecar; vorher wurde die Box
/// wörtlich genommen und Ultrawide auf 16:9 gestaucht. Von allen drei
/// Pipelines genutzt (CPU hier, `pipeline_hw`, `pipeline_d3d12`).
pub(crate) fn fit_within_box(native_w: u32, native_h: u32, box_w: u32, box_h: u32) -> (u32, u32) {
    let even = |n: u32| (n & !1).max(2);
    let scale = f64::min(
        box_w as f64 / native_w.max(1) as f64,
        box_h as f64 / native_h.max(1) as f64,
    )
    .min(1.0); // kein Upscale
    let w = (native_w as f64 * scale).round() as u32;
    let h = (native_h as f64 * scale).round() as u32;
    (even(w), even(h))
}

#[cfg(test)]
mod fit_tests {
    use super::fit_within_box;

    #[test]
    fn fit_keeps_aspect_never_upscales() {
        // 16:9-Quelle + passende Box → exakt die Box.
        assert_eq!(fit_within_box(3840, 2160, 1920, 1080), (1920, 1080));
        // 21:9-Ultrawide + 1080p-Box → volle Breite, Höhe aspektwahrend < 1080.
        let (w, h) = fit_within_box(3440, 1440, 1920, 1080);
        assert_eq!(w, 1920);
        assert!(h < 1080 && h % 2 == 0, "aspektwahrend + gerade: {h}");
        // Quelle kleiner als Box → native Maße (kein Upscale).
        assert_eq!(fit_within_box(1280, 720, 1920, 1080), (1280, 720));
        // Ungerade Ergebnisse werden auf gerade Maße gerundet.
        let (_, h) = fit_within_box(2560, 1080, 1920, 1080);
        assert_eq!(h % 2, 0);
    }
}

