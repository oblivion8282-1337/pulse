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
use objc2_core_audio_types::{AudioBuffer, AudioBufferList};
use objc2_core_graphics::CGMainDisplayID;
use objc2_core_media::{CMBlockBuffer, CMSampleBuffer, CMTime};

// CoreFoundation is linked transitively by the objc2 framework crates; the
// retained CMBlockBuffer from `audio_buffer_list_with_retained_block_buffer`
// must be released after we copy the samples out.
unsafe extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}
use objc2_core_foundation::CFRetained;
use objc2_core_video::{CVImageBuffer, CVPixelBufferGetHeight, CVPixelBufferGetWidth};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCRunningApplication, SCShareableContent, SCStream,
    SCStreamConfiguration, SCStreamOutput, SCStreamOutputType, SCWindow,
};

// The sidecar's parent process is the Electron ("Pulse") main process (it
// spawns us) — used to exclude Pulse's own audio from a Desktop capture so the
// streamer's voice channel doesn't echo into the stream.
unsafe extern "C" {
    fn getppid() -> i32;
}

/// What to capture for audio (the SCK content filter scopes video AND audio
/// together, so these also shape the video). Built by `ops::start` from the
/// request's `audio` block.
#[derive(Debug, Clone, Default)]
pub enum AudioScope {
    /// No audio capture.
    #[default]
    None,
    /// Desktop audio, excluding Pulse (echo) + these app names.
    Desktop { exclude: Vec<String> },
    /// Only this application's audio (and, on macOS, its windows as the video).
    App(String),
}

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

/// One capturable on-screen window, for the app/window source picker.
#[derive(Debug, Clone)]
pub struct WindowInfo {
    /// CoreGraphics window id — round-trips as the `capture: "window:<id>"` token.
    pub window_id: u32,
    pub title: String,
    pub app: String,
    pub width: i64,
    pub height: i64,
}

/// A retained IOSurface-backed `CVPixelBuffer`, safe to move to the encode
/// thread (IOSurface-backed buffers are shareable across threads).
pub struct SendPixelBuffer(CFRetained<CVImageBuffer>);
// SAFETY: see the module note — SCK CVPixelBuffers are thread-safe.
unsafe impl Send for SendPixelBuffer {}

/// One captured video frame — the GPU pixel buffer itself, **not** copied to
/// RAM. The encoder wraps it as a VideoToolbox hw-frame (zero-copy).
pub struct Frame {
    pub width: usize,
    pub height: usize,
    /// Presentation timestamp in seconds (from the sample buffer's PTS).
    pub pts_seconds: f64,
    pixel_buffer: SendPixelBuffer,
}

impl Frame {
    /// A `*mut CVPixelBuffer` carrying ONE extra retain. Hand it to the encoder;
    /// its hw-frame free-callback releases the retain. Cloning the `Retained`
    /// retains; `forget` transfers that +1 to the raw pointer.
    pub fn retained_ptr(&self) -> *mut std::ffi::c_void {
        // clone() = CFRetain (+1); into_raw transfers that +1 to the raw pointer
        // (no release), which the encoder's hw-frame free-callback later drops.
        CFRetained::into_raw(self.pixel_buffer.0.clone()).as_ptr() as *mut std::ffi::c_void
    }
}

/// One captured audio buffer: interleaved Float32 PCM (L,R,L,R,…).
pub struct AudioFrame {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
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

/// Application names for the audio picker (specific-app capture + the
/// desktop-audio exclude list). SCK has no "is this app producing audio?" query,
/// so we approximate with the running applications that own at least one
/// on-screen window — the user-facing apps, deduped + sorted — which is the set
/// worth offering. (The Windows/Linux lists are "apps with an active audio
/// session"; macOS can't narrow that far without a private CoreAudio tap.)
pub fn list_audio_applications() -> Result<Vec<String>> {
    let content = shareable_content()?;
    let windows = unsafe { content.windows() };

    let mut names = std::collections::BTreeSet::new();
    for w in windows.iter() {
        // Keep only normal, on-screen app windows: `windowLayer == 0` drops the
        // menu bar / Dock / Spotlight / Control Center system layers, and a
        // minimum size drops tiny helper windows. This turns "every running
        // process with a surface" into "the apps the user actually sees".
        if !unsafe { w.isOnScreen() } || unsafe { w.windowLayer() } != 0 {
            continue;
        }
        let frame = unsafe { w.frame() };
        if frame.size.width < 120.0 || frame.size.height < 120.0 {
            continue;
        }
        if let Some(app) = unsafe { w.owningApplication() } {
            let name = unsafe { app.applicationName() }.to_string();
            if !name.is_empty() {
                names.insert(name);
            }
        }
    }
    Ok(names.into_iter().collect())
}

/// Capturable windows for the source picker — same "normal, on-screen, sizeable
/// window" filter as [`list_audio_applications`], but returns each window with
/// its CG id + title so the user can stream a single window instead of a whole
/// display.
pub fn list_capture_windows() -> Result<Vec<WindowInfo>> {
    let content = shareable_content()?;
    let windows = unsafe { content.windows() };

    let mut out = Vec::new();
    for w in windows.iter() {
        if !unsafe { w.isOnScreen() } || unsafe { w.windowLayer() } != 0 {
            continue;
        }
        let frame = unsafe { w.frame() };
        if frame.size.width < 120.0 || frame.size.height < 120.0 {
            continue;
        }
        let app = unsafe { w.owningApplication() }
            .map(|a| unsafe { a.applicationName() }.to_string())
            .unwrap_or_default();
        let title = unsafe { w.title() }
            .map(|t| t.to_string())
            .unwrap_or_default();
        out.push(WindowInfo {
            window_id: unsafe { w.windowID() },
            title,
            app,
            width: frame.size.width as i64,
            height: frame.size.height as i64,
        });
    }
    Ok(out)
}

/// Find a window by its CG id in the current shareable content.
fn find_window(
    content: &SCShareableContent,
    window_id: u32,
) -> Option<Retained<SCWindow>> {
    let windows = unsafe { content.windows() };
    windows
        .iter()
        .find(|w| unsafe { w.windowID() } == window_id)
        .map(|w| w.retain())
}

/// Running applications matching any of `names` (by `applicationName`) or the
/// given `also_pid` (used to find Pulse's own Electron process via getppid).
fn resolve_applications(
    content: &SCShareableContent,
    names: &[String],
    also_pid: Option<i32>,
) -> Vec<Retained<SCRunningApplication>> {
    let apps = unsafe { content.applications() };
    let mut out = Vec::new();
    for a in apps.iter() {
        let name = unsafe { a.applicationName() }.to_string();
        let pid = unsafe { a.processID() };
        if also_pid == Some(pid) || names.iter().any(|n| n == &name) {
            out.push(a.retain());
        }
    }
    out
}

/// Resolve the 1-based display index (clamped to the main display).
fn pick_display(content: &SCShareableContent, display_index: usize) -> Result<Retained<SCDisplay>> {
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
    Ok(displays.objectAtIndex(idx))
}

// ── Frame-output delegate (SCStreamOutput) ───────────────────────────────────

struct OutputIvars {
    video_tx: Mutex<Sender<Frame>>,
    audio_tx: Mutex<Option<Sender<AudioFrame>>>,
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
            match ty {
                SCStreamOutputType::Screen => self.handle_video(sample_buffer),
                SCStreamOutputType::Audio => self.handle_audio(sample_buffer),
                _ => {}
            }
        }
    }
);

