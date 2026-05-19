//! Resize-Filter-Graph: D3D11 → CPU-format-convert → CUDA → `scale_cuda` → sink.
//!
//! Wird vom HW-Encoder dazwischengeschoben wenn dst != src (Downscale-Override).
//! Pipeline (Stand FFmpeg n8.1):
//! ```text
//! buffer (D3D11, src-res, BGRA)
//!   └─→ hwdownload                  (D3D11 → Sysmem BGRA, PCIe-Download)
//!         └─→ format=nv12           (swscale BGRA → NV12 auf CPU, NUR Format
//!                                    kein Resize — bei 4K single-thread ~80 FPS)
//!               └─→ hwupload_cuda   (Sysmem → CUDA, PCIe-Upload, NV12)
//!                     └─→ scale_cuda=W:H   (Resize NV12→NV12 auf GPU)
//!                           └─→ buffersink (CUDA, dst-res, NV12)
//! ```
//!
//! **Constraints in FFmpeg n8.1, die diesen Pfad erzwungen haben:**
//! - `hwmap=derive_device=cuda` returnt ENOSYS (kein D3D11VA→CUDA derive
//!   implementiert). Daher Sysmem-Bounce.
//! - `scale_cuda=...:format=nv12` kann BGRA-Input nicht zu NV12 konvertieren
//!   („Unsupported conversion: bgra -> semiplanar8"). Daher CPU-format-convert
//!   davor.
//! - `colorspace_cuda` macht nur range-conversion (tv↔pc), kein Pixel-Format.
//!
//! Performance: swscale BGRA→NV12 OHNE Resize ist ~3-4× schneller als swscale
//! mit gleichzeitigem Resize (kein konvolutionaler Anteil, nur Format-Mapping
//! + Downsample der Chroma). Bei 4K@60 ~50-60 FPS auf single-thread. Resize +
//! Final-Output zu NVENC läuft komplett auf der GPU.
//!
//! Echtes Zero-Copy-Downscale wäre ein D3D11-Compute-Shader vor dem Encoder-
//! Pool (BGRA→NV12 + Resize) — separate Iteration, dann auch AMD/Intel-fähig.
//!
//! ffmpeg-next bindet `libavfilter` nur mit Cargo-Feature `filter` — siehe
//! `Cargo.toml`. Wir gehen über die Roh-FFI weil ffmpeg-next's safe AVFilter-
//! Wrapper kein `av_buffersrc_parameters_set` exponiert (das ist zwingend, weil
//! der hw_frames_ctx VOR `avfilter_init_str` rein muss).

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;
use std::ffi::CString;
use std::ptr;

pub struct ScaleFilter {
    graph: *mut AVFilterGraph,
    src_ctx: *mut AVFilterContext,
    sink_ctx: *mut AVFilterContext,
}

unsafe impl Send for ScaleFilter {}

impl ScaleFilter {
    /// Baut den Filter-Graph. `d3d11_frames_ref` ist die AVBufferRef aus dem
    /// HwContext (Capture-Pool). Wir nehmen eine eigene Referenz; Caller behält
    /// seine.
    pub fn new(
        d3d11_frames_ref: *mut AVBufferRef,
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
        fps: u32,
    ) -> Result<Self> {
        unsafe { Self::new_inner(d3d11_frames_ref, src_w, src_h, dst_w, dst_h, fps) }
    }

