//! Tests zu [`super`] — die ganze Rechnung ohne Fenster-Server.
//!
//! **Die Zahlen sind gemessen, nicht erfunden.** Pfeil und I-Balken stammen aus
//! `examples/probe_zeigerform.rs` auf dieser Maschine (macOS 15.7.3,
//! 2026-08-23); der Modulkopf von [`super`] fuehrt sie in einer Tabelle. Ein
//! Test mit erfundenen Massen haette die Falle, um die es hier geht, nicht
//! einmal beschreiben koennen: dass AppKit fuer den einen Zeiger die einfache
//! und fuer den naechsten die doppelte Aufloesung herausgibt.

use super::*;

/// Ein waagerechter Streifen vorvervielfachter RGBA-Punkte, jeder Punkt gleich.
fn streifen(punkt: [u8; 4], anzahl: usize) -> Vec<u8> {
    punkt.repeat(anzahl)
}

// ── Die Masse ───────────────────────────────────────────────────────────────

/// **Die Kernprobe dieses Moduls.** Der I-Balken dieser Maschine: 9x18 Punkte,
/// aber AppKit reicht ein 18x36 grosses Bild heraus. Gesendet werden die
/// **Punkte** — wer die Bildpunkte nimmt, verschickt einen Zeiger in doppelter
/// Groesse, und winit skaliert ihn nicht zurueck.
#[test]
fn die_punktmasse_entscheiden_nicht_die_bildpunkte() {
    assert_eq!(zielmasse((9.0, 18.0), (18, 36)), Some((9, 18)));
}

/// Der Pfeil derselben Maschine, bei dem beide Zahlen zufaellig gleich sind.
/// Steht hier, damit der Test oben nicht als Sonderfall gelesen wird: es ist
/// nicht so, dass AppKit immer verdoppelt — es ist unvorhersehbar.
#[test]
fn beim_pfeil_stimmen_beide_zahlen_ueberein() {
    assert_eq!(zielmasse((17.0, 23.0), (17, 23)), Some((17, 23)));
}

/// Ein Bild ohne Flaeche ist der Rueckfall-Fall, nicht ein Bild der Groesse
/// null: `NSCursor.arrow.image` liefert genau das, und der Steuernde bekommt
/// dann den Namen statt eines leeren Rechtecks.
#[test]
fn ohne_bildpunkte_gibt_es_nichts_zu_senden() {
    assert_eq!(zielmasse((17.0, 23.0), (0, 0)), None);
    assert_eq!(zielmasse((17.0, 23.0), (17, 0)), None);
    assert_eq!(zielmasse((0.0, 0.0), (0, 0)), None);
}

/// Punktmasse unter einem Bildpunkt ergeben kein Bild — und `stimmig()` wuerde
/// es drueben ohnehin abweisen.
#[test]
fn zu_kleine_punktmasse_ergeben_kein_bild() {
    assert_eq!(zielmasse((0.4, 18.0), (18, 36)), None);
    assert_eq!(zielmasse((0.0, 0.0), (18, 36)), None);
}

/// Ueber [`MAX_KANTE`] wird nicht gesendet: an der Kante haengt die Arbeit
/// jedes einzelnen Weckers.
#[test]
fn zu_grosse_punktmasse_werden_abgewiesen() {
    assert_eq!(zielmasse((MAX_KANTE as f64, MAX_KANTE as f64), (256, 256)), Some((256, 256)));
    assert_eq!(zielmasse((MAX_KANTE as f64 + 1.0, 10.0), (257, 10)), None);
}

/// Punkte sind Fliesskommazahlen. Gerundet, nicht abgeschnitten — sonst
/// schrumpfte ein 17,6 Punkte breiter Zeiger auf 17 und der Halt saesse falsch.
#[test]
fn punktmasse_werden_gerundet() {
    assert_eq!(zielmasse((9.4, 18.6), (19, 38)), Some((9, 19)));
}

/// Unsinn aus der Bruecke stuerzt nicht ab, er faellt auf den Namen zurueck.
#[test]
fn unendlich_und_nan_ergeben_kein_bild() {
    assert_eq!(zielmasse((f64::NAN, 18.0), (18, 36)), None);
    assert_eq!(zielmasse((f64::INFINITY, 18.0), (18, 36)), None);
    assert_eq!(zielmasse((-9.0, 18.0), (18, 36)), None);
}

// ── Der Haltepunkt ──────────────────────────────────────────────────────────

/// Der gemessene I-Balken: Halt 4,9 in einem 9x18-Bild. **Unveraendert
/// uebernommen** — `NSCursor.hotSpot` steht in Punkten, und gesendet werden
/// Punkte. Waere das Ziel die doppelte Aufloesung, muesste hier verdoppelt
/// werden; dieser Test haelt beides zusammen.
#[test]
fn der_gemessene_haltepunkt_geht_unveraendert_mit() {
    assert_eq!(halt((4.0, 9.0), 9, 18), (4, 9));
    assert_eq!(halt((4.0, 4.0), 17, 23), (4, 4));
}

