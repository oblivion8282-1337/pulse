//! `AudioSource` — was capturen wir.
//!
//! Übersetzung aus dem UI-Label-Set in `profiles.rs::AUDIO_MODES` macht der
//! JSON-Layer (Stage 8, `start`-Op); diese Enum ist die maschinen-lesbare Form.

/// Wo kommen die Samples her.
#[derive(Debug, Clone)]
pub enum AudioSource {
    /// Default-Render-Endpoint (WASAPI-Loopback).
    DefaultDesktop,
    /// Default-Capture-Endpoint (Mikrofon).
    DefaultMicrophone,
    /// Beide parallel — Stage 7 mischt sie in einen Stream.
    DesktopPlusMicrophone,
    /// Per-App-Loopback per PID. `include_tree=true` deckt Child-Prozesse mit
    /// ab — wichtig für Chromium/Electron-Apps die Audio im Render-Process
    /// erzeugen. Per WASAPI-Doku muss die PID die *Parent*-PID sein.
    Application { pid: u32, include_tree: bool },
}
