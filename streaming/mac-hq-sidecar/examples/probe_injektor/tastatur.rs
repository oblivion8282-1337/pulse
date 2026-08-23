//! Die Läufe, die an der Tastatur hängen: die Umschalttasten-Kennzeichnung auf
//! Tasten- und auf Maus-Ereignissen.

use std::thread::sleep;
use std::time::Duration;

use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::plattform::Injektor;

use crate::ziel::{
    CMD, Fenster, MARKE, TASTE_C, auswahl_melden, injektor, klick, lauf, markieren,
    zwischenablage_lesen, zwischenablage_setzen,
};

/// Die offene Frage: muss das Cmd-Runter-Ereignis selbst `.maskCommand` tragen?
pub(crate) fn cmd_c(f: &Fenster, eigen: bool) -> anyhow::Result<()> {
    println!(
        "Lauf cmd-c, Cmd-Runter trägt seine eigene Kennzeichnung: {}",
        if eigen { "JA" } else { "nein (Reihenfolge wie in ausfuehrung.rs)" }
    );
    let inj = injektor()?;
    let mut druck = Druck::default();

    // Erst ein Wort markieren — per Doppelklick, damit die Auswahl nicht
    // ihrerseits von einem Tastenkürzel abhängt.
    markieren(&inj, &mut druck, f.wort());
    zwischenablage_setzen(MARKE)?;

    // Cmd runter. `ausfuehrung` schreibt `Druck` NACH dem Injektor-Aufruf fort;
    // `--eigen` dreht genau das um.
    if eigen {
        druck.taste(CMD, true);
        inj.taste(CMD, true, &druck);
    } else {
        inj.taste(CMD, true, &druck);
        druck.taste(CMD, true);
    }
    sleep(Duration::from_millis(60));
    // C runter/hoch — hier trägt die Kennzeichnung in beiden Läufen, weil Cmd
    // zu diesem Zeitpunkt in der Menge steht.
    inj.taste(TASTE_C, true, &druck);
    druck.taste(TASTE_C, true);
    sleep(Duration::from_millis(60));
    inj.taste(TASTE_C, false, &druck);
    druck.taste(TASTE_C, false);
    sleep(Duration::from_millis(60));
    inj.taste(CMD, false, &druck);
    druck.taste(CMD, false);
    sleep(Duration::from_millis(400));

    let inhalt = zwischenablage_lesen()?;
    println!("Zwischenablage danach: {inhalt:?}");
    println!(
        "-> {}",
        if inhalt.trim() == MARKE {
            "Cmd+C hat NICHT gewirkt"
        } else {
            "Cmd+C hat gewirkt"
        }
    );

    // **Die Kehrseite derselben Reihenfolge.** Beim Cmd-HOCH steht Cmd noch in
    // der Menge (`ausfuehrung` schreibt danach fort) — das Loslass-Ereignis
    // trägt also `.maskCommand`, obwohl es das Ende von Cmd meldet. Bleibt Cmd
    // dadurch hängen, wäre die nächste gewöhnliche Taste ein Tastenkürzel.
    // Geprüft mit „e": als Text ersetzt es die Auswahl, als Cmd+E tut es nichts
    // Sichtbares.
    inj.taste(0x12, true, &druck);
    sleep(Duration::from_millis(60));
    inj.taste(0x12, false, &druck);
    sleep(Duration::from_millis(400));
    let text = lauf("osascript", &[
        "-e",
        "tell application \"TextEdit\" to get text of document 1",
    ])?;
    let erste = text.lines().next().unwrap_or("");
    println!("Erste Zeile danach: {erste:?}");
    println!(
        "-> {}",
        if erste.starts_with('e') {
            "Cmd war beim Loslassen wirklich weg (e kam als Text an)"
        } else {
            "Cmd hing fest — e wurde als Tastenkürzel gedeutet"
        }
    );
    Ok(())
}

/// Die Kennzeichnung auf einem **Maus**-Ereignis: Umschalt+Klick erweitert in
/// TextEdit die Auswahl. Der Weg dahin ist der gemerkte Zwischenstand — `Druck`
/// erreicht `maus_setzen`, `maus_knopf` bekommt ihn gar nicht (s. `Zustand` in
/// `injektion.rs`). Mit `--ohne-flags` sieht `maus_setzen` eine leere Menge,
/// obwohl die Umschalttaste körperlich unten ist: die Gegenprobe zu der Frage,
/// ob der WindowServer die Kennzeichnung für Maus-Ereignisse selbst füllt.
pub(crate) fn shift_klick(f: &Fenster, ohne_flags: bool) -> anyhow::Result<()> {
    println!(
        "Lauf shift-klick, Kennzeichnung auf dem Maus-Ereignis: {}",
        if ohne_flags { "AUS (leere Menge an maus_setzen)" } else { "an" }
    );
    const SHIFT: u16 = 0x2a;
    let inj = injektor()?;
    let mut druck = Druck::default();
    let leer = Druck::default();
    let (x, y) = f.wort();

    klick(&inj, &druck, (x, y));
    // Über der Doppelklick-Frist, damit der zweite Klick nicht als Doppelklick
    // zählt und wortweise markiert.
    sleep(Duration::from_millis(900));
    zwischenablage_setzen(MARKE)?;

    inj.taste(SHIFT, true, &druck);
    druck.taste(SHIFT, true);
    sleep(Duration::from_millis(80));
    inj.maus_setzen((x + 90, y), if ohne_flags { &leer } else { &druck });
    inj.maus_knopf(0, true);
    sleep(Duration::from_millis(40));
    inj.maus_knopf(0, false);
    sleep(Duration::from_millis(120));
    inj.taste(SHIFT, false, &druck);
    druck.taste(SHIFT, false);
    sleep(Duration::from_millis(300));

    auswahl_melden(&inj, "nichts markiert", "Auswahl erweitert")
}
