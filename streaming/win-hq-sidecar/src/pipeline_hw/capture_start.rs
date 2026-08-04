//! Capture-Start + Warten auf das erste Bild für den D3D11-Zero-Copy-Pfad.
//!
//! Herausgezogen aus `pipeline_hw::run` (s. dortige Modul-Doku): eigener
//! Verantwortungsbereich, der VOR jeder Encode-Weg-/Skalierer-Entscheidung
//! steht — die brauchen alle schon Dimensionen und einen ersten Frame.

use anyhow::{Result, anyhow};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::capture::wgc::CaptureConfig;
use crate::capture::{CaptureSource, HwCaptureItem, WgcHwCapture};
use crate::encode::{HwContext, OwnedHwFrame};

/// Startet den WGC-Hardware-Capture-Worker und wartet auf dessen erstes
/// Setup-Item (D3D11VA-Pool + erster Frame + Dimensionen).
///
/// Bei Disconnect wird der echte Capture-Fehler aus dem Worker-JoinHandle
/// gezogen (`join_error`) — sonst geht die Root-Cause (WGC-Close ohne Frame /
/// HwContext::new-Fehler / …) verloren und nur „channel disconnected" bleibt
/// übrig. Timeout vs. Disconnected getrennt: Ersteres = WGC liefert nie
/// (Target/Permission/HDR), Zweiteres = Capture-Thread ist tatsächlich
/// gecrasht/zu Ende.
///
/// Rückgabe: `(capture, hw, width, height, first_frame, first_qpc, origin_instant)`.
/// `origin_instant` ist der Wall-clock-Zeitpunkt des Video-Origins (≈
/// `first_qpc`) — Audio-Chunks ohne QPC ankern hieran, NICHT an einen später
/// genommenen Zeitpunkt (der Setup-Versatz würde sonst zum konstanten
/// A/V-Offset).
pub(super) fn start_and_wait_for_setup(
    capture_source: CaptureSource,
    fps: u32,
    show_cursor: bool,
) -> Result<(WgcHwCapture, Arc<HwContext>, u32, u32, OwnedHwFrame, i64, Instant)> {
    // Capture-D3D11VA-Pool: versorgt Capture-Queue + (im Native-Pfad) die
    // NVENC-In-Flight-Tiefe. Im Downscale-Pfad hat der Scaler einen eigenen
    // Ziel-Pool, dann muss dieser hier nur Capture-Queue + Scaler-Input-Halt
    // bedienen — 24 ist für beide Fälle robust.
    let mut capture = WgcHwCapture::start(
        capture_source,
        CaptureConfig { max_fps: fps, include_cursor: show_cursor, ..Default::default() },
        24,
    )?;

    // Setup-Item warten (mit erstem Pool-Frame). Bei Disconnect den echten
    // Capture-Fehler aus dem Worker-JoinHandle ziehen (`join_error`) — sonst
    // geht die Root-Cause (WGC-Close ohne Frame / HwContext::new-Fehler / …)
    // verloren und nur „channel disconnected" bleibt übrig. Timeout vs.
    // Disconnected trennen: Ersteres = WGC liefert nie (Target/Permission/HDR),
    // Zweiteres = Capture-Thread ist tatsächlich gecrasht/zu Ende.
    let setup = match capture.items.recv_timeout(Duration::from_secs(5)) {
        Ok(item) => item,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            return Err(anyhow!(
                "hw capture lieferte innerhalb von 5 s keinen ersten Frame \
                 (WGC-Capture startete, aber lieferte nichts — Target/Permission/HDR-Verdacht)"
            ));
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let worker_err = capture.join_error();
            return Err(anyhow!(
                "hw capture exit vor dem ersten Frame{}",
                crate::capture::worker_err_suffix(
                    worker_err,
                    "Thread clean beendet, nie ein Frame geliefert"
                )
            ));
        }
    };
    // Wall-clock-Zeitpunkt des Video-Origins (≈ first_qpc). Audio-Chunks ohne
    // QPC ankern hieran — NICHT an `started` (das liegt erst NACH der Encoder-
    // Erzeugung; der Setup-Versatz würde zum konstanten A/V-Offset).
    let origin_instant = Instant::now();
    let (hw, width, height, first, first_qpc) = match setup {
        HwCaptureItem::Setup { hw, width, height, first, first_qpc } => {
            (hw, width, height, first, first_qpc)
        }
        HwCaptureItem::Frame { .. } => return Err(anyhow!("first item was Frame, expected Setup")),
    };
    Ok((capture, hw, width, height, first, first_qpc, origin_instant))
}
