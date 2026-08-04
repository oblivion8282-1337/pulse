//! Gemeinsame Mechanik für den `fail_msg`-Slot der Writer-Threads
//! (`mux_writer.rs`, `senke_writer.rs`): der Erzeuger sieht einen toten Kanal
//! nur als Disconnect — ohne diesen Slot bekäme er bei jedem mid-stream-Abriss
//! nur "thread/Faden ist weg" statt der tatsächlichen Ursache. Beide Writer
//! hatten dieselben zwei Funktionen (Grund ablegen / Grund lesen mit
//! Fallback) wortgleich als Inline-Code.

use std::sync::Mutex;

/// Grund ablegen, BEVOR der Kanal fällt — die Reihenfolge ist der ganze Zweck
/// (s. Aufrufstellen in `write_loop`/`sende_schleife`).
pub(super) fn hinterlege(slot: &Mutex<Option<String>>, e: impl std::fmt::Display) {
    if let Ok(mut s) = slot.lock() {
        *s = Some(format!("{e:#}"));
    }
}

/// Abgelegten Grund lesen, mit `fallback` falls der Faden ohne Eintrag starb.
pub(super) fn lies(slot: &Mutex<Option<String>>, fallback: &str) -> String {
    slot.lock()
        .ok()
        .and_then(|s| s.clone())
        .unwrap_or_else(|| fallback.to_string())
}
