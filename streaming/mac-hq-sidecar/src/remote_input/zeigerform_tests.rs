//! Tests zu [`super`] — auch die, die bisher niemand hatte.
//!
//! ## Warum es diese Datei gibt
//!
//! Die Weiche ([`super::ermitteln_mit`]) und die Rechnung
//! ([`super::super::zeigerpunkte`]) waren genetzt, [`super::zeichnen`] nicht —
//! und dort entsteht das Bild. Zwei Fehler, die dort ebenso naheliegen wie in
//! der Rechnung davor, liefen am 2026-08-23 durch **alle** vorhandenen Netze:
//!
//! 1. Das Zeichenrechteck von den Punktmassen auf die Masse des CGImage
//!    umgestellt — derselbe Denkfehler, gegen den `zielmasse` eine Zeile weiter
//!    oben fuenf Tests hat. Ergebnis: der I-Balken kam als vergroessertes
//!    Viertel heraus.
//! 2. `Order32Big` zu `Order32Little`. Ergebnis: die Deckung wurde aus dem
//!    Rot-Byte gelesen, der Pfeil wurde hohl, die gepackte Groesse fiel von
//!    1121 auf 473 Byte.
//!
//! Beides bestand 134 Unit-Tests und alle Urteile des Prueflings. Gefangen hat
//! es das menschliche Auge am ASCII-Bild.
//!
//! ## Warum es ohne Fenster-Server geht
//!
//! Nicht abfragbar ist nur `NSCursor` — das ist AppKit. **CoreGraphics selbst
//! braucht keinen Fenster-Server**: ein Zeichenraum ist Speicher, und aus einem
//! Zeichenraum wird per `CGBitmapContextCreateImage` ein CGImage. Damit laesst
//! sich der Quellzeiger bauen, den AppKit sonst liefert — samt der einen
//! Eigenschaft, auf die es ankommt: **doppelt so gross wie seine Punktmasse**.
//! Diese Tests laufen deshalb in `cargo test`, nicht nur an dieser Maschine.
//!
//! ## Die eine Regel, die man hier brechen kann, ohne es zu merken
//!
//! [`quellbild`] schreibt seine Byte-Ordnung **ausdruecklich hin** und holt sie
//! nicht aus [`super::zeichnen`]. Geteilt waere sie kein Pruefstein mehr: eine
//! gedrehte Ordnung draehte dann beide Seiten und hoebe sich selbst auf. Wer
//! hier eine gemeinsame Konstante einfuehrt, macht die Tests still wirkungslos.

use super::*;
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::CGBitmapContextCreateImage;
use std::cell::Cell;

// ── Die Weiche ──────────────────────────────────────────────────────────────

fn probe_bild(farbe: u8) -> Zeigerbild {
    Zeigerbild { breite: 1, hoehe: 1, halt_x: 0, halt_y: 0, punkte: vec![farbe, farbe, farbe, 255] }
}

fn kennung_von(stand: &Stand) -> String {
    match stand {
        Stand::Eigen(b) => b.kennung(),
        Stand::Name(n) => panic!("erwartet war ein eigenes Bild, gemeldet wurde {n}"),
    }
}

/// **Die Mutationsprobe der Weiche.** Zwei Runden, zwei verschiedene Zeiger —
/// wer das Ergebnis der Abfrage zwischenspeichert, meldet in der zweiten Runde
/// noch den ersten und faellt hier durch. Der Zaehler haelt zusaetzlich fest,
/// dass wirklich zweimal gefragt wurde: ein zwischengespeichertes `Stand` waere
/// sonst an der Kennung allein nicht von einem unveraenderten Zeiger zu
/// unterscheiden.
#[test]
fn jede_runde_fragt_neu() {
    let runden = Cell::new(0u8);
    let abfrage = || {
        runden.set(runden.get() + 1);
        Some(probe_bild(runden.get()))
    };
    let erste = kennung_von(&ermitteln_mit(abfrage));
    let zweite = kennung_von(&ermitteln_mit(abfrage));
    assert_eq!(runden.get(), 2, "die Abfrage wurde nicht in jeder Runde gestellt");
    assert_ne!(erste, zweite, "der Zeiger hat gewechselt, die Meldung nicht");
}

