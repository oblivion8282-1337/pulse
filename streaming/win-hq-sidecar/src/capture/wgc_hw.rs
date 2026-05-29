//! WGC-Capture mit Zero-Copy in einen D3D11VA-Pool (NVENC-Pfad).
//!
//! Variante von `wgc.rs::WgcCapture`. Statt im Callback einen BGRA-CPU-Buffer
//! zu materialisieren, kopieren wir die WGC-Frame-Texture per
//! `CopySubresourceRegion` in einen Pool-Frame aus `encode::HwContext`. Die
//! Pipeline endet beim Encoder ohne PCIe-Hin-und-Her.
//!
//! Lazy-Init: der `HwContext` braucht Dimensionen + WGCs `ID3D11Device`. Beides
//! kennen wir erst im ersten `on_frame_arrived`. Erstes Item im Channel ist
//! deshalb `HwCaptureItem::Setup` mit der `Arc<HwContext>` + dem ersten
//! Pool-Frame; alle folgenden sind `HwCaptureItem::Frame(OwnedHwFrame)`.

use anyhow::{Context as _, Result, anyhow};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender, TrySendError, channel, sync_channel};
use std::thread::{self, JoinHandle};

use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::core::Interface;

use windows_capture::capture::{Context as HandlerCtx, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use super::source::{CaptureSource, ResolvedTarget};
use super::wgc::CaptureConfig;
use crate::encode::{HwContext, OwnedHwFrame};

/// Items aus dem Capture-Thread. Erstes ist immer Setup, danach Frame.
pub enum HwCaptureItem {
    Setup {
        width: u32,
        height: u32,
        hw: Arc<HwContext>,
        first: OwnedHwFrame,
        /// WGC-HW-Capture-Timestamp (QPC, 100ns) des `first`-Frames — Ursprung
        /// der A/V-Timeline (HW-Timestamps).
        first_qpc: i64,
    },
    Frame {
        frame: OwnedHwFrame,
        /// WGC-HW-Capture-Timestamp (QPC, 100ns) des Frames; 0 = n/a.
        qpc: i64,
    },
}

/// Kapazität der Capture→Encoder-Queue. Muss deutlich kleiner als der
/// D3D11VA-`pool_size` sein (s. `WgcHwCapture::start`).
const CHANNEL_CAPACITY: usize = 4;

pub struct WgcHwCapture {
    pub items: Receiver<HwCaptureItem>,
    stop_tx: Sender<()>,
    worker: Option<JoinHandle<Result<(), String>>>,
    /// Kumulativ verworfene Capture-Frames (Pool erschöpft ODER Channel-
    /// Backpressure). Vom Capture-Thread geschrieben, vom Pacing-Loop pro Tick
    /// gelesen — ein Anstieg deutet auf Encode-/Push-Rückstau hin.
    dropped: Arc<AtomicU64>,
}

impl WgcHwCapture {
    pub fn start(source: CaptureSource, cfg: CaptureConfig, pool_size: u32) -> Result<Self> {
        let target = source.resolve()?;
        // Channel-Kapazität bewusst KLEINER als der D3D11VA-Pool: der Channel
        // teilt sich die `pool_size` Surfaces mit scale_cuda (hwmap D3D11→CUDA)
        // und der NVENC-In-Flight-Tiefe. Wäre die Kapazität == pool_size, könnte
        // eine volle Queue den kompletten Pool belegen → 0 Surfaces für den
        // Encoder → „Static surface pool size exceeded" → Push-Crash. Mit 4
        // bleiben pool_size−4 Surfaces für die Encode-Seite.
        let (tx, items) = sync_channel(CHANNEL_CAPACITY);
        let (stop_tx, stop_rx) = channel();
        let pool_size_for_thread = pool_size;
        let cfg_for_thread = cfg.clone();
        let dropped = Arc::new(AtomicU64::new(0));
        let dropped_for_thread = dropped.clone();
        let worker = thread::spawn(move || -> Result<(), String> {
            run_capture(
                target,
                cfg_for_thread,
                tx,
                stop_rx,
                pool_size_for_thread,
                dropped_for_thread,
            )
            .map_err(|e| format!("{e:#}"))
        });
        Ok(Self { items, stop_tx, worker: Some(worker), dropped })
    }

    /// Kumulativ verworfene Capture-Frames seit Start. Lock-frei pollbar.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn stop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

impl Drop for WgcHwCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── Handler ─────────────────────────────────────────────────────────────────

struct HwFrameSink {
    tx: SyncSender<HwCaptureItem>,
    stop_rx: Receiver<()>,
    pool_size: u32,
    hw: Option<Arc<HwContext>>,
    dropped: Arc<AtomicU64>,
}

struct HwHandlerFlags {
    tx: SyncSender<HwCaptureItem>,
    stop_rx: Receiver<()>,
    pool_size: u32,
    dropped: Arc<AtomicU64>,
}

impl GraphicsCaptureApiHandler for HwFrameSink {
    type Flags = HwHandlerFlags;
    type Error = anyhow::Error;

    fn new(ctx: HandlerCtx<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: ctx.flags.tx,
            stop_rx: ctx.flags.stop_rx,
            pool_size: ctx.flags.pool_size,
            hw: None,
            dropped: ctx.flags.dropped,
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
        // Hardware-Capture-Timestamp (QPC, 100ns) des Frames; 0 = n/a.
        let qpc = frame.timestamp().map(|t| t.Duration).unwrap_or(0);

        // Erste Frame: HwContext bauen + Setup + erster Pool-Frame.
        if self.hw.is_none() {
            let width = frame.width();
            let height = frame.height();
            let hw = HwContext::new(
                frame.device().clone(),
                frame.device_context().clone(),
                width,
                height,
                self.pool_size,
                0,    // Capture-Pool: keine extra Bind-Flags (libavutil-Default).
                None, // Capture-Pool besitzt den Lock; der Scaler teilt ihn (#2).
            )
            .context("HwContext::new")?;
            let hw = Arc::new(hw);
            let mut pool_frame = hw.acquire_frame().context("acquire first pool frame")?;
            pool_frame.set_pts(0);
            copy_into_pool(&hw, frame.as_raw_texture(), &pool_frame)?;
            let setup =
                HwCaptureItem::Setup { width, height, hw: hw.clone(), first: pool_frame, first_qpc: qpc };
            self.hw = Some(hw);
            // Setup ist one-shot; falls Channel ge-disconnected ist sofort stoppen.
            if self.tx.try_send(setup).is_err() {
                capture_control.stop();
            }
            return Ok(());
        }

        let hw = self.hw.as_ref().unwrap();
        let pool_frame = match hw.acquire_frame() {
            Ok(f) => f,
            Err(_) => {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 30 == 0 {
                    eprintln!("[capture-hw] pool exhausted: {n} frames dropped");
                }
                return Ok(());
            }
        };
        copy_into_pool(hw, frame.as_raw_texture(), &pool_frame)?;
        match self.tx.try_send(HwCaptureItem::Frame { frame: pool_frame, qpc }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 30 == 0 {
                    eprintln!("[capture-hw] backpressure: {n} frames dropped");
                }
            }
            Err(TrySendError::Disconnected(_)) => capture_control.stop(),
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

fn copy_into_pool(hw: &HwContext, src: &ID3D11Texture2D, dst: &OwnedHwFrame) -> Result<()> {
    hw.lock();
    let result = unsafe {
        let dst_raw = dst.texture_raw();
        // `from_raw_borrowed` braucht `&*mut c_void` — benannter Slot reicht.
        match ID3D11Texture2D::from_raw_borrowed(&dst_raw) {
            Some(dst_tex) => {
                hw.device_context().CopySubresourceRegion(
                    dst_tex,
                    dst.subresource_index(),
                    0,
                    0,
                    0,
                    src,
                    0,
                    None,
                );
                Ok(())
            }
            None => Err(anyhow!("pool frame texture is null")),
        }
    };
    hw.unlock();
    result
}

fn run_capture(
    target: ResolvedTarget,
    cfg: CaptureConfig,
    tx: SyncSender<HwCaptureItem>,
    stop_rx: Receiver<()>,
    pool_size: u32,
    dropped: Arc<AtomicU64>,
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
        MinimumUpdateIntervalSettings::Custom(std::time::Duration::from_secs_f64(
            1.0 / cfg.max_fps as f64,
        ))
    };
    let flags = HwHandlerFlags { tx, stop_rx, pool_size, dropped };

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
            HwFrameSink::start(settings).context("Monitor capture failed")?;
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
            HwFrameSink::start(settings).context("Window capture failed")?;
        }
    }
    Ok(())
}
