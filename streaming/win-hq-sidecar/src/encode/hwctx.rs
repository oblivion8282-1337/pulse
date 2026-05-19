//! D3D11VA hwdevice + hwframes-Pool für Zero-Copy NVENC.
//!
//! ffmpeg-next 8.1 hat keine safe Bindings für `hwcontext_d3d11va.h` — wir gehen
//! direkt über `ffmpeg-sys-next`-FFI. Der `AVD3D11VADeviceContext`-Struct ist
//! verbatim aus FFmpeg 8.1 hier gespiegelt (Layout-Mismatch = sofortiger
//! Crash beim Init, also stabil genug, solange wir an FFmpeg 8.x bleiben).
//!
//! Lebenszyklus:
//! - `HwContext::new(d3d_device, d3d_context, w, h, pool)` baut device_ref +
//!   frames_ref.
//! - `acquire_frame()` zieht einen Pool-Frame; Drop unrefs die AVFrame und gibt
//!   die D3D11-Texture an den Pool zurück.
//! - `frames_ref()` ist die Roh-AVBufferRef, die der Encoder via
//!   `av_buffer_ref()` adoptiert und an `AVCodecContext.hw_frames_ctx` hängt.
//!
//! Thread-Safety: ID3D11DeviceContext ist nicht thread-safe. Wir registrieren
//! eine CRITICAL_SECTION als `lock`/`unlock` an `AVD3D11VADeviceContext`,
//! damit FFmpeg vor jedem internen D3D11-Zugriff lockt. Der Capture-Thread
//! MUSS denselben Lock via `lock()`/`unlock()` halten wenn er
//! CopySubresourceRegion gegen den Pool-Frame fährt.

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;
use std::ffi::c_void;
use std::os::raw::c_int;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext};
use windows::Win32::System::Threading::{
    CRITICAL_SECTION, DeleteCriticalSection, EnterCriticalSection, InitializeCriticalSection,
    LeaveCriticalSection,
};
use windows::core::Interface;

/// `AVD3D11VADeviceContext` aus FFmpeg 8.1 `libavutil/hwcontext_d3d11va.h`.
/// ffmpeg-sys-next bindet die D3D11VA-Header nicht — Hand-Spiegel.
#[repr(C)]
struct AVD3D11VADeviceContext {
    device: *mut c_void,         // ID3D11Device*
    device_context: *mut c_void, // ID3D11DeviceContext*
    video_device: *mut c_void,   // ID3D11VideoDevice* (libavutil füllt)
    video_context: *mut c_void,  // ID3D11VideoContext* (libavutil füllt)
    lock: Option<unsafe extern "C" fn(lock_ctx: *mut c_void)>,
    unlock: Option<unsafe extern "C" fn(lock_ctx: *mut c_void)>,
    lock_ctx: *mut c_void,
}

/// `AVD3D11VAFramesContext` aus FFmpeg 8.1. `texture_infos` füllt libavutil
/// nach `av_hwframe_ctx_init` (Länge = `initial_pool_size`). Wir lesen es
/// nicht — pro AVFrame kommt die Textur via `data[0]` + `data[1]` raus.
/// Layout-Dokumentation; aktuell ungenutzt da wir BindFlags=0 (Default) lassen.
#[repr(C)]
#[allow(dead_code)]
struct AVD3D11VAFramesContext {
    bind_flags: c_int, // D3D11_BIND_* (0 = libavutil-Default DECODER|SHADER_RESOURCE)
    misc_flags: c_int, // D3D11_RESOURCE_MISC_* (0 = libavutil-Default)
    texture_infos: *mut c_void, // AVD3D11FrameDescriptor* — output, ungenutzt
}

unsafe extern "C" fn cs_lock(ctx: *mut c_void) {
    unsafe { EnterCriticalSection(ctx as *mut CRITICAL_SECTION) }
}
unsafe extern "C" fn cs_unlock(ctx: *mut c_void) {
    unsafe { LeaveCriticalSection(ctx as *mut CRITICAL_SECTION) }
}