/// Ein Halt neben dem Bild wird geklemmt, nicht verworfen — `stimmig()` wiese
/// das ganze Bild ab, und ein leicht verschobener Zielpunkt ist besser als gar
/// kein Zeiger.
#[test]
fn ein_halt_neben_dem_bild_wird_geklemmt() {
    assert_eq!(halt((100.0, 100.0), 9, 18), (8, 17));
    assert_eq!(halt((-3.0, -1.0), 9, 18), (0, 0));
    // NaN und Unendlich in die linke obere Ecke, nicht an den Rand: ein Halt,
    // den niemand kennt, gehoert an den Ursprung des Bildes.
    assert_eq!(halt((f64::NAN, f64::NAN), 9, 18), (0, 0));
    assert_eq!(halt((f64::INFINITY, f64::NEG_INFINITY), 9, 18), (0, 0));
}

// ── Die Punkte ──────────────────────────────────────────────────────────────

/// Voll deckend bleibt alles, wie es ist — der Regelfall im Inneren eines
/// Zeigers.
#[test]
fn voll_deckende_punkte_bleiben_stehen() {
    let roh = [10u8, 20, 30, 255];
    assert_eq!(entvielfachtes_feld(&roh, 1, 1, 4), Some(vec![10, 20, 30, 255]));
}

/// **Die Rueckrechnung.** Halb deckendes Grau liegt vorvervielfacht bei 64 und
/// muss als 128 hinausgehen. Ohne diesen Schritt bekaeme jeder weiche
/// Zeigerrand einen zu dunklen Saum — und nichts stuerzte ab.
#[test]
fn halb_deckende_punkte_werden_zurueckgerechnet() {
    let roh = [64u8, 64, 64, 128];
    assert_eq!(entvielfachtes_feld(&roh, 1, 1, 4), Some(vec![128, 128, 128, 128]));
}

/// Die Deckung selbst wandert **unveraendert** mit. Wer sie beim Umrechnen auf
/// 255 setzt (oder ganz weglaesst), schickt einen Zeiger, der seine Umgebung
/// als Rechteck ausstanzt.
#[test]
fn die_deckung_wandert_unveraendert_mit() {
    let roh = [0u8, 0, 0, 0, 32, 32, 32, 64, 200, 200, 200, 200];
    let raus = entvielfachtes_feld(&roh, 3, 1, 12).expect("drei Punkte");
    assert_eq!([raus[3], raus[7], raus[11]], [0, 64, 200]);
    // Voellig durchsichtig heisst auch farblos — die Farbe unter Deckung null
    // ist bedeutungslos, und ein Rest davon saesse als Schatten im Bild.
    assert_eq!(&raus[0..4], &[0, 0, 0, 0]);
}

/// Die Kanalreihenfolge bleibt, wie sie ist: der Zeichenraum wird als RGBA
/// angelegt, die Leitung will RGBA. **Anders als auf Windows**, wo GDI BGRA
/// liefert und gedreht werden muss — wer den dortigen Code als Vorlage nimmt,
/// dreht hier einmal zu viel und schickt jeden Zeiger in Falschfarben.
#[test]
fn die_kanaele_werden_nicht_gedreht() {
    let roh = [10u8, 20, 30, 255];
    let raus = entvielfachtes_feld(&roh, 1, 1, 4).expect("ein Punkt");
    assert_eq!(&raus[0..3], &[10, 20, 30]);
}

/// Der Zeilenabstand des Zeichenraums darf groesser sein als die Zeile. Die
/// Auffuellung gehoert nicht ins Bild — mitgenommen verzoege sie den Zeiger
/// schraeg, Zeile um Zeile weiter.
#[test]
fn die_zeilenauffuellung_wird_uebersprungen() {
    // Zwei Zeilen zu je zwei Punkten, Zeilenabstand 12 statt 8.
    let mut roh = Vec::new();
    roh.extend_from_slice(&streifen([1, 1, 1, 255], 2));
    roh.extend_from_slice(&[0xAA, 0xAA, 0xAA, 0xAA]); // Auffuellung
    roh.extend_from_slice(&streifen([2, 2, 2, 255], 2));
    roh.extend_from_slice(&[0xAA, 0xAA, 0xAA, 0xAA]);
    let raus = entvielfachtes_feld(&roh, 2, 2, 12).expect("zwei mal zwei");
    assert_eq!(raus.len(), 16);
    assert_eq!(&raus[0..8], &[1, 1, 1, 255, 1, 1, 1, 255]);
    assert_eq!(&raus[8..16], &[2, 2, 2, 255, 2, 2, 2, 255]);
}

