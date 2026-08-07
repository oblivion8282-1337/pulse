//! `pulse-player --flimmern` — aendert sich das gezeichnete Bild, obwohl sich
//! das Quellbild NICHT aendert?
//!
//! Der Anlass: am 2026-08-07 flimmerte ein **statisches** HDR-Testbild im
//! Fenster sichtbar. Bei einem stehenden Bild ist jede Aenderung von Bild zu
//! Bild ein Fehler — die Frage ist nur, an welcher Station sie entsteht. Diese
//! Messung nimmt sich die erste vor: den **Shader**.
//!
//! **Warum sie ueberhaupt etwas findet, obwohl die Quelle steht.** Zwischen
//! zwei Bildern eines Standbilds unterscheidet den Uniform-Block genau ein
//! Wert: `params.w`, der Stand der Uhr. Deband und Dither wuerfeln daraus ihr
//! Rauschmuster (`shader.wgsl`, `hash23`). Der Messstand hielt ihn bis zum
//! 2026-08-07 fest auf 0 — er KONNTE diese Frage also gar nicht stellen, und
//! jeder Lauf sah nach Stabilitaet aus.
//!
//! **Was hier nicht gemessen wird:** alles hinter dem Shader. Swapchain,
//! Compositor und Bildschirm kommen in dieser Messung nicht vor; sie hat kein
//! Fenster. Ein gruener Befund hier heisst deshalb „der Shader ist es nicht",
//! nicht „es flimmert nicht".
//!
//! ```text
//! pulse-player --flimmern
//! ```

use anyhow::Result;

use super::farbwerte::{mittel, pq_quelle, quelle_bauen, Ziel, BANDHOEHE, RAND, ZIELE};
use super::gpu::{Ausgabe, Lauf, Messstand};
use super::sollwerte::FAELLE;

/// Wie viele aufeinanderfolgende Bilder verglichen werden.
///
/// 30 bei 60 Bildern je Sekunde ist eine halbe Sekunde — lang genug, dass ein
/// Flimmern mit jeder Frequenz ueber 4 Hz mindestens zweimal hin und her geht,
/// und kurz genug, dass die Messung in Sekunden durch ist.
const BILDER: usize = 30;

/// Der Uhrenabstand zweier Bilder, in Sekunden. Genau das, was der Renderer
/// bei 60 Bildern je Sekunde in `params.w` fortschreibt.
const TAKT: f32 = 1.0 / 60.0;

/// Wo die Uhr beim ersten Bild steht.
///
/// **Nicht 0.** `hash23` faengt mit `sin` eines Skalarprodukts an, und bei
/// t = 0 faellt der Zeitanteil darin weg — man maesse den einen Sonderfall,
/// den im Betrieb niemand sieht. Sieben Sekunden sind ein beliebiger, aber
/// betriebsnaher Stand.
const UHR_START: f32 = 7.0;

/// Die vier Einstellungen, die auseinanderzuhalten der ganze Zweck ist:
/// (Deband-Staerke, Dither). Die dritte Zeile ist die **Vorgabe des Players**
/// (`proto::PlayerOptions::defaults`).
const EINSTELLUNGEN: [(f32, bool, &str); 4] = [
    (0.0, false, "Deband aus, Dither aus"),
    (0.6, false, "Deband 0,6,  Dither aus"),
    (0.0, true, "Deband aus, Dither an"),
    (0.6, true, "Deband 0,6,  Dither an  (Vorgabe)"),
];

/// Was ein Band ueber [`BILDER`] Durchgaenge hinweg getan hat.
struct Befund {
    fall: &'static str,
    /// Mittelwert ueber die Flaeche, gemittelt ueber alle Durchgaenge — der
    /// Bezug, an dem die Schwankung gemessen wird.
    bezug: f32,
    /// Groesste Schwankung des **Flaechenmittels** ueber die Durchgaenge.
    ///
    /// Das ist die Zahl, die dem Auge entspricht: ein Rauschen, das je
    /// Bildpunkt in die eine oder andere Richtung geht, hebt sich ueber die
    /// Flaeche auf und ist unsichtbar. Was die Flaeche als Ganzes heller und
    /// dunkler macht, sieht man.
    flaeche: f32,
    /// Groesste Schwankung eines EINZELNEN Bildpunkts ueber die Durchgaenge.
    /// Bei eingeschaltetem Dither ist sie von Haus aus rund eine Ausgabestufe
    /// gross und kein Befund — sie steht daneben, damit die Flaechenzahl nicht
    /// mit ihr verwechselt wird.
    punkt: f32,
}

impl Befund {
    /// Die Flaechenschwankung als Anteil des Bezugswerts, in Prozent.
    fn flaeche_prozent(&self) -> f32 {
        if self.bezug.abs() < 1e-6 { 0.0 } else { self.flaeche / self.bezug.abs() * 100.0 }
    }
}

