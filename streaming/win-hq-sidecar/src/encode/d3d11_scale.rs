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
//!   └─→ VideoProcessorBlt   (GPU-Resize BGRA→BGRA)
//!         └─→ Scaler-HwContext (D3D11, dst-res, BGRA)  → NVENC direkt
//! ```
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
use windows::core::Interface;

use super::hwctx::{HwContext, OwnedHwFrame};

/// GPU-Downscaler. Besitzt einen eigenen D3D11VA-Pool in dst-Auflösung, aus dem
/// `scale()` die Ziel-Frames zieht. Capture-Pool bleibt unangetastet.
pub struct D3D11Scaler {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    /// Ziel-Pool (dst-res, BGRA, +RENDER_TARGET). NVENC liest hieraus.
    dst: HwContext,
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

        // Ziel-Pool: dst-res, BGRA, mit RENDER_TARGET damit
        // CreateVideoProcessorOutputView die Pool-Texturen frisst. NVENC liest
        // dieselben Texturen direkt (DECODER|SHADER_RESOURCE bleiben gesetzt).
        let dst = HwContext::new(
            device,
            device_context,
            dst_w,
            dst_h,
            pool_size,
            D3D11_BIND_RENDER_TARGET.0 as u32,
        )?;

        // Auto-Color-Space-Conversion abschalten: BGRA→BGRA, kein YCbCr im
        // Spiel. Default-Bitfield (0) = RGB Full-Range, Playback-Usage — exakt
        // was wir wollen. Explizit gesetzt, damit ein Treiber-Default uns nicht
        // überrascht (z.B. Studio- statt Full-Range-RGB).
        unsafe {
            let cs = std::mem::zeroed();
            video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &cs);
            video_context.VideoProcessorSetOutputColorSpace(&processor, &cs);
            video_context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            // Auto-Processing AUS: ohne das macht der Treiber beim Blt
            // Denoise/Edge-Enhance/etc. — reiner Overhead für einen simplen
            // Downscale und auf schwacher Hardware (iGPU) der Flaschenhals.
            // Spart auf der AMD-iGPU ~6 ms/Frame (44 → ~60 FPS bei 4K→1080p).
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false.into());
        }

        Ok(Self { video_device, video_context, enumerator, processor, dst })
    }

    /// Frames-AVBufferRef des Ziel-Pools — der Encoder hängt das via
    /// `av_buffer_ref` an `AVCodecContext.hw_frames_ctx`.
    pub fn dst_frames_ref(&self) -> *mut AVBufferRef {
        self.dst.frames_ref()
    }

    /// Skaliert einen Capture-Frame in einen frischen Ziel-Pool-Frame.
    /// GPU-only: `VideoProcessorBlt` macht Resize ohne PCIe-Roundtrip.
    pub fn scale(&self, src: &OwnedHwFrame) -> Result<OwnedHwFrame> {
        let dst_frame = self.dst.acquire_frame()?;

        // Input-View auf die src-Capture-Texture (Array-Pool, ArraySlice =
        // Subresource-Index).
        let mut in_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ArraySlice: src.subresource_index(),
                },
            },
        };
        let mut out_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2DArray: D3D11_TEX2D_ARRAY_VPOV {
                    MipSlice: 0,
                    FirstArraySlice: dst_frame.subresource_index(),
                    ArraySize: 1,
                },
            },
        };

        let src_raw = src.texture_raw();
        let dst_raw = dst_frame.texture_raw();

        // Alle D3D11-Context-Aufrufe unter dem dst-HwContext-Lock (gleiche
        // CRITICAL_SECTION-Disziplin wie copy_into_pool). View-Creation läuft
        // auf dem ID3D11VideoDevice (thread-safe), das Blt auf dem Context.
        self.dst.lock();
        let result = unsafe { self.blt_locked(src_raw, dst_raw, &mut in_desc, &mut out_desc) };
        self.dst.unlock();
        result?;

        Ok(dst_frame)
    }

    /// Innerer Blt-Pfad — Caller hält den dst-HwContext-Lock.
    unsafe fn blt_locked(
        &self,
        src_raw: *mut std::ffi::c_void,
        dst_raw: *mut std::ffi::c_void,
        in_desc: &mut D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
        out_desc: &mut D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    ) -> Result<()> {
        let src_res = unsafe { ID3D11Resource::from_raw_borrowed(&src_raw) }
            .ok_or_else(|| anyhow!("src texture is null"))?;
        let dst_res = unsafe { ID3D11Resource::from_raw_borrowed(&dst_raw) }
            .ok_or_else(|| anyhow!("dst pool texture is null"))?;

        let mut input_view: Option<ID3D11VideoProcessorInputView> = None;
        unsafe {
            self.video_device.CreateVideoProcessorInputView(
                src_res,
                &self.enumerator,
                in_desc as *const _,
                Some(&mut input_view),
            )
        }
        .map_err(|e| anyhow!("CreateVideoProcessorInputView: {e}"))?;
        let input_view = input_view.ok_or_else(|| anyhow!("input view NULL"))?;

        let mut output_view: Option<ID3D11VideoProcessorOutputView> = None;
        unsafe {
            self.video_device.CreateVideoProcessorOutputView(
                dst_res,
                &self.enumerator,
                out_desc as *const _,
                Some(&mut output_view),
            )
        }
        .map_err(|e| anyhow!("CreateVideoProcessorOutputView: {e}"))?;
        let output_view = output_view.ok_or_else(|| anyhow!("output view NULL"))?;

        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            OutputIndex: 0,
            InputFrameOrField: 0,
            PastFrames: 0,
            FutureFrames: 0,
            ppPastSurfaces: std::ptr::null_mut(),
            pInputSurface: std::mem::ManuallyDrop::new(Some(input_view)),
            ppFutureSurfaces: std::ptr::null_mut(),
            ppPastSurfacesRight: std::ptr::null_mut(),
            pInputSurfaceRight: std::mem::ManuallyDrop::new(None),
            ppFutureSurfacesRight: std::ptr::null_mut(),
        };

        let blt_result = unsafe {
            self.video_context
                .VideoProcessorBlt(&self.processor, &output_view, 0, &[stream])
        };
        blt_result.map_err(|e| anyhow!("VideoProcessorBlt: {e}"))
    }
}
