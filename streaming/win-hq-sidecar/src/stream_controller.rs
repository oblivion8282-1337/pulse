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
    pub profile: &'static StreamProfile,
    pub channel_id: String,
    pub token: String,
    pub push_url: String,
    pub capture: CaptureSource,
    pub audio: Option<AudioSource>,
    pub override_codec: Option<VideoCodec>,
    pub override_bitrate_kbps: Option<u32>,
    pub override_fps: Option<u32>,
    /// Downscale-Target (1920x1080, 1280x720, 854x480). `None` = capture-native.
    /// Upscale wird nicht unterstützt — wenn target > capture-res, ignoriert die
    /// Pipeline das (s. `run_pipeline`).
    pub override_resolution: Option<(u32, u32)>,
    /// Mauszeiger im Stream zeigen. Default `true` (entspricht GSRs `-cursor yes`).
    /// `false` → WGC `CursorCaptureSettings::WithoutCursor`.
    pub show_cursor: bool,
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
        // hier ist nur Aufräumen.
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.running = false;
        inner.snapshot.state = "stopped";
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
            events::emit(json!({"ev": "error", "message": msg}));
        }
        emit_state("stopped", false, uptime);
        events::emit(json!({"ev": "stopped"}));
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
    let result = (|| -> Result<()> {
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
    })();

    let error_msg = result.err().map(|e| format!("{e:#}"));
    ctrl.worker_finished(error_msg);
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
        let capture = WgcCapture::start(
            params.capture.clone(),
            CaptureConfig {
                max_fps: params.override_fps.unwrap_or(params.profile.fps),
                include_cursor: params.show_cursor,
                ..Default::default()
            },
        )?;

        // Warmup-Frame für native Dimensions.
        let first = capture
            .frames
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| anyhow!("never got first capture frame: {e}"))?;

        let codec = params.override_codec.unwrap_or(match params.profile.codec {
            "h264" => VideoCodec::H264,
            "hevc" => VideoCodec::Hevc,
            "av1" => VideoCodec::Av1,
            _ => VideoCodec::H264,
        });
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
        let audio_cfg: Option<AudioStreamConfig> = audio_capture
            .as_ref()
            .map(|_| AudioStreamConfig::DEFAULT);

        // dst_width/dst_height aus override (mit Upscale-Schutz: max = capture-native).
        // Bei Match dst==src degeneriert swscale zu reinem Format-Convert; sonst
        // triggert `FfmpegEncoder::create` automatisch den Downscale-Pfad.
        let (dst_w, dst_h) = match params.override_resolution {
            Some((w, h)) if w <= first.width && h <= first.height => (w, h),
            Some((w, h)) => {
                eprintln!(
                    "[stream-pipeline] resolution override {}x{} > capture {}x{} — ignored",
                    w, h, first.width, first.height
                );
                (first.width, first.height)
            }
            None => (first.width, first.height),
        };
        let mut encoder = FfmpegEncoder::create(
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

        ctrl.set_state("live");
        emit_state("live", true, 0.0);

        // Frame-Pacing wie GSR (Details: `pipeline_hw.rs`). WGC ist change-
        // driven — der Encode-Loop läuft mit fester Kadenz und dupliziert bei
        // statischem Bild den letzten Frame, statt im Capture-Takt zu encoden.
        // Ohne das stockt der RTMP-Push und MediaMTX killt die Verbindung.
        let frame_dur = Duration::from_secs_f64(1.0 / fps as f64);
        let expected = (first.width, first.height);
        let started = Instant::now();
        // Audio-PTS am selben Wall-clock-Ursprung wie der Video-PTS verankern.
        encoder.set_audio_origin(started);
        let mut last_frame: Option<CapturedFrame> = Some(first);
        let mut last_pts: i64 = -1;
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
                            last_frame = Some(f);
                            captured += 1;
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        return Err(anyhow!("capture channel disconnected"));
                    }
                }
            }
            let capture_drain = t_capture.elapsed();

            // Audio non-blocking nachziehen — leert den Channel auch bei
            // `audio_cfg = None`, damit WASAPI weiter buffern kann.
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
        encoder.finish()?;

        // Kein `capture.stop()`/`ac.stop()`/Drop — s. ausführlicher Kommentar
        // in `pipeline_hw::run`: die grafische Teardown-Sequenz lässt einen
        // treiber-internen Threadpool-Timer dangling zurück (Use-after-free-
        // Crash). Wir machen gar keinen Teardown; der Per-Stream-Sidecar endet
        // gleich, `ExitProcess` terminiert alle Threads + räumt sauber auf.
        std::mem::forget(capture);
        std::mem::forget(audio_capture);
        std::mem::forget(encoder);
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
fn build_argv_redacted(params: &StartParams) -> Vec<String> {
    vec![
        "pulse-win-hq-sidecar.exe".to_string(),
        "--profile".into(),
        params.profile.name.to_string(),
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
        redact_token(&params.push_url),
    ]
}

fn redact_token(url: &str) -> String {
    let mut s = url.to_string();
    for pat in ["pass=", "token=", "streamid=publish:"] {
        if let Some(idx) = s.find(pat) {
            let tail_start = idx + pat.len();
            let tail_end = s[tail_start..]
                .find(|c: char| c == '&' || c == ' ')
                .map(|i| tail_start + i)
                .unwrap_or(s.len());
            s.replace_range(tail_start..tail_end, "***");
        }
    }
    s
}

