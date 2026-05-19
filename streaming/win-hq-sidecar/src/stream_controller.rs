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
use crate::capture::wgc::{CaptureConfig, WgcCapture};
use crate::encode::{AudioStreamConfig, EncoderConfig, FfmpegEncoder, VideoCodec};
use crate::events;
use crate::profiles::StreamProfile;
use crate::system::dxgi;

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
        if let Some(w) = worker {
            let _ = w.join();
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

    fn set_fps(&self, fps: f64) {
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.fps = Some(fps);
    }

    fn set_state(&self, state: &'static str) {
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.state = state;
    }
}

// ── Worker-Thread ───────────────────────────────────────────────────────────

fn run_pipeline(params: StartParams, stop_rx: Receiver<()>) {
    let ctrl = StreamController::singleton();
    let result = (|| -> Result<()> {
        let adapter = dxgi::list_adapters()?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("no DXGI adapter for encode"))?;

        let mut capture = WgcCapture::start(
            params.capture.clone(),
            CaptureConfig {
                max_fps: params.override_fps.unwrap_or(params.profile.fps),
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

        // Audio-Pipeline ist als Infrastruktur vorhanden (siehe `encode::audio`)
        // aber noch NICHT in den Live-Mux-Pfad verdrahtet: das initial Wiring
        // löste eine FFmpeg-write_interleaved-Blockade aus (Video-Packets warten
        // auf Audio-Packets, die zwar produziert werden aber das Mux-Buffer
        // anscheinend nicht ablaufen lassen). Stage 8a Schritt 2 muss das in
        // einer fokussierten Session debuggen — wahrscheinlich `write` statt
        // `write_interleaved` oder Audio-Pre-Buffer vor write_header.
        //
        // Bis dahin: Audio wird gecaptured aber nicht gemuxt. Stream ist tonlos
        // — funktionsfähig für Screen-Tests, Audio-Mux folgt.
        let audio_capture: Option<AudioCapture> = params.audio.as_ref().and_then(|src| {
            match AudioCapture::start(src.clone(), 1024) {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("[stream-pipeline] audio capture failed, continuing video-only: {e:#}");
                    None
                }
            }
        });
        let audio_cfg: Option<AudioStreamConfig> = None;

        let mut encoder = FfmpegEncoder::create(
            &EncoderConfig {
                codec,
                vendor: adapter.vendor().to_string(),
                src_width: first.width,
                src_height: first.height,
                dst_width: first.width, // native, kein Downscale (Stage 7b)
                dst_height: first.height,
                fps,
                bitrate_kbps: bitrate,
            },
            audio_cfg,
            &params.push_url,
        )?;

        ctrl.set_state("live");
        emit_state("live", true, 0.0);
        encoder.send(&first)?;

        let started = Instant::now();
        let mut frames_sent: u64 = 1;
        let mut last_fps_emit = Instant::now();

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            // Audio zuerst rein-pumpen — non-blocking try_recv. Audio kommt in
            // 1024-Frame-Chunks ~jede 21ms an, Video alle ~16ms, also locker
            // genug Headroom für beides in einem Loop.
            // Audio wird gecaptured aber bewusst weggeworfen — siehe Kommentar
            // bei `audio_cfg = None` oben. Sobald die Mux-Blockade gefixt ist,
            // wird hier `encoder.send_audio(&chunk)` reaktiviert.
            if let Some(ac) = audio_capture.as_ref() {
                while ac.samples.try_recv().is_ok() {}
            }

            let frame = match capture.frames.recv_timeout(Duration::from_millis(500)) {
                Ok(f) => f,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(anyhow!("capture channel disconnected"));
                }
            };
            if (frame.width, frame.height) != (first.width, first.height) {
                continue;
            }
            encoder.send(&frame)?;
            frames_sent += 1;

            if last_fps_emit.elapsed() >= Duration::from_secs(2) {
                let elapsed = started.elapsed().as_secs_f64();
                let fps = frames_sent as f64 / elapsed;
                ctrl.set_fps(fps);
                events::emit(json!({"ev": "fps", "fps": fps, "uptime_s": elapsed}));
                last_fps_emit = Instant::now();
            }
        }

        capture.stop();
        if let Some(mut ac) = audio_capture {
            ac.stop();
        }
        encoder.finish()?;
        Ok(())
    })();

    let error_msg = result.err().map(|e| format!("{e:#}"));
    ctrl.worker_finished(error_msg);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn emit_state(state: &str, running: bool, uptime_s: f64) {
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

