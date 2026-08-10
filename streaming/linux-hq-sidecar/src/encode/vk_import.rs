//! Zero-Copy-Import: DMABUF (PipeWire-Capture) → Vulkan-NV12-Frame (NVIDIA).
//!
//! Analog zu `va_import.rs`, nur über den Vulkan-hwcontext statt VAAPI:
//!
//! DMABUF-fds → `AV_PIX_FMT_DRM_PRIME`-`AVFrame` (aus `AVDRMFrameDescriptor`)
//!   → Filtergraph `buffer(drm_prime) → hwmap=derive_device=vulkan
//!      → scale_vulkan=format=nv12 → buffersink`
//!   → NV12-Vulkan-Surface (der Encoder bindet den Buffersink-Frames-Kontext).
//!
//! `hwmap` importiert das DMABUF ohne Kopie in eine Vulkan-Image (Vulkan kann
//! über `VK_KHR_external_memory_fd` DMABUFs importieren), `scale_vulkan` macht
//! die BGRx→NV12-Farbkonversion auf der GPU. Der Encoder (`h264_vulkan`) will
//! NV12.
//!
//! Warum dieser Pfad existiert: NVENC kann die Intra-Refresh-Richtung nicht
//! waehlen (nur Zeilen), Vulkan liefert COLUMN (Spalten) — `PULSE_VULKAN_ENCODE=1`
//! waehlt diesen Importer + Encoder. Siehe `opts.rs::vulkan_gewuenscht`.

use std::ptr;

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;

use crate::capture::pipewire_stream::DmabufFrame;

/// `AV_BUFFERSRC_FLAG_PUSH` — Frame sofort durch den Graph schieben.
const AV_BUFFERSRC_FLAG_PUSH: i32 = 4;

/// DMABUF→Vulkan-Importer. Hält den DRM-Device-Kontext, die DRM-Frames-Vorlage
/// und den Filtergraph (buffersrc→hwmap→scale_vulkan→buffersink).
pub struct VulkanImporter {
    drm_dev: *mut AVBufferRef,
    drm_frames: *mut AVBufferRef,
    graph: *mut AVFilterGraph,
    src_ctx: *mut AVFilterContext,
    sink_ctx: *mut AVFilterContext,
    /// NV12-Vulkan-Frames-Kontext vom Buffersink — der Encoder bindet DIESEN.
    out_frames: *mut AVBufferRef,
    width: u32,
    height: u32,
    drm_fourcc: u32,
    fps: u32,
    out_w: u32,
    out_h: u32,
}

impl VulkanImporter {
    /// `render_node`: `/dev/dri/renderDXXX`. `drm_fourcc`: DRM-Format der
    /// Capture-Surface (XRGB8888 für BGRx). `width`/`height`: native Maße der
    /// Capture. `out_w`/`out_h`: Encoder-Zielgröße.
    pub fn new(
        render_node: &str,
        drm_fourcc: u32,
        width: u32,
        height: u32,
        fps: u32,
        out_w: u32,
        out_h: u32,
    ) -> Result<Self> {
        unsafe {
            // 1) DRM-Device am Render-Node. Der Filter leitet daraus per
            //    hwmap=derive_device=vulkan den Vulkan-hwcontext ab.
            let node_c = std::ffi::CString::new(render_node).unwrap();
            let mut drm_dev: *mut AVBufferRef = ptr::null_mut();
            let r = av_hwdevice_ctx_create(
                &mut drm_dev,
                AVHWDeviceType::AV_HWDEVICE_TYPE_DRM,
                node_c.as_ptr(),
                ptr::null_mut(),
                0,
            );
            if r < 0 || drm_dev.is_null() {
                return Err(anyhow!("av_hwdevice_ctx_create(DRM, {render_node}) failed (rc={r})"));
            }

            let mut me = Self {
                drm_dev,
                drm_frames: ptr::null_mut(),
                graph: ptr::null_mut(),
                src_ctx: ptr::null_mut(),
                sink_ctx: ptr::null_mut(),
                out_frames: ptr::null_mut(),
                width,
                height,
                drm_fourcc,
                fps,
                out_w,
                out_h,
            };
            if let Err(e) = me.build_graph(fps, out_w, out_h) {
                return Err(e);
            }
            Ok(me)
        }
    }

