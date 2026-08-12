//! WGC-Capture mit Cross-API-Brücke nach D3D12 (AMD-Zero-Copy-Pfad, Phase 2).
//!
//! Windows hat keine D3D12-Bildschirmaufnahme — WGC liefert zwingend
//! `ID3D11Texture2D`. Dieses Modul kopiert jede WGC-Frame GPU-intern in einen
//! **Ring teilbarer D3D11-BGRA-Texturen** (`CopySubresourceRegion`). Jede
//! Ring-Textur ist mit `SHARED_NTHANDLE` erzeugt; der zugehörige NT-Handle
//! wird einmalig zum Pacing-Loop geschickt, der ihn auf FFmpegs D3D12-Device
//! per `OpenSharedHandle` zu einer `ID3D12Resource` öffnet (s. `pipeline_d3d12`).
//!
//! Kein PCIe-Roundtrip, kein CPU-`Vec<u8>` — anders als `wgc.rs`. Der spätere
//! D3D12-Compute-Shader (`encode::d3d12_convert`) liest die BGRA-Resource
//! direkt und schreibt NV12 in den Encoder-Pool.
//!
//! Ring-Recycling: ein Slot ist erst wieder frei, wenn der Pacing-Loop ihn
//! fertig konvertiert hat — er gibt den Slot-Index über `free_tx` zurück. Ist
//! kein Slot frei, wird die Capture-Frame verworfen (Backpressure).
//!
//! Threading: WGCs `ID3D11Device` wird ausschließlich vom Capture-Thread
//! benutzt (FFmpeg rührt es nicht an) — kein Lock nötig, anders als `wgc_hw.rs`.
//! Cross-API-Sync: nach dem Copy wartet der Capture-Thread per CPU-Fence, bis
//! die D3D11-GPU-Arbeit fertig ist, BEVOR er den Slot freigibt — dann liest
//! der D3D12-Converter eine garantiert vollständige Surface.
//!
//! ## ZWILLING — wer hier etwas lernt, muss es dort nachtragen
//!
//! `streaming/pulse-player/src/zerocopy/bruecke.rs` fährt seit dem 2026-08-06
//! dieselbe Brücke in der Gegenrichtung (dekodiertes Bild statt Capture-Frame),
//! strukturgleich bis hin zum CPU-Fence. Es sind zwei getrennte Crates ohne
//! gemeinsame Bibliothek — bewusst nicht geteilt, aber deshalb diese Notiz: die
//! beiden waren am 2026-08-06 bereits auseinandergelaufen (`Flush()` und das
//! Überspringen des Wartens bei erreichtem Fence-Wert gab es nur hier).
//! Kommt ein dritter Verbraucher dazu, oder wird der queue-seitige Fence
//! gebaut, ist das der Zeitpunkt für eine gemeinsame Crate.

use anyhow::{Context as _, Result, anyhow};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::thread::{self, JoinHandle};

use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_FENCE_FLAG_NONE,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Device5, ID3D11DeviceContext,
    ID3D11DeviceContext4, ID3D11Fence, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};
use windows::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};
use windows::core::{Interface, PCWSTR};

use windows_capture::capture::{Context as HandlerCtx, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, DirtyRegionSettings, SecondaryWindowSettings, Settings,
};

use super::source::{CaptureSource, MaskGate, ResolvedTarget, SourceGuard};
use super::wgc::CaptureConfig;

/// Ring-Größe: so viele teilbare BGRA-Texturen, dass der Capture-Thread Frame
/// K+1 schreiben kann, während der Pacing-Loop Frame K konvertiert.
pub const RING_SIZE: usize = 4;

/// Items aus dem Capture-Thread. Erstes ist immer `Setup` (Dimensionen + die
/// `RING_SIZE` NT-Handles), danach `Frame { slot }`.
pub enum D3d12CaptureItem {
    Setup {
        width: u32,
        height: u32,
        /// NT-Handle-Werte (`HANDLE.0 as isize`) der Ring-Texturen, Index =
        /// Slot. Der Pacing-Loop öffnet sie auf FFmpegs D3D12-Device.
        handles: Vec<isize>,
    },
    Frame {
        slot: usize,
        /// WGC-HW-Capture-Timestamp (QPC, 100ns) des Frames; 0 = n/a.
        qpc: i64,
    },
}

