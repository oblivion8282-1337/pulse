//! ScreenCaptureKit capture.
//!
//! Two entry points:
//!   - [`list_displays`] — synchronous display enumeration (drives `list_monitors`),
//!     via `SCShareableContent`.
//!   - [`Capturer`] — starts an `SCStream` for one display and pushes BGRA
//!     [`Frame`]s onto an `mpsc` channel for the encoder.
//!
//! ScreenCaptureKit delivers frames asynchronously on a dispatch queue, so the
//! frame sink is an `SCStreamOutput` delegate defined here with objc2's
//! `define_class!`. The delegate copies the locked `CVPixelBuffer` (BGRA) into an
//! owned buffer in the callback — simplest and avoids any cross-thread lifetime
//! juggling of the IOSurface-backed pixel buffer.
//!
//! Thread-safety: SCK objects are safe to retain/release/use across threads
//! (Apple's API is thread-safe), but objc2's auto-derived `Send`/`Sync` markers
//! are conservative. [`AssumeSend`] wraps a `Retained<_>` we move between the
//! query thread and the worker thread; this is sound for SCK objects.

use std::sync::mpsc::{Sender, channel};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Result, anyhow};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AllocAnyThread, DefinedClass, Message, define_class, msg_send};
use objc2_core_graphics::CGMainDisplayID;
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::{
    CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
    CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
    SCStreamOutputType, SCWindow,
};

/// A `Retained<T>` we promise is safe to move across threads. Sound for SCK/CM
/// objects, whose retain/release/use are thread-safe.
struct AssumeSend<T>(T);
// SAFETY: see the module-level note — SCK objects are thread-safe.
unsafe impl<T> Send for AssumeSend<T> {}

/// One display, as reported by `list_monitors`.
#[derive(Debug, Clone)]
pub struct DisplayInfo {
    /// 1-based position in the enumeration (the `capture: "display:<index>"`
    /// token the renderer sends back resolves via this).
    pub index: usize,
    pub display_id: u32,
    pub name: String,
    pub primary: bool,
    pub width: i64,
    pub height: i64,
    pub refresh_hz: i64,
}

/// One captured video frame: packed BGRA8888, `bytes_per_row`-strided.
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    pub data: Vec<u8>,
    /// Presentation timestamp in seconds (from the sample buffer's PTS).
    pub pts_seconds: f64,
}

fn cmtime_seconds(t: CMTime) -> f64 {
    if t.timescale != 0 {
        t.value as f64 / t.timescale as f64
    } else {
        0.0
    }
}

/// kCVPixelFormatType_32BGRA — fourcc 'BGRA'.
const PIXEL_FORMAT_BGRA: u32 = u32::from_be_bytes(*b"BGRA");

// ── Content query ────────────────────────────────────────────────────────────

/// Block on `SCShareableContent.getShareableContentWithCompletionHandler:` and
/// hand back the retained content. Requires Screen-Recording permission — without
/// it the completion handler returns an error (or times out).
fn shareable_content() -> Result<Retained<SCShareableContent>> {
    let (tx, rx) = channel::<Result<AssumeSend<Retained<SCShareableContent>>, String>>();
    let tx = Mutex::new(Some(tx));

    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let result = unsafe {
            if let Some(content) = content.as_ref() {
                Ok(AssumeSend(content.retain()))
            } else if let Some(err) = error.as_ref() {
                Err(err.localizedDescription().to_string())
            } else {
                Err("getShareableContent returned no content and no error".to_string())
            }
        };
        if let Ok(mut guard) = tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(result);
            }
        }
    });

    // SAFETY: completion-handler block matches the documented signature.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };

    match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(content)) => Ok(content.0),
        Ok(Err(msg)) => Err(anyhow!("SCShareableContent error: {msg}")),
        Err(_) => Err(anyhow!(
            "SCShareableContent timed out (Screen-Recording-Permission fehlt?)"
        )),
    }
}

/// Enumerate displays for `list_monitors`.
pub fn list_displays() -> Result<Vec<DisplayInfo>> {
    let content = shareable_content()?;
    let main_id = CGMainDisplayID();
    let displays = unsafe { content.displays() };

    let mut out = Vec::new();
    for (i, display) in displays.iter().enumerate() {
        let display_id = unsafe { display.displayID() };
        let width = unsafe { display.width() } as i64;
        let height = unsafe { display.height() } as i64;
        out.push(DisplayInfo {
            index: i + 1,
            display_id,
            name: format!("Display {display_id}"),
            primary: display_id == main_id,
            width,
            height,
            // TODO(stage: polish): CGDisplayCopyDisplayMode → refresh rate.
            refresh_hz: 0,
        });
    }
    Ok(out)
}

// ── Frame-output delegate (SCStreamOutput) ───────────────────────────────────

struct OutputIvars {
    tx: Mutex<Sender<Frame>>,
}

