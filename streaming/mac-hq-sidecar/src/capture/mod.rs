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

mod abfrage;
pub mod cursorsteuerung;
mod filter;
mod output;

use abfrage::{find_window, pick_display, resolve_applications, shareable_content};
use output::FrameOutput;
pub use abfrage::{list_audio_applications, list_capture_windows, list_displays};

use std::sync::mpsc::{Sender, channel};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Result, anyhow};
use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::AllocAnyThread;
use objc2_core_media::CMTime;

// CoreFoundation is linked transitively by the objc2 framework crates; the
// retained CMBlockBuffer from `audio_buffer_list_with_retained_block_buffer`
// must be released after we copy the samples out.
unsafe extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVImageBuffer;
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{SCStream, SCStreamConfiguration, SCStreamOutputType};

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

// ── Capturer ─────────────────────────────────────────────────────────────────

/// A running ScreenCaptureKit session for one display. Keeps the stream + output
/// delegate alive; frames arrive on the `Sender<Frame>` passed to [`start`].
///
/// **Zwei Streams seit dem 2026-08-20, nicht einer.** SCK schneidet Bild und
/// Ton mit demselben Inhaltsfilter zu; ein einzelner Stream kann daher nicht
/// "ganzer Monitor im Bild, aber nur Safari im Ton". Die Begruendung samt der
/// zwei Fehler, die daraus entstanden waren, steht in [`filter`]. Der Ton-Stream
/// existiert nur, wenn Ton gewuenscht ist.
pub struct Capturer {
    stream: AssumeSend<Retained<SCStream>>,
    _output: AssumeSend<Retained<FrameOutput>>,
    ton_stream: Option<AssumeSend<Retained<SCStream>>>,
    _ton_output: Option<AssumeSend<Retained<FrameOutput>>>,
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

        // Bild und Ton bekommen je einen EIGENEN Filter und einen eigenen
        // Stream. Warum das noetig ist — und welche zwei Fehler die fruehere
        // gemeinsame Loesung hatte — steht ausfuehrlich in `filter.rs`.
        let bild = filter::bild_filter(&content, display_index, window_id)?;

        // Pulse (der Electron-Elternprozess) wird nur beim Ton ausgeschlossen,
        // gegen Echo. Im BILD bleibt es sichtbar.
        let pulse_pid = if want_audio { Some(unsafe { getppid() }) } else { None };
        let ton = if want_audio {
            filter::ton_filter(&content, display_index, &audio_scope, pulse_pid)?
        } else {
            None
        };

