//! stdio-Transport: Zeilen von stdin herein, Zeilen nach stdout hinaus.
//!
//! Die Nachrichtenformen selbst stehen in [`crate::proto`] — hier geht es nur
//! um den Kanal. stdout gehoert ausschliesslich dem Protokoll; jede Diagnose
//! muss nach stderr, sonst zerlegt sie den Strom auf der Electron-Seite.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use winit::event_loop::EventLoopProxy;

use crate::app::UserEvent;
use crate::proto::Request;

/// Serialisiert Schreibzugriffe auf stdout — Antworten und Ereignisse teilen
/// sich den Kanal, und eine zerrissene Zeile waere fuer die Gegenseite fatal.
#[derive(Clone)]
pub struct StdoutWriter(Arc<Mutex<std::io::Stdout>>);

impl StdoutWriter {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(std::io::stdout())))
    }

    pub fn send<T: serde::Serialize>(&self, value: &T) {
        let Ok(mut out) = self.0.lock() else { return };
        if let Ok(line) = serde_json::to_string(value) {
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
    }
}

/// Liest JSON-Zeilen von stdin und reicht sie in die Fenster-Schleife.
/// Unlesbare Zeilen werden gemeldet und uebersprungen, nicht als Abbruch
/// gewertet.
pub fn spawn_stdin_reader(proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                // Ungueltiges UTF-8 ist eine kaputte Zeile, kein Grund den
                // Player zu beenden — vorher brach die Schleife hier ab und
                // `StdinClosed` fuhr die ganze Anwendung herunter, entgegen
                // dem Versprechen im Kommentar darueber.
                Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                    eprintln!("pulse-player: unlesbare Zeile uebersprungen: {e}");
                    continue;
                }
                // Alles andere ist ein echter Ein-/Ausgabefehler: stdin ist weg.
                Err(e) => {
                    eprintln!("pulse-player: stdin beendet: {e}");
                    break;
                }
            };
            let line = zeile_saeubern(&line);
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Request>(line) {
                Ok(req) => {
                    if proxy.send_event(UserEvent::Request(Box::new(req))).is_err() {
                        return;
                    }
                }
                Err(e) => eprintln!("pulse-player: ungueltiger Request: {e}"),
            }
        }
        let _ = proxy.send_event(UserEvent::StdinClosed);
    });
}

/// Leerraum weg — und eine Byte-Reihenfolge-Marke am Zeilenanfang dazu.
///
/// **Warum die Marke ueberhaupt ankommt und der Aufrufer sie nicht abstellen
/// kann.** .NET setzt beim Start eines Kindprozesses `AutoFlush = true` auf
/// dessen stdin-Schreiber, und dieser Setzer ruft `Flush()`. Damit liegt die
/// Marke der Konsolen-Kodierung in der Leitung, **bevor** der Aufrufer ein
/// einziges Byte geschrieben hat. Steht die Konsole auf UTF-8 (Codepage
/// 65001, die Vorgabe der PowerShell auf dieser Maschine), ist sie drei Bytes
/// lang. Rohe Bytes am Schreiber vorbei in den `BaseStream` zu legen hilft
/// deshalb NICHT — genau das hat `hdr-ansehen.ps1` versucht, mit einem
/// Kommentar, der es als geloest auswies.
///
/// **Warum `trim()` nicht genuegt:** U+FEFF gilt in Rust nicht als Leerraum.
/// Die Zeile ging also unveraendert in `serde_json` und kam als „expected
/// value at line 1 column 1" zurueck — als Aussage ueber unser Format,
/// obwohl das Format stimmte. Am 2026-08-07 hat das eine HDR-Pruefung
/// blockiert: der Player startete nie, und der ausbleibende Beleg sah aus wie
/// ein Fehler an der Farbe.
fn zeile_saeubern(zeile: &str) -> &str {
    zeile.trim_start_matches('\u{feff}').trim()
}

#[cfg(test)]
mod tests {
    use super::zeile_saeubern;

    #[test]
    fn eine_marke_am_zeilenanfang_faellt_weg() {
        assert_eq!(zeile_saeubern("\u{feff}{\"op\":\"ping\"}"), "{\"op\":\"ping\"}");
    }

    #[test]
    fn marke_hinter_leerraum_faellt_auch_weg() {
        // Die Reihenfolge ist nicht garantiert: die Marke kommt aus dem
        // Start des Prozesses, der Leerraum aus dem Aufrufer.
        assert_eq!(zeile_saeubern("\u{feff}  {\"op\":\"ping\"}  "), "{\"op\":\"ping\"}");
    }

    #[test]
    fn eine_marke_allein_ist_eine_leere_zeile() {
        // Sonst gaebe es je Prozessstart eine Fehlermeldung ueber eine Zeile,
        // die niemand geschrieben hat.
        assert!(zeile_saeubern("\u{feff}").is_empty());
    }

    #[test]
    fn eine_marke_mitten_in_der_zeile_bleibt_stehen() {
        // Dort ist sie Nutzlast (ein Fenstertitel darf sie enthalten) und
        // nicht Transport-Beiwerk.
        let mit = "{\"title\":\"a\u{feff}b\"}";
        assert_eq!(zeile_saeubern(mit), mit);
    }
}
