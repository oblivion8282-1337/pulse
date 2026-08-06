//! Reiner GPU-Downscaler über `ID3D11VideoProcessor` (`VideoProcessorBlt`).
//!
//! Ersetzt den alten `scale_filter.rs`-Pfad (`hwdownload,format,hwupload_cuda,
//! scale_cuda`). Der war langsam, weil `hwdownload` pro Frame einen 33-MB-PCIe-
//! Download auslöste und der Format-Convert auf der CPU lief (~70 ms/Frame →
//! ~14 FPS-Cap). `VideoProcessorBlt` macht Resize komplett auf der GPU, kein
//! PCIe-Roundtrip, kein swscale, kein CUDA.
//!
//! Pipeline jetzt:
//! ```text
//! WGC-Capture-HwContext (D3D11, src-res, BGRA)
//!   └─→ VideoProcessorBlt   (GPU-Resize, dabei BGRA→BGRA oder BGRA→P010)
//!         └─→ Scaler-HwContext (D3D11, dst-res)  → Encoder direkt
//! ```
//!
//! Das Zielformat entscheidet der Aufrufer (`dst_format`): BGRA ist der
//! Regelfall, P010 der 10-bit-Weg. Beides kostet denselben einen Durchgang —
//! der Video-Processor wandelt die Farben beim Skalieren mit.
//!
//! Der Ziel-Pool (`dst`-`HwContext`) wird mit `D3D11_BIND_RENDER_TARGET`
//! angelegt (zusätzlich zum libavutil-Default DECODER|SHADER_RESOURCE), damit
//! `CreateVideoProcessorOutputView` die Pool-Texturen akzeptiert. NVENC liest
//! dieselben Texturen weiter direkt.
//!
//! Thread-Safety: alle `ID3D11VideoContext`-Aufrufe laufen unter der
//! CRITICAL_SECTION des Ziel-`HwContext` (`lock()`/`unlock()`) — gleiche
//! Disziplin wie `wgc_hw.rs::copy_into_pool`.

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::AVBufferRef;
use std::collections::HashMap;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_TEX2D_ARRAY_VPOV, D3D11_TEX2D_VPIV,
    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2DARRAY, ID3D11Device, ID3D11DeviceContext, ID3D11Resource,
    ID3D11VideoContext, ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_RATIONAL;
use windows::Win32::System::Threading::CRITICAL_SECTION;
use windows::core::Interface;

use super::hwctx::{HwContext, HwPoolConfig, OwnedHwFrame};

/// GPU-Downscaler. Besitzt einen eigenen D3D11VA-Pool in dst-Auflösung, aus dem
/// `scale()` die Ziel-Frames zieht. Capture-Pool bleibt unangetastet.
pub struct D3D11Scaler {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    /// Ziel-Pool (dst-res, BGRA, +RENDER_TARGET). NVENC liest hieraus.
    dst: HwContext,
    /// View-Cache, gekeyt auf (Textur-Ptr, Array-Slice). Pool-Texturen sind
    /// eine feste kleine Menge → nach dem ersten Pool-Durchlauf 0 View-Allocs
    /// im Hot-Path (statt 2 Treiber-Calls pro Frame).
    input_views: HashMap<(usize, u32), ID3D11VideoProcessorInputView>,
    output_views: HashMap<(usize, u32), ID3D11VideoProcessorOutputView>,
}

// ID3D11Video*-Zugriffe sind durch die CRITICAL_SECTION des dst-HwContext
// serialisiert; die COM-Pointer selbst sind nur Heap-Adressen.
unsafe impl Send for D3D11Scaler {}
unsafe impl Sync for D3D11Scaler {}

impl D3D11Scaler {
    /// Baut Video-Processor + Ziel-Pool. `device`/`device_context` sind die
    /// D3D11-Handles aus dem Capture-`HwContext` (selbe GPU wie WGC).
    pub fn new(
        device: ID3D11Device,
        device_context: ID3D11DeviceContext,
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
        fps: u32,
        pool_size: u32,
        // CRITICAL_SECTION des Capture-`HwContext` — der Ziel-Pool teilt sie,
        // damit alle ID3D11DeviceContext-Zugriffe (Capture-Copy, Blt, NVENC)
        // auf EINEM Lock serialisieren (#2-Fix, sonst Datenrace).
        shared_lock: *mut CRITICAL_SECTION,
        // Format des Ziel-Pools: `AV_PIX_FMT_BGRA` (8 bit, Encoder wandelt
        // selbst) oder `AV_PIX_FMT_P010` (10 bit, Begründung am Pool-Bau unten).
        dst_format: ffmpeg_next::ffi::AVPixelFormat,
        // Ziel-Texturen als NT-Handle teilbar anlegen. Nur ein Encode-Weg, der
        // sie in eine andere Grafik-API importiert, braucht das — heute der
        // Vulkan-Weg des Labors (s. `HwPoolConfig::shared`).
        geteilt: bool,
        // Was der Prozessor mit den Farben zu tun hat (s. `super::farbraum`).
        // Getrennt vom `dst_format`, weil das Zielformat die Frage nicht
        // beantwortet: P010 kann BT.709/SDR ODER PQ/BT.2020 tragen, und der
        // Unterschied ist am Format nicht zu sehen — nur am Eingang.
        farbweg: super::farbraum::Farbweg,
        // Angaben des aufgenommenen Bildschirms. Nur der HDR-Weg braucht sie
        // (für die Mastering-Metadaten), dort aber zwingend.
        schirm: Option<&crate::system::hdr::SchirmFarbe>,
    ) -> Result<Self> {
        let video_device: ID3D11VideoDevice = device
            .cast()
            .map_err(|e| anyhow!("device.cast::<ID3D11VideoDevice>(): {e}"))?;
        let video_context: ID3D11VideoContext = device_context
            .cast()
            .map_err(|e| anyhow!("device_context.cast::<ID3D11VideoContext>(): {e}"))?;

        let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
            InputWidth: src_w,
            InputHeight: src_h,
            OutputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
            OutputWidth: dst_w,
            OutputHeight: dst_h,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };

