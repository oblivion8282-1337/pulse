//! Pulse — Windows-HQ-Labor (Einstiegspunkt).
//!
//! **Protokoll-gleich mit dem ausgelieferten Sidecar.** Dieselben Ops, dieselben
//! Felder, dieselben Events — `desktop/electron/sidecar.ts` und der Prüfstand
//! sprechen mit beiden Binaries identisch. Der Unterschied liegt allein im
//! Sendeweg: eine `http(s)://`-Push-URL geht hier über den EIGENEN
//! WebRTC-Sender (`whip/`) statt über den FFmpeg-WHIP-Muxer.
//!
//! Warum das nicht im Sidecar steht, steht in `../README.md`. Kurz: der eigene
//! Sendeweg greift mitten in den Bildweg, und ein Fehler darin zeigt sich nicht
//! als Absturz, sondern als etwas mehr Ruckeln bei Leuten, die nichts damit zu
//! tun haben.
//!
//! Die Wire-Schleife ist wörtlich die des Sidecars (Writer-Thread serialisiert
//! stdout, `Null`-Sentinel beendet). Sie ist bewusst nicht abstrahiert: zwei
//! Fassungen derselben Schleife, die auseinanderlaufen, wären teurer als die
//! Doppelung — und die Bibliothek darf vom Labor nichts wissen.

use std::io::{self, BufRead, Write};
use std::thread;

use pulse_win_hq_sidecar::{dispatch, env, events};

fn main() -> anyhow::Result<()> {
    // Als Allererstes: sonst laufen alle folgenden `tracing`-Zeilen ins Leere.
    pulse_win_hq_labor::logging::init();

    // Über `env::flag` statt `env::var(..).is_ok()`: sonst wäre `=0` im Labor
    // an und im Sidecar aus, und derselbe Aufruf verhielte sich in zwei
    // Binaries verschieden.
    if env::flag("PULSE_HQ_FFMPEG_DEBUG") {
        ffmpeg_next::util::log::set_level(ffmpeg_next::util::log::Level::Debug);
        eprintln!("[hq-labor] FFmpeg log level = Debug (PULSE_HQ_FFMPEG_DEBUG)");
    }

    // Beim Start SAGEN, was hier läuft. Labor und Sidecar sind protokollgleich
    // und damit von außen nicht zu unterscheiden — eine Messreihe, die
    // versehentlich das ausgelieferte Binary gefahren hat, sähe normal aus und
    // beantwortete eine andere Frage. Genau diese Verwechslung ist auf der
    // Linux-Seite am 2026-07-30 passiert (WHIP-Läufe fielen still auf H.264
    // zurück, weil der ffmpeg-Muxer statt des eigenen Senders lief).
    eprintln!(
        "[hq-labor] Windows-HQ-LABOR {} — NICHT der ausgelieferte Sidecar",
        env!("CARGO_PKG_VERSION")
    );

    // Den eigenen Sendeweg anmelden, BEVOR das erste `start` hereinkommen
    // kann. Ab hier nimmt jeder Stream auf eine `http(s)://`-URL den eigenen
    // WHIP-Sender statt des FFmpeg-Muxers — der einzige Unterschied zum
    // ausgelieferten Sidecar, und der ganze Zweck dieses Binaries.
    pulse_win_hq_labor::senke::anmelden();
    eprintln!("[hq-labor] eigener WHIP-Sendeweg angemeldet (http/https -> WebRTC statt ffmpeg)");

    // **Der Encode-Weg. Seit 2026-08-02 ist das AMF, nicht mehr Vulkan.**
    //
    // Der Vulkan-Weg gab es aus einem einzigen Grund: die Annahme, AMF koenne
    // kein Intra-Refresh. Die ist widerlegt — AMF kann es, es heisst dort nur
    // anders. Und in jedem gemessenen Punkt ist AMF besser: rund 43 % weniger
    // Bits bei gleicher Bildqualitaet, 10 Bit farblich in Ordnung (ueber Vulkan
    // magenta), eine brauchbare Ratensteuerung (die des Vulkan-Encoders trifft
    // ihr Ziel nicht), und im Browser durchgehend in Hardware. Messakten
    // `amf-2026-08-02-intra-refresh-doch.json`,
    // `amd-2026-08-02-h264-intra-refresh.json` und
    // `amd-2026-08-02-qualitaet-und-browser.json`.
    //
    // `PULSE_LABOR_VULKAN=1` holt den alten Weg zurueck — er bleibt als
    // Vergleichsarm stehen, damit die Messakten nachvollziehbar bleiben.
    //
    // **Diese Zeile sagt nur, WELCHER Weg gewaehlt wurde — nicht, ob dabei
    // aufgefrischt wird.** Bis 2026-08-02 behauptete sie beides, und beides war
    // hier gar nicht zu haben. Die Auskunft gibt es ohnehin dort, wo sie
    // feststeht: beim Oeffnen des Encoders (`[encode] PULSE_ENCODER_OPTS: k=v`
    // bzw. die Zeile von `vulkan_encoder` nach `open_with`).
    if env::flag("PULSE_LABOR_VULKAN") {
        pulse_win_hq_labor::vulkan_encoder::anmelden();
        eprintln!("[hq-labor] VERGLEICHSBETRIEB: Vulkan-Encoder statt AMF");
    } else {
        eprintln!("[hq-labor] Encode-Weg: herstellereigen (AMF/D3D12)");
    }

    let (out_tx, out_rx) = std::sync::mpsc::channel::<serde_json::Value>();
    events::init(out_tx.clone());

    let writer = thread::Builder::new()
        .name("stdout-writer".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut out = stdout.lock();
            while let Ok(value) = out_rx.recv() {
                if value.is_null() {
                    let _ = out.flush();
                    std::process::exit(0);
                }
                let json = match serde_json::to_string(&value) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[hq-labor] failed to serialize event: {e}");
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
        let n = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[hq-labor] stdin read error: {e}");
                break;
            }
        };
        if n == 0 {
            break;
        }
        // `trim()` entfernt Whitespace, aber nicht U+FEFF (UTF-8 BOM).
        // PowerShells Default-Encoder schreibt einen BOM auf den ersten
        // stdin-Write — den schlucken wir, statt „invalid JSON" zu werfen.
        let trimmed = line.trim().trim_start_matches('\u{feff}').trim();
        if trimmed.is_empty() {
            continue;
        }

        // Auf dem herstellereigenen Weg die Auffrischung einschalten, bevor der
        // Auftrag hineingeht — der ausgelieferte Sidecar setzt sie nicht, und
        // fuer eine Labormessung wird er nicht angefasst (s. `auffrischung`).
        pulse_win_hq_labor::auffrischung::vorbereiten(trimmed);
        let (response, exit_after) = dispatch::handle_request_line(trimmed);
        match serde_json::to_value(&response) {
            Ok(v) => {
                if out_tx.send(v).is_err() {
                    break; // Writer-Thread weg → Shutdown
                }
            }
            Err(e) => eprintln!("[hq-labor] failed to serialize response: {e}"),
        }
        if exit_after {
            break;
        }
    }

    events::shutdown();
    drop(out_tx);
    let _ = writer.join();
    let _ = pulse_win_hq_sidecar::stream_controller::StreamController::singleton().stop();
    Ok(())
}