/// Kein Bild heisst Vorgabe, nicht Absturz und nicht Schweigen — an diesem
/// Zweig haengt der Rueckfall, wenn Apple die Abfrage abschaltet.
#[test]
fn ohne_bild_gilt_die_vorgabe() {
    match ermitteln_mit(|| None) {
        Stand::Name(n) => assert_eq!(n, VORGABE),
        Stand::Eigen(_) => panic!("aus dem Nichts darf kein Bild entstehen"),
    }
}

/// Ein Bild geht als [`Stand::Eigen`] hinaus — und **nicht** unter einem
/// erfundenen Namen. Auf macOS gibt es keine Namenstabelle (Modulkopf); waere
/// hier je eine, verlore der Steuernde genau die Formen, fuer die das Bild
/// gebaut wurde.
#[test]
fn ein_bild_geht_als_eigenes_hinaus() {
    assert_eq!(kennung_von(&ermitteln_mit(|| Some(probe_bild(7)))), probe_bild(7).kennung());
}

// ── Das Zeichnen ────────────────────────────────────────────────────────────

/// Ein Quellbild bauen, wie AppKit es liefert: RGBA, 8 bit, Deckung
/// vorvervielfacht, **Rot zuerst im Speicher**.
///
/// Die Byte-Ordnung steht hier ausgeschrieben (s. Modulkopf) — sie ist der
/// Massstab, gegen den [`super::zeichnen`] gemessen wird, und darf deshalb
/// nicht dieselbe Zeile sein.
fn quellbild(
    breite: usize,
    hoehe: usize,
    farbe: impl Fn(usize, usize) -> [u8; 4],
) -> CFRetained<CGImage> {
    let raum = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB })).expect("sRGB");
    let format = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    let ctx = unsafe {
        CGBitmapContextCreate(std::ptr::null_mut(), breite, hoehe, 8, 0, Some(&raum), format)
    }
    .expect("Zeichenraum fuer das Quellbild");
    let daten = CGBitmapContextGetData(Some(&ctx)) as *mut u8;
    assert!(!daten.is_null(), "der Zeichenraum gab keinen Speicher heraus");
    let abstand = CGBitmapContextGetBytesPerRow(Some(&ctx));
    for y in 0..hoehe {
        for x in 0..breite {
            let p = farbe(x, y);
            // Zeile 0 ist die **obere** — so liest CoreGraphics einen
            // Bitmap-Puffer, und so gibt `zeichnen` ihn auch wieder heraus.
            unsafe { std::ptr::copy_nonoverlapping(p.as_ptr(), daten.add(y * abstand + x * 4), 4) };
        }
    }
    CGBitmapContextCreateImage(Some(&ctx)).expect("Quellbild aus dem Zeichenraum")
}

/// Ein Punkt aus dem rohen Puffer, den [`super::zeichnen`] herausgibt — ueber
/// den gemeldeten Zeilenabstand, nie ueber `breite * 4`.
fn roh_punkt(roh: &[u8], abstand: usize, x: usize, y: usize) -> [u8; 4] {
    let i = y * abstand + x * 4;
    [roh[i], roh[i + 1], roh[i + 2], roh[i + 3]]
}

const ROT: [u8; 4] = [255, 0, 0, 255];
const GRUEN: [u8; 4] = [0, 255, 0, 255];
const BLAU: [u8; 4] = [0, 0, 255, 255];
const GELB: [u8; 4] = [255, 255, 0, 255];

/// Ein Quellbild in vier verschieden gefaerbten Vierteln — das Muster, an dem
/// sich „ganz hineingerechnet" von „ein Viertel vergroessert" unterscheiden
/// laesst.
fn viertel(breite: usize, hoehe: usize) -> CFRetained<CGImage> {
    quellbild(breite, hoehe, |x, y| match (x < breite / 2, y < hoehe / 2) {
        (true, true) => ROT,
        (false, true) => GRUEN,
        (true, false) => BLAU,
        (false, false) => GELB,
    })
}

/// Welchem der vier Viertel ein Punkt am naechsten liegt.
///
/// Verglichen wird, **welche** Farbe die naechste ist, nicht wie weit sie
/// entfernt liegt: eine Schranke waere eine Zahl dieser Maschine, die
/// Zuordnung ist keine.
fn welches_viertel(p: [u8; 4]) -> &'static str {
    [("rot", ROT), ("gruen", GRUEN), ("blau", BLAU), ("gelb", GELB)]
        .into_iter()
        .min_by_key(|(_, soll)| {
            (0..4).map(|i| (p[i] as i32 - soll[i] as i32).pow(2)).sum::<i32>()
        })
        .map(|(name, _)| name)
        .expect("vier Farben")
}

