//! WGC-basierter Capture (`windows-capture` v2 Handler-Trait).
//!
//! Architektur: `Capture::start(settings)` blockiert den aufrufenden Thread —
//! wir starten ihn deshalb auf einem dedizierten Thread und routen Frames per
//! `mpsc::Sender` raus. Der Sender geht in die `Flags` des Handlers rein
//! (einziger Weg State in `GraphicsCaptureApiHandler::new` zu übergeben).
//!
//! Frame-Output: rohe BGRA8-Bytes plus Geometrie. **Das ist der CPU-Pfad** —
//! für AMD AMF + Intel QSV + jeden Downscale-Case. Für NVIDIA-native gibt's
//! parallel `wgc_hw.rs` mit Zero-Copy direkt in einen D3D11VA-Pool; siehe
//! `encode/hwctx.rs` und `pipeline_hw.rs`.

use anyhow::{Context, Result};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::{self, JoinHandle};

use windows_capture::capture::{Context as HandlerCtx, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, DirtyRegionSettings, SecondaryWindowSettings, Settings,
};

use super::source::{CaptureSource, MaskGate, ResolvedTarget, SourceGuard};

/// Ein einzelner Capture-Frame als CPU-Buffer.
#[derive(Debug)]
pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    /// BGRA8 (4 bytes/pixel), `width * height * 4` Bytes lang. Padding-Bytes
    /// wurden bereits rausgestrippt von `frame.buffer()`. Encoder swizzelt
    /// das selbst nach NV12. Zero-Copy-Pfad (NVIDIA) nutzt `wgc_hw.rs` statt
    /// dieses Module — bekommt D3D11-Texture-Handles ohne Sysmem-Roundtrip.
    pub bgra: Vec<u8>,
    /// WGC-Hardware-Capture-Timestamp (`SystemRelativeTime`, QPC, 100ns-Einheiten).
    /// Für die A/V-Sync-Verankerung an der ECHTEN Aufnahmezeit (HW-Timestamps);
    /// `0` = nicht verfügbar → Pacing-Loop fällt auf Wall-clock zurück.
    pub qpc: i64,
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
    /// Das Bild in **16-Bit-Fließkomma** abholen statt in 8-Bit-BGRA.
    ///
    /// Das ist der HDR-Eingang, und es ist die einzige Stelle, an der HDR
    /// überhaupt entstehen kann: WGC gibt bei einem HDR-Desktop in
    /// `Bgra8` ein bereits auf SDR heruntergerechnetes Bild heraus. Was dort
    /// verlorengeht, holt keine spätere Stufe zurück — die Spitzlichter sind
    /// dann abgeschnitten und die weiten Farben zusammengeschoben, und der
    /// Strom trüge trotzdem das HDR-Etikett.
    ///
    /// Die Werte kommen als **scRGB**: lineares Licht mit BT.709-Primärvalenzen,
    /// wobei 1,0 dem SDR-Weiß (per Vereinbarung 80 cd/m²) entspricht und
    /// Spitzlichter darüber hinausgehen. Negative Werte sind erlaubt und
    /// bedeuten Farben außerhalb von BT.709. Die Umrechnung nach PQ/BT.2020
    /// macht der Farbwandler davor dem Encoder — **`encode::hdr_wandler`**,
    /// ein eigener Shader.
    ///
    /// **Hier stand bis zum 2026-08-06 `encode::d3d11_scale`. Das ist falsch,
    /// und der Irrtum ist der lehrreiche Teil:** der Video-Prozessor kann es
    /// auf diesem Treiber gerade NICHT — er verneint jede Wandlung mit
    /// 16-Bit-Fließkomma am Eingang und jede mit PQ am Ausgang (32 geprüfte
    /// Kombinationen, Tabelle in
    /// `encode::farbraum::tests::wandlungen_dieses_treibers`). Genau deshalb
    /// gibt es `hdr_wandler` überhaupt.
    ///
    /// Kostet Bandbreite über den Bus: 8 Byte je Bildpunkt statt 4.
    pub hdr: bool,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            include_cursor: true,
            draw_border: false,
            max_fps: 60,
            channel_capacity: 4,
            hdr: false,
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
    /// Kumulativ verworfene Capture-Frames (Channel-Backpressure). Vom
    /// Capture-Thread geschrieben, vom Pacing-Loop pro Tick gelesen.
    dropped: Arc<AtomicU64>,
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
        let dropped = Arc::new(AtomicU64::new(0));
        let dropped_for_thread = dropped.clone();
        let worker = thread::spawn(move || -> Result<(), String> {
            run_capture(target, cfg_for_thread, tx, stop_rx, dropped_for_thread)
                .map_err(|e| format!("{e:#}"))
        });

        Ok(Self {
            frames: into_unbounded(frames),
            stop_tx,
            worker: Some(worker),
            dropped,
        })
    }

    /// Kumulativ verworfene Capture-Frames seit Start. Lock-frei pollbar.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Stoppt die Capture (best-effort). `Drop` ruft das selber.
    pub fn stop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(handle) = self.worker.take() {
            // Capture::start blockiert — der Stop-Signal-Pfad geht über den
            // Handler-Callback (s. on_frame_arrived). Bleiben die Frames aus,
            // zieht das Signal nie; deshalb mit Zeitlimit joinen statt hart.
            super::join_or_detach(handle, "wgc");
        }
    }

    /// Worker-Thread joinen und dessen Ergebnis-String liefern: `Some(msg)`
    /// bei Fehler/Panic, `None` bei cleanem Exit oder wenn der Handle schon
    /// genommen wurde. Idempotent. Die Pipeline ruft das bei Channel-Disconnect
    /// auf, damit die echte Root-Cause (WGC-Close ohne Frame / Settings-Fehler
    /// / Panic) nicht im JoinHandle verlorengeht — `recv_timeout`/`try_recv`
    /// liefern sonst nur die wertlose „channel disconnected"-Meldung.
    pub fn join_error(&mut self) -> Option<String> {
        // Mit Zeitlimit — ein hängender WGC-Teardown darf den Fehlerpfad der
        // Pipeline nicht blockieren (s. `super::join_result_or_detach`).
        self.worker
            .take()
            .and_then(|h| super::join_result_or_detach(h, "wgc"))
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
    dropped: Arc<AtomicU64>,
    /// Privacy-Mask beim Fenster→Monitor-Fallback (s. `source::SourceGuard`).
    mask: MaskGate,
    /// Fenster-Target? Dann heißt `on_closed` „Quell-Fenster zerstört" →
    /// gleicher saubere-Stop-Pfad wie der Guard (`SOURCE_CLOSED_MARKER`).
    is_window: bool,
}

