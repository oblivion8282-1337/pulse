//! Aus den rohen Blöcken Zahlen machen: Pieps finden, mit den Blitzen paaren,
//! Aussetzer und Versatz beziffern.
//!
//! **Getrennt vom Sammeln** ([`super::ton`]), damit sich die Deutung ändern
//! lässt, ohne die Messung zu wiederholen — und damit die Schwellwerte an genau
//! einer Stelle stehen statt verstreut in der Empfangsschleife.
//!
//! **Das Referenzsignal**, gegen das hier gerechnet wird (erzeugt von
//! `testbench/tonreferenz.ps1`, gegengeprüft mit `silencedetect`):
//!
//! * alle **2 s** gleichzeitig ein 1-kHz-Piep von 50 ms **und** ein weißer
//!   Vollbild-Blitz von 100 ms — sample- und bildgenau aus derselben Quelle,
//! * der Piep wechselt dabei **links/rechts**,
//! * dazwischen ein leiser 220-Hz-Träger, der **nie** aussetzt.
//!
//! Daraus fallen drei verschiedene Zahlen, und sie beantworten verschiedene
//! Fragen — das ist der Grund, warum hier nicht „der Versatz" steht:
//!
//! 1. **Versatz bei Ankunft** — Blitz gegen Piep, beide an der Uhr des
//!    Empfängers. Das ist, was ein Zuschauer ohne eigene Synchronisierung
//!    sieht (unser Player hat keine), einschließlich Leitung und Puffer.
//! 2. **Drift der beiden Sender-Uhren** — dieselbe Differenz, aber in den
//!    RTP-Zeitleisten, und nur ihre **Änderung** über den Lauf. Der Anfangswert
//!    ist bedeutungslos (beide Uhren fangen bei einem beliebigen Wert an), die
//!    Steigung nicht: sie ist die Zahl, die der Bauart des Sendewegs nach
//!    schiefgehen kann. Ein Zuschauer, der richtig synchronisiert, sieht genau
//!    diese Zahl wachsen.
//! 3. **Takt** — Piep-Abstand gegen die 2000 ms des Referenzsignals. Läuft die
//!    Ton-Uhr selbst zu schnell oder zu langsam, steht es hier.
//!
//! **Messgrenzen, die im Ergebnis mit ausgewiesen werden** (eine Zahl ohne ihre
//! Grenze verleitet zum Überziehen): das Bild wird mit 30 Bildern je Sekunde
//! abgetastet, ein Blitz ist damit auf **±33 ms** genau zu verorten; der Ton auf
//! die Länge eines Opus-Pakets, also **±5 ms**. Für die *Änderung* über viele
//! Punkte spielt beides keine Rolle — dort mittelt es sich heraus.

use super::ton::Block;

/// Ein dekodiertes Bild, auf seine Helligkeit eingedampft.
#[derive(Clone, Copy)]
pub(super) struct Bildblock {
    /// Millisekunden in der **Bild-Zeitleiste des Senders** (RTP-Uhr, 90 kHz).
    pub(super) ms_uhr: f64,
    /// Millisekunden seit Messbeginn, als der Zeitabschnitt vollständig war.
    pub(super) ms_ankunft: f64,
    /// Mittlere Helligkeit (0..255).
    pub(super) helligkeit: f32,
}

/// Ein gefundenes Ereignis in einer der beiden Spuren.
#[derive(Clone, Copy)]
struct Marke {
    ms_uhr: f64,
    ms_ankunft: f64,
    /// Nur beim Piep belegt: lag er links? Beim Blitz immer `false` — die
    /// Bildspur hat keine Seiten.
    links: bool,
}

/// Was am Ende über den Ton gesagt werden kann.
#[derive(Debug, Default)]
pub struct TonErgebnis {
    pub pakete: u64,
    /// Auf der Leitung verlorene Pakete (Sprung in der Sequenznummer).
    pub seq_luecken: u64,
    /// Lücken, die der Sender schon hatte (Sprung im Zeitstempel).
    pub ts_luecken: u64,
    pub ts_luecken_ms: u64,
    /// Wie lange der Träger ausgesetzt hat. **Muss 0 sein** — das Signal ist
    /// nie still.
    pub stille_ms: u64,
    pub stille_stellen: u64,
    pub pieps: usize,
    pub blitze: usize,
    /// Piep und Blitz einander zugeordnet.
    pub paare: usize,
    /// Wechselte der Piep sauber zwischen links und rechts? Fällt eine
    /// Stereo-Spur zu Mono zusammen, steht hier `false`.
    pub stereo_wechsel_ok: bool,
    /// Mittlerer Piep-Abstand in ms (Soll: 2000).
    pub takt_ms: f64,
    /// Versatz bei Ankunft, Mittelwert der Paare. Positiv = das Bild kommt
    /// **später** als der Ton desselben Augenblicks.
    pub versatz_ankunft_ms: f64,
    pub versatz_ankunft_spanne_ms: f64,
    /// Auseinanderlaufen der beiden Sender-Uhren, in ms je Minute. **Das ist
    /// die Zahl, auf die es ankommt.**
    pub drift_ms_pro_min: f64,
    /// Mittlere Piep-Stärke — eine Plausibilitätsprüfung: fällt sie in den
    /// Bereich des Rauschens, wurde etwas anderes gefunden als ein Piep.
    pub piep_pegel: f32,
}

