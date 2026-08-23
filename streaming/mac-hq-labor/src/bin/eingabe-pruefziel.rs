//! Das Eingabe-Pruefziel — Aufruf und Ablauf.
//!
//! ```text
//! eingabe-pruefziel [--sekunden N] [--datei PFAD] [--eigenfahrt]
//! ```
//!
//! * `--sekunden N` — **Zwangsabschaltung** (Vorgabe 45). Ein Vollbildfenster,
//!   das Eingabe schluckt und haengenbleibt, sperrt den Rechner aus; die Frist
//!   ist Pflicht, nicht Bequemlichkeit. Von Hand beendet Strg+Alt+Umschalt+Q.
//! * `--datei PFAD` — Protokoll in eine Datei statt auf stdout. Sinnvoll, wenn
//!   ein zweiter Prozess waehrend des Laufs mitliest.
//! * `--eigenfahrt` — das Labor faehrt die Ziele **selbst** an (s.
//!   `eigenfahrt`). Prueft das Messmittel, nicht den Sidecar.
//! * `--soll-klicks N`, `--soll-raeder N`, `--soll-klickstaende 1,1,2,2`,
//!   `--soll-scancodes 0x19,0x16,…` — die Sollwerte eines fremden Treibers.
//!   Ohne sie urteilt das Pruefziel nur ueber Maus und Aufbau; der Rest steht
//!   dann als Zahl in der Zusammenfassung, ohne bewertet zu werden.
//!
//! Rueckgabewert: 0 bestanden, 1 durchgefallen, **2 ungueltig**.

use std::cell::RefCell;
use std::rc::Rc;

use pulse_mac_hq_labor::ereignisse::Sammler;
use pulse_mac_hq_labor::fenster::{App, Einstellungen};
use pulse_mac_hq_labor::protokoll::{Aufzeichnung, Protokoll};
use pulse_mac_hq_labor::{eigenfahrt, ziele, zusammenfassung};
use winit::event_loop::EventLoop;

/// `0x`-Vorsatz erlaubt, damit Scancodes so dastehen wie ueberall sonst.
fn wert<T: TryFrom<u32>>(roh: &str) -> Option<T> {
    let roh = roh.trim();
    let n = match roh.strip_prefix("0x").or_else(|| roh.strip_prefix("0X")) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => roh.parse().ok()?,
    };
    T::try_from(n).ok()
}

fn zahl<T: TryFrom<u32> + Default>(roh: Option<String>) -> T {
    roh.as_deref().and_then(wert).unwrap_or_default()
}

fn liste<T: TryFrom<u32>>(roh: Option<String>) -> Vec<T> {
    roh.iter().flat_map(|s| s.split(',')).filter_map(wert).collect()
}

fn main() {
    let mut sekunden = 45u64;
    let mut datei: Option<String> = None;
    let mut selbst = false;
    let mut soll =
        zusammenfassung::Sollwerte { klicks: 0, raeder: 0, scancodes: Vec::new(), klickstaende: Vec::new() };
    let mut argumente = std::env::args().skip(1);
    while let Some(a) = argumente.next() {
        match a.as_str() {
            "--sekunden" => sekunden = argumente.next().and_then(|v| v.parse().ok()).unwrap_or(45),
            "--datei" => datei = argumente.next(),
            "--eigenfahrt" => selbst = true,
            "--soll-klicks" => soll.klicks = zahl(argumente.next()),
            "--soll-raeder" => soll.raeder = zahl(argumente.next()),
            "--soll-scancodes" => soll.scancodes = liste(argumente.next()),
            "--soll-klickstaende" => soll.klickstaende = liste(argumente.next()),
            andere => {
                eprintln!("unbekanntes Argument: {andere}");
                std::process::exit(64);
            }
        }
    }

    let ziel = datei.as_ref().and_then(|p| std::fs::File::create(p).ok());
    if datei.is_some() && ziel.is_none() {
        eprintln!("Protokolldatei nicht anlegbar");
        std::process::exit(64);
    }
    let sammler = Rc::new(RefCell::new(Sammler {
        protokoll: Protokoll::neu(ziel),
        daten: Aufzeichnung::default(),
        geometrie: None,
        gehalten: Default::default(),
    }));

    let mut app = App::neu(Rc::clone(&sammler), Einstellungen { sekunden, eigenfahrt: selbst });
    let lauf = EventLoop::new().expect("Ereignisschleife");
    if let Err(e) = lauf.run_app(&mut app) {
        eprintln!("Ereignisschleife: {e}");
    }

    let mut s = sammler.borrow_mut();
    let treffer = ziele::auswerten(&app.ergebnis.ziele, &s.daten.bewegungen);
    // Die Selbstprobe kennt ihr eigenes Soll; ein fremder Treiber gibt es auf
    // der Befehlszeile mit. Ohne beides prueft das Pruefziel nur Maus und
    // Aufbau.
    if selbst {
        soll = zusammenfassung::Sollwerte {
            klicks: 4,
            raeder: 1,
            scancodes: eigenfahrt::TASTENFOLGE.to_vec(),
            klickstaende: vec![1, 1, 2, 2],
        };
    }
    // Ohne Selbstprobe hat das Pruefziel keine Sollwerte fuer Klicks, Rad und
    // Tasten — dann urteilt es nur ueber Maus und Aufbau, und der Treiber
    // urteilt ueber den Rest.
    let urteil = zusammenfassung::urteilen(
        &app.ergebnis.aufbau,
        app.ergebnis.verdeckung.as_ref(),
        &treffer,
        &s.daten,
        &soll,
    );
    let skalierung = app.ergebnis.skalierung;
    let daten = std::mem::take(&mut s.daten);
    zusammenfassung::schreiben(&mut s.protokoll, &urteil, &treffer, &daten, skalierung);
    drop(s);
    std::process::exit(urteil.ruecksprung());
}
