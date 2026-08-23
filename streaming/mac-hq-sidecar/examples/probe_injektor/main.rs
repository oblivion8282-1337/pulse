//! Prüfling für den macOS-Injektor: **fährt echte Ereignisse durch den echten
//! Injektor** und lässt TextEdit das Ergebnis bezeugen.
//!
//! Ein Injektor lässt sich nicht mit Unit-Tests abnehmen — die prüfen die
//! Rechnung, nicht die Wirkung. Was ankommt, entscheidet der WindowServer.
//! Dieser Prüfling schliesst die Lücke: er öffnet ein eigenes Zielfenster,
//! injiziert über `MacInjektor` und liest das Ergebnis aus der Zwischenablage
//! zurück, statt es zu behaupten.
//!
//! **Vorsicht:** injizierte Eingabe geht an das Programm im Vordergrund. Der
//! Prüfling holt TextEdit selbst nach vorn und arbeitet nur auf seiner eigenen
//! Datei unter `$TMPDIR` — trotzdem nicht laufen lassen, während nebenher etwas
//! Wichtiges getippt wird.
//!
//! Läufe (jeweils `cargo run --example probe_injektor -- <lauf>`):
//!
//! * `cmd-c` — **die offene Frage aus Aufgabe 1**: trägt ein Cmd-**Runter**-
//!   Ereignis seine eigene Kennzeichnung? `pulse_fernsteuerung::ausfuehrung`
//!   ruft den Injektor VOR dem Nachtrag in `Druck`, die Taste steht beim
//!   eigenen Runter-Ereignis also noch nicht in der Menge. Mit `--eigen` wird
//!   die Menge vorher fortgeschrieben, das Cmd-Runter trägt dann `.maskCommand`
//!   selbst. Beide Läufe vergleichen.
//! * `doppelklick` — Befund 2 am eigenen Code: zwei Klicks im
//!   Doppelklick-Abstand markieren das Wort. Mit `--ohne-zaehler` bekommt der
//!   zweite Klick einen frischen Injektor (und damit `clickState = 1`) — das ist
//!   die Gegenprobe.
//! * `shift-klick` — dieselbe Kennzeichnung auf einem **Maus**-Ereignis:
//!   Umschalt+Klick erweitert die Auswahl. `--ohne-flags` ist die Gegenprobe.
//! * `ziehen` — Befund „Ziehen ist ein eigener Ereignistyp": mit gedrücktem
//!   Knopf markiert die Bewegung Text. Mit `--ohne-zieh-typ` bekommt
//!   `maus_setzen` eine leere Gedrückt-Menge (wie auf Windows) und feuert
//!   `MouseMoved` — die Gegenprobe.
//! * `fenster-ziehen` — dasselbe an einem zweiten Ziel: das Fenster an seiner
//!   Titelleiste verschieben, gemessen an der Fensterlage statt an Text.
//! * `zieh-typ` — was das System aus der Bewegung wirklich macht, abgelesen an
//!   den Ereigniszählern des HID-Systems statt an einem Programm.
//! * `rad` — Richtung und Weite des Rollens, abgelesen am sichtbaren
//!   Zeichenbereich der Textfläche.
//! * `zeiger` — die Grundprüfung: kommt überhaupt etwas an? Schlägt sie fehl,
//!   ist jeder andere Befund wertlos.
//!
//! Die Ergebnisse aller Läufe stehen als Nachträge in
//! `docs/plans/2026-08-23-macos-eingabe-messungen.md`.
//!
//! Alle Läufe brauchen die Bedienungshilfen-Freigabe für das startende Programm
//! (Terminal). Ohne sie tut `CGEventPost` wortlos nichts — der Prüfling sagt es
//! an, statt einen leeren Befund zu melden.

mod maus;
mod tastatur;
mod ziel;

use pulse_mac_hq_sidecar::berechtigung;
use ziel::{TEXT, ziel_oeffnen};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let lauf = args.first().map(String::as_str).unwrap_or("cmd-c");
    let schalter = |name: &str| args.iter().any(|a| a == name);

    if !berechtigung::darf_einspielen() {
        eprintln!(
            "ABBRUCH: keine Bedienungshilfen-Freigabe für dieses Terminal.\n\
             CGEventPost täte wortlos nichts, und der Lauf sähe wie ein Befund aus."
        );
        std::process::exit(2);
    }

    // Der Rad-Lauf braucht eine lange Datei; alle anderen die kurze.
    let inhalt: String = match lauf {
        "rad" => (1..=400).map(|n| format!("Zeile {n:03} — zum Rollen.\n")).collect(),
        _ => TEXT.to_string(),
    };
    let fenster = ziel_oeffnen(&inhalt)?;
    println!("Zielfenster: {fenster:?}");

    match lauf {
        "cmd-c" => tastatur::cmd_c(&fenster, schalter("--eigen"))?,
        "doppelklick" => maus::doppelklick(&fenster, schalter("--ohne-zaehler"))?,
        "ziehen" => maus::ziehen(&fenster, schalter("--ohne-zieh-typ"))?,
        "zeiger" => maus::zeiger(&fenster)?,
        "fenster-ziehen" => maus::fenster_ziehen(&fenster, schalter("--ohne-zieh-typ"))?,
        "zieh-typ" => maus::zieh_typ(&fenster)?,
        "shift-klick" => tastatur::shift_klick(&fenster, schalter("--ohne-flags"))?,
        "rad" => maus::rad(&fenster)?,
        anderer => {
            eprintln!("unbekannter Lauf: {anderer}");
            std::process::exit(2);
        }
    }
    Ok(())
}
