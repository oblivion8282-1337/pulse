//! Pruefling fuer das Cursor-Echo (`capture::cursorsteuerung`) — der Teil, der
//! ohne laufenden `SCStream` nicht pruefbar ist.
//!
//! Die Reihenfolge (fragen, rufen, erst dann buchen) und die drei Zusagen des
//! Schalters haengen in Unit-Tests; **hier** haengt, was nur eine echte
//! Aufnahme zeigt: dass `updateConfiguration:completionHandler:` am laufenden
//! Strom ueberhaupt gelingt, wie lange es braucht (Grundlage fuer `FRIST`) —
//! und dass ein Strom, der OHNE Zeiger gestartet wurde, durch die
//! Fernsteuerung keinen bekommt.
//!
//! Was er NICHT belegt: dass SCK die Umstellung auch auf das Bild anwendet.
//! Gelesen wird die eigene Einstellungs-Instanz, nicht der Bildinhalt — das
//! zeigt erst der Zwei-Geraete-Lauf.
//!
//! Lauf: `cargo run --release --example probe_zeigerecho`
//! (braucht die Bildschirmaufnahme-Freigabe fuer das rufende Terminal; nimmt
//! ~1 s lang auf und schiebt nichts irgendwohin).

use std::sync::Arc;
use std::time::{Duration, Instant};

use pulse_mac_hq_sidecar::capture::cursorsteuerung::{
    verbergen, zeigen, zeiger_in_der_aufnahme,
};
use pulse_mac_hq_sidecar::capture::{AudioScope, Capturer, Postfach};

/// Eine kurze Aufnahme mit dem gewuenschten Ausgangszustand, gefahren bis das
/// erste Bild da ist — vorher ist ein `updateConfiguration` nicht aussagekraeftig.
fn aufnahme(zeiger_an: bool) -> anyhow::Result<Capturer> {
    let bildpost = Arc::new(Postfach::neu());
    let cap = Capturer::start(
        1,
        None,
        AudioScope::None,
        1280,
        720,
        30,
        zeiger_an,
        bildpost.clone(),
        None,
    )?;
    match bildpost.warten_bis(Instant::now() + Duration::from_secs(5)) {
        Some(_) => Ok(cap),
        None => {
            cap.stop();
            anyhow::bail!("kein Bild binnen 5 s (Freigabe? Bildschirm 1?)")
        }
    }
}

/// Eine Umschaltung samt Dauer und dem, was danach in der Einstellung steht.
fn schalten(was: &str, f: impl FnOnce()) -> (f64, Option<bool>) {
    let t = Instant::now();
    f();
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    let stand = zeiger_in_der_aufnahme();
    eprintln!("  {was:<28} {ms:>7.3} ms  → showsCursor={stand:?}");
    (ms, stand)
}

fn main() -> anyhow::Result<()> {
    let mut fehler = Vec::new();

    eprintln!("Aufnahme MIT Zeiger (show_cursor=true):");
    let cap = aufnahme(true)?;
    let stand = zeiger_in_der_aufnahme();
    if stand != Some(true) {
        fehler.push(format!("Anmeldung: showsCursor={stand:?}, erwartet Some(true)"));
    }
    let mut dauern = Vec::new();
    let (ms, stand) = schalten("verbergen (1. Wechsel)", verbergen);
    dauern.push(ms);
    if stand != Some(false) {
        fehler.push(format!("verbergen: showsCursor={stand:?}, erwartet Some(false)"));
    }
    // Zweiter Ruf derselben Richtung: der Schalter filtert ihn weg, es geht
    // gar kein `updateConfiguration` hinaus — sichtbar an der Dauer.
    let (ms_wieder, _) = schalten("verbergen (schon verborgen)", verbergen);
    let (ms_zeigen, stand) = schalten("zeigen", zeigen);
    dauern.push(ms_zeigen);
    if stand != Some(true) {
        fehler.push(format!("zeigen: showsCursor={stand:?}, erwartet Some(true)"));
    }
    let (ms2, _) = schalten("verbergen (2. Wechsel)", verbergen);
    dauern.push(ms2);
    let (ms3, _) = schalten("zeigen (2. Wechsel)", zeigen);
    dauern.push(ms3);
    let langsamste = dauern.iter().copied().fold(0.0_f64, f64::max);
    if ms_wieder > langsamste {
        fehler.push("der gefilterte Ruf dauerte laenger als ein echter — filtert der Schalter?".into());
    }
    cap.stop();
    if zeiger_in_der_aufnahme().is_some() {
        fehler.push("nach `stop` ist der Platz noch angemeldet".into());
    }

    eprintln!("\nAufnahme OHNE Zeiger (show_cursor=false) — nie ueber den Ausgangszustand hinaus:");
    let cap = aufnahme(false)?;
    for (was, f) in [("zeigen", zeigen as fn()), ("verbergen", verbergen), ("zeigen", zeigen)] {
        let (_, stand) = schalten(was, f);
        if stand != Some(false) {
            fehler.push(format!("ohne Ausgangs-Zeiger: {was} ergab showsCursor={stand:?}"));
        }
    }
    cap.stop();

    eprintln!("\n{} echte Umschaltungen, langsamste {langsamste:.3} ms", dauern.len());
    if fehler.is_empty() {
        eprintln!("OK");
        Ok(())
    } else {
        for f in &fehler {
            eprintln!("FEHLER: {f}");
        }
        anyhow::bail!("{} Befund(e)", fehler.len())
    }
}
