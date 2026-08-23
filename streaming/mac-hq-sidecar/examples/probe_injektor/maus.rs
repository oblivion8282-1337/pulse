//! Die Läufe, die an der Maus hängen: Doppelklick, Ziehen, Rad — und die
//! Gegenproben dazu.

use std::thread::sleep;
use std::time::Duration;

use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::plattform::Injektor;

use crate::ziel::{
    Fenster, ZEILENLAENGE, auswahl_leeren, auswahl_melden, fensterlage, injektor, klick, lauf,
};

/// Befund 2 am eigenen Code: zwei Klicks im Doppelklick-Abstand markieren das
/// Wort — und ohne den Zähler eben nicht.
pub(crate) fn doppelklick(f: &Fenster, ohne_zaehler: bool) -> anyhow::Result<()> {
    println!(
        "Lauf doppelklick, Klickzähler: {}",
        if ohne_zaehler { "AUS (zweiter Klick über frischen Injektor)" } else { "an" }
    );
    let inj = injektor()?;
    let druck = Druck::default();
    let ort = f.wort();

    auswahl_leeren(&inj, &druck, f)?;

    klick(&inj, &druck, ort);
    sleep(Duration::from_millis(80));
    if ohne_zaehler {
        // Ein frischer Injektor beginnt mit leerer Kette — sein Klick trägt
        // `clickState = 1`. Das ist die Gegenprobe zu Messung 2.
        let zweiter = injektor()?;
        klick(&zweiter, &druck, ort);
    } else {
        klick(&inj, &druck, ort);
    }
    sleep(Duration::from_millis(400));

    auswahl_melden(&inj, "nichts markiert", "Wort markiert")
}

/// Ziehen: mit gedrücktem Knopf markiert die Bewegung Text.
pub(crate) fn ziehen(f: &Fenster, ohne_zieh_typ: bool) -> anyhow::Result<()> {
    println!(
        "Lauf ziehen, Zieh-Ereignistyp: {}",
        if ohne_zieh_typ { "AUS (leere Gedrückt-Menge, wie auf Windows)" } else { "an" }
    );
    let inj = injektor()?;
    let mut druck = Druck::default();
    let leer = Druck::default();
    let (x, y) = f.wort();

    auswahl_leeren(&inj, &druck, f)?;

    inj.maus_setzen((x, y), &druck);
    inj.maus_knopf(0, true);
    druck.knopf(0, true);
    sleep(Duration::from_millis(80));
    for schritt in 1..=8 {
        let ziel = (x + schritt * 8, y);
        if ohne_zieh_typ {
            inj.maus_setzen(ziel, &leer);
        } else {
            inj.maus_setzen(ziel, &druck);
        }
        sleep(Duration::from_millis(30));
    }
    inj.maus_knopf(0, false);
    druck.knopf(0, false);
    sleep(Duration::from_millis(400));

    auswahl_melden(&inj, "nichts gezogen", "Text gezogen")
}

/// Das Rad: Richtung und Weite. Die Richtung war am 2026-08-23 schon gemessen
/// (Messung 3, keine Gegenrechnung); offen blieb die Umrechnung Raste → Zeile.
/// Abgelesen wird über System Events — eine Zahl, keine Deutung; welche, sagt
/// der Kommentar unten.
///
/// **Braucht eine lange Datei:** der Prüfling schreibt sie sich selbst und lässt
/// sie in TextEdit öffnen. Damit ist dieser Lauf der einzige, der die Zieldatei
/// wechselt — er wird deshalb zuletzt gefahren.
pub(crate) fn rad(f: &Fenster) -> anyhow::Result<()> {
    let inj = injektor()?;
    let druck = Druck::default();
    // **Nicht am Rollbalken abgelesen.** `scroll bar 1` ist bei TextEdit der
    // WAAGERECHTE — sein Wert steht still, egal wie weit gerollt wird, und ein
    // Lauf sähe aus wie „das Rad tut nichts". Der sichtbare Zeichenbereich ist
    // eindeutig: durch die Zeilenlänge geteilt ergibt er die oberste Zeile.
    let oberste = || -> anyhow::Result<f64> {
        let s = lauf("osascript", &[
            "-e",
            "tell application \"System Events\" to tell process \"TextEdit\" \
             to get value of attribute \"AXVisibleCharacterRange\" \
             of text area 1 of scroll area 1 of window 1",
        ])?;
        let erste: f64 =
            s.trim().split(',').next().unwrap_or("").trim().parse().unwrap_or(f64::NAN);
        Ok(erste / ZEILENLAENGE + 1.0)
    };

    // In die Mitte der Datei rollen, damit beide Richtungen Platz haben.
    inj.maus_setzen((f.x + 200, f.y + 200), &druck);
    for _ in 0..40 {
        inj.maus_rad(-120, 0);
        sleep(Duration::from_millis(40));
    }
    sleep(Duration::from_millis(800));
    let mut vorher = oberste()?;
    println!("oberste Zeile zu Beginn: {vorher:.1}");
    for rasten in [1i16, 5, -1, -5] {
        inj.maus_rad(rasten * 120, 0);
        sleep(Duration::from_millis(700));
        let nachher = oberste()?;
        println!(
            "{rasten:+} Rasten -> oberste Zeile {nachher:.1} (Schritt {:+.1} Zeilen)",
            nachher - vorher
        );
        vorher = nachher;
    }
    println!("(positive Rasten müssen die Zeilennummer KLEINER machen — Windows-Bedeutung)");
    Ok(())
}

