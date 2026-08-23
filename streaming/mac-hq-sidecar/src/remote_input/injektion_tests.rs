//! Was der Injektor an ein Ereignis haengt — geprueft gegen die Spur.
//!
//! **Warum es diese Datei gibt.** Bis zum 2026-08-23 war der Injektor die
//! einzige Stelle der Fernsteuerung, an der eine Mutation garantiert gruen
//! blieb: Marke, Flags, Klickstand und Ereignistyp werden gesetzt und
//! verschwinden im selben Atemzug hinter `CGEvent::post`. Der Testbau-Riegel in
//! [`super::Zustand::abfeuern`] zeichnet sie stattdessen auf.
//!
//! **Was diese Tests NICHT belegen:** dass ein Ereignis das System erreicht,
//! und dass die Marke den WindowServer ueberlebt. Beides ist gemessen
//! (`docs/plans/2026-08-23-macos-eingabe-messungen.md`, Nachtraege 5 und 6),
//! nicht getestet — und das ist die richtige Arbeitsteilung: eine Messung
//! beweist die Kette einmal, ein Test haelt eine Entscheidung dauerhaft.

use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::plattform::Injektor;

use objc2_core_graphics::{CGEventFlags, CGEventType};

use super::{MacInjektor, PULSE_MARKE, spur};

/// `Err` hiesse: diese Maschine gibt keine Ereignisquelle her. Dann sagt der
/// Test das, statt an einer Ecke zu scheitern, die nichts damit zu tun hat.
fn injektor() -> MacInjektor {
    MacInjektor::neu().expect("CGEventSource auf dieser Maschine nicht erzeugbar")
}

fn mit_knopf(btn: u8) -> Druck {
    let mut d = Druck::default();
    d.knopf(btn, true);
    d
}

/// Die wichtigste Zeile der Datei. Ohne Marke haelt die Wache die eigene
/// Injektion fuer den Host, loest den Vorrang aus und sperrt den Steuernden
/// mit seiner ersten Mausbewegung dauerhaft aus.
///
/// Geprueft ueber **alle vier** Ereignis-Arten, weil der Stempel in
/// `abfeuern` sitzt und jede Art ihn ueber einen eigenen Weg dorthin traegt.
#[test]
fn jede_art_traegt_die_marke() {
    let inj = injektor();
    let leer = Druck::default();
    inj.maus_setzen((100, 100), &leer);
    inj.maus_knopf(0, true);
    inj.maus_rad(3, 0);
    inj.taste(0x1E, true, &leer); // A

    let spur = spur::nehmen();
    assert_eq!(spur.len(), 4, "{spur:?}");
    for e in &spur {
        assert_eq!(e.marke, PULSE_MARKE, "ungestempelt: {e:?}");
    }
}

/// Die Umschalttasten-Kennzeichnung fuellt macOS **nicht** von selbst — sie
/// kommt aus der Gedrueckt-Menge. Ohne sie kaeme Strg+C als blosses C an.
#[test]
fn flags_kommen_aus_der_gedrueckten_menge() {
    let inj = injektor();
    let mut d = Druck::default();
    d.taste(0x1D, true); // linke Strg-Taste
    inj.taste(0x2E, true, &d); // C

    let spur = spur::nehmen();
    assert_eq!(spur.len(), 1, "{spur:?}");
    assert!(
        spur[0].flags.contains(CGEventFlags::MaskControl),
        "Strg fehlt in der Kennzeichnung: {:?}",
        spur[0]
    );
}

/// Ohne gedrueckten Knopf ist eine Bewegung `MouseMoved`, mit gedruecktem
/// `*Dragged` — ein eigener Ereignistyp, den Windows nicht kennt. Wer das
/// zusammenzieht, laesst in jedem Programm das Ziehen ausfallen, das auf den
/// Zieh-Typ hoert.
#[test]
fn bewegung_waehlt_ihren_typ_nach_der_gedrueckten_menge() {
    let inj = injektor();
    inj.maus_setzen((10, 10), &Druck::default());
    inj.maus_setzen((20, 20), &mit_knopf(0));
    inj.maus_setzen((30, 30), &mit_knopf(1));

    let spur = spur::nehmen();
    let typen: Vec<CGEventType> = spur.iter().map(|e| e.typ).collect();
    assert_eq!(
        typen,
        vec![
            CGEventType::MouseMoved,
            CGEventType::LeftMouseDragged,
            CGEventType::RightMouseDragged,
        ],
        "{spur:?}"
    );
}

/// Ein Zieh-Ereignis traegt den Klickstand seines ausloesenden
/// Runter-Ereignisses. Ohne das faellt „ein Wort doppelklicken und
/// verschieben" auf zeichenweise zurueck, obwohl der Stand im Zustand liegt.
#[test]
fn ziehen_traegt_den_klickstand_des_ausloesenden_drucks() {
    let inj = injektor();
    inj.maus_setzen((50, 50), &Druck::default());
    // Zwei Klicks am selben Ort, dicht hintereinander -> Stand 2.
    inj.maus_knopf(0, true);
    inj.maus_knopf(0, false);
    inj.maus_knopf(0, true);
    let _ = spur::nehmen();

    inj.maus_setzen((51, 51), &mit_knopf(0));
    let spur = spur::nehmen();
    assert_eq!(spur.len(), 1, "{spur:?}");
    assert_eq!(spur[0].typ, CGEventType::LeftMouseDragged, "{spur:?}");
    assert_eq!(
        spur[0].klickstand, 2,
        "Ziehen hat den Doppelklick verloren: {:?}",
        spur[0]
    );
}

/// Ein Hoch-Ereignis traegt denselben Stand wie sein Runter-Ereignis — sonst
/// sieht das Programm einen Doppelklick, dessen zweites Loslassen als
/// einfacher Klick zurueckkommt.
#[test]
fn hoch_traegt_denselben_stand_wie_sein_runter() {
    let inj = injektor();
    inj.maus_setzen((60, 60), &Druck::default());
    inj.maus_knopf(0, true);
    inj.maus_knopf(0, false);
    inj.maus_knopf(0, true);
    inj.maus_knopf(0, false);

    let spur = spur::nehmen();
    let staende: Vec<i64> = spur.iter().skip(1).map(|e| e.klickstand).collect();
    assert_eq!(staende, vec![1, 1, 2, 2], "{spur:?}");
}

/// Ein Scancode ohne Ziel auf dieser Tastatur wird **still verworfen**, nicht
/// geraten. Ein erfundener Virtualcode kaeme als falsche Taste an, und ein
/// Runter-Ereignis ohne passendes Hoch bliebe haengen.
#[test]
fn taste_ohne_ziel_feuert_gar_nichts() {
    let inj = injektor();
    inj.taste(0x00, true, &Druck::default());
    assert!(spur::nehmen().is_empty());
}

/// Dasselbe fail-closed fuer einen Knopf, den die Abbildung nicht kennt.
#[test]
fn unbekannter_knopf_feuert_gar_nichts() {
    let inj = injektor();
    inj.maus_knopf(9, true);
    assert!(spur::nehmen().is_empty());
}
