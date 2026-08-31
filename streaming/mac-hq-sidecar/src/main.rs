//! Pulse — macOS HQ-streaming sidecar (entry point).
//!
//! Wire-format-equivalent to `streaming/gsr-sidecar/control.py` (Linux) and
//! `streaming/win-hq-sidecar/` (Windows): one JSON object per stdin line is a
//! request, one JSON object per stdout line is either a response (mirrors the
//! request `id`) or an async event (`{"ev": "...", ...}`, no `id`). See
//! `streaming/README.md` for the protocol and this crate's README for the plan.
//!
//! Identical protocol = `desktop/electron/sidecar.ts` only needs a platform
//! branch on which binary to spawn (`resolveMacBinaryPath()`) — every op name,
//! request field, response field and event payload matches the other sidecars.
//!
//! Threading: one writer thread serialises all stdout writes (responses + async
//! events from the future stream controller). Pattern from `control.py`.

use std::io::{self, BufRead, Write};
use std::thread;

use pulse_mac_hq_sidecar::{ablage, dispatch, events, remote_input};

fn main() -> anyhow::Result<()> {
    let (out_tx, out_rx) = std::sync::mpsc::channel::<serde_json::Value>();
    events::init(out_tx.clone());

    // Writer thread: serialised stdout output.
    let writer = thread::Builder::new()
        .name("stdout-writer".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut out = stdout.lock();
            while let Ok(value) = out_rx.recv() {
                let json = match serde_json::to_string(&value) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[mac-hq-sidecar] failed to serialize event: {e}");
                        continue;
                    }
                };
                if writeln!(out, "{json}").is_err() {
                    break;
                }
                if out.flush().is_err() {
                    break;
                }
            }
        })?;

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break; // EOF on stdin (Electron closed our stdin) → shut down.
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Unlike the Windows sidecar, macOS never self-exits after `stop`: the
        // process stays warm across streams and `sidecar.ts` keeps the child
        // alive (Windows-only respawn). So there's no `exit_after` flag here —
        // the loop runs until stdin EOF.

        // Auflist-Ops auf einen EIGENEN Faden. `SCShareableContent` hat Fristen
        // bis 8 s (capture/abfrage.rs), und dieselbe Leseschleife traegt die
        // Eingabe einer Fernsteuerung (bis 125 Nachrichten/s): Liefen die
        // Auflistungen inline, stand jede Eingabe bis zu 8 s hinter einem
        // Fenster-Listen-Aufruf — spuerbar als Eingabe-Spitze, wann immer die
        // Oberflaeche parallel aufzaehlt (Audit 2026-08-24). Antworten tragen
        // ihre `id`, die Reihenfolge auf stdout ist dem Elternprozess deshalb
        // gleichgueltig; der Writer-Faden serialisiert ohnehin. Ein beim
        // stdin-EOF noch laufender Aufruf haelt seinen Sender-Klon, der Writer
        // liefert die Antwort noch und endet erst danach.
        let op = serde_json::from_str::<serde_json::Value>(trimmed)
            .ok()
            .and_then(|v| v.get("op").and_then(|o| o.as_str()).map(str::to_owned));
        if op.as_deref().is_some_and(ist_aufzaehlung) {
            let zeile = trimmed.to_string();
            let ausgang = out_tx.clone();
            if thread::Builder::new()
                .name("aufzaehlung".into())
                .spawn(move || {
                    let response = dispatch::handle_request_line(&zeile);
                    if let Ok(v) = serde_json::to_value(&response) {
                        let _ = ausgang.send(v);
                    }
                })
                .is_ok()
            {
                continue; // Antwort kommt vom Faden; weiterlesen ohne Zu warten.
            }
            // Spawn gescheitert (Ressourcen): inline weiter, wie vorher.
        }

        let response = dispatch::handle_request_line(trimmed);
        match serde_json::to_value(&response) {
            Ok(v) => {
                if out_tx.send(v).is_err() {
                    break; // writer thread gone → shut down
                }
            }
            Err(e) => {
                eprintln!("[mac-hq-sidecar] failed to serialize response: {e}");
            }
        }
    }

    // **Vor dem Abbau der Ausgabe**: eine noch laufende Fernsteuerung wird
    // beendet, und zwar endgueltig. Ohne das stirbt der Prozess mit einer
    // physisch gedrueckten Taste, und niemand ist mehr da, der sie loest — das
    // Betriebssystem haelt sie weiter fuer unten. `beenden_endgueltig` statt
    // `beenden`, weil danach nichts mehr angenommen werden darf.
    let freigegeben = remote_input::sitzung().beenden_endgueltig();
    if freigegeben > 0 {
        eprintln!("[remote-input] Prozessende: {freigegeben} Taste(n)/Knopf/Knoepfe freigegeben");
    }

    // Dasselbe fuer die Zwischenablage: Eigentum abgeben und den gemerkten
    // Vorbestand des Nutzers zurueckschreiben. Ohne das stirbt der Prozess als
    // Eigentuemer eines verzoegerten Rendervorgangs, und was der Nutzer vorher
    // kopiert hatte, ist still weg (s. `ablage::beenden_endgueltig`).
    ablage::beenden_endgueltig();

    // EOF on stdin → let the writer thread finish. Drop the emitter-internal
    // sender clone first, otherwise the OnceLock holds it for the whole process
    // lifetime and `writer.join()` hangs forever.
    events::shutdown();
    drop(out_tx);
    let _ = writer.join();

    // TODO(capture): once StreamController lands, stop any running stream here.

    Ok(())
}

/// Die Ops, die `SCShareableContent`-Gesamtanschnappschuesse ziehen und darum
/// Sekunden dauern koennen — alles, was die Eingabe einer Fernsteuerung nicht
/// ausbremsen darf (s. der Block am Anfang der Leseschleife).
fn ist_aufzaehlung(op: &str) -> bool {
    matches!(op, "list_monitors" | "list_windows" | "list_application_audio")
}