/// **Was das System aus einer Bewegung bei gedrücktem Knopf macht.** Nicht über
/// ein Programm gedeutet, sondern an den Ereigniszählern des HID-Systems
/// abgelesen (`CGEventSourceCounterForEventType`): einmal mit leerer
/// Gedrückt-Menge (der Injektor feuert `MouseMoved`), einmal mit gedrücktem
/// linken Knopf (`LeftMouseDragged`). Zählt der Dragged-Zähler auch im ersten
/// Lauf hoch, hat der WindowServer den Typ selbst berichtigt.
pub(crate) fn zieh_typ(f: &Fenster) -> anyhow::Result<()> {
    use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType};
    let zaehler = |typ| {
        CGEventSource::counter_for_event_type(CGEventSourceStateID::HIDSystemState, typ)
    };
    let inj = injektor()?;
    let leer = Druck::default();
    let mut gedrueckt = Druck::default();
    gedrueckt.knopf(0, true);
    let (x, y) = f.wort();

    for (name, druck) in [("MouseMoved (leere Menge)", &leer), ("LeftMouseDragged", &gedrueckt)] {
        inj.maus_setzen((x, y), &leer);
        inj.maus_knopf(0, true);
        sleep(Duration::from_millis(120));
        let v_moved = zaehler(CGEventType::MouseMoved);
        let v_drag = zaehler(CGEventType::LeftMouseDragged);
        for schritt in 1..=10 {
            inj.maus_setzen((x + schritt * 6, y), druck);
            sleep(Duration::from_millis(30));
        }
        let n_moved = zaehler(CGEventType::MouseMoved);
        let n_drag = zaehler(CGEventType::LeftMouseDragged);
        inj.maus_knopf(0, false);
        sleep(Duration::from_millis(300));
        println!(
            "{name}: 10 Bewegungen -> MouseMoved +{}, LeftMouseDragged +{}",
            n_moved - v_moved,
            n_drag - v_drag
        );
    }
    Ok(())
}

/// Dasselbe Ziehen an einem Ziel mit strengerer Ereignisschleife: das Fenster
/// an seiner Titelleiste verschieben. Gemessen wird die Fensterlage vorher und
/// nachher — kein Auslesen von Text, keine Deutung.
pub(crate) fn fenster_ziehen(f: &Fenster, ohne_zieh_typ: bool) -> anyhow::Result<()> {
    println!(
        "Lauf fenster-ziehen, Zieh-Ereignistyp: {}",
        if ohne_zieh_typ { "AUS (leere Gedrückt-Menge)" } else { "an" }
    );
    let inj = injektor()?;
    let mut druck = Druck::default();
    let leer = Druck::default();
    let (x, y) = (f.x + 200, f.y + 12);

    inj.maus_setzen((x, y), &druck);
    sleep(Duration::from_millis(120));
    inj.maus_knopf(0, true);
    druck.knopf(0, true);
    sleep(Duration::from_millis(120));
    for schritt in 1..=10 {
        let ziel = (x + schritt * 12, y + schritt * 5);
        inj.maus_setzen(ziel, if ohne_zieh_typ { &leer } else { &druck });
        sleep(Duration::from_millis(40));
    }
    inj.maus_knopf(0, false);
    druck.knopf(0, false);
    sleep(Duration::from_millis(500));

    let nachher = fensterlage()?;
    println!("Fenster vorher {:?}, nachher {nachher:?}", (f.x, f.y));
    println!("-> {}", if nachher == (f.x, f.y) { "nicht bewegt" } else { "bewegt" });
    Ok(())
}

/// Nachweis, dass überhaupt etwas ankommt: den Zeiger setzen und die Lage
/// gleich wieder aus dem System zurücklesen. Schlägt das fehl, ist jeder andere
/// Befund dieses Prüflings wertlos.
pub(crate) fn zeiger(f: &Fenster) -> anyhow::Result<()> {
    use objc2_core_graphics::CGEvent;
    let inj = injektor()?;
    let druck = Druck::default();
    for ziel in [(f.x + 40, f.y + 70), (f.x + 200, f.y + 150)] {
        inj.maus_setzen(ziel, &druck);
        sleep(Duration::from_millis(200));
        let ist = CGEvent::new(None).map(|e| CGEvent::location(Some(&e)));
        println!("gesetzt {ziel:?} -> gelesen {ist:?}");
    }
    Ok(())
}
