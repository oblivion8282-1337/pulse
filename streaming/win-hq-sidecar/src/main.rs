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
    // **Per-Monitor-DPI-Bewusstsein v2 als ALLERERSTES** — vor jeder Fenster-,
    // Bildschirm- oder Zeigerabfrage. Zwei Gründe: (1) die Eingabe-Injektion der
    // Fernsteuerung trifft sonst bei einer Skalierung ≠ 100 % systematisch
    // daneben (ganze Begründung an `injektion::dpi_bewusstsein_setzen`);
    // (2) die Aufnahme-/FSE-Logik in `capture/source.rs` rechnet ohnehin in
    // physischen Bildpunkten, und DPI-bewusst sind ihre Rechtecke durchgängig
    // physisch statt je nach Schirm anders gemeint. Ein Fehlschlag ist nicht
    // tödlich (älteres Windows, oder schon gesetzt): melden und weiterlaufen.
    if let Err(e) = pulse_win_hq_sidecar::remote_input::injektion::dpi_bewusstsein_setzen() {
        eprintln!("[hq-sidecar] Per-Monitor-DPI-Bewusstsein nicht gesetzt: {e}");
    }

    // Systemtimer auf 1 ms (Windows-Vorgabe: 15,6 ms). Der Pacing-Loop braucht
    // das NICHT (`thread::sleep` läuft über den High-Resolution-Waitable-Timer,
    // s. `pipeline_hw`), wohl aber die Tokio-Seite des WHIP-Sendewegs: deren
    // Wartezeiten (Timeouts, `tokio::time::sleep` — der gemessene Grund, warum
    // der erste Pacer-Versuch 7,9-ms-Schlafzeiten als 13,1 ms ausführte)
    // laufen über Timeouts mit Systemtimer-Auflösung. Prozessweit seit
    // Win10 2004, fällt mit dem Prozess.
    //
    // DIESE ZEILE GEHÖRT ZUM TAKTGEBER, auch wenn er seit dem 2026-08-22 in
    // `pulse-whip::pacer` liegt und nicht mehr hier: ohne sie verfehlt er sein
    // Soll um ein Vielfaches. Wie sich das äußert, steht dort im Doc-Kommentar
    // von `tests::verteilung_haelt_ihr_soll` — genau dieser Testlauf hat kein
    // `timeBeginPeriod` und flattert deshalb unter Windows.
    unsafe {
        if windows::Win32::Media::timeBeginPeriod(1) != 0 {
            eprintln!("[hq-sidecar] timeBeginPeriod(1) abgelehnt — Systemtimer bleibt grob");
        }
    }

    // Diagnose-Schalter: `PULSE_HQ_FFMPEG_DEBUG=1` hebt das FFmpeg-Log-Level auf
    // Debug — nötig um hinter „Writing encrypted data to socket failed" den
    // tatsächlichen Socket-Fehler (Connection reset / timed out / broken pipe)
    // zu sehen. Default-Level (Info) verschluckt den. Greift für tcp/tls/rtmp.
    if pulse_win_hq_sidecar::env::flag("PULSE_HQ_FFMPEG_DEBUG") {
        ffmpeg_next::util::log::set_level(ffmpeg_next::util::log::Level::Debug);
        eprintln!("[hq-sidecar] FFmpeg log level = Debug (PULSE_HQ_FFMPEG_DEBUG)");
    }

    // Den eigenen WebRTC-Sendeweg anmelden. Ab hier gehen `http(s)://`-Ziele
    // nicht mehr an ffmpegs WHIP-Muxer (kein Rueckkanal, kein AV1), sondern an
    // `whip::WhipSender`; RTMPS bleibt unveraendert beim Muxer.
    //
    // **Hier und nicht in der Bibliothek**, und das ist keine Formsache: ein
    // Vorgabe-Bauer in `encode::senke` schickte jeden Nutzer der Bibliothek
    // stillschweigend auf diesen Weg — auch das Labor, das seinen eigenen
    // anmeldet. Ein Test dort haelt genau das fest.
    pulse_win_hq_sidecar::encode::senke::registriere_senken_bauer(
        pulse_win_hq_sidecar::whip::senke::baue,
    );

    let (out_tx, out_rx) = std::sync::mpsc::channel::<serde_json::Value>();
    events::init(out_tx.clone());

    // Writer-Thread: serialisierter stdout-Output.
    let writer = thread::Builder::new()
        .name("stdout-writer".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut out = stdout.lock();
            while let Ok(value) = out_rx.recv() {
                // `Null`-Sentinel (s. `events::request_exit`): alles davor ist
                // geschrieben+geflusht (dieser Thread arbeitet den Kanal strikt
                // in Reihenfolge ab) → Prozess jetzt beenden.
                if value.is_null() {
                    let _ = out.flush();
                    // Fehler-Exit-Pfad (`events::request_exit`): eine noch
                    // laufende Fernsteuer-Sitzung ließe sonst jede gedrückte
                    // Taste am Host hängen — „Alles loslassen beim Ende" gilt
                    // auch für dieses Ende.
                    //
                    // **Endgültig**, nicht nur beenden: der `exit(0)` in der
                    // nächsten Zeile beendet den Prozess sofort, während der
                    // Dispatch-Faden in `frames()` auf der Sperre warten kann.
                    // Käme der gleich danach dran, drückte er noch etwas —
                    // und niemand wäre mehr da, der es löst.
                    pulse_win_hq_sidecar::remote_input::sitzung().beenden_endgueltig();
                    // Und die Zwischenablage: dieser Prozess haelt sie
                    // womoeglich mit verzoegertem Rendern. Stirbt er als
                    // Eigentuemer, haelt Windows danach ein leeres Fach — was
                    // der Nutzer vor der Sitzung kopiert hatte, waere still
                    // weg. `beenden_endgueltig` schreibt es zurueck.
                    pulse_win_hq_sidecar::ablage::beenden_endgueltig();
                    std::process::exit(0);
                }
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

    // Eine noch laufende Fernsteuer-Sitzung schließen (gibt Gedrücktes frei),
    // dann einen noch laufenden Stream stoppen. Endgültig: stdin ist zu, es
    // kommt nichts mehr — und was doch noch käme, dürfte nichts mehr drücken.
    pulse_win_hq_sidecar::remote_input::sitzung().beenden_endgueltig();
    // Dasselbe fuer die Zwischenablage: Eigentum abgeben, den gemerkten
    // Vorbestand des Nutzers zurueckschreiben (s. `ablage::beenden_endgueltig`).
    pulse_win_hq_sidecar::ablage::beenden_endgueltig();
    // Und eine evtl. stehende Direkt-Sitzung: deren PeerConnection gehört
    // zum Prozess — ohne das bliebe der ICE-Socket bis zum process::exit
    // offen (Idempotenz: ohne Direktpfad ein No-op, s. `crate::direct`).
    pulse_win_hq_sidecar::direct::sitzung().beende_endgueltig();
    let _ = pulse_win_hq_sidecar::stream_controller::StreamController::singleton().stop();

    Ok(())
}