impl FrameOutput {
    fn new(video_tx: Sender<Frame>, audio_tx: Option<Sender<AudioFrame>>) -> Retained<Self> {
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
            let _ = tx.send(frame);
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
        window_id: Option<u32>,
        audio_scope: AudioScope,
        width: usize,
        height: usize,
        fps: u32,
        show_cursor: bool,
        tx: Sender<Frame>,
        audio_tx: Option<Sender<AudioFrame>>,
    ) -> Result<Self> {
        let want_audio = audio_tx.is_some();
        let content = shareable_content()?;
        let empty_windows: Retained<NSArray<SCWindow>> = NSArray::new();

        // The SCK content filter scopes video AND audio together, so the audio
        // mode also shapes what's captured visually:
        //   - explicit window  → just that window (initWithDesktopIndependentWindow)
        //   - App(x)           → only app x's windows + audio (includingApplications)
        //   - Desktop{exclude} → whole display minus Pulse (echo) + excluded apps
        //                        from both video and audio (excludingApplications)
        //   - None             → whole display, nothing excluded
        let filter = if let Some(wid) = window_id {
            let window = find_window(&content, wid)
                .ok_or_else(|| anyhow!("Fenster {wid} nicht gefunden (geschlossen?)"))?;
            unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(
                    SCContentFilter::alloc(),
                    &window,
                )
            }
        } else if let AudioScope::App(app_name) = &audio_scope {
            let apps = resolve_applications(&content, std::slice::from_ref(app_name), None);
            if apps.is_empty() {
                return Err(anyhow!("App '{app_name}' nicht gefunden (läuft sie?)"));
            }
            let arr = NSArray::from_retained_slice(&apps);
            let display = pick_display(&content, display_index)?;
            unsafe {
                SCContentFilter::initWithDisplay_includingApplications_exceptingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &arr,
                    &empty_windows,
                )
            }
        } else {
            let display = pick_display(&content, display_index)?;
            let excludes: &[String] = match &audio_scope {
                AudioScope::Desktop { exclude } => exclude,
                _ => &[],
            };
            // Always also exclude Pulse itself (the Electron parent process) so
            // the streamer's voice channel isn't recaptured → no echo.
            let pulse_pid = if want_audio { Some(unsafe { getppid() }) } else { None };
            let apps = resolve_applications(&content, excludes, pulse_pid);
            if apps.is_empty() {
                unsafe {
                    SCContentFilter::initWithDisplay_excludingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &empty_windows,
                    )
                }
            } else {
                let arr = NSArray::from_retained_slice(&apps);
                unsafe {
                    SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &arr,
                        &empty_windows,
                    )
                }
            }
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
            if want_audio {
                config.setCapturesAudio(true);
                config.setSampleRate(48_000);
                config.setChannelCount(2);
                // Don't capture Pulse's own playback (other voice participants)
                // back into the stream → no echo.
                config.setExcludesCurrentProcessAudio(true);
            }
        }

        let output = FrameOutput::new(tx, audio_tx);

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
                .map_err(|e| anyhow!("addStreamOutput(video) failed: {}", e.localizedDescription()))?;
            if want_audio {
                stream
                    .addStreamOutput_type_sampleHandlerQueue_error(
                        output_proto,
                        SCStreamOutputType::Audio,
                        None,
                    )
                    .map_err(|e| {
                        anyhow!("addStreamOutput(audio) failed: {}", e.localizedDescription())
                    })?;
            }
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