/// `Flags`-Payload — `windows-capture` reicht den 1:1 an `new()` durch.
struct HandlerFlags {
    tx: std::sync::mpsc::SyncSender<CapturedFrame>,
    stop_rx: Receiver<()>,
    dropped: Arc<AtomicU64>,
    guard: Option<SourceGuard>,
    is_window: bool,
}

impl GraphicsCaptureApiHandler for FrameSink {
    type Flags = HandlerFlags;
    type Error = anyhow::Error;

    fn new(ctx: HandlerCtx<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: ctx.flags.tx,
            stop_rx: ctx.flags.stop_rx,
            dropped: ctx.flags.dropped,
            mask: MaskGate::new(ctx.flags.guard),
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
        // Hardware-Capture-Timestamp (QPC, 100ns) des Frames; 0 = nicht verfügbar.
        let qpc = frame.timestamp().map(|t| t.Duration).unwrap_or(0);

        // `?` = Quell-Fenster geschlossen (Spiel beendet): der Capture-Worker
        // endet mit dem Marker, die Pipeline liest ihn über `join_error`,
        // `worker_finished` mappt ihn auf einen SAUBEREN Stop (kein error).
        let captured = if self.mask.frame_masked()? {
            // Privacy-Mask: Quell-Fenster ist nicht auf dem Schirm → schwarzer
            // Frame statt Desktop-Pixel (zeroed BGRA = Schwarz). `vec![0; n]`
            // ist calloc-billig; die WGC-Pixel werden gar nicht erst angefasst.
            let width = frame.width();
            let height = frame.height();
            let bgra = vec![0u8; width as usize * height as usize * 4];
            CapturedFrame { width, height, bgra, qpc }
        } else {
            let buf = frame.buffer().context("Frame::buffer")?;
            let width = buf.width();
            let height = buf.height();

            // `FrameBuffer::as_nopadding_buffer` returns the de-padded slice; the
            // `&mut Vec<u8>` is scratch the crate uses internally if it needs to
            // de-stride. We materialise into a fresh Vec via `.to_vec()` because
            // the slice's lifetime is tied to `buf`. NVIDIA hat einen parallelen
            // Zero-Copy-Pfad in `wgc_hw.rs` der das vermeidet; hier ist der CPU-
            // Pfad für AMD/Intel/Downscale.
            let mut scratch: Vec<u8> = Vec::new();
            let bgra = buf.as_nopadding_buffer(&mut scratch).to_vec();
            CapturedFrame { width, height, bgra, qpc }
        };

        match self.tx.try_send(captured) {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 30 == 0 {
                    eprintln!("[capture] backpressure: {n} frames dropped");
                }
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                capture_control.stop();
            }
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // Capture-Item ist weg. Beim FENSTER-Target heißt das: die App wurde
        // beendet → mit Marker enden, `worker_finished` macht daraus einen
        // sauberen Stop (statt „channel disconnected (clean exit)"-Fehler).
        // Der Guard deckt diesen Fall NICHT — er läuft im Frame-Callback, und
        // nach dem Item-Close kommt kein Frame mehr. Monitor-Target
        // (abgestecktes Display) behält das alte Verhalten.
        if self.is_window {
            return Err(super::source_closed_err());
        }
        Ok(())
    }
}

// ── Worker-Thread-Entry ─────────────────────────────────────────────────────

fn run_capture(
    target: ResolvedTarget,
    cfg: CaptureConfig,
    tx: std::sync::mpsc::SyncSender<CapturedFrame>,
    stop_rx: Receiver<()>,
    dropped: Arc<AtomicU64>,
) -> Result<()> {
    // OS-Support-gated (Win10 kennt z.B. IsBorderRequired nicht) — s. capture/mod.rs.
    let cursor = super::cursor_settings(cfg.include_cursor);
    let border = super::border_settings(cfg.draw_border);
    let min_interval = super::min_interval_settings(cfg.max_fps);

    let flags = HandlerFlags {
        tx,
        stop_rx,
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