define_class!(
    // SAFETY:
    // - NSObject has no subclassing requirements.
    // - FrameOutput does not implement Drop.
    #[unsafe(super = NSObject)]
    #[ivars = OutputIvars]
    struct FrameOutput;

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
            if ty != SCStreamOutputType::Screen {
                return; // audio handled separately (later stage)
            }
            // SAFETY: a screen sample buffer is backed by a CVPixelBuffer.
            let Some(image_buffer) = (unsafe { sample_buffer.image_buffer() }) else {
                return;
            };
            let pb = &*image_buffer;
            let flags = CVPixelBufferLockFlags::empty();
            unsafe { CVPixelBufferLockBaseAddress(pb, flags) };

            let base = CVPixelBufferGetBaseAddress(pb);
            if !base.is_null() {
                let width = CVPixelBufferGetWidth(pb);
                let height = CVPixelBufferGetHeight(pb);
                let bytes_per_row = CVPixelBufferGetBytesPerRow(pb);
                let len = bytes_per_row.saturating_mul(height);
                // SAFETY: base points at `len` bytes while the buffer is locked.
                let data = unsafe { std::slice::from_raw_parts(base as *const u8, len) }.to_vec();
                let pts = cmtime_seconds(unsafe { sample_buffer.presentation_time_stamp() });
                let frame = Frame { width, height, bytes_per_row, data, pts_seconds: pts };
                if let Ok(tx) = self.ivars().tx.lock() {
                    let _ = tx.send(frame);
                }
            }
            unsafe { CVPixelBufferUnlockBaseAddress(pb, flags) };
        }
    }
);

impl FrameOutput {
    fn new(tx: Sender<Frame>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(OutputIvars { tx: Mutex::new(tx) });
        // SAFETY: NSObject's init is correct.
        unsafe { msg_send![super(this), init] }
    }
}

// ── Capturer ─────────────────────────────────────────────────────────────────

/// A running ScreenCaptureKit session for one display. Keeps the stream + output
/// delegate alive; frames arrive on the `Sender<Frame>` passed to [`start`].
pub struct Capturer {
    stream: AssumeSend<Retained<SCStream>>,
    _output: AssumeSend<Retained<FrameOutput>>,
}

// SAFETY: SCStream operations are thread-safe; see the module note.
unsafe impl Send for Capturer {}

impl Capturer {
    /// Start capturing `display_index` (1-based; falls back to the main display
    /// if out of range). `width`/`height` are the output pixel dimensions.
    pub fn start(
        display_index: usize,
        width: usize,
        height: usize,
        fps: u32,
        show_cursor: bool,
        tx: Sender<Frame>,
    ) -> Result<Self> {
        let content = shareable_content()?;
        let displays = unsafe { content.displays() };
        let count = displays.len();
        if count == 0 {
            return Err(anyhow!("keine Displays gefunden"));
        }
        let idx = if display_index >= 1 && display_index <= count {
            display_index - 1
        } else {
            0
        };
        let display = displays
            .objectAtIndex(idx);

        // Content filter: whole display, excluding nothing.
        let empty: Retained<NSArray<SCWindow>> = NSArray::new();
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &empty,
            )
        };

        // Stream configuration.
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(width);
            config.setHeight(height);
            config.setMinimumFrameInterval(CMTime {
                value: 1,
                timescale: fps as i32,
                flags: objc2_core_media::CMTimeFlags::Valid,
                epoch: 0,
            });
            config.setPixelFormat(PIXEL_FORMAT_BGRA);
            config.setShowsCursor(show_cursor);
            config.setQueueDepth(6);
        }

        let output = FrameOutput::new(tx);

        // SCStreamDelegate omitted (None) for now — didStopWithError lands with
        // the StreamController wiring.
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None)
        };

        let output_proto = ProtocolObject::from_ref(&*output);
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    output_proto,
                    SCStreamOutputType::Screen,
                    None,
                )
                .map_err(|e| anyhow!("addStreamOutput failed: {}", e.localizedDescription()))?;
        }

        // Start capture and block until the start completes (or errors).
        let (start_tx, start_rx) = channel::<Result<(), String>>();
        let start_tx = Mutex::new(Some(start_tx));
        let start_handler = RcBlock::new(move |error: *mut NSError| {
            let res = unsafe {
                match error.as_ref() {
                    Some(err) => Err(err.localizedDescription().to_string()),
                    None => Ok(()),
                }
            };
            if let Ok(mut g) = start_tx.lock() {
                if let Some(t) = g.take() {
                    let _ = t.send(res);
                }
            }
        });
        unsafe { stream.startCaptureWithCompletionHandler(Some(&start_handler)) };
        match start_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {}
            Ok(Err(msg)) => return Err(anyhow!("startCapture failed: {msg}")),
            Err(_) => return Err(anyhow!("startCapture timed out")),
        }

        Ok(Self {
            stream: AssumeSend(stream),
            _output: AssumeSend(output),
        })
    }

    /// Stop the capture session (blocks until stopped, best-effort).
    pub fn stop(&self) {
        let (tx, rx) = channel::<()>();
        let tx = Mutex::new(Some(tx));
        let handler = RcBlock::new(move |_error: *mut NSError| {
            if let Ok(mut g) = tx.lock() {
                if let Some(t) = g.take() {
                    let _ = t.send(());
                }
            }
        });
        unsafe { self.stream.0.stopCaptureWithCompletionHandler(Some(&handler)) };
        let _ = rx.recv_timeout(Duration::from_secs(5));
    }
}