/// Living capture-handle. Drop = stop.
pub struct WgcD3d12Capture {
    pub items: Receiver<D3d12CaptureItem>,
    /// Der Pacing-Loop gibt fertig konvertierte Slots hierüber zurück.
    pub free_tx: Sender<usize>,
    stop_tx: Sender<()>,
    worker: Option<JoinHandle<Result<(), String>>>,
    dropped: Arc<AtomicU64>,
}

impl WgcD3d12Capture {
    pub fn start(source: CaptureSource, cfg: CaptureConfig) -> Result<Self> {
        let target = source.resolve()?;
        // Dasselbe aufgelöste Ziel, auf das die Fernsteuerung ihre Koordinaten
        // klemmt — ein zweites `resolve()` dort zeigte womöglich woanders hin
        // (Begründung: `remote_input::ziel::ziel_gebunden`).
        crate::remote_input::ziel::ziel_gebunden(&target);
        let (items_tx, items) = channel();
        let (free_tx, free_rx) = channel::<usize>();
        // Alle Slots starten frei.
        for i in 0..RING_SIZE {
            let _ = free_tx.send(i);
        }
        let (stop_tx, stop_rx) = channel();
        let dropped = Arc::new(AtomicU64::new(0));

        let flags = SinkFlags {
            items_tx,
            free_rx,
            stop_rx,
            dropped: dropped.clone(),
            guard: target.guard(),
            is_window: target.is_window(),
        };
        let worker = thread::Builder::new()
            .name("wgc-d3d12-capture".into())
            .spawn(move || -> Result<(), String> {
                run_capture(target, cfg, flags).map_err(|e| format!("{e:#}"))
            })
            .context("spawn wgc-d3d12-capture thread")?;

        Ok(Self {
            items,
            free_tx,
            stop_tx,
            worker: Some(worker),
            dropped,
        })
    }

    /// Kumulativ verworfene Capture-Frames (kein freier Ring-Slot ODER
    /// Größen-Mismatch nach Resize).
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn stop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(h) = self.worker.take() {
            // Zeitlimit statt hartem `join()` — s. `super::join_or_detach`.
            super::join_or_detach(h, "wgc-d3d12");
        }
    }

    /// Worker-Thread joinen und dessen Ergebnis-String liefern: `Some(msg)`
    /// bei Fehler/Panic, `None` bei cleanem Exit oder wenn der Handle schon
    /// genommen wurde. Idempotent. Die Pipeline ruft das bei Channel-Disconnect
    /// auf, damit die echte Root-Cause (WGC-Close ohne Frame / Bridge-Fehler /
    /// Panic) nicht im JoinHandle verlorengeht — `recv_timeout`/`try_recv`
    /// liefern sonst nur die wertlose „channel disconnected"-Meldung.
    pub fn join_error(&mut self) -> Option<String> {
        // Mit Zeitlimit — ein hängender WGC-Teardown darf den Fehlerpfad der
        // Pipeline nicht blockieren (s. `super::join_result_or_detach`).
        self.worker
            .take()
            .and_then(|h| super::join_result_or_detach(h, "wgc-d3d12"))
    }
}

impl Drop for WgcD3d12Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── Handler ─────────────────────────────────────────────────────────────────

struct SinkFlags {
    items_tx: Sender<D3d12CaptureItem>,
    free_rx: Receiver<usize>,
    stop_rx: Receiver<()>,
    dropped: Arc<AtomicU64>,
    guard: Option<SourceGuard>,
    is_window: bool,
}

/// Ein Ring-Slot: teilbare D3D11-BGRA-Textur + ihr Keyed-Mutex.
struct RingSlot {
    texture: ID3D11Texture2D,
    mutex: IDXGIKeyedMutex,
}

/// Cross-API-Sync-State, lazy beim ersten Frame aus WGCs Device gebaut.
struct Bridge {
    ctx: ID3D11DeviceContext,
    ctx4: ID3D11DeviceContext4,
    fence: ID3D11Fence,
    fence_event: HANDLE,
    fence_value: u64,
    ring: Vec<RingSlot>,
    expected: (u32, u32),
    /// Schwarze Ersatz-Quelltextur für den Privacy-Mask-Pfad; nur gebaut,
    /// wenn ein `SourceGuard` existiert (s. `super::black_bgra_texture`).
    black: Option<ID3D11Texture2D>,
}

// Die COM-Objekte + der `HANDLE` werden ausschließlich auf dem WGC-Capture-
// Thread erzeugt und benutzt — der Handler wird einmalig dorthin gemoved, nie
// geteilt. `Send` ist die windows-capture-API-Bedingung; gleiche Begründung
// wie `unsafe impl Send for HwContext` in `encode/hwctx.rs`.
unsafe impl Send for Bridge {}