/// **Die Probe auf das Zeichenrechteck.** Ein doppelt aufgeloestes Quellbild
/// (18x36, die gemessenen Masse des I-Balkens dieser Maschine) muss beim
/// Zeichnen auf seine Punktmasse (9x18) **hineingerechnet** werden — nicht in
/// Bildpunkten aufgezogen und am Rand des Zeichenraums abgeschnitten.
///
/// Wer das Rechteck aus dem CGImage nimmt, bekommt genau ein Viertel des
/// Zeigers, vergroessert; alle vier Proben zeigen dann dieselbe Farbe. Am Pfeil
/// dieser Maschine (17x23 Punkte auf 17x23 Bildpunkte) waere davon nichts zu
/// bemerken — deshalb steht dieser Test hier und nicht im Pruefling.
#[test]
fn das_zeichenrechteck_folgt_den_punktmassen() {
    let quelle = viertel(18, 36);
    let (roh, abstand) = zeichnen(&quelle, 9, 18).expect("gezeichnet");
    let ecken = [
        ("rot", (2, 4)),
        ("gruen", (6, 4)),
        ("blau", (2, 13)),
        ("gelb", (6, 13)),
    ];
    for (soll, (x, y)) in ecken {
        let ist = welches_viertel(roh_punkt(&roh, abstand, x, y));
        assert_eq!(ist, soll, "bei ({x},{y}) sollte das {soll}e Viertel stehen, es steht {ist}");
    }
}

/// Dasselbe Muster ohne Groessenwechsel — hier duerfen die vier Viertel
/// **nicht** wandern. Ohne diesen Test hiesse ein bestandener Test oben nur
/// „irgendetwas wird verkleinert", nicht „es wird richtig herum gezeichnet":
/// eine gespiegelte Zeilenrichtung vertauschte oben und unten und faellt erst
/// hier auf.
#[test]
fn ohne_groessenwechsel_bleibt_das_bild_wo_es_ist() {
    let quelle = viertel(8, 8);
    let (roh, abstand) = zeichnen(&quelle, 8, 8).expect("gezeichnet");
    assert_eq!(welches_viertel(roh_punkt(&roh, abstand, 1, 1)), "rot", "oben links");
    assert_eq!(welches_viertel(roh_punkt(&roh, abstand, 6, 1)), "gruen", "oben rechts");
    assert_eq!(welches_viertel(roh_punkt(&roh, abstand, 1, 6)), "blau", "unten links");
    assert_eq!(welches_viertel(roh_punkt(&roh, abstand, 6, 6)), "gelb", "unten rechts");
}

/// **Die Probe auf die Byte-Ordnung.** Eine Farbe, deren vier Kanaele alle
/// verschieden sind, muss Byte fuer Byte so wieder herauskommen. Mit
/// `Order32Little` liegt sie umgekehrt im Speicher (A, B, G, R) und wird als
/// (255, 50, 100, 200) gelesen — die Deckung kaeme dann aus dem Rot-Byte.
///
/// Gezeichnet wird 1:1: dieser Test soll die Ordnung pruefen und sonst nichts.
#[test]
fn die_kanaele_liegen_in_der_reihenfolge_der_leitung() {
    let farbe = [200u8, 100, 50, 255];
    let quelle = quellbild(4, 4, |_, _| farbe);
    let (roh, abstand) = zeichnen(&quelle, 4, 4).expect("gezeichnet");
    for y in 0..4 {
        for x in 0..4 {
            let ist = roh_punkt(&roh, abstand, x, y);
            // Spielraum fuer die Rundung der Farbumrechnung, nicht fuer eine
            // vertauschte Reihenfolge: die laege 100 und mehr daneben.
            for k in 0..4 {
                assert!(
                    ist[k].abs_diff(farbe[k]) <= 4,
                    "bei ({x},{y}) kam {ist:?} heraus statt {farbe:?}"
                );
            }
        }
    }
}

/// **Der hohle Pfeil, klein nachgebaut.** Ein schwarzer Strich auf
/// durchsichtigem Grund: Deckung 255, Rot 0. Wird die Deckung aus dem Rot-Byte
/// gelesen, verschwindet der Strich vollstaendig — genau das, was am echten
/// Zeiger als hohler Pfeil zu sehen war und was kein Urteil des Prueflings
/// gefangen hat.
#[test]
fn ein_schwarzer_strich_bleibt_deckend() {
    let strich = |x: usize, _y: usize| if (3..5).contains(&x) { [0, 0, 0, 255] } else { [0; 4] };
    let quelle = quellbild(8, 8, strich);
    let (roh, abstand) = zeichnen(&quelle, 8, 8).expect("gezeichnet");
    assert_eq!(roh_punkt(&roh, abstand, 3, 4), [0, 0, 0, 255], "der Strich ist verschwunden");
    assert_eq!(roh_punkt(&roh, abstand, 0, 0), [0; 4], "neben dem Strich ist nichts");
}

