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
            let Ok(line) = line else { break };
            let line = line.trim();
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