struct D3d12FrameSink {
    items_tx: Sender<D3d12CaptureItem>,
    free_rx: Receiver<usize>,
    stop_rx: Receiver<()>,
    dropped: Arc<AtomicU64>,
    bridge: Option<Bridge>,
    /// Privacy-Mask beim Fenster→Monitor-Fallback (s. `source::SourceGuard`).
    mask: MaskGate,
    /// Fenster-Target? Dann heißt `on_closed` „Quell-Fenster zerstört" →
    /// gleicher saubere-Stop-Pfad wie der Guard (`SOURCE_CLOSED_MARKER`).
    is_window: bool,
    /// Aufeinanderfolgende Frames mit Dimensionen != `Bridge::expected` seit
    /// dem letzten passenden Frame. Karenz gegen kurze Resize-Serien (Maus-Drag
    /// am Fensterrand) — erst bei `RESIZE_RESTART_THRESHOLD` geben wir auf.
    resize_mismatches: u32,
}

/// Aufeinanderfolgende Größen-Mismatches, bevor wir den Ring als endgültig
/// veraltet betrachten (~2s bei 60fps) und den Capture-Thread mit Fehler
/// beenden statt weiter stumm Frames zu verwerfen.
const RESIZE_RESTART_THRESHOLD: u32 = 120;

impl GraphicsCaptureApiHandler for D3d12FrameSink {
    type Flags = SinkFlags;
    type Error = anyhow::Error;

    fn new(ctx: HandlerCtx<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            items_tx: ctx.flags.items_tx,
            free_rx: ctx.flags.free_rx,
            stop_rx: ctx.flags.stop_rx,
            dropped: ctx.flags.dropped,
            bridge: None,
            mask: MaskGate::new(ctx.flags.guard),
            is_window: ctx.flags.is_window,
            resize_mismatches: 0,
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
        // Schirm → schwarze Ersatztextur statt der WGC-Frame in den Slot
        // kopieren (s. `copy_into_slot`). `?` = Fenster geschlossen (Spiel
        // beendet) → Worker endet mit Marker, `worker_finished` macht daraus
        // einen sauberen Stop.
        let masked = self.mask.frame_masked()?;

        // Erste Frame: Ring + Sync-State aus WGCs D3D11-Device bauen, `Setup`
        // mit allen NT-Handles schicken.
        if self.bridge.is_none() {
            let width = frame.width();
            let height = frame.height();
            let bridge = Bridge::build(
                frame.device().clone(),
                frame.device_context().clone(),
                width,
                height,
                self.mask.has_guard(),
            )
            .context("Bridge::build")?;
            // NT-Handles vor dem Move in `self.bridge` einsammeln.
            let handle_vals = bridge.handle_values().context("handle_values")?;
            let setup = D3d12CaptureItem::Setup { width, height, handles: handle_vals };
            self.bridge = Some(bridge);
            if let Err(err) = self.items_tx.send(setup) {
                // Empfänger schon weg, bevor der Pacing-Loop die NT-Handles per
                // `OpenSharedHandle` übernehmen konnte — ohne diesen Cleanup
                // blieben die rohen Kernel-Handles (einer pro Ring-Slot) für
                // immer offen (`err.0` liefert das nicht zugestellte Item zurück).
                if let D3d12CaptureItem::Setup { handles, .. } = err.0 {
                    for h in handles {
                        unsafe {
                            let _ = CloseHandle(HANDLE(h as *mut std::ffi::c_void));
                        }
                    }
                }
                capture_control.stop();
                return Ok(());
            }
        }

        let bridge = self.bridge.as_mut().unwrap();
        // WGC kann die Größe mitten im Stream ändern → der Ring passt dann
        // nicht mehr; solche Frames verwerfen (selten, z.B. Auflösungswechsel).
        if !bridge.dims_match(frame.width(), frame.height()) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            self.resize_mismatches += 1;
            if self.resize_mismatches == 1 {
                eprintln!(
                    "[capture-d3d12] Frame-Größe geändert: erwartet {}x{}, bekommen {}x{} — verwerfe Frames bis der Ring neu aufgebaut ist",
                    bridge.expected.0, bridge.expected.1, frame.width(), frame.height()
                );
            }
            if self.resize_mismatches >= RESIZE_RESTART_THRESHOLD {
                // Der Ring bleibt dauerhaft falsch dimensioniert (Resize hat
                // sich stabilisiert, aber der Ring wurde nie neu gebaut) — die
                // Session muss neu gestartet werden statt für immer stumm zu
                // verwerfen. `on_frame_arrived` gibt den Fehler zurück, WGC
                // beendet die Capture, der Worker-Thread endet damit; die
                // Pipeline liest den String über `join_error` (s. `WgcD3d12Capture`).
                return Err(anyhow!(
                    "{}: {}x{} -> {}x{} — stream must be restarted",
                    super::RESIZE_ERROR_MARKER,
                    bridge.expected.0,
                    bridge.expected.1,
                    frame.width(),
                    frame.height()
                ));
            }
            return Ok(());
        }
        self.resize_mismatches = 0;
        let src = frame.as_raw_texture();

