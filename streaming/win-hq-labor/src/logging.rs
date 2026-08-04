//! Diagnose-Logging (stderr).
//!
//! **stdout ist heilig** — dort läuft nur das JSON-RPC-Protokoll. Alles andere
//! geht auf stderr, wo Pulse es zeitgestempelt und token-bereinigt mitschreibt
//! (`desktop/electron/sidecar-log.ts`).
//!
//! Gleiche Bauart wie `linux-hq-sidecar/src/logging.rs`, damit dieselbe
//! Umgebungsvariable auf beiden Seiten dasselbe tut.
//!
//! **Warum es das überhaupt gibt.** Bis 2026-08-02 hatte das Labor keinen
//! Empfänger — und `tracing`-Aufrufe ohne Empfänger verschwinden spurlos, ohne
//! Warnung beim Bauen. Der WHIP-Weg meldete deshalb nichts, auch nicht seine
//! Fehler; beim ersten Handschlag gegen einen echten Server war nur zu sehen,
//! dass nichts ankam. Ein Messstand, der stumm ist, ist genau dann blind, wenn
//! man ihn braucht.
//!
//! Steuerung über `PULSE_HQ_LOG` (wie `RUST_LOG`), Vorgabe `info`. Für den
//! WHIP-Weg lohnt `PULSE_HQ_LOG=debug`.

use std::io::IsTerminal;

use tracing_subscriber::EnvFilter;

/// Richtet den globalen Empfänger ein. Ganz früh in `main()`, vor dem ersten
/// Log. Mehrfachaufruf ist harmlos (der zweite verpufft).
pub fn init() {
    let filter = EnvFilter::try_from_env("PULSE_HQ_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    // Farben nur am echten Terminal. Unter Pulse ist stderr eine Pipe — dort
    // wären Escape-Sequenzen nur Müll in der Logdatei.
    let ansi = std::io::stderr().is_terminal();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(ansi)
        .with_target(true)
        // Ohne Zeitstempel: Pulse stempelt beim Mitschreiben, und im Terminal
        // genügt die Reihenfolge.
        .without_time()
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}
