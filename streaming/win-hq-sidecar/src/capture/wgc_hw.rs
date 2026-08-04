//! WGC-Capture mit Zero-Copy in einen D3D11VA-Pool (D3D11-Zero-Copy-Pfad —
//! NVENC auf NVIDIA, `av1_amf` auf AMD).
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
    ColorFormat, DirtyRegionSettings, SecondaryWindowSettings, Settings,
};

use super::source::{CaptureSource, MaskGate, ResolvedTarget, SourceGuard};
use super::wgc::CaptureConfig;
use crate::encode::{HwContext, HwPoolConfig, OwnedHwFrame};

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
    /// Kumulativ verworfene Capture-Frames (Pool erschöpft, Channel-
    /// Backpressure ODER Größen-Mismatch nach Resize). Vom Capture-Thread
    /// geschrieben, vom Pacing-Loop pro Tick gelesen — ein Anstieg deutet auf
    /// Encode-/Push-Rückstau oder eine veränderte Quellgröße hin.
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
            // Zeitlimit statt hartem `join()` — s. `super::join_or_detach`.
            super::join_or_detach(h, "wgc-hw");
        }
    }

    /// Worker-Thread joinen und dessen Ergebnis-String liefern: `Some(msg)`
    /// bei Fehler/Panic, `None` bei cleanem Exit oder wenn der Handle schon
    /// genommen wurde. Idempotent. Die Pipeline ruft das bei Channel-Disconnect
    /// auf, damit die echte Root-Cause (WGC-Close ohne Frame / HwContext-Fehler
    /// / Panic) nicht im JoinHandle verlorengeht — `recv_timeout`/`try_recv`
    /// liefern sonst nur die wertlose „channel disconnected"-Meldung.
    pub fn join_error(&mut self) -> Option<String> {
        // Mit Zeitlimit — ein hängender WGC-Teardown darf den Fehlerpfad der
        // Pipeline nicht blockieren (s. `super::join_result_or_detach`).
        self.worker
            .take()
            .and_then(|h| super::join_result_or_detach(h, "wgc-hw"))
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
    /// Dimensionen des ersten Frames, gegen die jeder folgende Frame geprüft
    /// wird (der Pool ist auf diese Größe gebaut, s. `on_frame_arrived`).
    expected_dims: (u32, u32),
    /// Aufeinanderfolgende Frames mit abweichenden Dimensionen seit dem
    /// letzten passenden Frame. Karenz gegen kurze Resize-Serien — s.
    /// `RESIZE_RESTART_THRESHOLD` in `wgc_d3d12.rs` (gleiche Bauart).
    resize_mismatches: u32,
    /// Privacy-Mask beim Fenster→Monitor-Fallback (s. `source::SourceGuard`).
    mask: MaskGate,
    /// Schwarze Ersatz-Quelltextur; lazy beim ersten Frame gebaut, nur wenn
    /// ein Guard existiert (`super::black_bgra_texture`).
    black: Option<ID3D11Texture2D>,
    /// Fenster-Target? Dann heißt `on_closed` „Quell-Fenster zerstört" →
    /// gleicher saubere-Stop-Pfad wie der Guard (`SOURCE_CLOSED_MARKER`).
    is_window: bool,
}

/// Aufeinanderfolgende Größen-Mismatches, bevor der Pool als endgültig
/// veraltet gilt (~2s bei 60fps) und der Capture-Thread mit Fehler endet
/// statt weiter stumm Frames zu verwerfen. Gleicher Wert wie in `wgc_d3d12.rs`.
const RESIZE_RESTART_THRESHOLD: u32 = 120;

struct HwHandlerFlags {
    tx: SyncSender<HwCaptureItem>,
    stop_rx: Receiver<()>,
    pool_size: u32,
    dropped: Arc<AtomicU64>,
    guard: Option<SourceGuard>,
    is_window: bool,
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
            expected_dims: (0, 0),
            resize_mismatches: 0,
            mask: MaskGate::new(ctx.flags.guard),
            black: None,
            is_window: ctx.flags.is_window,
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

        // Privacy-Mask (Fenster→Monitor-Fallback): Quell-Fenster nicht auf dem
        // Schirm → schwarze Ersatztextur statt der WGC-Frame kopieren. Gilt
        // auch für den allerersten Frame — beim Start aus Pulse heraus ist das
        // Spiel gerade IMMER minimiert. `?` = Fenster geschlossen (Spiel
        // beendet) → Worker endet mit Marker, `worker_finished` macht daraus
        // einen sauberen Stop.
        let masked = self.mask.frame_masked()?;

