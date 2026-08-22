//! Der Abnehmer der aufgenommenen Daten.
//!
//! ScreenCaptureKit liefert Bilder und Tonpuffer asynchron auf einer
//! Dispatch-Queue an einen `SCStreamOutput`-Delegaten. Der ist ein echter
//! Objective-C-Typ und wird deshalb mit objc2s `define_class!` gebaut — er
//! kann kein gewoehnliches Rust-struct sein.
//!
//! Am 2026-08-21 aus `mod.rs` herausgeloest, weil die Datei mit der Trennung
//! von Bild und Ton auf 707 Zeilen gewachsen war (Projektgrenze 350). Reiner
//! Umzug, kein Umbau.

use std::sync::Mutex;
use std::sync::mpsc::Sender;

use objc2::rc::Retained;
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_core_audio_types::{AudioBuffer, AudioBufferList};
use objc2_core_media::{CMBlockBuffer, CMSampleBuffer};
use objc2_core_video::{CVPixelBufferGetHeight, CVPixelBufferGetWidth};
use objc2_foundation::{NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{SCStream, SCStreamOutput, SCStreamOutputType};

use super::{AudioFrame, CFRelease, Frame, SendPixelBuffer, cmtime_seconds};

// ── Frame-output delegate (SCStreamOutput) ───────────────────────────────────

/// Beide Kanaele sind optional, weil seit dem 2026-08-20 zwei Streams laufen:
/// der Bild-Stream traegt nur Bild, der Ton-Stream nur Ton. Ein Wegwerf-Kanal
/// fuer die jeweils andere Haelfte waere eine Falle — niemand leerte ihn.
pub(super) struct OutputIvars {
    video_tx: Mutex<Option<Sender<Frame>>>,
    audio_tx: Mutex<Option<Sender<AudioFrame>>>,
}

define_class!(
    // SAFETY:
    // - NSObject has no subclassing requirements.
    // - FrameOutput does not implement Drop.
    #[unsafe(super = NSObject)]
    #[ivars = OutputIvars]
    pub(super) struct FrameOutput;

    // SAFETY: NSObjectProtocol has no safety requirements.
    unsafe impl NSObjectProtocol for FrameOutput {}

    // SAFETY: the selector signature matches SCStreamOutput.
    unsafe impl SCStreamOutput for FrameOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            ty: SCStreamOutputType,
        ) {
            match ty {
                SCStreamOutputType::Screen => self.handle_video(sample_buffer),
                SCStreamOutputType::Audio => self.handle_audio(sample_buffer),
                _ => {}
            }
        }
    }
);

impl FrameOutput {
    pub(super) fn new(
        video_tx: Option<Sender<Frame>>,
        audio_tx: Option<Sender<AudioFrame>>,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(OutputIvars {
            video_tx: Mutex::new(video_tx),
            audio_tx: Mutex::new(audio_tx),
        });
        // SAFETY: NSObject's init is correct.
        unsafe { msg_send![super(this), init] }
    }

    fn handle_video(&self, sample_buffer: &CMSampleBuffer) {
        // SAFETY: a screen sample buffer is backed by a CVPixelBuffer. We retain
        // it and hand it on **without locking or copying** — the IOSurface stays
        // on the GPU and the encoder wraps it as a VideoToolbox hw-frame.
        let Some(image_buffer) = (unsafe { sample_buffer.image_buffer() }) else {
            return;
        };
        let width = CVPixelBufferGetWidth(&image_buffer);
        let height = CVPixelBufferGetHeight(&image_buffer);
        let pts = cmtime_seconds(unsafe { sample_buffer.presentation_time_stamp() });
        let frame = Frame {
            width,
            height,
            pts_seconds: pts,
            pixel_buffer: SendPixelBuffer(image_buffer),
        };
        if let Ok(tx) = self.ivars().video_tx.lock() {
            if let Some(tx) = tx.as_ref() {
                let _ = tx.send(frame);
            }
        }
    }

    fn handle_audio(&self, sample_buffer: &CMSampleBuffer) {
        // Fast bail if no audio sink registered.
        let guard = match self.ivars().audio_tx.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(atx) = guard.as_ref() else { return };

        // AudioBufferList sized for up to 2 buffers (stereo, interleaved or
        // planar). Layout-compatible prefix with the flexible-array
        // `AudioBufferList` (mNumberBuffers + mBuffers[…]).
        #[repr(C)]
        struct Abl2 {
            n: u32,
            buffers: [AudioBuffer; 2],
        }
        // SAFETY: zeroed is a valid initial AudioBufferList.
        let mut abl: Abl2 = unsafe { std::mem::zeroed() };
        let mut block_buffer: *mut CMBlockBuffer = std::ptr::null_mut();
        // SAFETY: pointers are valid; `buffer_list_size` matches `Abl2`.
        let status = unsafe {
            sample_buffer.audio_buffer_list_with_retained_block_buffer(
                std::ptr::null_mut(),
                &mut abl as *mut Abl2 as *mut AudioBufferList,
                std::mem::size_of::<Abl2>(),
                None,
                None,
                0,
                &mut block_buffer as *mut *mut CMBlockBuffer,
            )
        };

        if status == 0 {
            let interleaved = interleave_audio(&abl.buffers, abl.n as usize);
            if !interleaved.is_empty() {
                let pts = cmtime_seconds(unsafe { sample_buffer.presentation_time_stamp() });
                let _ = atx.send(AudioFrame {
                    samples: interleaved,
                    sample_rate: 48_000,
                    channels: 2,
                    pts_seconds: pts,
                });
            }
        }
        // Release the retained block buffer (+1 from the call above).
        if !block_buffer.is_null() {
            unsafe { CFRelease(block_buffer as *const std::ffi::c_void) };
        }
    }
}

/// Build interleaved stereo Float32 from an AudioBufferList. SCK delivers either
/// one interleaved buffer (mNumberChannels=2) or two planar buffers (L, R).
fn interleave_audio(buffers: &[AudioBuffer; 2], n: usize) -> Vec<f32> {
    if n == 1 {
        let b = buffers[0];
        if b.mData.is_null() {
            return Vec::new();
        }
        let count = (b.mDataByteSize as usize) / 4;
        // SAFETY: mData points at mDataByteSize bytes of Float32 PCM.
        unsafe { std::slice::from_raw_parts(b.mData as *const f32, count) }.to_vec()
    } else if n >= 2 {
        let (l, r) = (buffers[0], buffers[1]);
        if l.mData.is_null() || r.mData.is_null() {
            return Vec::new();
        }
        let nl = (l.mDataByteSize as usize) / 4;
        let nr = (r.mDataByteSize as usize) / 4;
        let frames = nl.min(nr);
        // SAFETY: each plane holds its byte count of Float32 PCM.
        let ls = unsafe { std::slice::from_raw_parts(l.mData as *const f32, nl) };
        let rs = unsafe { std::slice::from_raw_parts(r.mData as *const f32, nr) };
        let mut out = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            out.push(ls[i]);
            out.push(rs[i]);
        }
        out
    } else {
        Vec::new()
    }
}
