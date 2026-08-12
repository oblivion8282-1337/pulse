//! WGC-Capture mit Zero-Copy in einen D3D11VA-Pool (D3D11-Zero-Copy-Pfad —
//! NVENC auf NVIDIA, `av1_amf` auf AMD).
//!
//! Variante von `wgc.rs::WgcCapture`. Statt im Callback einen BGRA-CPU-Buffer
//! zu materialisieren, bringen wir die WGC-Frame-Texture GPU-intern in einen
//! Pool-Frame aus `encode::HwContext`. Die Pipeline endet beim Encoder ohne
//! PCIe-Hin-und-Her.
//!
//! **Hier stand bis zum 2026-08-07 „kopieren wir … per `CopySubresourceRegion`"
//! — das ist jetzt nur noch der eine von zwei Wegen.** In HDR rechnet der
//! Farbwandler direkt aus der WGC-Textur nach P010, und die Kopie entfällt
//! ganz; welcher Weg gilt und warum, steht in [`super::aufnahmeziel`]. Was das
//! für WGC-seitigen Bildverlust bedeutet — und warum es dafür einen eigenen
//! Zähler braucht — in [`super::rueckruf`].
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

use windows_capture::capture::{Context as HandlerCtx, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{DirtyRegionSettings, SecondaryWindowSettings, Settings};

use super::aufnahmeziel::{self, Aufnahmeziel};
use super::rueckruf::{RueckrufStand, RueckrufWacht};
use super::source::{CaptureSource, MaskGate, ResolvedTarget, SourceGuard};
use super::wgc::CaptureConfig;
use crate::encode::{HwContext, OwnedHwFrame};

/// Items aus dem Capture-Thread. Erstes ist immer Setup, danach Frame.
pub enum HwCaptureItem {
    Setup {
        width: u32,
        height: u32,
        /// Gesetzt, wenn die Aufnahme das Bild **schon gewandelt** hat — dann
        /// führt der Pool P010 in genau diesen Maßen, und zwischen Aufnahme und
        /// Encoder steht nichts mehr. `None` = der alte Weg mit Zwischenkopie.
        direkt: Option<(u32, u32)>,
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
    /// Verweildauer im Aufnahme-Rückruf und die daraus folgende Obergrenze
    /// WGC-seitig verworfener Bilder — s. [`super::rueckruf`]. **Der einzige
    /// Zähler, der überhaupt etwas über WGC-seitigen Verlust sagt**; `dropped`
    /// kennt nur unsere eigene Seite.
    wacht: Arc<RueckrufWacht>,
}

impl WgcHwCapture {
    pub fn start(source: CaptureSource, cfg: CaptureConfig, pool_size: u32) -> Result<Self> {
        let target = source.resolve()?;
        // Dasselbe aufgelöste Ziel, auf das die Fernsteuerung ihre Koordinaten
        // klemmt — ein zweites `resolve()` dort zeigte womöglich woanders hin
        // (Begründung: `remote_input::ziel::ziel_gebunden`).
        crate::remote_input::ziel::ziel_gebunden(&target);
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
        let wacht = Arc::new(RueckrufWacht::neu(cfg.max_fps));
        let wacht_for_thread = wacht.clone();
        let worker = thread::spawn(move || -> Result<(), String> {
            run_capture(
                target,
                cfg_for_thread,
                tx,
                stop_rx,
                pool_size_for_thread,
                dropped_for_thread,
                wacht_for_thread,
            )
            .map_err(|e| format!("{e:#}"))
        });
        Ok(Self { items, stop_tx, worker: Some(worker), dropped, wacht })
    }

    /// Kumulativ verworfene Capture-Frames seit Start. Lock-frei pollbar.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Abzug der Rückruf-Zähler. Lock-frei pollbar, wie [`Self::dropped`].
    pub fn rueckruf_stand(&self) -> RueckrufStand {
        self.wacht.stand()
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
    /// Wird in 16-Bit-Fließkomma aufgenommen (HDR)? Entscheidet über Pool- und
    /// Ersatztextur-Format, s. `super::bildformat`.
    hdr: bool,
    /// Wandlung im Rückruf gewünscht? Dann die Ziel-Box (`Some(None)` =
    /// Aufnahmegröße). Beim ersten Bild werden daraus die Zielmaße.
    kasten: Option<Option<(u32, u32)>>,
    /// Wie das Bild in die Pool-Textur kommt: Kopie oder Farbwandlung. Steht
    /// erst ab dem ersten Bild fest (mit dem Pool zusammen).
    ziel: Option<Aufnahmeziel>,
    wacht: Arc<RueckrufWacht>,
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
    hdr: bool,
    /// Wandlung im Rückruf: die Ziel-Box, in die dabei verkleinert wird
    /// (`Some(None)` = Aufnahmegröße). `None` = alter Weg mit Zwischenkopie.
    direkt_kasten: Option<Option<(u32, u32)>>,
    wacht: Arc<RueckrufWacht>,
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
            hdr: ctx.flags.hdr,
            kasten: ctx.flags.direkt_kasten,
            ziel: None,
            wacht: ctx.flags.wacht,
        })
    }

    /// **Die Verweildauer wird hier gemessen, nicht drinnen**, damit sie jeden
    /// Ausgang erfasst — auch die frühen Rückkehrpunkte und den Fehlerfall.
    /// Sie ist die einzige Größe, aus der sich WGC-seitiger Bildverlust
    /// überhaupt beschränken lässt (`super::rueckruf`).
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let beginn = std::time::Instant::now();
        let ergebnis = self.bild_verarbeiten(frame, capture_control);
        self.wacht.verbuchen(beginn.elapsed());
        ergebnis
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
    fn bild_verarbeiten(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<()> {
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
            // Zielmaße aus der Box — dieselbe Funktion, die auch der Taktfaden
            // nimmt, damit Pool und Encoder nicht auseinanderlaufen können.
            let direkt = self
                .kasten
                .map(|k| crate::stream_controller::zielmasse(width, height, k));
            // Lock bleibt auf Default: der Capture-Pool besitzt ihn selbst —
            // Scaler bzw. Farbwandler teilen ihn dann (#2). Welches Format der
            // Pool führt und was hineinschreibt, entscheidet `aufnahmeziel`.
            let aufbau = aufnahmeziel::bauen(
                frame.device(),
                frame.device_context(),
                width,
                height,
                self.pool_size,
                self.hdr,
                direkt,
            )
            .context("Aufnahme-Pool")?;
            let hw = Arc::new(aufbau.hw);
            self.ziel = Some(aufbau.ziel);
            if self.mask.has_guard() {
                self.black =
                    Some(super::black_bgra_texture(frame.device(), width, height, self.hdr)?);
            }
            let mut pool_frame = hw.acquire_frame().context("acquire first pool frame")?;
            pool_frame.set_pts(0);
            self.ins_pool(&hw, frame, masked, &pool_frame)?;
            let setup = HwCaptureItem::Setup {
                width,
                height,
                direkt,
                hw: hw.clone(),
                first: pool_frame,
                first_qpc: qpc,
            };
            self.hw = Some(hw);
            // Setup ist one-shot; falls Channel ge-disconnected ist sofort stoppen.
            if self.tx.try_send(setup).is_err() {
                capture_control.stop();
            }
            return Ok(());
        }

        let hw = self.hw.clone().unwrap();
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
        self.ins_pool(&hw, frame, masked, &pool_frame)?;
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

    /// Quelltextur dieses Frames in die Pool-Textur bringen — kopieren oder
    /// gleich wandeln, s. [`Aufnahmeziel`].
    ///
    /// Bei aktiver Privacy-Mask ist die Quelle die schwarze Ersatztextur, sonst
    /// die WGC-Frame-Textur. `masked` kann nur `true` sein, wenn ein Guard
    /// existiert — dann hat der erste Frame `black` gebaut.
    fn ins_pool(
        &mut self,
        hw: &HwContext,
        frame: &Frame,
        masked: bool,
        dst: &OwnedHwFrame,
    ) -> Result<()> {
        // Die Felder einzeln ausleihen: `black` wird gelesen, während `ziel`
        // verändert wird. Ohne die Zerlegung bräuchte die Quelltextur einen
        // Klon — ein COM-Zählerpaar je Bild, ausgerechnet in dem Rückruf,
        // dessen Verweildauer die Wacht beschränkt.
        let Self { black, ziel, .. } = self;
        let src = if masked { black.as_ref().unwrap() } else { frame.as_raw_texture() };
        ziel.as_mut()
            .ok_or_else(|| anyhow!("Aufnahmeziel fehlt"))?
            .schreiben(hw, src, dst)
    }
}

#[allow(clippy::too_many_arguments)]
fn run_capture(
    target: ResolvedTarget,
    cfg: CaptureConfig,
    tx: SyncSender<HwCaptureItem>,
    stop_rx: Receiver<()>,
    pool_size: u32,
    dropped: Arc<AtomicU64>,
    wacht: Arc<RueckrufWacht>,
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
        hdr: cfg.hdr,
        direkt_kasten: cfg.hdr_direkt.then_some(cfg.ziel_kasten),
        wacht,
    };
    // Farbformat und Pool-Format kommen aus derselben Quelle — s. `bildformat`.
    let farbformat = super::bildformat(cfg.hdr).0;

    match target {
        ResolvedTarget::Monitor { monitor, .. } => {
            let settings = Settings::new(
                monitor,
                cursor,
                border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                farbformat,
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
                farbformat,
                flags,
            );
            HwFrameSink::start(settings).context("Window capture failed")?;
        }
    }
    Ok(())
}
