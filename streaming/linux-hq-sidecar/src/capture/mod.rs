//! Capture-Quellen: `portal` (xdg-desktop-portal ScreenCast) +
//! `pipewire_stream` (DMABUF-Frames) — echtes Screen-Capture mit
//! Zero-Copy-DMABUF-Handoff in den Encoder.

pub mod audio;
pub mod audio_router;
pub mod egl_modifiers;
pub mod portal;
pub mod pipewire_stream;