pub struct HwContext {
    device_ref: *mut AVBufferRef,
    frames_ref: *mut AVBufferRef,
    cs: Box<CRITICAL_SECTION>,
    // ID3D11DeviceContext brauchen wir im Capture-Callback für
    // CopySubresourceRegion in den Pool-Frame. Zugriffe MÜSSEN durch
    // lock()/unlock() geschützt sein.
    device_context: ID3D11DeviceContext,
    width: u32,
    height: u32,
}

// HwContext ist Send/Sync, weil:
// - AVBufferRefs sind reference-counted und thread-safe (FFmpeg garantiert das).
// - ID3D11DeviceContext-Zugriffe sind durch die CRITICAL_SECTION serialisiert
//   (Capture-Thread via lock()/unlock(), FFmpeg-intern via lock_ctx-Callback).
// - CRITICAL_SECTION ist Box-stable; wir nehmen seine Adresse nur über *mut.
unsafe impl Send for HwContext {}
unsafe impl Sync for HwContext {}

impl HwContext {
    /// Baut device_ctx + frames_ctx aus WGCs D3D11-Handles.
    ///
    /// `pool_size`: D3D11VA kann den Pool nicht dynamisch erweitern, also genug
    /// für NVENC-Lookahead + Capture-Backpressure. 8 ist robust für 60 FPS bei
    /// `tune=ull` (kein B-Frame-Lookahead, aber NVENC braucht ~2-3 Frames in-flight).
    pub fn new(
        device: ID3D11Device,
        device_context: ID3D11DeviceContext,
        width: u32,
        height: u32,
        pool_size: u32,
    ) -> Result<Self> {
        let mut cs = Box::new(CRITICAL_SECTION::default());
        unsafe { InitializeCriticalSection(&mut *cs as *mut CRITICAL_SECTION) };

        let device_ref = unsafe { av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA) };
        if device_ref.is_null() {
            unsafe { DeleteCriticalSection(&mut *cs as *mut CRITICAL_SECTION) };
            return Err(anyhow!("av_hwdevice_ctx_alloc(D3D11VA) returned NULL"));
        }

        // `into_raw()` konsumiert den AddRef-Count: wir geben FFmpeg unsere
        // Refs ab. Die WGC-Originale (device/device_context im Caller-Scope)
        // sind separate AddRefs und bleiben gültig.
        let device_raw = device.clone().into_raw();
        let ctx_raw = device_context.clone().into_raw();

        unsafe {
            let dev_ctx = (*device_ref).data as *mut AVHWDeviceContext;
            let d3d_hw = (*dev_ctx).hwctx as *mut AVD3D11VADeviceContext;
            (*d3d_hw).device = device_raw;
            (*d3d_hw).device_context = ctx_raw;
            (*d3d_hw).lock = Some(cs_lock);
            (*d3d_hw).unlock = Some(cs_unlock);
            (*d3d_hw).lock_ctx = &mut *cs as *mut CRITICAL_SECTION as *mut c_void;
        }

        let init = unsafe { av_hwdevice_ctx_init(device_ref) };
        if init < 0 {
            let mut r = device_ref;
            unsafe {
                av_buffer_unref(&mut r);
                DeleteCriticalSection(&mut *cs as *mut CRITICAL_SECTION);
            }
            return Err(anyhow!("av_hwdevice_ctx_init(D3D11VA) failed: {init}"));
        }

        let frames_ref = unsafe { av_hwframe_ctx_alloc(device_ref) };
        if frames_ref.is_null() {
            let mut r = device_ref;
            unsafe {
                av_buffer_unref(&mut r);
                DeleteCriticalSection(&mut *cs as *mut CRITICAL_SECTION);
            }
            return Err(anyhow!("av_hwframe_ctx_alloc returned NULL"));
        }

        unsafe {
            let frames_hdr = (*frames_ref).data as *mut AVHWFramesContext;
            (*frames_hdr).format = AVPixelFormat::AV_PIX_FMT_D3D11;
            (*frames_hdr).sw_format = AVPixelFormat::AV_PIX_FMT_BGRA;
            (*frames_hdr).width = width as c_int;
            (*frames_hdr).height = height as c_int;
            (*frames_hdr).initial_pool_size = pool_size as c_int;
            // bind_flags=0 → libavutil-Default (DECODER|SHADER_RESOURCE). NVENC
            // braucht DECODER; libavutil setzt das selbst. Wir hauen nichts mehr
            // dazu — RENDER_TARGET würde Pool-Allocs für unsere CopyDst-Texturen
            // entlasten, NVENC will aber genau die Default-Flags.
        }

