//! Pruefling fuer die Zielaufloesung (`remote_input::ziel`).
//!
//! **Warum es ihn braucht.** Die sechs Unit-Tests pruefen die Buchfuehrung —
//! wer traegt welchen Platz, was bleibt nach dem Abmelden. Die Zahlen selbst
//! koennen sie nicht pruefen: `CGDisplayBounds` und `CGWindowListCopyWindowInfo`
//! haengen an der Maschine, und der ganze unsafe-Teil (CFArray → CFDictionary →
//! CGRect) liegt genau dort. Ein Fehler darin faellt in keinem Test auf und
//! aeussert sich spaeter als Klick an der falschen Stelle.
//!
//! Laeufe (`cargo run --example probe_ziel -- <lauf>`):
//!
//! * `schirm` (Vorgabe) — der Hauptschirm: Rechteck aufloesen und die Masse
//!   gegen `capture::list_displays` gegenpruefen. Beide reden in **Punkten**;
//!   weichen sie ab, ist irgendwo Pixel gerechnet worden.
//! * `fenster` — das erste teilbare Fenster: Rechteck ueber den Fenster-Server
//!   aufloesen und gegen `SCWindow.frame` gegenpruefen. Der Weg, den der
//!   Modulkopf begruendet.
//! * `weg` — eine Fensterkennung, die es nicht gibt: es darf **kein** Rechteck
//!   herauskommen, und nichts darf abstuerzen. Der Pfad durch den leeren
//!   CFArray.

use pulse_fernsteuerung::plattform::Zielsuche;
use pulse_mac_hq_sidecar::capture;
use pulse_mac_hq_sidecar::remote_input::ziel::{self, Quelle};

fn rechteck_von(quelle: Quelle) -> Option<pulse_fernsteuerung::zuordnung::Rechteck> {
    ziel::strom_gestartet(None, quelle);
    let gefunden = match ziel::ziel_fuer_slot(0) {
        Zielsuche::Gefunden { rechteck, .. } => rechteck,
        _ => None,
    };
    ziel::strom_beendet();
    gefunden
}

fn urteil(was: &str, gut: bool) -> bool {
    println!("{} {was}", if gut { "OK  " } else { "FEHL" });
    gut
}

fn lauf_schirm() -> bool {
    let schirme = match capture::list_displays() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("keine Schirmliste: {e}");
            return false;
        }
    };
    let Some(erster) = schirme.first() else {
        eprintln!("kein Schirm gemeldet");
        return false;
    };
    let Some(quelle) = ziel::quelle_aus(None, erster.index) else {
        eprintln!("Quelle nicht bestimmbar");
        return false;
    };
    let Some(r) = rechteck_von(quelle) else {
        eprintln!("kein Rechteck fuer {quelle:?}");
        return false;
    };
    let breite = i64::from(r.rechts - r.links);
    let hoehe = i64::from(r.unten - r.oben);
    println!(
        "  Schirm {} ({:?}): Rechteck {},{} .. {},{}  → {breite}×{hoehe} Punkte",
        erster.index, quelle, r.links, r.oben, r.rechts, r.unten
    );
    println!("  SCDisplay meldet: {}×{} Punkte", erster.width, erster.height);
    urteil(
        "Masse stimmen mit der Aufnahmequelle ueberein",
        breite == erster.width && hoehe == erster.height,
    )
}

fn lauf_fenster() -> bool {
    let fenster = match capture::list_capture_windows() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("keine Fensterliste: {e}");
            return false;
        }
    };
    let Some(w) = fenster.first() else {
        eprintln!("kein teilbares Fenster offen");
        return false;
    };
    let Some(r) = rechteck_von(Quelle::Fenster(w.window_id)) else {
        eprintln!("kein Rechteck fuer Fenster {}", w.window_id);
        return false;
    };
    let breite = i64::from(r.rechts - r.links);
    let hoehe = i64::from(r.unten - r.oben);
    println!("  Fenster {} „{}\" ({})", w.window_id, w.title, w.app);
    println!("  ueber den Fenster-Server: {},{} .. {},{} → {breite}×{hoehe}", r.links, r.oben, r.rechts, r.unten);
    println!("  SCWindow.frame meldet:   {}×{}", w.width, w.height);
    urteil("Masse stimmen mit SCWindow.frame ueberein", breite == w.width && hoehe == w.height)
}

fn lauf_weg() -> bool {
    // Eine Kennung, die kein Fenster traegt. Der Fenster-Server liefert dafuer
    // eine leere Liste — und genau dieser Pfad geht durch den unsafe-Teil.
    let r = rechteck_von(Quelle::Fenster(u32::MAX));
    urteil("verschwundenes Fenster liefert kein Rechteck", r.is_none())
}

fn main() {
    let lauf = std::env::args().nth(1).unwrap_or_else(|| "schirm".into());
    let gut = match lauf.as_str() {
        "schirm" => lauf_schirm(),
        "fenster" => lauf_fenster(),
        "weg" => lauf_weg(),
        anderes => {
            eprintln!("unbekannter Lauf: {anderes} (schirm | fenster | weg)");
            false
        }
    };
    if !gut {
        std::process::exit(1);
    }
}