/// Alles auswerten. `bloecke` ist die Tonspur, `bilder` die Bildspur.
pub(super) fn urteile(bloecke: &[Block], bilder: &[Bildblock]) -> TonErgebnis {
    let mut e = TonErgebnis::default();
    if bloecke.is_empty() {
        return e;
    }

    // **Schwelle aus dem Signal selbst, nicht als feste Zahl.** Der Pegel hängt
    // an der Lautstärke des Rechners und der Aussteuerung der Aufnahme; eine
    // eingebaute Konstante würde bei leiser Wiedergabe schlicht keine Pieps
    // finden und das als „Ton kaputt" melden.
    let spitze = bloecke
        .iter()
        .map(|b| b.piep_links.max(b.piep_rechts))
        .fold(0.0f32, f32::max);
    let schwelle = spitze * 0.35;

    let pieps = pieps(bloecke, schwelle);
    e.piep_pegel = spitze;
    e.pieps = pieps.len();

    // Stille: der Träger ist nie weg. Bezug ist der Mittelwert, nicht eine
    // absolute Zahl — s.o.
    let mittel: f32 =
        bloecke.iter().map(|b| b.lautstaerke).sum::<f32>() / bloecke.len() as f32;
    let stille_schwelle = mittel * 0.1;
    let mut in_stille = false;
    for b in bloecke {
        if b.lautstaerke < stille_schwelle {
            e.stille_ms += super::ton_paket_ms();
            if !in_stille {
                e.stille_stellen += 1;
                in_stille = true;
            }
        } else {
            in_stille = false;
        }
    }

    // Der Blitz hebt die Helligkeit des ganzen Bildes deutlich an; die Schwelle
    // liegt zwischen Ruhe- und Spitzenwert statt auf einem geratenen Absolutwert
    // (der Bildinhalt ist frei wählbar).
    let (hell_min, hell_max) = bilder.iter().fold((f32::MAX, 0.0f32), |(lo, hi), b| {
        (lo.min(b.helligkeit), hi.max(b.helligkeit))
    });
    let blitz_schwelle = hell_min + (hell_max - hell_min) * 0.6;
    let blitze = blitze(bilder, blitz_schwelle);
    e.blitze = blitze.len();

    e.stereo_wechsel_ok = wechselt_seiten(&pieps);
    e.takt_ms = mittlerer_abstand(&pieps);

    // **Paaren über die Ankunft, nicht über den Rang.** Ein verlorener Piep
    // oder ein verpasster Blitz verschiebt sonst alle folgenden Paare um zwei
    // Sekunden, und die Auswertung meldet einen gewaltigen Versatz, wo nur ein
    // Ereignis fehlt. Die Ankunftszeiten kommen aus derselben Uhr und sind
    // deshalb direkt vergleichbar.
    let mut versaetze = Vec::new();
    let mut uhr_diff = Vec::new();
    for p in &pieps {
        let Some(b) = blitze
            .iter()
            .min_by(|a, b| {
                (a.ms_ankunft - p.ms_ankunft)
                    .abs()
                    .total_cmp(&(b.ms_ankunft - p.ms_ankunft).abs())
            })
            .filter(|b| (b.ms_ankunft - p.ms_ankunft).abs() < 500.0)
        else {
            continue;
        };
        versaetze.push(b.ms_ankunft - p.ms_ankunft);
        uhr_diff.push((p.ms_ankunft, b.ms_uhr - p.ms_uhr));
    }
    e.paare = versaetze.len();
    if !versaetze.is_empty() {
        e.versatz_ankunft_ms = versaetze.iter().sum::<f64>() / versaetze.len() as f64;
        let lo = versaetze.iter().cloned().fold(f64::MAX, f64::min);
        let hi = versaetze.iter().cloned().fold(f64::MIN, f64::max);
        e.versatz_ankunft_spanne_ms = hi - lo;
    }
    e.drift_ms_pro_min = steigung(&uhr_diff) * 60_000.0;
    e
}