/// **Beim Halbieren entstehen Mischwerte.** Zwei Punkte, einer deckend, einer
/// durchsichtig, werden zu einem — der muss dazwischen liegen. Faellt der
/// Wert auf 255, wurde nicht gemischt, sondern ein Ausschnitt genommen; faellt
/// er auf 0, kam die Deckung aus dem falschen Byte. Der kleinste Test, der
/// beide Fehler zugleich faengt.
#[test]
fn beim_halbieren_wird_gemischt_und_nicht_ausgeschnitten() {
    let quelle = quellbild(2, 2, |x, _| if x == 0 { [0, 0, 0, 255] } else { [0; 4] });
    let (roh, abstand) = zeichnen(&quelle, 1, 1).expect("gezeichnet");
    let deckung = roh_punkt(&roh, abstand, 0, 0)[3];
    assert!(
        (1..=254).contains(&deckung),
        "aus halb deckend wurde {deckung} — weder gemischt noch aus dem Deckungs-Byte gelesen"
    );
}

/// Der Zeilenabstand gehoert zum Puffer und wird mitgegeben, nicht
/// nachgerechnet: CoreGraphics darf Zeilen auffuellen. Der Test prueft nicht,
/// **ob** aufgefuellt wird (das entscheidet die Bibliothek und haengt an der
/// Breite), sondern dass die beiden Zahlen zusammenpassen — sonst laese
/// [`super::super::zeigerpunkte`] schief oder daneben.
#[test]
fn der_gemeldete_zeilenabstand_passt_zum_puffer() {
    for breite in [1u16, 3, 9, 17] {
        let quelle = quellbild(breite as usize, 5, |_, _| [10, 20, 30, 255]);
        let (roh, abstand) = zeichnen(&quelle, breite, 5).expect("gezeichnet");
        assert!(abstand >= breite as usize * 4, "Zeilenabstand {abstand} kuerzer als die Zeile");
        assert!(
            roh.len() >= 4 * abstand + breite as usize * 4,
            "der Puffer endet vor der letzten Zeile"
        );
    }
}

/// **Der ganze Weg von `abfragen`, ohne AppKit.** Genau die Reihenfolge aus
/// [`super::abfragen`]: Punktmasse und Bildmasse in `zielmasse`, das Ergebnis
/// in `zeichnen`, dessen Puffer samt Zeilenabstand in `zeigerpunkte::bild`.
/// Was hier fehlt, ist allein `NSCursor` — alles danach ist gepruefte Strecke.
#[test]
fn der_ganze_weg_ohne_appkit() {
    let quelle = viertel(18, 36);
    let (breite, hoehe) = zeigerpunkte::zielmasse(
        (9.0, 18.0),
        (CGImage::width(Some(&quelle)), CGImage::height(Some(&quelle))),
    )
    .expect("Zielmasse");
    assert_eq!((breite, hoehe), (9, 18), "gesendet werden die Punkte, nicht die Bildpunkte");

    let (roh, abstand) = zeichnen(&quelle, breite, hoehe).expect("gezeichnet");
    let bild = zeigerpunkte::bild(breite, hoehe, (4.0, 9.0), &roh, abstand).expect("Zeigerbild");
    assert_eq!((bild.breite, bild.hoehe), (9, 18));
    assert_eq!((bild.halt_x, bild.halt_y), (4, 9), "der Halt steht in Punkten");
    assert_eq!(bild.punkte.len(), 9 * 18 * 4);
    let punkt = |x: usize, y: usize| {
        let i = (y * 9 + x) * 4;
        [bild.punkte[i], bild.punkte[i + 1], bild.punkte[i + 2], bild.punkte[i + 3]]
    };
    assert_eq!(welches_viertel(punkt(2, 4)), "rot");
    assert_eq!(welches_viertel(punkt(6, 13)), "gelb");
    assert!(bild.packen().is_some(), "ein Zeiger dieser Groesse passt durch den Trichter");
}
