//! WGC-basierter Capture (`windows-capture` v2 Handler-Trait).
//!
//! Architektur: `Capture::start(settings)` blockiert den aufrufenden Thread —
//! wir starten ihn deshalb auf einem dedizierten Thread und routen Frames per
//! `mpsc::Sender` raus. Der Sender geht in die `Flags` des Handlers rein
//! (einziger Weg State in `GraphicsCaptureApiHandler::new` zu übergeben).
//!
//! Frame-Output: rohe BGRA8-Bytes plus Geometrie. In Stage 7 (Encode) ersetzen
//! wir das durch D3D11-Texture-Handles für Zero-Copy NVENC; Day-3-Spike nutzt
//! CPU-Buffer weil das mit `frame.buffer()?` direkt geht und für PNG-Smoke-Test
//! ausreicht.

use anyhow::{Context, Result};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::{self, JoinHandle};

use windows_capture::capture::{Context as HandlerCtx, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use super::source::{CaptureSource, ResolvedTarget};

/// Ein einzelner Capture-Frame als CPU-Buffer.
#[derive(Debug)]
pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    /// BGRA8 (4 bytes/pixel), `width * height * 4` Bytes lang. Padding-Bytes
    /// wurden bereits rausgestrippt von `frame.buffer()`. Encoder swizzelt
    /// das selbst nach NV12 (oder bekommt direkt eine D3D11-Texture in Stage 7).
    pub bgra: Vec<u8>,
}

/// Konfiguration die `WgcCapture::start` an den Handler übergibt.
#[derive(Clone)]
pub struct CaptureConfig {
    pub include_cursor: bool,
    pub draw_border: bool,
    /// Maximale FPS (default `60`). `windows-capture` setzt das per
    /// `MinimumUpdateIntervalSettings`.
    pub max_fps: u32,
    /// Wieviele Frames buffern bevor send-blockt. Default `4` — kleiner Buffer
    /// = niedrige Latenz, höherer = toleriert kurze Encoder-Stalls.
    pub channel_capacity: usize,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            include_cursor: true,
            draw_border: false,
            max_fps: 60,
            channel_capacity: 4,
        }
    }
}

/// Living capture handle. Drop = stop. Hold the `frames` receiver and pull from it.
pub struct WgcCapture {
    /// Channel-Empfänger für Frames. Hat eine bounded queue (s. `channel_capacity`).
    /// Frame-Drops bei Backpressure werden im Handler geloggt.
    pub frames: Receiver<CapturedFrame>,
    /// Stop-Signal an den Capture-Thread.
    stop_tx: Sender<()>,
    /// Worker-Thread (held für JoinHandle on drop).
    worker: Option<JoinHandle<Result<(), String>>>,
}

impl WgcCapture {
    /// Startet die Capture in einem Worker-Thread. Returnt sofort.
    pub fn start(source: CaptureSource, cfg: CaptureConfig) -> Result<Self> {
        // Resolve auf Caller-Thread — billig, will früh fehlen wenn das Fenster
        // nicht da ist, statt nach dem Thread-Spawn.
        let target = source.resolve()?;

        // mpsc::sync_channel für bounded queue → Backpressure-Signal an Capture
        // (Sender::try_send wirft TrySendError::Full statt zu blockieren).
        let (tx, frames) = std::sync::mpsc::sync_channel(cfg.channel_capacity);
        let (stop_tx, stop_rx) = channel();

        let cfg_for_thread = cfg.clone();
        let worker = thread::spawn(move || -> Result<(), String> {
            run_capture(target, cfg_for_thread, tx, stop_rx).map_err(|e| format!("{e:#}"))
        });

        Ok(Self {
            frames: into_unbounded(frames),
            stop_tx,
            worker: Some(worker),
        })
    }

    /// Stoppt die Capture (best-effort). `Drop` ruft das selber.
    pub fn stop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(handle) = self.worker.take() {
            // Capture::start blockiert — der Stop-Signal-Pfad geht über die
            // Handler-Callback (s. on_frame_arrived). Wenn das nicht zieht
            // joinen wir hier hart, max paar Sekunden.
            let _ = handle.join();
        }
    }
}

