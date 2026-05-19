//! Globaler stdout-Event-Emitter.
//!
//! Damit Worker-Threads (Stream-Controller, FPS-Tracker, etc.) Events emittieren
//! können ohne die `main.rs`-Schreib-Logik zu kennen, hält dieses Modul einen
//! `OnceLock<Mutex<Sender<Value>>>`. `main.rs::init_event_writer()` initialisiert
//! ihn zur Boot-Zeit auf den Writer-Thread; Worker rufen `emit(...)` und der
//! Writer-Thread serialisiert das auf stdout (eine JSON-Zeile pro Event).
//!
//! Pattern 1:1 aus `streaming/gsr-sidecar/control.py::_output_queue` —
//! ein-Writer-Thread löst die race condition zwischen Response- und Event-
//! Schreibern auf stdout.

use serde_json::Value;
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};

static EMITTER: OnceLock<Mutex<Option<Sender<Value>>>> = OnceLock::new();

/// Initialisiert den Emitter mit dem Writer-Thread-Channel. Wird einmal von
/// `main.rs` aufgerufen.
pub fn init(tx: Sender<Value>) {
    let _ = EMITTER.set(Mutex::new(Some(tx)));
}

/// Sendet ein Event an den stdout-Writer-Thread. Nicht-blockierend; bei Disconnect
/// (z.B. weil Writer-Thread gestorben ist) wird das Event verworfen.
pub fn emit(event: Value) {
    if let Some(m) = EMITTER.get() {
        if let Ok(guard) = m.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(event);
            }
        }
    }
}

/// Dropped den EMITTER-internen Sender. Wird von `main.rs` zur Shutdown-Zeit
/// gerufen — sonst hält der static OnceLock einen Sender-Clone die ganze
/// Prozess-Lebenszeit fest, der writer-Thread sieht nie ein Disconnect, und
/// `writer.join()` hängt unendlich.
pub fn shutdown() {
    if let Some(m) = EMITTER.get() {
        if let Ok(mut guard) = m.lock() {
            *guard = None;
        }
    }
}