        // ── Bild-Stream ──────────────────────────────────────────────────────
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
            // Bewusst KEINE Audio-Einstellungen: dieser Stream traegt nur Bild.
        }

        let output = FrameOutput::new(Some(tx), None);
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &bild, &config, None)
        };
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*output),
                    SCStreamOutputType::Screen,
                    None,
                )
                .map_err(|e| anyhow!("addStreamOutput(video) failed: {}", e.localizedDescription()))?;
        }

        // ── Ton-Stream (nur wenn Ton gewuenscht) ─────────────────────────────
        let ton_teile = match (ton, audio_tx) {
            (Some(ton_filter), Some(audio_tx)) => {
                let ton_config = unsafe { SCStreamConfiguration::new() };
                unsafe {
                    // 2x2 bei einem Bild je Sekunde ist KEIN Versehen: SCK
                    // verlangt eine Bildkonfiguration, auch wenn niemand die
                    // Bilder abholt (unten wird nur der Audio-Output
                    // registriert). Die echte Aufloesung hier einzutragen
                    // hiesse, denselben Bildschirm ein zweites Mal zu
                    // skalieren, ohne dass ein einziges Bild gebraucht wird.
                    ton_config.setWidth(2);
                    ton_config.setHeight(2);
                    ton_config.setMinimumFrameInterval(CMTime {
                        value: 1,
                        timescale: 1,
                        flags: objc2_core_media::CMTimeFlags::Valid,
                        epoch: 0,
                    });
                    ton_config.setQueueDepth(3);
                    ton_config.setCapturesAudio(true);
                    ton_config.setSampleRate(48_000);
                    ton_config.setChannelCount(2);
                    // Schliesst den Sidecar-Prozess selbst aus. Pulse/Electron
                    // ist ein ANDERER Prozess und wird ueber den Filter
                    // ausgeschlossen (s. `pulse_pid` oben).
                    ton_config.setExcludesCurrentProcessAudio(true);
                }

                let ton_output = FrameOutput::new(None, Some(audio_tx));
                let ton_stream = unsafe {
                    SCStream::initWithFilter_configuration_delegate(
                        SCStream::alloc(),
                        &ton_filter,
                        &ton_config,
                        None,
                    )
                };
                unsafe {
                    ton_stream
                        .addStreamOutput_type_sampleHandlerQueue_error(
                            ProtocolObject::from_ref(&*ton_output),
                            SCStreamOutputType::Audio,
                            None,
                        )
                        .map_err(|e| {
                            anyhow!("addStreamOutput(audio) failed: {}", e.localizedDescription())
                        })?;
                }
                Some((ton_stream, ton_output))
            }
            _ => None,
        };

        // ── Beide starten ────────────────────────────────────────────────────
        starte_stream(&stream).map_err(|e| anyhow!("startCapture(Bild) {e}"))?;

        let ton_teile = match ton_teile {
            Some((ton_stream, ton_output)) => {
                if let Err(e) = starte_stream(&ton_stream) {
                    // Der Bild-Stream laeuft bereits. Ihn hier NICHT zu
                    // stoppen hinterliesse eine herrenlose Bildschirmaufnahme
                    // — und macOS liefert danach unter Umstaenden gar keine
                    // Aufnahmequellen mehr (am 2026-08-20 genau so erlebt).
                    stoppe_stream(&stream);
                    return Err(anyhow!("startCapture(Ton) {e}"));
                }
                Some((ton_stream, ton_output))
            }
            None => None,
        };

        let (ton_stream, ton_output) = match ton_teile {
            Some((s, o)) => (Some(AssumeSend(s)), Some(AssumeSend(o))),
            None => (None, None),
        };

        // Der Cursor-Platz der Fernsteuerung — ab hier laeuft die Aufnahme und
        // der Host-Zeiger laesst sich am laufenden Strom umschalten.
        //
        // **Erst HIER, nicht gleich nach dem Bild-Strom**: scheitert der
        // Ton-Strom, bricht `start` oben ab, und eine frueher gesetzte
        // Anmeldung bliebe als Leiche stehen. Angemeldet wird nur der
        // BILD-Strom mit SEINER Einstellungs-Instanz (der Ton-Strom traegt
        // keinen Zeiger).
        cursorsteuerung::anmelden(stream.clone(), config.clone(), show_cursor);

        Ok(Self {
            stream: AssumeSend(stream),
            _output: AssumeSend(output),
            ton_stream,
            _ton_output: ton_output,
        })
    }

    /// Stop the capture session (blocks until stopped, best-effort).
    ///
    /// Stoppt BEIDE Streams. Der Ton-Stream zuerst, damit nicht noch Ton
    /// hereinkommt, waehrend das Bild schon steht — und in jedem Fall auch der
    /// Bild-Stream, selbst wenn der erste haengt: eine zurueckgelassene
    /// Bildschirmaufnahme kann die naechste Sitzung blockieren.
    pub fn stop(&self) {
        // Cursor-Platz mit raeumen — die Einstellung stirbt mit der Aufnahme.
        cursorsteuerung::abmelden();
        if let Some(ton) = &self.ton_stream {
            stoppe_stream(&ton.0);
        }
        stoppe_stream(&self.stream.0);
    }
}

/// Einen SCK-Aufruf mit Abschluss-Block absetzen und warten, bis er sich
/// meldet.
///
/// Drei Stellen brauchen dasselbe: Start, Stopp und das Umschalten des
/// Host-Zeigers ([`cursorsteuerung`]). Der Block laeuft auf einer SCK-eigenen
/// Warteschlange, nicht auf dem hier wartenden Faden — deshalb ist das Warten
/// kein Selbstschloss; [`abfrage::shareable_content`] macht es seit jeher
/// genauso, und `list_monitors` lebt davon.
pub(super) fn mit_abschluss(
    frist: Duration,
    absetzen: impl FnOnce(&DynBlock<dyn Fn(*mut NSError)>),
) -> Result<(), String> {
    let (tx, rx) = channel::<Result<(), String>>();
    let tx = Mutex::new(Some(tx));
    let handler = RcBlock::new(move |error: *mut NSError| {
        let res = unsafe {
            match error.as_ref() {
                Some(err) => Err(err.localizedDescription().to_string()),
                None => Ok(()),
            }
        };
        if let Ok(mut g) = tx.lock() {
            if let Some(t) = g.take() {
                let _ = t.send(res);
            }
        }
    });
    absetzen(&handler);
    match rx.recv_timeout(frist) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(msg)) => Err(format!("failed: {msg}")),
        Err(_) => Err("timed out".to_string()),
    }
}

/// Startet einen Stream und wartet, bis SCK den Erfolg meldet.
///
/// Ohne das Warten liefe der Aufrufer weiter, waehrend die Aufnahme noch gar
/// nicht steht — ein Fehlschlag kaeme dann erst viel spaeter und ohne Bezug
/// zur Ursache an.
fn starte_stream(stream: &SCStream) -> Result<(), String> {
    mit_abschluss(Duration::from_secs(10), |h| unsafe {
        stream.startCaptureWithCompletionHandler(Some(h))
    })
}

/// Stoppt einen Stream, bestmoeglich. Fehler werden geschluckt — beim Abbau
/// gibt es nichts mehr zu retten, und ein `?` hier liesse den zweiten Stream
/// stehen.
fn stoppe_stream(stream: &SCStream) {
    let _ = mit_abschluss(Duration::from_secs(5), |h| unsafe {
        stream.stopCaptureWithCompletionHandler(Some(h))
    });
}