    unsafe fn build_graph(&mut self, fps: u32, out_w: u32, out_h: u32) -> Result<()> {
        unsafe {
            // 2) DRM-Frames-Kontext (Vorlage für die DRM_PRIME-Eingabe-Frames).
            let drm_frames = av_hwframe_ctx_alloc(self.drm_dev);
            if drm_frames.is_null() {
                return Err(anyhow!("av_hwframe_ctx_alloc(DRM) returned NULL"));
            }
            self.drm_frames = drm_frames;
            {
                let fc = (*drm_frames).data as *mut AVHWFramesContext;
                (*fc).format = AVPixelFormat::AV_PIX_FMT_DRM_PRIME;
                (*fc).sw_format = AVPixelFormat::AV_PIX_FMT_BGR0;
                (*fc).width = self.width as i32;
                (*fc).height = self.height as i32;
            }
            let r = av_hwframe_ctx_init(drm_frames);
            if r < 0 {
                return Err(anyhow!("av_hwframe_ctx_init(DRM) failed (rc={r})"));
            }

            // 3) Filtergraph.
            let graph = avfilter_graph_alloc();
            if graph.is_null() {
                return Err(anyhow!("avfilter_graph_alloc returned NULL"));
            }
            self.graph = graph;

            let buffer = avfilter_get_by_name(c"buffer".as_ptr());
            let buffersink = avfilter_get_by_name(c"buffersink".as_ptr());
            let hwmap = avfilter_get_by_name(c"hwmap".as_ptr());
            let scale_vk = avfilter_get_by_name(c"scale_vulkan".as_ptr());
            if buffer.is_null() || buffersink.is_null() || hwmap.is_null() || scale_vk.is_null() {
                return Err(anyhow!(
                    "Filter fehlt (buffer/buffersink/hwmap/scale_vulkan) — FFmpeg ohne Vulkan-Filter?"
                ));
            }

            // buffersrc: DRM_PRIME-Eingabe.
            let src_ctx = avfilter_graph_alloc_filter(graph, buffer, c"in".as_ptr());
            if src_ctx.is_null() {
                return Err(anyhow!("alloc buffersrc failed"));
            }
            self.src_ctx = src_ctx;
            let par = av_buffersrc_parameters_alloc();
            if par.is_null() {
                return Err(anyhow!("av_buffersrc_parameters_alloc returned NULL"));
            }
            (*par).format = AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;
            (*par).width = self.width as i32;
            (*par).height = self.height as i32;
            (*par).time_base = AVRational { num: 1, den: fps as i32 };
            (*par).hw_frames_ctx = av_buffer_ref(self.drm_frames);
            let r = av_buffersrc_parameters_set(src_ctx, par);
            av_buffer_unref(&mut (*par).hw_frames_ctx);
            av_free(par as *mut std::ffi::c_void);
            if r < 0 {
                return Err(anyhow!("av_buffersrc_parameters_set failed (rc={r})"));
            }
            let r = avfilter_init_str(src_ctx, ptr::null());
            if r < 0 {
                return Err(anyhow!("init buffersrc failed (rc={r})"));
            }

            // hwmap=derive_device=vulkan (DRM_PRIME → Vulkan-Image, zero-copy).
            let hwmap_ctx = avfilter_graph_alloc_filter(graph, hwmap, c"hwmap".as_ptr());
            if hwmap_ctx.is_null() {
                return Err(anyhow!("alloc hwmap failed"));
            }
            let r = avfilter_init_str(hwmap_ctx, c"derive_device=vulkan".as_ptr());
            if r < 0 {
                return Err(anyhow!("init hwmap derive_device=vulkan failed rc={r}"));
            }

            // scale_vulkan=w:h:format=nv12 (CSC BGRx→NV12 + Skalierung).
            let scale_args = std::ffi::CString::new(format!("w={out_w}:h={out_h}:format=nv12")).unwrap();
            let scale_ctx = avfilter_graph_alloc_filter(graph, scale_vk, c"csc".as_ptr());
            if scale_ctx.is_null() {
                return Err(anyhow!("alloc scale_vulkan failed"));
            }
            let r = avfilter_init_str(scale_ctx, scale_args.as_ptr());
            if r < 0 {
                return Err(anyhow!("init scale_vulkan failed (rc={r})"));
            }

            // buffersink.
            let sink_ctx = avfilter_graph_alloc_filter(graph, buffersink, c"out".as_ptr());
            if sink_ctx.is_null() {
                return Err(anyhow!("alloc buffersink failed"));
            }
            self.sink_ctx = sink_ctx;
            let r = avfilter_init_str(sink_ctx, ptr::null());
            if r < 0 {
                return Err(anyhow!("init buffersink failed (rc={r})"));
            }

            // Verketten: in → hwmap → csc → out.
            for (a, b, name) in [
                (src_ctx, hwmap_ctx, "in→hwmap"),
                (hwmap_ctx, scale_ctx, "hwmap→csc"),
                (scale_ctx, sink_ctx, "csc→out"),
            ] {
                let r = avfilter_link(a, 0, b, 0);
                if r < 0 {
                    return Err(anyhow!("avfilter_link {name} failed (rc={r})"));
                }
            }

            let r = avfilter_graph_config(graph, ptr::null_mut());
            if r < 0 {
                return Err(anyhow!("avfilter_graph_config failed (rc={r}) — Vulkan-Kette ungültig?"));
            }

            // NV12-Vulkan-Frames-Kontext vom Buffersink (für den Encoder).
            self.out_frames = av_buffersink_get_hw_frames_ctx(sink_ctx);
            if self.out_frames.is_null() {
                return Err(anyhow!("buffersink hat keinen hw_frames_ctx (scale_vulkan-Ausgang?)"));
            }
            Ok(())
        }
    }

    /// NV12-Vulkan-Frames-Kontext, den der Encoder binden muss.
    pub fn output_frames_ctx(&self) -> *mut AVBufferRef {
        self.out_frames
    }