        // Freien Ring-Slot holen; keiner frei → Frame verwerfen (Backpressure).
        let slot = match self.free_rx.try_recv() {
            Ok(s) => s,
            Err(TryRecvError::Empty) => {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 60 == 0 {
                    eprintln!("[capture-d3d12] backpressure: {n} frames dropped");
                }
                return Ok(());
            }
            Err(TryRecvError::Disconnected) => {
                capture_control.stop();
                return Ok(());
            }
        };

        match bridge.copy_into_slot(slot, src, masked) {
            Ok(()) => {
                if self
                    .items_tx
                    .send(D3d12CaptureItem::Frame { slot, qpc })
                    .is_err()
                {
                    capture_control.stop();
                }
            }
            Err(e) => return Err(e),
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

impl Bridge {
    /// Baut Ring + Sync aus WGCs D3D11-Handles.
    fn build(
        device: ID3D11Device,
        ctx: ID3D11DeviceContext,
        width: u32,
        height: u32,
        want_mask: bool,
    ) -> Result<Self> {
        let device5: ID3D11Device5 = device.cast().context("cast ID3D11Device5")?;
        let ctx4: ID3D11DeviceContext4 = ctx.cast().context("cast ID3D11DeviceContext4")?;

        let mut fence: Option<ID3D11Fence> = None;
        unsafe { device5.CreateFence(0, D3D11_FENCE_FLAG_NONE, &mut fence) }
            .context("CreateFence")?;
        let fence = fence.ok_or_else(|| anyhow!("D3D11-Fence NULL"))?;
        let fence_event =
            unsafe { CreateEventW(None, false, false, None) }.context("CreateEventW")?;

        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            // SHARED_NTHANDLE für D3D12-`OpenSharedHandle`; die D3D11-API
            // verlangt KEYEDMUTEX zwingend dazu (verifiziert per
            // `probe_d3d12_zerocopy`). WICHTIG (#6): der Keyed-Mutex
            // synchronisiert NICHT über die API-Grenze — D3D12-geöffnete
            // Resources stellen keinen `IDXGIKeyedMutex` bereit, der D3D12-Reader
            // (Converter) kann ihn also gar nicht akquirieren. Er klammert hier
            // nur den D3D11-seitigen `CopySubresourceRegion` (s. `copy_into_slot`)
            // und erfüllt die NTHANDLE-Erstellungs-Anforderung. Die EIGENTLICHE
            // D3D11→D3D12-Fertigstellungs-Synchronisation leistet der explizite
            // CPU-Fence in `copy_into_slot`; Slot-Exklusivität garantiert der
            // mpsc-Channel (Writer/Reader berühren nie denselben Slot zugleich).
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
                | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
        };
        let mut ring = Vec::with_capacity(RING_SIZE);
        for _ in 0..RING_SIZE {
            let mut tex: Option<ID3D11Texture2D> = None;
            unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex)) }
                .context("CreateTexture2D(shared BGRA ring slot)")?;
            let texture = tex.ok_or_else(|| anyhow!("Ring-Textur NULL"))?;
            let mutex: IDXGIKeyedMutex = texture.cast().context("cast IDXGIKeyedMutex")?;
            ring.push(RingSlot { texture, mutex });
        }

        // `hdr: false` ist hier keine Vereinfachung, sondern die Lage: der
        // D3D12-Weg nimmt fest in BGRA auf (s. `ColorFormat::Bgra8` weiter
        // unten) und trägt HDR nicht — er ist seit dem 2026-08-04 nur noch der
        // Gegenprobe-Pfad hinter `PULSE_HQ_AMD_D3D12=1`. Die Absage dafür steht
        // in `encode::hdr`, nicht hier.
        let black = if want_mask {
            Some(super::black_bgra_texture(&device, width, height, false)?)
        } else {
            None
        };

        Ok(Self {
            ctx,
            ctx4,
            fence,
            fence_event,
            fence_value: 0,
            ring,
            expected: (width, height),
            black,
        })
    }

    /// NT-Handle-Werte aller Ring-Texturen (für `Setup`). Je Slot ein eigener
    /// Handle — der Pacing-Loop öffnet jeden genau einmal in D3D12.
    fn handle_values(&self) -> Result<Vec<isize>> {
        let mut out = Vec::with_capacity(self.ring.len());
        for slot in &self.ring {
            let res: IDXGIResource1 = slot
                .texture
                .cast()
                .context("Ring-Textur als IDXGIResource1")?;
            let handle: HANDLE =
                unsafe { res.CreateSharedHandle(None, GENERIC_ALL.0, PCWSTR::null()) }
                    .context("CreateSharedHandle")?;
            // NB: NICHT hier schließen — der Wert wandert per `Setup` zum
            // Pacing-Loop, der ihn erst dort via `OpenSharedHandle` öffnet.
            // Sofortiges CloseHandle wäre ein Use-after-Close. Geschlossen wird
            // nach dem Öffnen in pipeline_d3d12.rs::open_shared_bgra.
            out.push(handle.0 as isize);
        }
        Ok(out)
    }

    /// Kopiert die WGC-Quelltextur in den Ring-Slot und wartet (CPU), bis die
    /// GPU-Kopie fertig ist — danach darf der D3D12-Converter den Slot lesen.
    /// `masked` ersetzt die Quelle durch die schwarze Ersatztextur
    /// (Privacy-Mask, s. `source::SourceGuard`).
    fn copy_into_slot(&mut self, slot: usize, src: &ID3D11Texture2D, masked: bool) -> Result<()> {
        let src = if masked {
            // masked ⇒ Guard existiert ⇒ `build(want_mask=true)` hat sie erzeugt.
            self.black.as_ref().ok_or_else(|| anyhow!("Mask ohne Ersatztextur"))?
        } else {
            src
        };
        let ring_slot = &self.ring[slot];
        unsafe {
            ring_slot
                .mutex
                .AcquireSync(0, INFINITE)
                .context("KeyedMutex::AcquireSync")?;
            self.ctx.CopySubresourceRegion(
                &ring_slot.texture,
                0,
                0,
                0,
                0,
                src,
                0,
                None,
            );
            ring_slot
                .mutex
                .ReleaseSync(0)
                .context("KeyedMutex::ReleaseSync")?;

            // CPU-Fence: warten bis Copy GPU-fertig ist. DIES ist die echte
            // Cross-API-Synchronisation (nicht der Keyed-Mutex, s.o. #6) — erst
            // nach diesem Wait wird der Slot als Frame gemeldet, der D3D12-
            // Converter sieht also garantiert fertige Pixel.
            self.fence_value += 1;
            self.ctx4
                .Signal(&self.fence, self.fence_value)
                .context("D3D11 Signal")?;
            self.ctx.Flush();
            if self.fence.GetCompletedValue() < self.fence_value {
                self.fence
                    .SetEventOnCompletion(self.fence_value, self.fence_event)
                    .context("SetEventOnCompletion")?;
                WaitForSingleObject(self.fence_event, INFINITE);
            }
        }
        Ok(())
    }

    /// Erwartete Capture-Dimensionen — Sicherheitscheck, falls WGC die Größe
    /// mitten im Stream ändert (dann passt der Ring nicht mehr).
    fn dims_match(&self, w: u32, h: u32) -> bool {
        self.expected == (w, h)
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.fence_event);
        }
    }
}

fn run_capture(target: ResolvedTarget, cfg: CaptureConfig, flags: SinkFlags) -> Result<()> {
    // OS-Support-gated (Win10 kennt z.B. IsBorderRequired nicht) — s. capture/mod.rs.
    let cursor = super::cursor_settings(cfg.include_cursor);
    let border = super::border_settings(cfg.draw_border);
    let min_interval = super::min_interval_settings(cfg.max_fps);

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
            D3d12FrameSink::start(settings).context("Monitor capture failed")?;
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
            D3d12FrameSink::start(settings).context("Window capture failed")?;
        }
    }
    Ok(())
}