        let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&content_desc) }
            .map_err(|e| anyhow!("CreateVideoProcessorEnumerator: {e}"))?;
        let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
            .map_err(|e| anyhow!("CreateVideoProcessor: {e}"))?;

        // Ziel-Pool: dst-res, mit RENDER_TARGET damit
        // CreateVideoProcessorOutputView die Pool-Texturen frisst. NVENC liest
        // dieselben Texturen direkt (DECODER|SHADER_RESOURCE bleiben gesetzt).
        //
        // Das Ziel-FORMAT ist der 10-bit-Schalter: bei 8 bit bleibt es BGRA und
        // der Encoder rechnet den Convert selbst; bei 10 bit muss hier schon
        // P010 stehen (Begründung an `HwPoolConfig::sw_format`). Der
        // Video-Processor wandelt BGRA→P010 dabei in einem Durchgang mit dem
        // Skalieren — es kostet also keinen zweiten Weg über die GPU.
        let dst = HwContext::new(
            device,
            device_context,
            dst_w,
            dst_h,
            HwPoolConfig {
                pool_size,
                extra_bind_flags: D3D11_BIND_RENDER_TARGET.0 as u32,
                shared_lock: Some(shared_lock), // Capture-Pool-Lock teilen (#2-Fix).
                sw_format: dst_format,
                shared: geteilt,
            },
        )?;

        // Farbraum — Entscheidung und Begründung stehen in `super::farbraum`,
        // nicht hier. Zwei Gründe: HDR braucht dafür eine andere API als SDR
        // (das alte Bitfeld kann PQ und BT.2020 nicht ausdrücken), und diese
        // Datei handelt von Views, Sperren und dem Blt — die Farbwissenschaft
        // dazwischen sucht dort niemand.
        super::farbraum::anwenden(&video_context, &enumerator, &processor, farbweg, schirm)?;
        unsafe {
            video_context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            // Auto-Processing AUS: ohne das macht der Treiber beim Blt
            // Denoise/Edge-Enhance/etc. — reiner Overhead für einen simplen
            // Downscale. Die korrekte Einstellung; auf der getesteten iGPU
            // brachte es keine fps-Änderung (Bottleneck ist die Skalier-
            // Rechenarbeit selbst), schadet aber nicht.
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false.into());
        }

        Ok(Self {
            video_device,
            video_context,
            enumerator,
            processor,
            dst,
            input_views: HashMap::new(),
            output_views: HashMap::new(),
        })
    }

    /// Frames-AVBufferRef des Ziel-Pools — der Encoder hängt das via
    /// `av_buffer_ref` an `AVCodecContext.hw_frames_ctx`.
    pub fn dst_frames_ref(&self) -> *mut AVBufferRef {
        self.dst.frames_ref()
    }

    /// Skaliert einen Capture-Frame in einen frischen Ziel-Pool-Frame.
    /// GPU-only: `VideoProcessorBlt` macht Resize ohne PCIe-Roundtrip. Die
    /// Input/Output-Views werden pro (Textur, Slice) genau einmal erzeugt und
    /// gecacht — Pool-Texturen sind eine feste kleine Menge, nach dem ersten
    /// Pool-Durchlauf gibt es 0 View-Allocs im Hot-Path.
    ///
    /// `vorher` läuft **nach** dem Holen des Ziel-Bildes und **vor** dem Blt.
    /// **Diese Naht ist nicht kosmetisch.** Der Ziel-Pool recycelt Texturen;
    /// wer eine davon noch liest — etwa ein Encoder, der sie in eine andere
    /// Grafik-API importiert hat — muss fertig sein, bevor der Video-Prozessor
    /// hineinschreibt. Ohne diesen Punkt bliebe nur, hinterher zu warten, und
    /// das ist ein Bild zu spät: der Blt lief dann schon. Der Fehler zeigt sich
    /// nicht dort, sondern später als zerrissenes Bild oder Geräteverlust, und
    /// nur manchmal. Wer nichts vorher zu tun hat, gibt `|_| Ok(())`.
    pub fn scale_mit<F>(&mut self, src: &OwnedHwFrame, vorher: F) -> Result<OwnedHwFrame>
    where
        F: FnOnce(&OwnedHwFrame) -> Result<()>,
    {
        let dst_frame = self.dst.acquire_frame()?;
        vorher(&dst_frame)?;
        let src_key = (src.texture_raw() as usize, src.subresource_index());
        let dst_key = (dst_frame.texture_raw() as usize, dst_frame.subresource_index());

        // Views holen — Treiber-Call nur beim ersten Auftreten eines Pool-Slots.
        // Läuft auf dem ID3D11VideoDevice (free-threaded) → kein Context-Lock.
        self.ensure_input_view(src_key, src.texture_raw())?;
        self.ensure_output_view(dst_key, dst_frame.texture_raw())?;

        // Blt auf dem ID3D11VideoContext — unter dem dst-HwContext-Lock (gleiche
        // CRITICAL_SECTION-Disziplin wie copy_into_pool).
        self.dst.lock();
        let result = unsafe { self.blt_cached(src_key, dst_key) };
        self.dst.unlock();
        result?;

        Ok(dst_frame)
    }

    /// Erzeugt + cacht einen Input-View für eine Capture-Pool-Textur/Slice.
    fn ensure_input_view(&mut self, key: (usize, u32), tex_raw: *mut std::ffi::c_void) -> Result<()> {
        if self.input_views.contains_key(&key) {
            return Ok(());
        }
        let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: key.1 },
            },
        };
        let res = unsafe { ID3D11Resource::from_raw_borrowed(&tex_raw) }
            .ok_or_else(|| anyhow!("src texture is null"))?;
        let mut view: Option<ID3D11VideoProcessorInputView> = None;
        unsafe {
            self.video_device.CreateVideoProcessorInputView(
                res,
                &self.enumerator,
                &desc,
                Some(&mut view),
            )
        }
        .map_err(|e| anyhow!("CreateVideoProcessorInputView: {e}"))?;
        self.input_views
            .insert(key, view.ok_or_else(|| anyhow!("input view NULL"))?);
        Ok(())
    }

    /// Erzeugt + cacht einen Output-View für eine Ziel-Pool-Textur/Slice.
    fn ensure_output_view(&mut self, key: (usize, u32), tex_raw: *mut std::ffi::c_void) -> Result<()> {
        if self.output_views.contains_key(&key) {
            return Ok(());
        }
        let desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2DArray: D3D11_TEX2D_ARRAY_VPOV {
                    MipSlice: 0,
                    FirstArraySlice: key.1,
                    ArraySize: 1,
                },
            },
        };
        let res = unsafe { ID3D11Resource::from_raw_borrowed(&tex_raw) }
            .ok_or_else(|| anyhow!("dst pool texture is null"))?;
        let mut view: Option<ID3D11VideoProcessorOutputView> = None;
        unsafe {
            self.video_device.CreateVideoProcessorOutputView(
                res,
                &self.enumerator,
                &desc,
                Some(&mut view),
            )
        }
        .map_err(|e| anyhow!("CreateVideoProcessorOutputView: {e}"))?;
        self.output_views
            .insert(key, view.ok_or_else(|| anyhow!("output view NULL"))?);
        Ok(())
    }

    /// Blt mit gecachten Views. Caller hält den dst-HwContext-Lock; beide Views
    /// MÜSSEN vorher via `ensure_*_view` im Cache liegen.
    unsafe fn blt_cached(&self, src_key: (usize, u32), dst_key: (usize, u32)) -> Result<()> {
        let in_view = self
            .input_views
            .get(&src_key)
            .ok_or_else(|| anyhow!("input view not cached"))?;
        let out_view = self
            .output_views
            .get(&dst_key)
            .ok_or_else(|| anyhow!("output view not cached"))?;

        // `pInputSurface` ist ein `ManuallyDrop` — der geklonte Ref (AddRef)
        // wird nach dem Blt explizit released, sonst COM-Leak pro Frame.
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            OutputIndex: 0,
            InputFrameOrField: 0,
            PastFrames: 0,
            FutureFrames: 0,
            ppPastSurfaces: std::ptr::null_mut(),
            pInputSurface: std::mem::ManuallyDrop::new(Some(in_view.clone())),
            ppFutureSurfaces: std::ptr::null_mut(),
            ppPastSurfacesRight: std::ptr::null_mut(),
            pInputSurfaceRight: std::mem::ManuallyDrop::new(None),
            ppFutureSurfacesRight: std::ptr::null_mut(),
        };
        let streams = [stream];
        let blt_result = unsafe {
            self.video_context
                .VideoProcessorBlt(&self.processor, out_view, 0, &streams)
        };
        // Geklonten Input-Surface-Ref freigeben (ManuallyDrop dropt nicht selbst).
        let [mut s] = streams;
        unsafe {
            std::mem::ManuallyDrop::drop(&mut s.pInputSurface);
            std::mem::ManuallyDrop::drop(&mut s.pInputSurfaceRight);
        }
        blt_result.map_err(|e| anyhow!("VideoProcessorBlt: {e}"))
    }
}
