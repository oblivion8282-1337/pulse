//! Capture-Start + Warten auf das erste Bild für den D3D11-Zero-Copy-Pfad.
//!
//! Herausgezogen aus `pipeline_hw::run` (s. dortige Modul-Doku): eigener
//! Verantwortungsbereich, der VOR jeder Encode-Weg-/Skalierer-Entscheidung
//! steht — die brauchen alle schon Dimensionen und einen ersten Frame.

use anyhow::{Result, anyhow};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::capture::wgc::CaptureConfig;
use crate::capture::{HwCaptureItem, WgcHwCapture};
use crate::encode::{HwContext, OwnedHwFrame};
use crate::stream_controller::StartParams;

/// Was nach dem ersten Bild feststeht.
///
/// **Ein Struct und keine Tupelreihe**, seit `direkt` dazugekommen ist: acht
/// Rückgabewerte in einer Klammer sind an der Aufrufstelle nur noch über die
/// Reihenfolge zu lesen, und zwei davon sind Maße desselben Typs.
pub(super) struct Aufnahmestart {
    pub capture: WgcHwCapture,
    pub hw: Arc<HwContext>,
    /// Maße der **Aufnahme** — auch dann, wenn schon verkleinert gewandelt wird.
    pub width: u32,
    pub height: u32,
    /// Zielmaße, wenn die Aufnahme das Bild bereits nach P010 gewandelt hat.
    /// Dann steht zwischen ihr und dem Encoder nichts mehr.
    pub direkt: Option<(u32, u32)>,
    pub first: OwnedHwFrame,
    pub first_qpc: i64,
    /// Wall-clock-Zeitpunkt des Video-Origins (≈ `first_qpc`) — Audio-Chunks
    /// ohne QPC ankern hieran, NICHT an einen später genommenen Zeitpunkt (der
    /// Setup-Versatz würde sonst zum konstanten A/V-Offset).
    pub origin_instant: Instant,
}

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
/// **Vier Angaben kommen aus `params`, zwei von aussen**, und das ist Absicht:
/// Aufnahmequelle, Zeiger, Aufnahmeformat und Ziel-Box entscheiden sich hier
/// alle beim Start der WGC-Sitzung und stehen ab dem ersten Bild im Pool fest.
/// `fps` ist die bereits aufgelöste Zielbildrate (der Aufrufer braucht sie
/// ohnehin), `hdr_direkt` eine Entscheidung über den Ablauf
/// (`vorstufe::direktwandlung`) — beides gehört nicht in die Auftragsdaten.
pub(super) fn start_and_wait_for_setup(
    params: &StartParams,
    fps: u32,
    hdr_direkt: bool,
) -> Result<Aufnahmestart> {
    // Capture-D3D11VA-Pool: versorgt Capture-Queue + (im Native-Pfad) die
    // NVENC-In-Flight-Tiefe. Im Downscale-Pfad hat der Scaler einen eigenen
    // Ziel-Pool, dann muss dieser hier nur Capture-Queue + Scaler-Input-Halt
    // bedienen — 24 ist für beide Fälle robust.
    let mut capture = WgcHwCapture::start(
        params.capture.clone(),
        CaptureConfig {
            max_fps: fps,
            include_cursor: params.show_cursor,
            // In 16-Bit-Fließkomma aufnehmen statt in BGRA.
            hdr: params.hdr,
            hdr_direkt,
            ziel_kasten: params.override_resolution,
            // Auf DERSELBEN Karte aufnehmen, die der Verteiler gewählt hat.
            gpu: params.gpu,
            ..Default::default()
        },
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
    match setup {
        HwCaptureItem::Setup { hw, width, height, direkt, first, first_qpc } => Ok(Aufnahmestart {
            capture,
            hw,
            width,
            height,
            direkt,
            first,
            first_qpc,
            origin_instant,
        }),
        HwCaptureItem::Frame { .. } => Err(anyhow!("first item was Frame, expected Setup")),
    }
}
