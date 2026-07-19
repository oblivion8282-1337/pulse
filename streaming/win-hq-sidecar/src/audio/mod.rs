//! Audio-Capture-Pipeline (Stage 6).
//!
//! Drei Quellen, vier UI-Modi ("Aus", "Desktop", "Mikrofon", "Desktop + Mikrofon"):
//!
//! | UI-Mode               | Wire-Pfad                                        |
//! |-----------------------|--------------------------------------------------|
//! | `"Aus"`               | kein Audio-Stream — Encoder bekommt nur Video    |
//! | `"Desktop"`           | Default-Render-Endpoint + LOOPBACK-Flag          |
//! | `"Mikrofon"`          | Default-Capture-Endpoint                         |
//! | `"Desktop + Mikrofon"`| beide Quellen parallel, in Stage 7 gemischt      |
//! | `"App: <name>"`       | `IAudioClient::new_application_loopback_client`  |
//!
//! Format: 32-bit float, 48 kHz, stereo, interleaved. FFmpeg-Opus mag's so,
//! kein swresample-Schritt nötig zwischen Capture und Encoder.

pub mod source;
pub mod wasapi;

pub use source::AudioSource;
pub use wasapi::{AudioCapture, AudioFormat, CapturedAudio};
