//! Die Tests der Zielaufloesung.
//!
//! Was hier NICHT geprueft werden kann: ob `CGDisplayBounds` und
//! `CGWindowListCopyWindowInfo` die erwarteten Zahlen liefern — das haengt an
//! der Maschine. Geprueft wird die Buchfuehrung: wer traegt welchen Platz, und
//! was bleibt nach dem Abmelden uebrig.

use super::*;

/// Die Tests fassen dieselbe Registrierung an — nacheinander.
static REIHUM: Mutex<()> = Mutex::new(());

fn ist_kein_strom(z: &Zielsuche) -> bool {
    matches!(z, Zielsuche::KeinStrom)
}

/// **Der Fall, den Aufgabe 6 ausdruecklich verlangt** (Schritt 3): anmelden,
/// abmelden, und die Aufloesung muss danach „kein Strom" liefern.
///
/// Auf Windows raeumt der Prozesswechsel je Strom das nebenbei ab; der
/// mac-Sidecar bleibt warm. Bliebe der Eintrag stehen, zielte die
/// Fernsteuerung auf einen Strom, den es nicht mehr gibt — und zwar auf ein
/// Rechteck, das der Fenster-Server womoeglich noch liefert.
#[test]
fn abgemeldeter_strom_traegt_keinen_platz_mehr() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    strom_gestartet(None, Quelle::Schirm(1));
    assert!(!ist_kein_strom(&ziel_fuer_slot(0)), "angemeldet muss tragen");
    strom_beendet();
    assert!(ist_kein_strom(&ziel_fuer_slot(0)), "nach dem Abmelden nicht mehr");
}

/// Ohne angemeldeten Strom gibt es nichts aufzuloesen — die eine Ausnahme von
/// fail-closed (Streams enden asynchron, ein Platz kann zwischen Absenden und
/// Ankunft verschwinden; das ist ein Rennen, kein Angriff).
#[test]
fn ohne_strom_kein_ziel() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    strom_beendet();
    assert!(ist_kein_strom(&ziel_fuer_slot(0)));
}

/// Der ungenannte Platz traegt jeden, der erklaerte gilt strikt. Die Regel
/// selbst steht samt Test in `pulse_fernsteuerung::slot`; hier wird belegt,
/// dass die Registrierung sie auch anwendet.
#[test]
fn slot_regeln_werden_angewandt() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    strom_gestartet(None, Quelle::Schirm(1));
    assert!(!ist_kein_strom(&ziel_fuer_slot(0)));
    assert!(!ist_kein_strom(&ziel_fuer_slot(7)), "ungenannt traegt jeden");
    strom_gestartet(Some(1), Quelle::Schirm(1));
    assert!(!ist_kein_strom(&ziel_fuer_slot(1)));
    assert!(ist_kein_strom(&ziel_fuer_slot(0)), "erklaerter Platz gilt strikt");
    strom_beendet();
}

/// Jenseits der Schranke gibt es den Platz nirgends — **auch nicht beim
/// ungenannten Strom**. Sonst genuegte ein `slot: 999`, um auf einen Strom zu
/// zielen, der ihn nie erklaert hat.
#[test]
fn platz_jenseits_der_schranke_traegt_nie() {
    let _reihum = REIHUM.lock().unwrap_or_else(|e| e.into_inner());
    strom_gestartet(None, Quelle::Schirm(1));
    assert!(ist_kein_strom(&ziel_fuer_slot(slot::SLOT_MAX + 1)));
    assert!(ist_kein_strom(&ziel_fuer_slot(u64::MAX)));
    strom_beendet();
}

/// Ein entartetes Rechteck ist kein Ziel — ein abgestecktes Display liefert ein
/// Null-Rechteck statt eines Fehlers.
#[test]
fn entartetes_rechteck_ist_kein_ziel() {
    use objc2_core_foundation::{CGPoint, CGSize};
    let leer = CGRect { origin: CGPoint { x: 10.0, y: 10.0 }, size: CGSize { width: 0.0, height: 400.0 } };
    assert!(aus_cgrect(leer).is_none(), "keine Breite = kein Ziel");
    let flach = CGRect { origin: CGPoint { x: 10.0, y: 10.0 }, size: CGSize { width: 400.0, height: 0.0 } };
    assert!(aus_cgrect(flach).is_none(), "keine Hoehe = kein Ziel");
}

/// Und die gewoehnliche Umrechnung stimmt: Ursprung plus Masse, nicht Masse
/// allein. Ein zweiter Schirm links der Hauptanzeige hat einen **negativen**
/// Ursprung — wer das Rechteck bei null beginnen laesst, trifft dort nie.
#[test]
fn rechteck_nimmt_den_ursprung_mit() {
    use objc2_core_foundation::{CGPoint, CGSize};
    let r = CGRect {
        origin: CGPoint { x: -1920.0, y: -200.0 },
        size: CGSize { width: 1920.0, height: 1080.0 },
    };
    let z = aus_cgrect(r).expect("gueltig");
    assert_eq!(z.links, -1920);
    assert_eq!(z.oben, -200);
    assert_eq!(z.rechts, 0);
    assert_eq!(z.unten, 880);
}