/// Steigende Flanken über einer Schwelle — für **beide** Spuren dieselbe
/// Funktion, weil es dieselbe Frage ist: wann fängt ein Ereignis an?
///
/// Die Entprellung ist nicht Kosmetik: ein Piep dauert 50 ms und damit zehn
/// Blöcke, ein Blitz 100 ms und damit drei Bilder, deren Werte um die Schwelle
/// herum schwanken. Ohne sie zählte ein einziges Ereignis als mehrere, und der
/// Takt wäre Unsinn.
///
/// `staerke` liefert je Eintrag den zu prüfenden Wert und die Seite (beim Bild
/// gibt es keine, dort ist sie `false`).
fn flanken<T>(
    eintraege: &[T],
    schwelle: f32,
    zeiten: impl Fn(&T) -> (f64, f64),
    staerke: impl Fn(&T) -> (f32, bool),
) -> Vec<Marke> {
    let mut aus: Vec<Marke> = Vec::new();
    let mut zuletzt_ueber = f64::MIN;
    for e in eintraege {
        let (wert, links) = staerke(e);
        if wert < schwelle {
            continue;
        }
        let (ms_uhr, ms_ankunft) = zeiten(e);
        if ms_uhr - zuletzt_ueber > 500.0 {
            aus.push(Marke { ms_uhr, ms_ankunft, links });
        }
        zuletzt_ueber = ms_uhr;
    }
    aus
}

/// Die Tonspur mit [`flanken`] absuchen.
fn pieps(bloecke: &[Block], schwelle: f32) -> Vec<Marke> {
    flanken(
        bloecke,
        schwelle,
        |b| (b.ms_uhr, b.ms_ankunft),
        |b| (b.piep_links.max(b.piep_rechts), b.piep_links > b.piep_rechts),
    )
}

/// Die Bildspur mit [`flanken`] absuchen.
fn blitze(bilder: &[Bildblock], schwelle: f32) -> Vec<Marke> {
    flanken(bilder, schwelle, |b| (b.ms_uhr, b.ms_ankunft), |b| (b.helligkeit, false))
}

/// Wechseln die Pieps sauber die Seite? Bei weniger als drei Funden ist die
/// Frage nicht zu beantworten — dann `false`, nicht „ja, wahrscheinlich".
fn wechselt_seiten(pieps: &[Marke]) -> bool {
    pieps.len() >= 3 && pieps.windows(2).all(|p| p[0].links != p[1].links)
}

fn mittlerer_abstand(pieps: &[Marke]) -> f64 {
    if pieps.len() < 2 {
        return 0.0;
    }
    let summe: f64 = pieps.windows(2).map(|p| p[1].ms_uhr - p[0].ms_uhr).sum();
    summe / (pieps.len() - 1) as f64
}

/// Steigung einer Punktwolke (kleinste Quadrate), in y-Einheiten je x-Einheit.
fn steigung(punkte: &[(f64, f64)]) -> f64 {
    if punkte.len() < 3 {
        return 0.0;
    }
    let n = punkte.len() as f64;
    let (sx, sy) = punkte.iter().fold((0.0, 0.0), |(a, b), (x, y)| (a + x, b + y));
    let (mx, my) = (sx / n, sy / n);
    let zaehler: f64 = punkte.iter().map(|(x, y)| (x - mx) * (y - my)).sum();
    let nenner: f64 = punkte.iter().map(|(x, _)| (x - mx) * (x - mx)).sum();
    if nenner == 0.0 { 0.0 } else { zaehler / nenner }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(ms: f64, l: f32, r: f32) -> Block {
        Block { ms_uhr: ms, ms_ankunft: ms, piep_links: l, piep_rechts: r, lautstaerke: 0.05 }
    }

    /// Ein 50-ms-Piep sind zehn Blöcke über der Schwelle — und trotzdem genau
    /// EIN Ereignis. Das war der Fehler, gegen den die Entprellung steht.
    #[test]
    fn ein_piep_ist_ein_ereignis() {
        let mut bloecke = Vec::new();
        for i in 0..800 {
            let ms = i as f64 * 5.0;
            let im_piep = (ms % 2000.0) < 50.0;
            let links = (ms / 2000.0) as i64 % 2 == 0;
            let stark = if im_piep { 0.25 } else { 0.001 };
            bloecke.push(block(ms, if links { stark } else { 0.001 }, if links { 0.001 } else { stark }));
        }
        let pieps = pieps(&bloecke, 0.25 * 0.35);
        assert_eq!(pieps.len(), 2, "zwei Pieps in vier Sekunden");
        assert!(wechselt_seiten(&[pieps[0], pieps[1], pieps[0]]) || pieps[0].links != pieps[1].links);
        assert!((mittlerer_abstand(&pieps) - 2000.0).abs() < 6.0);
    }

    /// Eine Wolke, die um 10 ms je 60 000 ms steigt, muss als 10 ms je Minute
    /// herauskommen — sonst zeigt die Drift-Zahl in die falsche Größenordnung.
    #[test]
    fn steigung_rechnet_in_ms_je_minute() {
        let punkte: Vec<(f64, f64)> =
            (0..10).map(|i| (i as f64 * 60_000.0, i as f64 * 10.0)).collect();
        assert!((steigung(&punkte) * 60_000.0 - 10.0).abs() < 1e-6);
    }

    #[test]
    fn ohne_bloecke_kein_urteil() {
        let e = urteile(&[], &[]);
        assert_eq!(e.pieps, 0);
        assert!(!e.stereo_wechsel_ok);
    }
}