    unsafe fn new_inner(
        d3d11_frames_ref: *mut AVBufferRef,
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
        fps: u32,
    ) -> Result<Self> {
        let graph = unsafe { avfilter_graph_alloc() };
        if graph.is_null() {
            return Err(anyhow!("avfilter_graph_alloc returned NULL"));
        }
        // Defer-Cleanup wenn was schiefgeht.
        let mut guard = GraphGuard { graph };

        // ── Source: buffer filter mit hwframes_ctx ─────────────────────────
        let buf_filter = unsafe { avfilter_get_by_name(c"buffer".as_ptr()) };
        if buf_filter.is_null() {
            return Err(anyhow!("avfilter 'buffer' not registered in linked FFmpeg"));
        }
        let src_name = CString::new("in").unwrap();
        let src_ctx = unsafe { avfilter_graph_alloc_filter(graph, buf_filter, src_name.as_ptr()) };
        if src_ctx.is_null() {
            return Err(anyhow!("avfilter_graph_alloc_filter(buffer) returned NULL"));
        }

        // Parameter inkl. hw_frames_ctx setzen, dann init. params->hw_frames_ctx
        // ist owned-by-caller — wir nehmen eine extra Ref damit libavfilter's
        // internal ref + unser bleiben unabhängig (Doku: „libavfilter will make
        // internal copies or references when necessary").
        let params = unsafe { av_buffersrc_parameters_alloc() };
        if params.is_null() {
            return Err(anyhow!("av_buffersrc_parameters_alloc returned NULL"));
        }
        unsafe {
            (*params).format = AVPixelFormat::AV_PIX_FMT_D3D11 as i32;
            (*params).width = src_w as i32;
            (*params).height = src_h as i32;
            (*params).time_base = AVRational { num: 1, den: fps as i32 };
            (*params).frame_rate = AVRational { num: fps as i32, den: 1 };
            (*params).hw_frames_ctx = av_buffer_ref(d3d11_frames_ref);
            let ret = av_buffersrc_parameters_set(src_ctx, params);
            // unsere temp-ref freigeben (libavfilter hat seine eigene).
            av_buffer_unref(&mut (*params).hw_frames_ctx);
            av_free(params as *mut _);
            if ret < 0 {
                return Err(anyhow!("av_buffersrc_parameters_set failed: {ret}"));
            }
            let ret = avfilter_init_str(src_ctx, ptr::null());
            if ret < 0 {
                return Err(anyhow!("avfilter_init_str(buffer) failed: {ret}"));
            }
        }

        // ── Sink: buffersink ───────────────────────────────────────────────
        let sink_filter = unsafe { avfilter_get_by_name(c"buffersink".as_ptr()) };
        if sink_filter.is_null() {
            return Err(anyhow!("avfilter 'buffersink' not registered"));
        }
        let mut sink_ctx: *mut AVFilterContext = ptr::null_mut();
        let sink_name = CString::new("out").unwrap();
        unsafe {
            let ret = avfilter_graph_create_filter(
                &mut sink_ctx,
                sink_filter,
                sink_name.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                graph,
            );
            if ret < 0 {
                return Err(anyhow!("create buffersink failed: {ret}"));
            }
        }

        // ── Intermediate filters via avfilter_graph_parse_ptr ──────────────
        // hwdownload (D3D11→Sysmem) + hwupload_cuda (Sysmem→CUDA) + scale_cuda.
        // FFmpeg n8.1 hat keinen direct device_derive D3D11VA→CUDA (s. Modul-
        // Doku oben). Sysmem-Bounce ist der pragmatische Pfad — Color-Convert
        // + Resize bleiben auf der GPU.
        // CPU swscale macht BGRA→NV12 ohne Resize (~3× schneller als mit), dann
        // GPU resize NV12→NV12 auf scale_cuda. `format=bgra` direkt nach
        // hwdownload zwingt den sw_format-Output explizit (sonst negoziert
        // FFmpeg den nv12-Wunsch rückwärts auf hwdownload → fail). Constraints
        // siehe Modul-Doku.
        let desc = format!(
            "hwdownload,format=bgra,format=nv12,hwupload_cuda,scale_cuda={dst_w}:{dst_h}"
        );
        let desc_c = CString::new(desc).unwrap();
        // `inputs` = ungebundene Inputs des parse-Result (= das was vorne reinkommt)
        //          → muss an unsere src_ctx-OUTPUT-Pad linked werden.
        // `outputs` = ungebundene Outputs                  (= das was hinten rauskommt)
        //          → muss an sink_ctx-INPUT-Pad linked werden.
        // Konvention der API: aus Sicht des Filterstrings sind das die
        // free hängenden Enden, die wir hier mit unserem src/sink verbinden.
        unsafe {
            let outputs = avfilter_inout_alloc(); // unser src_ctx → graph
            let inputs = avfilter_inout_alloc(); // graph → unser sink_ctx
            if outputs.is_null() || inputs.is_null() {
                if !outputs.is_null() {
                    let mut o = outputs;
                    avfilter_inout_free(&mut o);
                }
                if !inputs.is_null() {
                    let mut i = inputs;
                    avfilter_inout_free(&mut i);
                }
                return Err(anyhow!("avfilter_inout_alloc returned NULL"));
            }
            (*outputs).name = av_strdup(c"in".as_ptr()) as *mut _;
            (*outputs).filter_ctx = src_ctx;
            (*outputs).pad_idx = 0;
            (*outputs).next = ptr::null_mut();
            (*inputs).name = av_strdup(c"out".as_ptr()) as *mut _;
            (*inputs).filter_ctx = sink_ctx;
            (*inputs).pad_idx = 0;
            (*inputs).next = ptr::null_mut();

            let mut inputs_p = inputs;
            let mut outputs_p = outputs;
            let ret = avfilter_graph_parse_ptr(
                graph,
                desc_c.as_ptr(),
                &mut inputs_p,
                &mut outputs_p,
                ptr::null_mut(),
            );
            avfilter_inout_free(&mut inputs_p);
            avfilter_inout_free(&mut outputs_p);
            if ret < 0 {
                return Err(anyhow!("avfilter_graph_parse_ptr failed: {ret}"));
            }

            let ret = avfilter_graph_config(graph, ptr::null_mut());
            if ret < 0 {
                return Err(anyhow!("avfilter_graph_config failed: {ret}"));
            }
        }

        guard.graph = ptr::null_mut(); // ownership transferred
        Ok(Self { graph, src_ctx, sink_ctx })
    }