        let init = unsafe { av_hwframe_ctx_init(frames_ref) };
        if init < 0 {
            let mut fr = frames_ref;
            let mut dr = device_ref;
            unsafe {
                av_buffer_unref(&mut fr);
                av_buffer_unref(&mut dr);
                DeleteCriticalSection(&mut *cs as *mut CRITICAL_SECTION);
            }
            return Err(anyhow!("av_hwframe_ctx_init failed: {init}"));
        }

        Ok(Self { device_ref, frames_ref, cs, device_context, width, height })
    }

    pub fn width(&self) -> u32 { self.width }
    pub fn height(&self) -> u32 { self.height }

    /// Roh-Pointer auf die frames AVBufferRef. Encoder muss `av_buffer_ref`
    /// aufrufen um eine eigene Referenz für `AVCodecContext.hw_frames_ctx` zu
    /// bekommen.
    pub fn frames_ref(&self) -> *mut AVBufferRef { self.frames_ref }

    /// ID3D11DeviceContext für CopySubresourceRegion. Caller MUSS lock()/unlock()
    /// drumherum halten.
    pub fn device_context(&self) -> &ID3D11DeviceContext { &self.device_context }

    pub fn lock(&self) {
        unsafe { EnterCriticalSection(&*self.cs as *const CRITICAL_SECTION as *mut _) }
    }
    pub fn unlock(&self) {
        unsafe { LeaveCriticalSection(&*self.cs as *const CRITICAL_SECTION as *mut _) }
    }

    /// Pool-Frame anfordern. AVBufferPool ist intern thread-safe.
    pub fn acquire_frame(&self) -> Result<OwnedHwFrame> {
        let frame = unsafe { av_frame_alloc() };
        if frame.is_null() {
            return Err(anyhow!("av_frame_alloc returned NULL"));
        }
        let ret = unsafe { av_hwframe_get_buffer(self.frames_ref, frame, 0) };
        if ret < 0 {
            let mut f = frame;
            unsafe { av_frame_free(&mut f) };
            return Err(anyhow!("av_hwframe_get_buffer failed: {ret}"));
        }
        Ok(OwnedHwFrame { frame })
    }
}

impl Drop for HwContext {
    fn drop(&mut self) {
        unsafe {
            // frames_ref hält interne Ref auf device_ref → frames zuerst.
            av_buffer_unref(&mut self.frames_ref);
            av_buffer_unref(&mut self.device_ref);
            DeleteCriticalSection(&mut *self.cs as *mut CRITICAL_SECTION);
        }
    }
}

/// Eine Pool-Allokation aus HwContext. Drop unrefs die AVFrame; die D3D11-
/// Texture geht zurück in den Pool. Send, weil der AVFrame-Ptr nur eine
/// Heap-Adresse ist; alles tatsächlich Texture-bezogene ist ref-counted.
pub struct OwnedHwFrame {
    frame: *mut AVFrame,
}

unsafe impl Send for OwnedHwFrame {}

impl OwnedHwFrame {
    /// Roh-Pointer auf die D3D11-Texture im AVFrame (`data[0]`). Für
    /// CopySubresourceRegion als `pDstResource`. Borrowed — kein AddRef.
    pub fn texture_raw(&self) -> *mut c_void {
        unsafe { (*self.frame).data[0] as *mut c_void }
    }

    /// Subresource-Index in der Pool-Array-Texture (`data[1]`, intptr_t).
    pub fn subresource_index(&self) -> u32 {
        unsafe { (*self.frame).data[1] as isize as u32 }
    }

    /// AVFrame-Pointer für `avcodec_send_frame`. Eigentumsverhältnis: bleibt
    /// bei OwnedHwFrame — der Encoder ref'd intern wenn er den Frame
    /// weiterleitet.
    pub fn as_mut_ptr(&mut self) -> *mut AVFrame { self.frame }

    pub fn set_pts(&mut self, pts: i64) {
        unsafe { (*self.frame).pts = pts }
    }
}

impl Drop for OwnedHwFrame {
    fn drop(&mut self) {
        unsafe { av_frame_free(&mut self.frame) }
    }
}
