//! Pulse — Windows HQ-streaming sidecar (entry point).
//!
//! Wire-format-equivalent to `streaming/gsr-sidecar/control.py` (the Linux
//! GSR sidecar): one JSON object per stdin line is a request, one JSON object
//! per stdout line is either a response (mirrors the request `id`) or an async
//! event (`{"ev": "...", ...}`, no `id`). See `streaming/README.md` for the
//! protocol and `WINDOWS_HQ_SIDECAR.md` for the porting plan.
//!
//! Identical protocol = `desktop/electron/sidecar.ts` only needs a platform
//! branch on which binary to spawn — every op name, request field, response
//! field, and event payload matches the Linux sidecar.
//!
//! Threading: ein Writer-Thread serialisiert alle stdout-Schreibvorgänge
//! (Responses + async-Events vom Stream-Controller). Pattern aus `control.py`.

use std::io::{self, BufRead, Write};
use std::thread;

use pulse_win_hq_sidecar::{dispatch, events};

fn main() -> anyhow::Result<()> {
    // Diagnose-Schalter: `PULSE_HQ_FFMPEG_DEBUG=1` hebt das FFmpeg-Log-Level auf
    // Debug — nötig um hinter „Writing encrypted data to socket failed" den
    // tatsächlichen Socket-Fehler (Connection reset / timed out / broken pipe)
    // zu sehen. Default-Level (Info) verschluckt den. Greift für tcp/tls/rtmp.
    if std::env::var("PULSE_HQ_FFMPEG_DEBUG").is_ok() {
        ffmpeg_next::util::log::set_level(ffmpeg_next::util::log::Level::Debug);
        eprintln!("[hq-sidecar] FFmpeg log level = Debug (PULSE_HQ_FFMPEG_DEBUG)");
    }

    let (out_tx, out_rx) = std::sync::mpsc::channel::<serde_json::Value>();
    events::init(out_tx.clone());

    // Writer-Thread: serialisierter stdout-Output.
    let writer = thread::Builder::new()
        .name("stdout-writer".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut out = stdout.lock();
            while let Ok(value) = out_rx.recv() {
                let json = match serde_json::to_string(&value) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[hq-sidecar] failed to serialize event: {e}");
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
        // `match` statt `?`: ein I/O-Fehler auf stdin (z. B. Non-UTF8-Bytes →
        // `InvalidData`) würde sonst direkt aus `main` propagieren und den
        // Shutdown-Block unten (events::shutdown, writer.join, StreamController::
        // stop → schreibt den FLV-Trailer) überspringen — ein laufender Stream
        // bliebe ohne sauberen Teardown zurück. Stattdessen loggen + die Schleife
        // verlassen, damit der Cleanup-Block garantiert läuft.
        let n = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[hq-sidecar] stdin read error: {e}");
                break;
            }
        };
        if n == 0 {
            break;
        }
        // `trim()` entfernt Whitespace, aber nicht U+FEFF (UTF-8 BOM). PowerShell's
        // Default-Encoder schreibt einen BOM auf den ersten stdin-Write — den
        // schlucken wir hier sauber statt einen „invalid JSON"-Fehler zu werfen.
        let trimmed = line.trim().trim_start_matches('\u{feff}').trim();
        if trimmed.is_empty() {
            continue;
        }

        let (response, exit_after) = dispatch::handle_request_line(trimmed);
        // serde-Wert für den Writer. Wenn der Serialize-Schritt failt, ist's
        // ein Bug in der Response-Struktur — wir loggen auf stderr und gehen
        // weiter.
        match serde_json::to_value(&response) {
            Ok(v) => {
                if out_tx.send(v).is_err() {
                    break; // Writer-Thread weg → Shutdown
                }
            }
            Err(e) => {
                eprintln!("[hq-sidecar] failed to serialize response: {e}");
            }
        }
        // Nach erfolgreichem `stop`: Prozess beenden (s. `dispatch`-Doku —
        // dangling Threadpool-Timer aus dem Teardown). Wir brechen die Schleife
        // ab; der Shutdown-Block unten flusht Writer (also auch diese `stop`-
        // Response + das `stopped`-Event) und der Prozess endet danach prompt.
        if exit_after {
            break;
        }
    }

    // EOF auf stdin → Writer-Thread auch beenden lassen. Wichtig: erst die
    // EMITTER-interne Sender-Clone droppen (sonst hält der OnceLock sie für die
    // ganze Prozess-Lebenszeit fest → `writer.join()` hängt unendlich).
    events::shutdown();
    drop(out_tx);
    let _ = writer.join();

    // Falls noch ein Stream läuft, stoppen.
    let _ = pulse_win_hq_sidecar::stream_controller::StreamController::singleton().stop();

    Ok(())
}
