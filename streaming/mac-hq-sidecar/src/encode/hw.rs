//! VideoToolbox hardware-frame plumbing for zero-copy encode.
//!
//! Wraps an IOSurface-backed `CVPixelBuffer` (straight from ScreenCaptureKit) in
//! an `AV_PIX_FMT_VIDEOTOOLBOX` `AVFrame` and hands it to the VideoToolbox
//! encoder — no swscale, no GPU→RAM copy, the same on-GPU path NVENC/AMF take on
//! the other platforms. The `CVPixelBuffer` is opaque here (`*mut c_void`); the
//! capture module owns the objc2 retain semantics.
//!
//! Raw `ffmpeg-sys` FFI because ffmpeg-next has no safe hwframe bindings — same
//! reason and idioms as `win-hq-sidecar/src/encode/hwctx.rs`.

use std::ffi::c_void;
use std::os::raw::c_int;
use std::ptr;

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;

unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// Owns the VideoToolbox hw-device + hw-frames `AVBufferRef`s for the stream.
pub struct VtHwContext {
    device: *mut AVBufferRef,
    frames: *mut AVBufferRef,
}
// SAFETY: AVBufferRefs are atomically refcounted; the owner is moved to the
// encode worker thread and used only there.
unsafe impl Send for VtHwContext {}

impl VtHwContext {
    /// `sw_format` is fixed to BGRA — ScreenCaptureKit's pixel format. The
    /// VideoToolbox encoder converts BGRA→the codec's native format in hardware,
    /// so nothing touches the CPU.
    pub fn new(width: u32, height: u32) -> Result<Self> {
        unsafe {
            let mut device: *mut AVBufferRef = ptr::null_mut();
            let rc = av_hwdevice_ctx_create(
                &mut device,
                AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
                ptr::null(),
                ptr::null_mut(),
                0,
            );
            if rc < 0 || device.is_null() {
                return Err(anyhow!("av_hwdevice_ctx_create(videotoolbox): {rc}"));
            }

            let frames = av_hwframe_ctx_alloc(device);
            if frames.is_null() {
                av_buffer_unref(&mut device);
                return Err(anyhow!("av_hwframe_ctx_alloc returned NULL"));
            }
            let hdr = (*frames).data as *mut AVHWFramesContext;
            (*hdr).format = AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX;
            (*hdr).sw_format = AVPixelFormat::AV_PIX_FMT_BGRA;
            (*hdr).width = width as c_int;
            (*hdr).height = height as c_int;

            let rc = av_hwframe_ctx_init(frames);
            if rc < 0 {
                let mut f = frames;
                av_buffer_unref(&mut f);
                av_buffer_unref(&mut device);
                return Err(anyhow!("av_hwframe_ctx_init: {rc}"));
            }
            Ok(Self { device, frames })
        }
    }

    pub fn frames_ref(&self) -> *mut AVBufferRef {
        self.frames
    }
}

impl Drop for VtHwContext {
    fn drop(&mut self) {
        unsafe {
            if !self.frames.is_null() {
                av_buffer_unref(&mut self.frames);
            }
            if !self.device.is_null() {
                av_buffer_unref(&mut self.device);
            }
        }
    }
}

/// Free callback for the `AVBufferRef` that owns one `CVPixelBuffer` retain.
unsafe extern "C" fn release_cvpb(_opaque: *mut c_void, data: *mut u8) {
    if !data.is_null() {
        unsafe { CFRelease(data as *const c_void) };
    }
}

/// Wrap a `CVPixelBuffer` (`pb`, which carries ONE retain this frame takes over)
/// in a VIDEOTOOLBOX `AVFrame` referencing `hw`'s frames context.
///
/// The returned `*mut AVFrame` must be `avcodec_send_frame`'d then freed with
/// `av_frame_free`; the retain is released when the frame's `buf[0]` refcount
/// (held by both us and the encoder) drops to zero. On any error path the
/// retain is released here, so `pb` is never leaked.
///
/// # Safety
/// `pb` must be a valid `CVPixelBufferRef` carrying exactly one retain to hand
/// over, and `hw` must outlive the returned frame's submission.
pub unsafe fn wrap(
    hw: &VtHwContext,
    pb: *mut c_void,
    width: u32,
    height: u32,
    pts: i64,
) -> Result<*mut AVFrame> {
    unsafe {
        let frame = av_frame_alloc();
        if frame.is_null() {
            CFRelease(pb as *const c_void);
            return Err(anyhow!("av_frame_alloc returned NULL"));
        }
        (*frame).format = AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as c_int;
        (*frame).width = width as c_int;
        (*frame).height = height as c_int;
        (*frame).pts = pts;
        (*frame).data[3] = pb as *mut u8;

        let buf = av_buffer_create(pb as *mut u8, 0, Some(release_cvpb), ptr::null_mut(), 0);
        if buf.is_null() {
            let mut f = frame;
            av_frame_free(&mut f); // buf[0] not set yet → does not touch pb
            CFRelease(pb as *const c_void);
            return Err(anyhow!("av_buffer_create returned NULL"));
        }
        (*frame).buf[0] = buf;
        (*frame).hw_frames_ctx = av_buffer_ref(hw.frames_ref());
        Ok(frame)
    }
}