        // Erste Frame: HwContext bauen + Setup + erster Pool-Frame.
        if self.hw.is_none() {
            let width = frame.width();
            let height = frame.height();
            self.expected_dims = (width, height);
            // Bind-Flags, Format und Lock bleiben auf Default: der Capture-Pool
            // nimmt libavutils BGRA-Default und besitzt den Lock selbst — der
            // Scaler teilt ihn dann (#2).
            let hw = HwContext::new(
                frame.device().clone(),
                frame.device_context().clone(),
                width,
                height,
                HwPoolConfig { pool_size: self.pool_size, ..Default::default() },
            )
            .context("HwContext::new")?;
            let hw = Arc::new(hw);
            if self.mask.has_guard() {
                self.black = Some(super::black_bgra_texture(frame.device(), width, height)?);
            }
            let mut pool_frame = hw.acquire_frame().context("acquire first pool frame")?;
            pool_frame.set_pts(0);
            copy_into_pool(&hw, self.source_texture(frame, masked), &pool_frame)?;
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
        // WGC kann die Größe mitten im Stream ändern → der Pool ist auf
        // `expected_dims` gebaut. `CopySubresourceRegion` wird bei Mismatch im
        // Release-Build still zum No-Op (kein Fehler, kein Frame) — deshalb
        // hier explizit prüfen statt uns auf `copy_into_pool` zu verlassen.
        let (w, h) = (frame.width(), frame.height());
        if (w, h) != self.expected_dims {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            self.resize_mismatches += 1;
            if self.resize_mismatches == 1 {
                eprintln!(
                    "[capture-hw] Frame-Größe geändert: erwartet {}x{}, bekommen {w}x{h} — verwerfe Frames bis der Pool neu aufgebaut ist",
                    self.expected_dims.0, self.expected_dims.1
                );
            }
            if self.resize_mismatches >= RESIZE_RESTART_THRESHOLD {
                // Karenz gegen transiente Resize-Serien (Maus-Drag am
                // Fensterrand) ausgeschöpft — der Pool passt dauerhaft nicht
                // mehr, Session muss neu gestartet werden statt endlos ein
                // Standbild zu liefern. `on_frame_arrived` gibt den Fehler
                // zurück, der Worker-Thread endet damit, die Pipeline liest
                // den String über `join_error` (Fix 1).
                return Err(anyhow!(
                    "{}: {}x{} -> {w}x{h} — stream must be restarted",
                    super::RESIZE_ERROR_MARKER,
                    self.expected_dims.0,
                    self.expected_dims.1
                ));
            }
            return Ok(());
        }
        self.resize_mismatches = 0;
        let pool_frame = match hw.acquire_frame() {
            Ok(f) => f,
            Err(e) => {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 30 == 0 {
                    // Fehlerstring mitloggen — sonst nicht von normaler
                    // Backpressure (Pool kurzzeitig voll) unterscheidbar, wenn
                    // die eigentliche Ursache ein dauerhafter Treiberfehler ist.
                    eprintln!("[capture-hw] pool exhausted: {n} frames dropped, last error: {e:#}");
                }
                return Ok(());
            }
        };
        copy_into_pool(hw, self.source_texture(frame, masked), &pool_frame)?;
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
        // Fenster-Target zerstört (App beendet) → sauberer Stop via Marker;
        // Begründung s. `wgc.rs::on_closed`.
        if self.is_window {
            return Err(super::source_closed_err());
        }
        Ok(())
    }
}

impl HwFrameSink {
    /// Quelltextur dieses Frames: bei aktiver Privacy-Mask die schwarze
    /// Ersatztextur, sonst die WGC-Frame-Textur. `masked` kann nur `true`
    /// sein, wenn ein Guard existiert — dann hat der erste Frame `black`
    /// gebaut.
    fn source_texture<'a>(&'a self, frame: &'a Frame, masked: bool) -> &'a ID3D11Texture2D {
        if masked {
            self.black.as_ref().unwrap()
        } else {
            frame.as_raw_texture()
        }
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
    // OS-Support-gated (Win10 kennt z.B. IsBorderRequired nicht) — s. capture/mod.rs.
    let cursor = super::cursor_settings(cfg.include_cursor);
    let border = super::border_settings(cfg.draw_border);
    let min_interval = super::min_interval_settings(cfg.max_fps);
    let flags = HwHandlerFlags {
        tx,
        stop_rx,
        pool_size,
        dropped,
        guard: target.guard(),
        is_window: target.is_window(),
    };

    match target {
        ResolvedTarget::Monitor { monitor, .. } => {
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
