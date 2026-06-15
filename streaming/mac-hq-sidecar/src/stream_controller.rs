//! Stream controller — owns the single active capture→encode→push session.
//!
//! `start` spawns a worker thread that creates the [`Capturer`] + [`VideoEncoder`],
//! pumps BGRA frames through the encoder, and emits `state`/`fps`/`error`/`stopped`
//! events. `stop` signals the worker and joins it (the macOS sidecar stays warm
//! afterwards — no self-exit, unlike Windows). `state` returns a snapshot.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};

use crate::capture::{AudioFrame, Capturer};
use crate::encode::VideoEncoder;
use crate::events;
use crate::proto::{Event, StreamState};

/// Resolved parameters for one stream (built by `ops::start` from the request).
pub struct StartParams {
    pub display_index: usize,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub codec: String,
    pub push_url: String,
    pub show_cursor: bool,
    pub enable_audio: bool,
}

pub struct StreamSnapshot {
    pub running: bool,
    pub state: String,
    pub fps: Option<f64>,
    pub uptime_s: Option<f64>,
    pub argv_redacted: Option<Vec<String>>,
}

struct Shared {
    running: AtomicBool,
    live: AtomicBool,
    /// fps × 1000 (atomic; the worker updates it once per second).
    fps_milli: AtomicU64,
    started_at: Mutex<Option<Instant>>,
}

struct Active {
    stop_tx: Sender<()>,
    worker: JoinHandle<()>,
    shared: Arc<Shared>,
    argv: Vec<String>,
}

pub struct StreamController {
    active: Mutex<Option<Active>>,
}

static INSTANCE: OnceLock<StreamController> = OnceLock::new();

fn emit(event: Event) {
    if let Ok(v) = serde_json::to_value(event) {
        events::emit(v);
    }
}

impl StreamController {
    pub fn singleton() -> &'static StreamController {
        INSTANCE.get_or_init(|| StreamController { active: Mutex::new(None) })
    }

    /// Start a stream. `argv` is the redacted diagnostic argv (for `state`).
    pub fn start(&self, params: StartParams, argv: Vec<String>) -> Result<()> {
        let mut guard = self.active.lock().unwrap();
        if guard.is_some() {
            return Err(anyhow!("ein Stream läuft bereits"));
        }
        let (stop_tx, stop_rx) = channel::<()>();
        let shared = Arc::new(Shared {
            running: AtomicBool::new(true),
            live: AtomicBool::new(false),
            fps_milli: AtomicU64::new(0),
            started_at: Mutex::new(None),
        });
        let shared_worker = shared.clone();
        let worker = thread::Builder::new()
            .name("hq-stream".into())
            .spawn(move || {
                let result = run_stream(params, stop_rx, &shared_worker);
                shared_worker.running.store(false, Ordering::SeqCst);
                shared_worker.live.store(false, Ordering::SeqCst);
                if let Err(e) = result {
                    emit(Event::Error { message: format!("{e:#}") });
                    emit(Event::State {
                        state: StreamState::Error,
                        running: false,
                        uptime_s: 0.0,
                    });
                }
                emit(Event::State {
                    state: StreamState::Stopped,
                    running: false,
                    uptime_s: 0.0,
                });
                emit(Event::Stopped { code: None });
            })
            .map_err(|e| anyhow!("spawn hq-stream thread: {e}"))?;

        *guard = Some(Active { stop_tx, worker, shared, argv });
        Ok(())
    }

    /// Stop the active stream (idempotent). Blocks until the worker has finished
    /// flushing + closing the RTMP connection.
    pub fn stop(&self) -> Result<()> {
        let active = self.active.lock().unwrap().take();
        if let Some(active) = active {
            let _ = active.stop_tx.send(());
            let _ = active.worker.join();
        }
        Ok(())
    }

    pub fn state(&self) -> StreamSnapshot {
        let guard = self.active.lock().unwrap();
        match guard.as_ref() {
            Some(a) => {
                let running = a.shared.running.load(Ordering::SeqCst);
                let live = a.shared.live.load(Ordering::SeqCst);
                let fps = a.shared.fps_milli.load(Ordering::SeqCst) as f64 / 1000.0;
                let uptime = a
                    .shared
                    .started_at
                    .lock()
                    .unwrap()
                    .map(|t| t.elapsed().as_secs_f64());
                StreamSnapshot {
                    running,
                    state: if live { "live" } else { "starting" }.to_string(),
                    fps: if fps > 0.0 { Some(fps) } else { None },
                    uptime_s: uptime,
                    argv_redacted: Some(a.argv.clone()),
                }
            }
            None => StreamSnapshot {
                running: false,
                state: "idle".to_string(),
                fps: None,
                uptime_s: None,
                argv_redacted: None,
            },
        }
    }
}

/// Worker body: capture → encode → push until stopped.
fn run_stream(params: StartParams, stop_rx: std::sync::mpsc::Receiver<()>, shared: &Shared) -> Result<()> {
    *shared.started_at.lock().unwrap() = Some(Instant::now());
    emit(Event::State {
        state: StreamState::Starting,
        running: true,
        uptime_s: 0.0,
    });

    let (frame_tx, frame_rx) = channel();
    let (audio_tx, audio_rx) = if params.enable_audio {
        let (t, r) = channel::<AudioFrame>();
        (Some(t), Some(r))
    } else {
        (None, None)
    };
    let cap = Capturer::start(
        params.display_index,
        params.width as usize,
        params.height as usize,
        params.fps,
        params.show_cursor,
        frame_tx,
        audio_tx,
    )?;
    let mut enc = VideoEncoder::start(
        &params.push_url,
        params.width,
        params.height,
        params.fps,
        params.bitrate_kbps,
        &params.codec,
        params.enable_audio,
    )?;

    shared.live.store(true, Ordering::SeqCst);
    let started = Instant::now();
    emit(Event::State {
        state: StreamState::Live,
        running: true,
        uptime_s: 0.0,
    });

    let mut window_start = Instant::now();
    let mut window_frames = 0u64;

    let run_result = (|| -> Result<()> {
        loop {
            // Stop requested?
            match stop_rx.try_recv() {
                Ok(()) | Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
            // Drain any pending audio (non-blocking) before the video frame.
            if let Some(arx) = &audio_rx {
                while let Ok(af) = arx.try_recv() {
                    enc.push_audio(&af.samples)?;
                }
            }
            match frame_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(frame) => {
                    enc.push_bgra(&frame.data, frame.bytes_per_row)?;
                    window_frames += 1;
                    if window_start.elapsed() >= Duration::from_secs(1) {
                        let fps = window_frames as f64 / window_start.elapsed().as_secs_f64();
                        shared.fps_milli.store((fps * 1000.0) as u64, Ordering::SeqCst);
                        emit(Event::Fps {
                            fps,
                            uptime_s: started.elapsed().as_secs_f64(),
                        });
                        window_start = Instant::now();
                        window_frames = 0;
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        // Drain any audio buffered after the last video frame.
        if let Some(arx) = &audio_rx {
            while let Ok(af) = arx.try_recv() {
                enc.push_audio(&af.samples)?;
            }
        }
        Ok(())
    })();

    // Teardown in order: stop capture, then flush + close the encoder/mux.
    cap.stop();
    let finish_result = enc.finish();
    run_result.and(finish_result)
}
