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
    /// When set, capture this single window instead of the display.
    pub window_id: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub codec: String,
    pub push_url: String,
    pub show_cursor: bool,
    pub enable_audio: bool,
    /// Audio capture scope (desktop-minus-excludes / specific app / none).
    pub audio_scope: crate::capture::AudioScope,
    /// Manual A/V trim in ms (UI slider). >0 shifts audio later. Applied to the
    /// audio anchor to correct any residual constant offset.
    pub av_offset_ms: i32,
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
        // Eine Vollbild-Anforderung, die nach dem letzten Bild des vorigen
        // Streams eintraf, gehoert nicht diesem hier — und vor allem darf seine
        // Drossel den neuen Stream nicht sperren (Begruendung an
        // `keyframe::reset`). Zwilling: `win-hq-sidecar` ruft es an derselben
        // Stelle im Ablauf.
        crate::keyframe::reset();
        // Die Fernsteuerung braucht zu wissen, worauf dieser Strom zeigt.
        // **Der Platz bleibt `None`**: der mac-`start` liest keinen `slot`, und
        // damit gilt „ein Strom ohne erklaerten Platz traegt jeden Platz"
        // (Begruendung in `remote_input::ziel`).
        match crate::remote_input::ziel::quelle_aus(params.window_id, params.display_index) {
            Some(quelle) => crate::remote_input::ziel::strom_gestartet(None, quelle),
            None => eprintln!(
                "[remote-input] Aufnahmequelle nicht bestimmbar — dieser Strom traegt keine Fernsteuerung"
            ),
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
                // **Abmelden ist hier Pflicht, nicht Hoeflichkeit** — der
                // mac-Sidecar bleibt zwischen zwei Streams warm. Am Ende des
                // Workers und nicht in `stop`, weil der Strom auch von selbst
                // enden kann (Fehler, Quelle weg); `stop` wartet ohnehin auf
                // diesen Faden.
                crate::remote_input::ziel::strom_beendet();
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
            .map_err(|e| {
                // **Die Anmeldung zuruecknehmen, wenn der Faden nicht kommt.**
                // Sie steht bewusst VOR der Spawn und wird nicht dahinter
                // geschoben: der Worker meldet am Ende ab, und ein sofort
                // scheiterndes `run_stream` koennte das tun, bevor eine
                // nachgelagerte Anmeldung ueberhaupt laeuft — dann bliebe eine
                // Leiche stehen. Hier ist die Reihenfolge eindeutig.
                crate::remote_input::ziel::strom_beendet();
                anyhow!("spawn hq-stream thread: {e}")
            })?;

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
        params.window_id,
        params.audio_scope.clone(),
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
    // Manual A/V trim: ms → samples (48 @ 48kHz). >0 shifts audio later.
    let audio_offset_samples = params.av_offset_ms as i64 * 48;
    // A/V sync anchors on the capture timestamps (CMSampleBuffer PTS — the same
    // host clock for video + audio), NOT on processing time. Using emit/drain
    // wall-clock skewed audio ~300ms late (SCK audio buffering + FIFO latency).
    // `epoch_s` = first media sample seen; video duplicates project the last
    // real frame's capture time forward by the wall clock since it arrived.
    let mut epoch_s = f64::NAN;
    let mut last_frame_pts_s = 0.0_f64;
    let mut last_frame_at = Instant::now();
    emit(Event::State {
        state: StreamState::Live,
        running: true,
        uptime_s: 0.0,
    });

    // Constant-frame-rate output: emit a frame every `frame_interval`,
    // regardless of how fast ScreenCaptureKit delivers. SCK throttles on a
    // static screen and is slow to deliver the first frame on a cold start, so
    // raw passthrough lets the stream's media-time crawl behind the wall clock
    // — MediaMTX then waits out its 10s readTimeout before registering the
    // publish (the intermittent "i/o timeout" failure). Steady realtime output
    // (latest frame, a duplicate when static, black before the first frame)
    // keeps media-time == wall-clock so MediaMTX registers in ~2s, and it keeps
    // the video in sync with the always-realtime audio.
    let frame_interval = Duration::from_secs_f64(1.0 / params.fps.max(1) as f64);
    let mut next_emit = Instant::now();
    let mut last_frame = None;
    let mut window_start = Instant::now();
    let mut window_frames = 0u64;

    let run_result = (|| -> Result<()> {
        loop {
            // Stop requested?
            match stop_rx.try_recv() {
                Ok(()) | Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
            // Drain pending audio (non-blocking). Anchor the first frame to the
            // audio sample's own capture pts (shared epoch with video) + the
            // manual trim — so audio sits where it was captured, not where it
            // was drained.
            if let Some(arx) = &audio_rx {
                while let Ok(af) = arx.try_recv() {
                    if epoch_s.is_nan() {
                        epoch_s = af.pts_seconds;
                    }
                    let anchor = ((af.pts_seconds - epoch_s) * 48_000.0).round() as i64
                        + audio_offset_samples;
                    enc.push_audio(&af.samples, anchor)?;
                }
            }
            // Grab the freshest captured frame(s); record its capture pts + the
            // instant it arrived (for duplicate projection).
            while let Ok(f) = frame_rx.try_recv() {
                if epoch_s.is_nan() {
                    epoch_s = f.pts_seconds;
                }
                last_frame_pts_s = f.pts_seconds;
                last_frame_at = Instant::now();
                last_frame = Some(f);
            }

            let now = Instant::now();
            if now >= next_emit {
                // Constant-rate emit: the latest captured frame, re-sent as a
                // duplicate when the screen is static (SCK stops delivering). The
                // frame is zero-copy — `retained_ptr()` hands the encoder a
                // retained CVPixelBuffer. Before the first frame arrives we just
                // wait (no black pre-roll on the hw path); SCK delivers the first
                // frame within a frame or two of start.
                if let Some(f) = &last_frame {
                    // Video pts from the frame's capture time (shared epoch with
                    // audio → A/V sync), projecting the last real frame forward by
                    // the wall clock since it arrived so static-screen duplicates
                    // keep advancing. push_pixel_buffer clamps it monotonic.
                    let cap_s = last_frame_pts_s + last_frame_at.elapsed().as_secs_f64();
                    let pts_v = ((cap_s - epoch_s) * params.fps as f64).round().max(0.0) as i64;
                    enc.push_pixel_buffer(f.retained_ptr(), pts_v)?;
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
                next_emit += frame_interval;
                if next_emit <= now {
                    // Fell behind (long encode stall) — resync, don't spiral.
                    next_emit = now + frame_interval;
                }
            } else {
                // Wait until the next emit deadline or the next captured frame.
                match frame_rx.recv_timeout(next_emit - now) {
                    Ok(f) => {
                        if epoch_s.is_nan() {
                            epoch_s = f.pts_seconds;
                        }
                        last_frame_pts_s = f.pts_seconds;
                        last_frame_at = Instant::now();
                        last_frame = Some(f);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        }
        // Drain any audio buffered after the last video frame.
        if let Some(arx) = &audio_rx {
            while let Ok(af) = arx.try_recv() {
                if epoch_s.is_nan() {
                    epoch_s = af.pts_seconds;
                }
                let anchor = ((af.pts_seconds - epoch_s) * 48_000.0).round() as i64
                    + audio_offset_samples;
                enc.push_audio(&af.samples, anchor)?;
            }
        }
        Ok(())
    })();

    // Teardown in order: stop capture, then flush + close the encoder/mux.
    cap.stop();
    let finish_result = enc.finish();
    run_result.and(finish_result)
}