/// Ein Ziel und eine Einstellung: [`BILDER`] Durchgaenge zeichnen und je Band
/// auswerten.
fn durchgang(stand: &mut Messstand, ziel: &Ziel, deband: f32, dither: bool) -> Result<Vec<Befund>> {
    let mut ausgaben = Vec::with_capacity(BILDER);
    for i in 0..BILDER {
        ausgaben.push(stand.zeichnen(&Lauf {
            format: ziel.format,
            deband,
            dither,
            farbe: pq_quelle(),
            hdr_fenster: ziel.hdr_fenster,
            zeit: UHR_START + i as f32 * TAKT,
        })?);
    }
    Ok(FAELLE
        .iter()
        .enumerate()
        .map(|(b, fall)| {
            // Ueber die drei Kanaele das SCHLIMMSTE nehmen: ein Flimmern in
            // nur einem Kanal ist ein Farbflackern und faellt genauso auf.
            let mut flaeche = 0.0f32;
            let mut bezug = 0.0f32;
            for k in 0..3 {
                let werte: Vec<f32> = ausgaben.iter().map(|a| mittel(a, b)[k]).collect();
                let spanne = spanne(&werte);
                if spanne > flaeche {
                    flaeche = spanne;
                    bezug = werte.iter().sum::<f32>() / werte.len() as f32;
                }
            }
            Befund { fall: fall.name, bezug, flaeche, punkt: punktspanne(&ausgaben, b) }
        })
        .collect())
}

/// Groesste Schwankung eines einzelnen Bildpunkts im Messfenster des Bandes.
fn punktspanne(ausgaben: &[Ausgabe], band: usize) -> f32 {
    let rand = RAND as usize;
    let hoehe = BANDHOEHE as usize;
    let erste = &ausgaben[0];
    let mut groesste = 0.0f32;
    for zeile in band * hoehe + rand..(band + 1) * hoehe - rand {
        for spalte in rand..erste.breite - rand {
            let i = zeile * erste.breite + spalte;
            for k in 0..3 {
                let werte: Vec<f32> = ausgaben.iter().map(|a| a.punkte[i][k]).collect();
                groesste = groesste.max(spanne(&werte));
            }
        }
    }
    groesste
}

fn spanne(werte: &[f32]) -> f32 {
    let max = werte.iter().copied().fold(f32::MIN, f32::max);
    let min = werte.iter().copied().fold(f32::MAX, f32::min);
    max - min
}

fn tabelle(beschriftung: &str, befunde: &[Befund]) {
    // Nur die auffaelligsten drei Baender je Einstellung — die Tabelle soll
    // eine Rangfolge zeigen, keine Vollstaendigkeit vortaeuschen.
    let mut sortiert: Vec<&Befund> = befunde.iter().collect();
    sortiert.sort_by(|a, b| b.flaeche_prozent().total_cmp(&a.flaeche_prozent()));
    for (i, b) in sortiert.iter().take(3).enumerate() {
        println!(
            "{:34} {:30} {:12.6} {:10.6} {:9.3} % {:12.6}",
            if i == 0 { beschriftung } else { "" },
            b.fall,
            b.bezug,
            b.flaeche,
            b.flaeche_prozent(),
            b.punkt,
        );
    }
}

pub fn ausfuehren() -> Result<()> {
    let q = quelle_bauen();
    let mut stand = pollster::block_on(Messstand::aufbauen(&q))?;
    println!("GPU      {}", stand.adaptername);
    println!("Quelle   das Pruefbild der Farbmessung — ein einfarbiges Band je Fall, PQ/BT.2020");
    println!(
        "Aufbau   {BILDER} Durchgaenge im Abstand {:.2} ms; der EINZIGE Unterschied \
         zwischen ihnen ist die Uhr",
        TAKT * 1000.0
    );
    println!(
        "Massstab „Flaeche\" = Schwankung des Flaechenmittels (das, was man sieht), \
         „Punkt\" = die eines einzelnen Bildpunkts\n"
    );

    let mut schlimmste = 0.0f32;
    for ziel in &ZIELE {
        println!("== {} ==", ziel.name);
        println!(
            "{:34} {:30} {:>12} {:>10} {:>11} {:>12}",
            "Einstellung", "auffaelligstes Band", "Bezug", "Flaeche", "rel.", "Punkt"
        );
        println!("{}", "-".repeat(114));
        for (deband, dither, name) in EINSTELLUNGEN {
            let befunde = durchgang(&mut stand, ziel, deband, dither)?;
            schlimmste = befunde
                .iter()
                .map(Befund::flaeche_prozent)
                .fold(schlimmste, f32::max);
            tabelle(name, &befunde);
        }
        println!();
    }

    println!(
        "Groesste Flaechenschwankung ueber alle Ziele und Einstellungen: {schlimmste:.3} %\n\
         Gemessen wird allein `shader.wgsl` samt Uniform-Bau — ohne Fenster, ohne Swapchain,\n\
         ohne Compositor. Ein kleiner Wert hier schliesst diese drei NICHT aus."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Uhr muss sich zwischen den Durchgaengen wirklich bewegen — sonst
    /// maesse die ganze Datei die immer gleiche Zahl und waere gruen, ohne
    /// etwas geprueft zu haben. Genau dieser Zustand lag bis zum 2026-08-07 vor.
    #[test]
    fn die_uhr_laeuft_ueber_die_durchgaenge() {
        let erst = UHR_START;
        let letzt = UHR_START + (BILDER - 1) as f32 * TAKT;
        assert!(letzt - erst > 0.4, "die Messung muss mindestens eine halbe Sekunde abdecken");
        assert!(TAKT > 0.0);
    }

    #[test]
    fn die_spanne_ist_max_minus_min() {
        assert!((spanne(&[1.0, 3.0, 2.0]) - 2.0).abs() < f32::EPSILON);
        assert_eq!(spanne(&[5.0]), 0.0);
    }
}