    /// Output-frames-ctx (CUDA, dst-res, NV12). Encoder hängt das via
    /// `av_buffer_ref` an `AVCodecContext.hw_frames_ctx`.
    pub fn cuda_frames_ref(&self) -> *mut AVBufferRef {
        unsafe { av_buffersink_get_hw_frames_ctx(self.sink_ctx) }
    }

    /// Schickt einen D3D11-Frame in den Filter. Frame-Ownership bleibt beim
    /// Caller — av_buffersrc_add_frame nimmt KEINE ownership (KEEP_REF), macht
    /// intern eine neue Referenz. Caller darf den Frame nach Return freigeben.
    pub fn push(&mut self, frame: *mut AVFrame) -> Result<()> {
        let ret = unsafe { av_buffersrc_add_frame(self.src_ctx, frame) };
        if ret < 0 {
            return Err(anyhow!("av_buffersrc_add_frame failed: {ret}"));
        }
        Ok(())
    }

    /// Pull next ready frame. Returns `Ok(Some(frame))` wenn einer fertig ist,
    /// `Ok(None)` wenn der Filter noch mehr Input braucht (EAGAIN), `Err` sonst.
    /// Caller besitzt den Frame und muss ihn `av_frame_free`en (oder via
    /// `OwnedCudaFrame`-Drop).
    pub fn pull(&mut self) -> Result<Option<OwnedCudaFrame>> {
        let frame = unsafe { av_frame_alloc() };
        if frame.is_null() {
            return Err(anyhow!("av_frame_alloc returned NULL"));
        }
        let ret = unsafe { av_buffersink_get_frame(self.sink_ctx, frame) };
        if ret == AVERROR_EAGAIN || ret == AVERROR_EOF {
            let mut f = frame;
            unsafe { av_frame_free(&mut f) };
            return Ok(None);
        }
        if ret < 0 {
            let mut f = frame;
            unsafe { av_frame_free(&mut f) };
            return Err(anyhow!("av_buffersink_get_frame failed: {ret}"));
        }
        Ok(Some(OwnedCudaFrame { frame }))
    }
}

impl Drop for ScaleFilter {
    fn drop(&mut self) {
        if !self.graph.is_null() {
            unsafe { avfilter_graph_free(&mut self.graph) };
        }
    }
}

/// CUDA-AVFrame aus dem Filter-Output. data[0] ist ein CUdeviceptr (nicht
/// ID3D11Texture2D wie bei `OwnedHwFrame`) — der Encoder liest das via
/// hw_frames_ctx-API ohne dass wir's selbst inspizieren müssen.
pub struct OwnedCudaFrame {
    frame: *mut AVFrame,
}

unsafe impl Send for OwnedCudaFrame {}

impl OwnedCudaFrame {
    pub fn as_mut_ptr(&mut self) -> *mut AVFrame { self.frame }
    pub fn set_pts(&mut self, pts: i64) {
        unsafe { (*self.frame).pts = pts }
    }
}

impl Drop for OwnedCudaFrame {
    fn drop(&mut self) {
        unsafe { av_frame_free(&mut self.frame) };
    }
}

/// RAII-Guard für AVFilterGraph beim Fail im Konstruktor.
struct GraphGuard {
    graph: *mut AVFilterGraph,
}
impl Drop for GraphGuard {
    fn drop(&mut self) {
        if !self.graph.is_null() {
            unsafe { avfilter_graph_free(&mut self.graph) };
        }
    }
}

// AVERROR-Konstanten: ffmpeg-sys-next exponiert sie nicht direkt; rekonstruieren.
// AVERROR(e) = -e auf POSIX-Systemen mit FFTAG-Encoded Macro auf anderen.
// Wir brauchen nur EAGAIN (=11) und EOF (FFERRTAG('E','O','F',' ')).
const AVERROR_EAGAIN: i32 = -11;
const AVERROR_EOF: i32 = -(
    (b'E' as i32) | ((b'O' as i32) << 8) | ((b'F' as i32) << 16) | ((b' ' as i32) << 24)
);