    /// Graph + DRM-Frames-Ctx für neue Eingabemaße neu bauen (Ausgabe fix).
    unsafe fn rebuild_for(&mut self, w: u32, h: u32, fourcc: u32) -> Result<()> {
        unsafe {
            if !self.graph.is_null() {
                avfilter_graph_free(&mut self.graph);
            }
            self.src_ctx = ptr::null_mut();
            self.sink_ctx = ptr::null_mut();
            self.out_frames = ptr::null_mut();
            if !self.drm_frames.is_null() {
                av_buffer_unref(&mut self.drm_frames);
            }
            self.width = w;
            self.height = h;
            self.drm_fourcc = fourcc;
            self.build_graph(self.fps, self.out_w, self.out_h)
        }
    }

    /// Importiere einen DMABUF-Frame → NV12-Vulkan-`AVFrame`. Caller besitzt
    /// das Ergebnis (`av_frame_free`).
    pub fn import(&mut self, frame: &DmabufFrame) -> Result<*mut AVFrame> {
        if frame.planes.is_empty() || frame.planes.len() > 4 {
            return Err(anyhow!("DmabufFrame mit {} Planes", frame.planes.len()));
        }
        if frame.width != self.width
            || frame.height != self.height
            || frame.drm_fourcc != self.drm_fourcc
            || self.graph.is_null()
        {
            tracing::info!(
                target: "stream",
                from = format!("{}x{} fourcc={:#x}", self.width, self.height, self.drm_fourcc),
                to = format!("{}x{} fourcc={:#x}", frame.width, frame.height, frame.drm_fourcc),
                "Capture-Geometrie/-Format geändert — Vulkan-Graph wird neu gebaut"
            );
            unsafe { self.rebuild_for(frame.width, frame.height, frame.drm_fourcc)? };
        }
        unsafe {
            let mut desc: AVDRMFrameDescriptor = std::mem::zeroed();
            desc.nb_objects = frame.planes.len() as i32;
            for (i, p) in frame.planes.iter().enumerate() {
                desc.objects[i].fd = p.fd;
                desc.objects[i].size =
                    (p.offset as isize + self.height as isize * p.stride as isize).max(0) as usize;
                desc.objects[i].format_modifier = frame.modifier;
            }
            desc.nb_layers = 1;
            desc.layers[0].format = self.drm_fourcc;
            desc.layers[0].nb_planes = frame.planes.len() as i32;
            for (i, p) in frame.planes.iter().enumerate() {
                desc.layers[0].planes[i].object_index = i as i32;
                desc.layers[0].planes[i].offset = p.offset as isize;
                desc.layers[0].planes[i].pitch = p.stride as isize;
            }

            let desc_size = std::mem::size_of::<AVDRMFrameDescriptor>();
            let desc_heap = av_malloc(desc_size) as *mut AVDRMFrameDescriptor;
            if desc_heap.is_null() {
                return Err(anyhow!("av_malloc(AVDRMFrameDescriptor) returned NULL"));
            }
            ptr::write(desc_heap, desc);
            let mut desc_buf =
                av_buffer_create(desc_heap as *mut u8, desc_size, None, ptr::null_mut(), 0);
            if desc_buf.is_null() {
                av_free(desc_heap as *mut std::ffi::c_void);
                return Err(anyhow!("av_buffer_create(desc) returned NULL"));
            }

            let mut src = av_frame_alloc();
            if src.is_null() {
                av_buffer_unref(&mut desc_buf);
                return Err(anyhow!("av_frame_alloc(src) returned NULL"));
            }
            (*src).format = AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;
            (*src).width = self.width as i32;
            (*src).height = self.height as i32;
            (*src).data[0] = desc_heap as *mut u8;
            (*src).buf[0] = desc_buf;
            (*src).hw_frames_ctx = av_buffer_ref(self.drm_frames);

            let r = av_buffersrc_add_frame_flags(self.src_ctx, src, AV_BUFFERSRC_FLAG_PUSH);
            av_frame_free(&mut src);
            if r < 0 {
                return Err(anyhow!("av_buffersrc_add_frame_flags failed (rc={r})"));
            }

            let mut out = av_frame_alloc();
            if out.is_null() {
                return Err(anyhow!("av_frame_alloc(out) returned NULL"));
            }
            let r = av_buffersink_get_frame(self.sink_ctx, out);
            if r < 0 {
                av_frame_free(&mut out);
                return Err(anyhow!("av_buffersink_get_frame failed (rc={r})"));
            }
            Ok(out)
        }
    }
}

impl Drop for VulkanImporter {
    fn drop(&mut self) {
        unsafe {
            if !self.graph.is_null() {
                avfilter_graph_free(&mut self.graph);
            }
            if !self.drm_frames.is_null() {
                av_buffer_unref(&mut self.drm_frames);
            }
            if !self.drm_dev.is_null() {
                av_buffer_unref(&mut self.drm_dev);
            }
        }
    }
}

// SAFETY: wie VaapiImporter — auf dem Encode-Thread erzeugt und benutzt,
// nicht nebenläufig geteilt.
unsafe impl Send for VulkanImporter {}
