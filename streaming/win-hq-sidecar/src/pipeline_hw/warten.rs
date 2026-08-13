//! Die Wartephase des Pacing-Loops: bis zum Tick schlafen (Zusehen) oder auf
//! die Ankunft des nächsten Bildes warten (Fernsteuerung), danach die
//! Capture-Queue leeren.
//!
//! Herausgelöst aus `mod.rs`, weil die Datei mit dem Fern-Zweig zum zweiten
//! Mal über die harte 500-Zeilen-Grenze gewachsen war (PLAN.md §12.1) — ihr
//! Modulkopf begründet schon die erste Auslagerung (`capture_start`) genau so.
//! Die Messpunkte (`geplant`/`iter_start`/`capture_drain`) werden HIER gesetzt
//! und unverändert zurückgegeben, damit der `TickMonitor` in `mod.rs` dieselben
//! Größen sieht wie vor dem Umzug.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};

use crate::capture::{HwCaptureItem, WgcHwCapture};
use crate::encode::OwnedHwFrame;

/// Der Capture-Kanal ist mitten im Stream tot — die Fehlermeldung dazu.
///
/// **An einer Stelle**, weil zwei Wege sie brauchen (das Warten auf die
/// Ankunft im Fern-Weg und das Nachziehen der wartenden Bilder) und beide
/// dieselbe Auskunft geben müssen: ohne den echten Worker-Fehler aus
/// `join_error` bliebe nur „channel disconnected", und die eigentliche
/// Ursache (WGC-Close ohne Frame, Pool-Fehler, …) ginge verloren.
fn kanal_tot(capture: &mut WgcHwCapture) -> anyhow::Error {
    let worker_err = capture.join_error();
    anyhow!(
        "hw capture channel disconnected mid-stream{}",
        crate::capture::worker_err_suffix(worker_err, "clean exit, keine Fehlermeldung")
    )
}

/// Ein angekommenes Bild übernehmen: das vorige geht dabei in den Pool zurück,
/// nur der neueste QPC-Zeitstempel bleibt (`0` heißt „nicht verfügbar" und
/// überschreibt den letzten gültigen deshalb nicht).
///
/// An einer Stelle, weil beide Wege sie brauchen — das Wartefenster des
/// Fern-Zweigs und der Drain danach.
fn frame_uebernehmen(
    frame: OwnedHwFrame,
    qpc: i64,
    last_frame: &mut Option<OwnedHwFrame>,
    newest_qpc: &mut i64,
) {
    *last_frame = Some(frame);
    if qpc != 0 {
        *newest_qpc = qpc;
    }
}

/// Ergebnis einer Wartephase — die Zähler und Messpunkte, die der
/// Tick-Monitor in `mod.rs` weiterverbucht.
pub(super) struct Abholung {
    /// Wieviele Bilder diese Iteration gebracht hat (Wartefenster + Drain);
    /// `0` heißt „Quelle unverändert" und steuert die Duplizierung.
    pub captured: u32,
    /// Der geplante Termin — `wake_jitter` wird dagegen gemessen. Im Fern-Weg
    /// ist eine FRÜHE Ankunft der Normalfall; `saturating` beim Aufrufer macht
    /// daraus 0, die Zahl misst dort nur noch verspätete Heartbeats.
    pub geplant: Instant,
    /// Der echte Wieder-Aufwach-Zeitpunkt — ab hier zählt die Arbeitszeit.
    pub iter_start: Instant,
    pub capture_drain: Duration,
}

/// Eine Wartephase fahren. Zwei Wartearten:
///
/// * **ZUSEHEN** (`fern == false`): bis zum nächsten Tick schlafen — das feste
///   Raster glättet, und genau dafür ist es da. `thread::sleep` nutzt auf
///   Win10+/aktuellem Rust einen High-Resolution-Waitable-Timer.
/// * **FERNSTEUERUNG**: auf die ANKUNFT des nächsten Bildes warten, höchstens
///   bis zum Tick (der bleibt als Heartbeat für stehende Bilder — ohne ihn
///   stürbe der Push am MediaMTX-readTimeout). Das Raster kostete sonst im
///   Mittel einen halben Bildabstand (8,3 ms bei 60 fps): ein Bild, das 1 ms
///   nach dem Tick ankommt, wartete fast einen vollen. Beim Steuern zahlt das
///   der geschlossene Kreis aus Eingabe hin und Bild zurück.
///
/// Danach werden alle noch wartenden Capture-Frames abgeholt, nur der neueste
/// bleibt in `last_frame` (ältere gehen in den Pool zurück). Kommt nichts
/// Neues, bleibt `last_frame` erhalten = Duplizierung bei statischem Bild.
pub(super) fn warten_und_abholen(
    capture: &mut WgcHwCapture,
    fern: bool,
    frame_dur: Duration,
    next_tick: &mut Instant,
    last_frame: &mut Option<OwnedHwFrame>,
    newest_qpc: &mut i64,
) -> Result<Abholung> {
    let geplant = *next_tick;
    // Zählt bereits das im Wartefenster angekommene Bild mit (nur Fern-Weg);
    // der Drain unten zählt weiter.
    let mut captured: u32 = 0;
    let now = Instant::now();
    if *next_tick > now {
        if fern {
            match capture.items.recv_timeout(*next_tick - now) {
                Ok(HwCaptureItem::Frame { frame, qpc }) => {
                    frame_uebernehmen(frame, qpc, last_frame, newest_qpc);
                    captured = 1;
                }
                Ok(HwCaptureItem::Setup { .. }) => {
                    return Err(anyhow!("unexpected Setup item after pipeline init"));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(kanal_tot(capture));
                }
            }
        } else {
            std::thread::sleep(*next_tick - now);
        }
    }
    let now = Instant::now();
    if fern {
        // Heartbeat-Frist ab JETZT, kein Raster: das Raster wäre genau die
        // Quantisierung, die dieser Zweig wegnimmt. Encodiert wird trotzdem
        // höchstens im fps-Takt — die PTS-Platz-Bremse in `mod.rs` hält
        // Bilder, deren Platz schon bedient ist, bis zum nächsten Heartbeat.
        *next_tick = now + frame_dur;
    } else {
        *next_tick += frame_dur;
        // Rückstand nicht akkumulieren — sonst Frame-Burst nach einem Stall.
        if *next_tick < now {
            *next_tick = now;
        }
    }

    // Ab hier wird Arbeit gemessen (ohne den Pacing-Sleep) — derselbe
    // Zeitpunkt trägt den Iterationsbeginn und den Anfang des Drains.
    let iter_start = Instant::now();
    loop {
        match capture.items.try_recv() {
            Ok(HwCaptureItem::Frame { frame, qpc }) => {
                frame_uebernehmen(frame, qpc, last_frame, newest_qpc);
                captured += 1;
            }
            Ok(HwCaptureItem::Setup { .. }) => {
                return Err(anyhow!("unexpected Setup item after pipeline init"));
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => break,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return Err(kanal_tot(capture));
            }
        }
    }
    Ok(Abholung { captured, geplant, iter_start, capture_drain: iter_start.elapsed() })
}