impl Drop for WgcCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

// `sync_channel` gibt `SyncSender<T>` zurück, der `Receiver<T>` ist aber
// derselbe wie bei `channel()`. Cast ist trivial weil Receiver-Typ identisch.
fn into_unbounded<T>(rx: Receiver<T>) -> Receiver<T> {
    rx
}

// ── Handler-Implementation (läuft im Capture-Thread) ────────────────────────

struct FrameSink {
    tx: std::sync::mpsc::SyncSender<CapturedFrame>,
    stop_rx: Receiver<()>,
    dropped: u64,
}

/// `Flags`-Payload — `windows-capture` reicht den 1:1 an `new()` durch.
struct HandlerFlags {
    tx: std::sync::mpsc::SyncSender<CapturedFrame>,
    stop_rx: Receiver<()>,
}

impl GraphicsCaptureApiHandler for FrameSink {
    type Flags = HandlerFlags;
    type Error = anyhow::Error;

    fn new(ctx: HandlerCtx<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: ctx.flags.tx,
            stop_rx: ctx.flags.stop_rx,
            dropped: 0,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.stop_rx.try_recv().is_ok() {
            capture_control.stop();
            return Ok(());
        }

        let buf = frame.buffer().context("Frame::buffer")?;
        let width = buf.width();
        let height = buf.height();

        // `FrameBuffer::as_nopadding_buffer` returns the de-padded slice; the
        // `&mut Vec<u8>` is scratch the crate uses internally if it needs to
        // de-stride. We materialise into a fresh Vec via `.to_vec()` because
        // the slice's lifetime is tied to `buf`. Stage 7 replaces this with
        // D3D11-texture sharing for zero-copy to NVENC; CPU-buffer is fine
        // here.
        let mut scratch: Vec<u8> = Vec::new();
        let bgra = buf.as_nopadding_buffer(&mut scratch).to_vec();

        let captured = CapturedFrame { width, height, bgra };

        match self.tx.try_send(captured) {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                self.dropped += 1;
                if self.dropped % 30 == 0 {
                    eprintln!("[capture] backpressure: {} frames dropped", self.dropped);
                }
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                capture_control.stop();
            }
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // Capture-Item ist weg (Fenster geschlossen, Monitor abgesteckt). Sender
        // schließt durch Drop von Self.
        Ok(())
    }
}

// ── Worker-Thread-Entry ─────────────────────────────────────────────────────

fn run_capture(
    target: ResolvedTarget,
    cfg: CaptureConfig,
    tx: std::sync::mpsc::SyncSender<CapturedFrame>,
    stop_rx: Receiver<()>,
) -> Result<()> {
    let cursor = if cfg.include_cursor {
        CursorCaptureSettings::WithCursor
    } else {
        CursorCaptureSettings::WithoutCursor
    };
    let border = if cfg.draw_border {
        DrawBorderSettings::WithBorder
    } else {
        DrawBorderSettings::WithoutBorder
    };
    let min_interval = if cfg.max_fps == 60 {
        MinimumUpdateIntervalSettings::Default
    } else {
        // `windows-capture` nimmt `std::time::Duration`. min update interval =
        // 1/fps; bei 30fps z.B. ~33ms. Crate clampt das wenn nötig.
        MinimumUpdateIntervalSettings::Custom(std::time::Duration::from_secs_f64(
            1.0 / cfg.max_fps as f64,
        ))
    };

    let flags = HandlerFlags { tx, stop_rx };

    match target {
        ResolvedTarget::Monitor(monitor) => {
            let settings = Settings::new(
                monitor,
                cursor,
                border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            );
            FrameSink::start(settings).context("Monitor capture failed")?;
        }
        ResolvedTarget::Window(window) => {
            let settings = Settings::new(
                window,
                cursor,
                border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            );
            FrameSink::start(settings).context("Window capture failed")?;
        }
    }

    Ok(())
}
