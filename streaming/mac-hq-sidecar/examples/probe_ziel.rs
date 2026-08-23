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
//! * `lebenszyklus` — **die Verdrahtung selbst**: meldet der echte
//!   `StreamController` an und wieder ab? Ein Unit-Test kommt da nicht hin, weil
//!   `Capturer::start` die Aufnahmefreigabe verlangt. Genau diese beiden
//!   Aufrufe sind aber die Stelle, an der die Fernsteuerung sonst auf einen
//!   Strom zielt, den es nicht mehr gibt — der mac-Sidecar bleibt zwischen zwei
//!   Streams warm, es raeumt hier niemand nebenbei auf.
//! * `quelle` — `quelle_aus` fuer den Schirm-Zweig (braucht die Freigabe, der
//!   Fenster-Zweig steht im Unit-Test).

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

/// Der echte Lebenszyklus: `StreamController::start` meldet an, das Ende des
/// Workers meldet ab.
///
/// Gefahren wird mit einer **ungueltigen Fensterkennung** — `Capturer::start`
/// scheitert daran frueh, ohne dass eine Aufnahme anlaeuft. Der Strom ist
/// trotzdem angemeldet worden, und genau das ist zu zeigen.
fn lauf_lebenszyklus() -> bool {
    use pulse_mac_hq_sidecar::capture::AudioScope;
    use pulse_mac_hq_sidecar::stream_controller::{StartParams, StreamController};

    ziel::strom_beendet();
    let params = StartParams {
        display_index: 1,
        window_id: Some(u32::MAX),
        width: 640,
        height: 360,
        fps: 30,
        bitrate_kbps: 1000,
        codec: "h264".into(),
        push_url: String::new(),
        show_cursor: false,
        enable_audio: false,
        audio_scope: AudioScope::None,
        av_offset_ms: 0,
    };
    let controller = StreamController::singleton();
    if let Err(e) = controller.start(params, vec![]) {
        eprintln!("start schlug schon beim Aufsetzen fehl: {e:#}");
        return false;
    }
    // Sofort nachsehen: der Worker scheitert gleich, aber die Anmeldung steht
    // vor ihm.
    let angemeldet = !matches!(ziel::ziel_fuer_slot(0), Zielsuche::KeinStrom);
    let mut gut = urteil("start meldet den Strom an", angemeldet);
    // `stop` wartet auf den Worker — danach muss abgemeldet sein.
    let _ = controller.stop();
    gut &= urteil(
        "das Ende des Workers meldet ihn wieder ab",
        matches!(ziel::ziel_fuer_slot(0), Zielsuche::KeinStrom),
    );
    gut
}

/// `quelle_aus` fuer den Schirm — der Zweig, der die Schirmliste braucht.
fn lauf_quelle() -> bool {
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
    let mut gut = urteil(
        "der genannte Schirm wird genommen",
        ziel::quelle_aus(None, erster.index) == Some(Quelle::Schirm(erster.display_id)),
    );
    // **Muss deckungsgleich mit der Aufnahme sein:** `resolve_resolution` faellt
    // bei einem Index ausserhalb der Liste ebenfalls auf den ersten Schirm
    // zurueck. Liefe das auseinander, zielte die Eingabe auf einen anderen
    // Schirm als den uebertragenen.
    gut &= urteil(
        "ein Index ausserhalb der Liste faellt auf den ersten Schirm",
        ziel::quelle_aus(None, 999) == Some(Quelle::Schirm(erster.display_id)),
    );
    gut
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
        "lebenszyklus" => lauf_lebenszyklus(),
        "quelle" => lauf_quelle(),
        anderes => {
            eprintln!("unbekannter Lauf: {anderes} (schirm | fenster | weg | lebenszyklus | quelle)");
            false
        }
    };
    if !gut {
        std::process::exit(1);
    }
}