/// Ein Puffer, der nicht zu den Massen passt, ergibt kein Bild — und liest vor
/// allem nicht darueber hinaus.
#[test]
fn ein_zu_kurzer_puffer_ergibt_nichts() {
    assert_eq!(entvielfachtes_feld(&streifen([1, 1, 1, 255], 3), 2, 2, 8), None);
    let voll = streifen([1, 1, 1, 255], 4);
    assert_eq!(entvielfachtes_feld(&voll, 2, 2, 4), None, "Zeilenabstand kleiner als die Zeile");
    assert_eq!(entvielfachtes_feld(&[], 0, 0, 0), None);
}

/// Die letzte Zeile muss ganz da sein, ihre Auffuellung nicht — der
/// Zeichenraum legt sie an, aber darauf verlaesst sich hier nichts.
#[test]
fn die_letzte_zeile_darf_ohne_auffuellung_enden() {
    let mut roh = streifen([1, 1, 1, 255], 2);
    roh.extend_from_slice(&[0xAA; 4]);
    roh.extend_from_slice(&streifen([2, 2, 2, 255], 2));
    assert_eq!(roh.len(), 20, "zwei Zeilen a 12 Byte minus die letzte Auffuellung");
    assert!(entvielfachtes_feld(&roh, 2, 2, 12).is_some());
}

// ── Alles zusammen ──────────────────────────────────────────────────────────

/// Der ganze Weg an einem Zeiger in der Groesse des gemessenen I-Balkens:
/// Masse, Halt, Punkte, und das Ergebnis ist stimmig und laesst sich packen.
#[test]
fn aus_dem_gezeichneten_feld_wird_ein_sendefertiges_bild() {
    let (breite, hoehe) = zielmasse((9.0, 18.0), (18, 36)).expect("gemessene Masse");
    let roh = streifen([64, 64, 64, 128], breite as usize * hoehe as usize);
    let bild = bild(breite, hoehe, (4.0, 9.0), &roh, breite as usize * 4).expect("stimmiges Bild");
    assert_eq!((bild.breite, bild.hoehe), (9, 18));
    assert_eq!((bild.halt_x, bild.halt_y), (4, 9));
    assert_eq!(bild.punkte.len(), 9 * 18 * 4);
    assert_eq!(&bild.punkte[0..4], &[128, 128, 128, 128], "zurueckgerechnet");
    assert!(bild.stimmig());
    assert!(bild.packen().is_some(), "ein gewoehnlicher Zeiger passt durch den Trichter");
}

/// Ein Halt weit ausserhalb macht das Bild nicht ungueltig — er wird geklemmt,
/// und `stimmig()` bleibt zufrieden. Ohne das Klemmen faellt der Zeiger
/// vollstaendig aus.
#[test]
fn ein_wilder_halt_kostet_nicht_das_ganze_bild() {
    let roh = streifen([0, 0, 0, 255], 4);
    let b = bild(2, 2, (999.0, 999.0), &roh, 8).expect("geklemmt statt verworfen");
    assert_eq!((b.halt_x, b.halt_y), (1, 1));
}

/// Der Trichter gehoert dem Format, nicht diesem Modul: ein Bild, das nicht
/// unter [`pulse_zeigerbild::MAX_LAEUFE_BYTE`] passt, entsteht hier trotzdem —
/// `Zeigerbuch::nachricht` laesst dann das `bild`-Feld weg und der Steuernde
/// behaelt den Namen. Wer den Trichter hier nachbaute, pflegte ihn zweimal.
#[test]
fn der_trichter_wird_hier_nicht_gezogen() {
    // 256x256 mit lauter verschiedenen Punkten — laesst sich nicht packen.
    let mut roh = Vec::with_capacity(256 * 256 * 4);
    for i in 0..256usize * 256 {
        roh.extend_from_slice(&[(i % 251) as u8, (i % 253) as u8, (i % 249) as u8, 255]);
    }
    let b = bild(256, 256, (0.0, 0.0), &roh, 256 * 4).expect("stimmig ist es trotzdem");
    assert!(b.stimmig());
    assert!(b.packen().is_none(), "zu gross fuer die Leitung — das entscheidet das Format");
}

/// **Ein durchweg durchsichtiges Bild ist kein Bild** — der zweite Ausloeser
/// des Rueckfalls (`super::super::zeigermeldung`).
///
/// Ginge es hinaus, bekaeme der Steuernde einen unsichtbaren Zeiger geschickt
/// und stuende ganz ohne da, waehrend Sender wie Empfaenger einen Erfolg
/// buchen — der leiseste Fehlerausgang dieser Kette. Ein einziger deckender
/// Punkt genuegt dagegen: ein Zeiger darf ueberwiegend durchsichtig sein.
#[test]
fn ein_durchweg_durchsichtiges_bild_geht_nicht_hinaus() {
    let leer = streifen([0, 0, 0, 0], 4);
    assert!(bild(2, 2, (0.0, 0.0), &leer, 8).is_none(), "nichts zu sehen, nichts zu senden");

    let mut fast_leer = leer.clone();
    fast_leer[3] = 1;
    assert!(
        bild(2, 2, (0.0, 0.0), &fast_leer, 8).is_some(),
        "ein einziger deckender Punkt macht daraus einen Zeiger"
    );
}
