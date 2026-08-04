//! Zuschauer-Messwerk: empfangen, zusammensetzen, **dekodieren**, nachrechnen.
//!
//! Beantwortet die Frage, die ein Paketzähler nicht beantwortet: kommt der
//! Zuschauer nach einem Verlust wieder ins Bild, und wie lange dauert das?
//! Mechanik und Begründung in [`pulse_win_hq_labor::whep`].
//!
//! ```text
//! cargo run --example whep_messwerk -- <whep-url> [Sekunden] [Verlust-ab-s] [Pakete] [Modus]
//! ```
//!
//! Der Vergleich ist der Punkt, und es sind **zwei verschiedene**:
//!
//! | Modus | Einstieg | nach Verlust | misst |
//! |---|---|---|---|
//! | `pli` | fragt | fragt | den Regelfall |
//! | `kein-pli` | fragt nicht | fragt nicht | ob man ohne Rückkanal ins Bild kommt |
//! | `nur-einstieg` | fragt | fragt nicht | ob Intra-Refresh nach Verlust selbst heilt |
//!
//! `nur-einstieg` gegen `pli` ist die Erholungs-Messung. Ohne diesen dritten
//! Modus wäre sie bei Intra-Refresh gar nicht zu haben: ein Zuschauer, der
//! beim Einstieg nicht fragt, hat nie ein Bild — der Verlust hätte dann nichts
//! zu zerstören.

use anyhow::Result;
use pulse_win_hq_labor::whep::{Auftrag, miss, pruefe_datei};

fn ja_nein(b: bool) -> &'static str {
    if b { "JA" } else { "nein" }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();

    // Erstes Argument ist eine Datei statt einer URL → offline prüfen. Damit
    // lässt sich eine Mitschrift (`PULSE_MESSWERK_DUMP`) ohne Netz, Server und
    // Sender durch denselben Decoder schicken.
    if let Some(pfad) = a.get(1)
        && !pfad.starts_with("http")
        && std::path::Path::new(pfad).is_file()
    {
        let mime = a.get(2).map(String::as_str).unwrap_or("video/AV1");
        let (gut, schlecht) = pruefe_datei(pfad, mime)?;
        println!("  dekodiert: {gut}");
        println!("  abgelehnt: {schlecht}");
        return Ok(());
    }
    let modus = a.get(5).map(String::as_str).unwrap_or("pli");
    let auftrag = Auftrag {
        url: a.get(1).cloned().unwrap_or_else(|| "http://127.0.0.1:8889/labor/whep".into()),
        sekunden: a.get(2).and_then(|s| s.parse().ok()).unwrap_or(16),
        verlust_ab: a.get(3).and_then(|s| s.parse().ok()),
        verlust_pakete: a.get(4).and_then(|s| s.parse().ok()).unwrap_or(60),
        fordert_beim_einstieg: modus != "kein-pli",
        fordert_nach_verlust: modus == "pli",
    };

    println!("== Zuschauer-Messwerk ==");
    // Die WHEP-URL trägt am Messstand ein Token. Es hier roh auszugeben,
    // hiesse es in jede Messmitschrift und jedes Terminal-Protokoll zu
    // schreiben — dieselbe Regel wie im Sidecar, dieselbe Funktion.
    println!("  Ziel:    {}", pulse_win_hq_sidecar::redact::secrets(&auftrag.url));
    println!("  Laufzeit {} s", auftrag.sekunden);
    println!(
        "  Anforderung: Einstieg={}  nach Verlust={}",
        ja_nein(auftrag.fordert_beim_einstieg),
        ja_nein(auftrag.fordert_nach_verlust)
    );
    match auftrag.verlust_ab {
        Some(ab) => {
            println!("  Verlust: {} Pakete ab Sekunde {ab}", auftrag.verlust_pakete)
        }
        None => println!("  Verlust: keiner"),
    }
    println!();

    let e = miss(auftrag).await?;

    println!("== Ergebnis ==");
    println!("  RTP-Pakete empfangen:      {}", e.pakete);
    println!("  Zeitabschnitte vollstaendig:{}", e.abschnitte);
    println!("  davon verworfen (Luecke):  {}", e.verworfen);
    println!("  BILDER (unbeschaedigt):    {}", e.bilder);
    println!("  davon VOLLBILDER:          {}", e.vollbilder);
    println!("  Bilder mit Fehlern:        {}", e.beschaedigt);
    println!("  vom Decoder abgelehnt:     {}", e.decoder_fehler);
    println!("  erzeugter Verlust:         {} Pakete", e.verlust_erzeugt);
    ton_bericht(&e.ton);
    if e.verlust_erzeugt == 0 {
        println!("  (kein Verlust erzeugt — nichts zu vergleichen)");
        return Ok(());
    }
    match e.luecke_ms {
        Some(ms) => println!("  erstes Bild nach dem Verlust: {ms} ms"),
        None => println!("  NACH DEM VERLUST KAM KEIN BILD MEHR (bis zum Ende)"),
    }
    // **Die Rate ist die Aussage, nicht die Lücke.** Ein einzelnes Bild direkt
    // nach dem Verlust heisst nicht, dass es weitergeht.
    println!("  Bildrate vor dem Verlust:  {:.1}/s", e.rate_vor);
    println!("  >>> Bildrate DANACH:       {:.1}/s", e.rate_nach);
    Ok(())
}

/// Der Ton-Teil des Berichts.
///
/// **Getrennt vom Verlust-Teil und VOR dessen Abbruch**, weil er auch für einen
/// Lauf ohne erzeugten Verlust gilt — die Ton-Messung braucht keinen Schaden,
/// sie braucht Zeit.
fn ton_bericht(t: &pulse_win_hq_labor::whep::TonErgebnis) {
    println!();
    println!("== Ton ==");
    if t.pakete == 0 {
        println!("  KEINE TONSPUR im Strom (oder keine angekommen)");
        return;
    }
    println!("  Opus-Pakete:               {}", t.pakete);
    println!("  auf der Leitung verloren:  {} Stellen", t.seq_luecken);
    println!(
        "  Luecken schon beim Sender: {} Stellen, zusammen {} ms",
        t.ts_luecken, t.ts_luecken_ms
    );
    println!("  STILLE (Traeger weg):      {} ms an {} Stellen", t.stille_ms, t.stille_stellen);
    println!("  Pieps / Blitze / Paare:    {} / {} / {}", t.pieps, t.blitze, t.paare);
    println!("  Stereo wechselt sauber:    {}", ja_nein(t.stereo_wechsel_ok));
    println!("  Piep-Takt (Soll 2000 ms):  {:.1} ms", t.takt_ms);
    if t.paare == 0 {
        println!("  (keine Paare — ohne Referenzsignal ist kein Versatz zu messen)");
        return;
    }
    println!(
        "  Versatz bei Ankunft:       {:+.0} ms (Spanne {:.0} ms, + = Bild spaeter)",
        t.versatz_ankunft_ms, t.versatz_ankunft_spanne_ms
    );
    println!("  >>> DRIFT der Sender-Uhren: {:+.1} ms je Minute", t.drift_ms_pro_min);
    println!("  (Messgrenzen: Bild +-33 ms bei 30/s, Ton +-5 ms je Opus-Paket)");
}
