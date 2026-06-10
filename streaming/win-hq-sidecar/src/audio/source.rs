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
    /// Desktop-Mix UNTER Ausschluss eines Prozess-Trees: WASAPI-Process-Loopback
    /// im EXCLUDE-Modus (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`).
    /// Pulse nutzt das für den „Desktop"-Audio-Modus, damit der EIGENE Ton —
    /// v. a. die Wiedergabe der anderen Voice-Teilnehmer — NICHT zurück in den
    /// Stream läuft (Echo). `pid` ist die Electron-Main-PID (Tree-Root aller
    /// Chromium-Child-Prozesse inkl. Audio-Service), die `sidecar.ts` via
    /// `PULSE_SELF_PID` mitgibt. Linux-Äquivalent: `-a app-inverse:Pulse`
    /// (s. `gsr-sidecar/profiles.py`).
    DesktopExcludingTree { pid: u32 },
}
