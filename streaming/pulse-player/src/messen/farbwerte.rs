//! `pulse-player --farbwerte` — rechnet der HDR-Farbweg richtig?
//!
//! **Was hier NICHT gefragt wird:** ob das Bild schoen aussieht. Ein Blick
//! entscheidet das nicht — am 2026-08-06 hat „gruenstichig" zwei Runden lang in
//! die Farbrechnung gefuehrt, und die Ursache war der Einfrier-Waechter
//! (`docs/2026-08-06-hdr-windows-amd.md` Befund 5). Danach war die Farbfrage
//! nicht beantwortet, sondern unbeantwortet.
//!
//! **Was gefragt wird:** kommt bei einem bekannten PQ-Codewert hinten die
//! Helligkeit heraus, die die Norm dafuer vorsieht — in beiden Zielen. Der Weg
//! ist derselbe wie im Fenster (`build_graphics`, `shader.wgsl`,
//! `build_uniforms`), nur ohne Swapchain; die Sollwerte kommen aus
//! [`super::sollwerte`] und sind unabhaengig davon gerechnet.
//!
//! ```text
//! pulse-player --farbwerte
//! ```
//! Es braucht keine Datei: das Pruefbild entsteht hier, ein waagerechtes Band
//! je Fall.

use anyhow::Result;

use super::gpu::{Ausgabe, Lauf, Messstand, Quelle};
use super::pixel::fp16_stufe;
use super::sollwerte::{Fall, FAELLE, SPITZE_NITS};
use crate::decode::{ColorMatrix, Farbangaben, Uebertragung};
use crate::render::{output_levels, HDR_OBERFLAECHE};

/// Breite des Pruefbilds. Klein, weil jede Flaeche einfarbig ist — mehr Punkte
/// brauchte es nur, wenn ein Verlauf gemessen wuerde.
const BREITE: u32 = 32;

/// Hoehe eines Bandes in Luma-Zeilen. **Muss durch vier teilbar sein**: die
/// Chroma-Ebenen sind halb so hoch, und das Messfenster braucht darin noch
/// Rand.
pub(super) const BANDHOEHE: u32 = 16;

/// Zeilen und Spalten am Rand eines Bandes, die nicht zaehlen.
///
/// **Kein Sicherheitszuschlag, sondern notwendig.** Chroma liegt in halber
/// Aufloesung, und der Sampler steht auf linearer Filterung: an der Bandgrenze
/// mischt er die Farbe zweier BENACHBARTER Faelle. Gemessen wuerde dort ein
/// Zwischenwert, den es im Bild gar nicht gibt — genau der Fehler, vor dem die
/// Stufenmessung mit ihrer 1:1-Bedingung warnt.
pub(super) const RAND: u32 = 4;

/// Das Ziel, in das gezeichnet wird — die zwei Betriebsarten aus `shader.wgsl`.
///
/// **Reine Daten.** Sollspalte und Stufengroesse folgen daraus und sind
/// deshalb Methoden, keine Felder: als Felder waeren „HDR-Ziel mit
/// SDR-Sollspalte" und „Unorm-Format mit fp16-Massstab" konstruierbar, und
/// beides ergaebe eine Messung, die still am falschen Bezug misst.
pub(super) struct Ziel {
    pub(super) name: &'static str,
    pub(super) format: wgpu::TextureFormat,
    pub(super) hdr_fenster: bool,
}

/// **Das HDR-Ziel braucht ein Fliesskomma-Format.** `Rgb10a2Unorm` und
/// `Bgra8Unorm` koennen keine Werte ueber 1,0 tragen; wer den scRGB-Fall dort
/// misst, misst die Begrenzung des Formats statt der Rechnung. Die
/// Spitzlichter dieser Tabelle reichen bis 125,0.
///
/// Das Format kommt deshalb aus [`HDR_OBERFLAECHE`] und steht nicht hier: es
/// ist dieselbe Entscheidung, die das Fenster trifft, und sie darf nur an
/// einer Stelle stehen. Beim SDR-Ziel ist `Rgb10a2Unorm` die uebliche Wahl von
/// `render::setup::pick_format` — hier bewusst festgeschrieben, weil `headless`
/// keine Angebotsliste hat, gegen die man fragen koennte.
pub(super) const ZIELE: [Ziel; 2] = [
    Ziel { name: "HDR-Fenster (scRGB)", format: HDR_OBERFLAECHE, hdr_fenster: true },
    Ziel {
        name: "SDR-Fenster (Tone-Mapping)",
        format: wgpu::TextureFormat::Rgb10a2Unorm,
        hdr_fenster: false,
    },
];

impl Ziel {
    /// Welche Spalte der Sollwert-Tabelle gilt.
    pub(super) fn soll(&self, fall: &Fall) -> [f32; 3] {
        if self.hdr_fenster { fall.hdr } else { fall.sdr }
    }

    /// Wie gross eine Stufe des Ausgabeformats an dieser Stelle ist.
    pub(super) fn stufe(&self, wert: f32) -> f32 {
        match self.format {
            // Fliesskomma hat kein festes Raster — der Abstand haengt am
            // Betrag. `output_levels` taugt hier NICHT: es liefert fuer fp16
            // 2048, und das ist eine Dither-Zahl, keine Stufenzahl.
            wgpu::TextureFormat::Rgba16Float => fp16_stufe(wert),
            // Sonst dieselbe Antwort, mit der der Shader dithert: `levels`
            // Werte, der groesste ist 1,0, also `levels - 1` Schritte.
            f => 1.0 / (output_levels(f) - 1.0),
        }
    }
}

/// **Der Massstab der Pruefung: eine Stufe des Ausgabeformats.**
///
/// Keine gegriffene Toleranz, sondern die Grenze dessen, was ueberhaupt
/// unterscheidbar ist — was feiner ist als eine Stufe, kann in der Textur gar
/// nicht stehen. 1,5 statt 1,0 aus zwei Gruenden, die beide gemessen bzw.
/// bekannt sind:
///
/// * **Dieser Treiber SCHNEIDET beim Schreiben nach fp16 AB, er rundet nicht.**
///   Gemessen an der Umstellung der BT.2020-Matrix: der Fall „BT.2020 Blau"
///   wanderte naeher an den Sollwert und sprang dabei eine Stufe nach UNTEN,
///   weil er die Stufengrenze von oben unterschritt. Abschneiden kostet bis zu
///   einer vollen Stufe, Runden nur eine halbe.
/// * `pow` ist auf jeder Hardware anders genau, und die PQ-Kurve hat den
///   Exponenten 6,28 — ein relativer Fehler dort wird versechsfacht.
const TOLERANZ_STUFEN: f32 = 1.5;

/// Die Farbwelt, die der Windows-Sidecar seit dem 2026-08-06 sendet:
/// BT.2020 ohne konstante Leuchtdichte, PQ, weite Primaervalenzen.
pub(super) fn pq_quelle() -> Farbangaben {
    Farbangaben {
        matrix: ColorMatrix::Bt2020Ncl,
        uebertragung: Uebertragung::Pq,
        weiter_farbraum: true,
        spitze_nits: Some(SPITZE_NITS),
    }
}

/// Hoehe des Pruefbilds: ein Band je Fall.
const HOEHE: u32 = FAELLE.len() as u32 * BANDHOEHE;

/// Das Pruefbild: ein einfarbiges Band je Fall, planar 10 bit, begrenzter
/// Wertebereich — genau die Form, die der Software-Decoder abliefert.
pub(super) fn quelle_bauen() -> Quelle {
    let h = HOEHE;
    let (cw, ch) = (BREITE / 2, h / 2);
    let ebene = |breite: u32, hoehe: u32, code: fn(&Fall) -> u16| {
        let mut out = Vec::with_capacity((breite * hoehe * 2) as usize);
        for zeile in 0..hoehe {
            // Welches Band diese Zeile trifft — die Chroma-Ebenen sind halb so
            // hoch, deshalb ueber den Anteil und nicht ueber eine feste Zahl.
            let fall = &FAELLE[(zeile * FAELLE.len() as u32 / hoehe) as usize];
            out.extend(std::iter::repeat_n(code(fall).to_le_bytes(), breite as usize).flatten());
        }
        out
    };
    Quelle {
        breite: BREITE,
        hoehe: h,
        y: ebene(BREITE, h, |f| f.y),
        u: ebene(cw, ch, |f| f.cb),
        v: ebene(cw, ch, |f| f.cr),
        voller_bereich: false,
    }
}

/// Mittel ueber das Messfenster eines Bandes.
///
/// Gemittelt statt einen Punkt gelesen, damit derselbe Aufruf auch mit
/// eingeschaltetem Dither eine Aussage traegt: das Rauschen ist mittelwertfrei,
/// ein Farbfehler nicht.
pub(super) fn mittel(aus: &Ausgabe, band: usize) -> [f32; 3] {
    let rand = RAND as usize;
    let zeilen = band * BANDHOEHE as usize + rand..(band + 1) * BANDHOEHE as usize - rand;
    // Die Breite aus der Ausgabe, nicht die Modulkonstante: sie steht dort,
    // weil sie zur Speicherordnung gehoert, und beide muessen dieselbe sein.
    let spalten = rand..aus.breite - rand;
    let anzahl = (zeilen.len() * spalten.len()) as f64;
    let mut summe = [0.0f64; 3];
    for zeile in zeilen {
        for spalte in spalten.clone() {
            let p = aus.punkte[zeile * aus.breite + spalte];
            for k in 0..3 {
                summe[k] += f64::from(p[k]);
            }
        }
    }
    std::array::from_fn(|k| (summe[k] / anzahl) as f32)
}

/// Was bei einem Fall herauskam.
pub struct Befund {
    pub fall: &'static str,
    /// Ist die Quelle farblos (Chroma auf der Mitte)? Dann muss die Ausgabe es
    /// auch sein — der schaerfste Einzeltest.
    pub neutral: bool,
    pub soll: [f32; 3],
    pub ist: [f32; 3],
    /// Groesste Abweichung ueber die drei Kanaele, in **Stufen des
    /// Ausgabeformats** — dem einzigen Massstab, der hier etwas aussagt.
    pub abweichung: f32,
}

impl Befund {
    pub fn haelt(&self) -> bool {
        self.abweichung <= TOLERANZ_STUFEN
    }

    /// Wie weit R, G und B auseinanderliegen — die Antwort auf „ist da ein
    /// Farbstich?", unabhaengig davon, ob der Sollwert getroffen ist.
    pub fn kanalspreizung(&self) -> f32 {
        let max = self.ist.iter().copied().fold(f32::MIN, f32::max);
        let min = self.ist.iter().copied().fold(f32::MAX, f32::min);
        max - min
    }
}

fn messen(stand: &mut Messstand, ziel: &Ziel, deband: f32, dither: bool) -> Result<Vec<Befund>> {
    let aus = stand.zeichnen(&Lauf {
        format: ziel.format,
        deband,
        dither,
        farbe: pq_quelle(),
        hdr_fenster: ziel.hdr_fenster,
        zeit: 0.0,
    })?;
    Ok(FAELLE
        .iter()
        .enumerate()
        .map(|(b, fall)| {
            let soll = ziel.soll(fall);
            let ist = mittel(&aus, b);
            Befund {
                fall: fall.name,
                neutral: fall.neutral(),
                soll,
                ist,
                // Die Stufengroesse am GROESSEREN der beiden Werte: bei
                // Fliesskomma haengt sie am Betrag, und der Sollwert kann
                // knapp unter einer Zweierpotenz liegen, der Messwert darueber.
                abweichung: (0..3)
                    .map(|k| {
                        (ist[k] - soll[k]).abs() / ziel.stufe(ist[k].abs().max(soll[k].abs()))
                    })
                    .fold(0.0, f32::max),
            }
        })
        .collect())
}

/// Beide Ziele, ohne Deband und ohne Dither — der reine Rechenweg. In der
/// Reihenfolge von [`ZIELE`], mit dem der Aufrufer die Namen holt.
pub fn pruefen(stand: &mut Messstand) -> Result<Vec<Vec<Befund>>> {
    ZIELE.iter().map(|z| messen(stand, z, 0.0, false)).collect()
}

fn tabelle_ausgeben(befunde: &[Befund]) {
    println!(
        "{:26} {:>32} {:>32} {:>10} {:>8}",
        "Fall", "erwartet (R,G,B)", "gemessen (R,G,B)", "Abw. abs", "Stufen"
    );
    println!("{}", "-".repeat(122));
    // Sechs Nachkommastellen, nicht fuenf: die Ausgabe soll ohne Nachrechnen
    // belegen, dass der Messwert ein DARSTELLBARER fp16-Wert ist (1,152344 =
    // 1181/1024). Mit fuenf Stellen ist das nicht mehr zu erkennen.
    let drei = |v: [f32; 3]| format!("{:10.6} {:10.6} {:10.6}", v[0], v[1], v[2]);
    for b in befunde {
        let abs = (0..3).map(|k| (b.ist[k] - b.soll[k]).abs()).fold(0.0, f32::max);
        println!(
            "{:26} {:>32} {:>32} {abs:10.6} {:8.2}  {}",
            b.fall,
            drei(b.soll),
            drei(b.ist),
            b.abweichung,
            if b.haelt() { "ok" } else { "ABWEICHUNG" }
        );
    }
    // Die Frage, die den ganzen Anlass hat: bleibt Grau grau? Nicht ueber den
    // Sollwert beantwortet, sondern direkt am Unterschied zwischen den
    // Kanaelen — ein Farbstich ist in jedem einzelnen Kanal unsichtbar.
    let spreizung = befunde
        .iter()
        .filter(|b| b.neutral)
        .map(Befund::kanalspreizung)
        .fold(0.0, f32::max);
    println!("groesste Spreizung zwischen R, G und B bei neutralem Chroma: {spreizung:.8}");
}

pub fn ausfuehren() -> Result<()> {
    let q = quelle_bauen();
    let mut stand = pollster::block_on(Messstand::aufbauen(&q))?;
    println!("GPU       {}", stand.adaptername);
    println!("Quelle    planar 10 bit, begrenzter Bereich, BT.2020 NCL, PQ");
    println!("Spitze    {SPITZE_NITS} cd/m² (fuers Tone-Mapping angemeldet)");
    println!("Pruefbild {BREITE}x{HOEHE} — ein Band je Fall\n");

    let mut alles_ok = true;
    for (ziel, befunde) in ZIELE.iter().zip(pruefen(&mut stand)?) {
        println!("== {} ==", ziel.name);
        tabelle_ausgeben(&befunde);
        alles_ok &= befunde.iter().all(Befund::haelt);
        println!();
    }

    // Gegenprobe mit den Vorgaben des Players. Deband ist auf einer einfarbigen
    // Flaeche wirkungslos (alle vier Nachbarn tragen denselben Wert), Dither
    // dagegen nicht — es rauscht um bis zu eine halbe Ausgabestufe. Ueber die
    // Flaeche gemittelt muss davon nichts uebrig bleiben; bliebe etwas, waere
    // das Rauschen nicht mittelwertfrei und verschoebe die Farbe.
    println!("== Gegenprobe mit den Vorgaben des Players (Deband 0.6, Dither an) ==");
    for ziel in &ZIELE {
        let befunde = messen(&mut stand, ziel, 0.6, true)?;
        let schlimmster = befunde
            .iter()
            .max_by(|a, b| a.abweichung.total_cmp(&b.abweichung))
            .expect("mindestens ein Fall");
        println!(
            "{:30} groesste Abweichung {:.2} Stufen bei „{}\"",
            ziel.name, schlimmster.abweichung, schlimmster.fall
        );
    }

    println!(
        "\nSollwerte aus `messen::sollwerte` — aus SMPTE ST 2084, ITU-R BT.2020/BT.709,\n\
         IEC 61966-2-1/-2-2 und ITU-R BT.2408 gerechnet, NICHT aus `shader.wgsl`."
    );
    if !alles_ok {
        anyhow::bail!("mindestens ein Fall liegt ausserhalb der Toleranz");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn das_pruefbild_traegt_je_band_einen_fall() {
        let q = quelle_bauen();
        assert_eq!(q.y.len(), (BREITE * HOEHE * 2) as usize);
        assert_eq!(q.u.len(), (BREITE / 2 * (HOEHE / 2) * 2) as usize);
        // Mitte des dritten Bandes, Luma und Chroma.
        let fall = &FAELLE[2];
        let zeile = 2 * BANDHOEHE + BANDHOEHE / 2;
        let off = ((zeile * BREITE + BREITE / 2) * 2) as usize;
        assert_eq!(u16::from_le_bytes([q.y[off], q.y[off + 1]]), fall.y);
        let coff = (((zeile / 2) * (BREITE / 2) + BREITE / 4) * 2) as usize;
        assert_eq!(u16::from_le_bytes([q.u[coff], q.u[coff + 1]]), fall.cb);
        assert_eq!(u16::from_le_bytes([q.v[coff], q.v[coff + 1]]), fall.cr);
    }

    /// Das Messfenster darf die Bandgrenze nicht beruehren — sonst mittelte es
    /// zwei Faelle, und der Fehler saehe wie ein Rechenfehler des Shaders aus.
    #[test]
    fn das_messfenster_bleibt_im_band() {
        assert!(RAND >= 2, "Chroma liegt in halber Aufloesung");
        assert!(BANDHOEHE % 4 == 0 && BANDHOEHE > 2 * RAND);
    }

    /// **Die eigentliche Pruefung.** Braucht eine GPU; ohne Adapter wird sie
    /// uebersprungen statt rot zu werden — ein fehlendes Geraet ist keine
    /// Aussage ueber den Shader.
    #[test]
    fn der_hdr_farbweg_trifft_die_normwerte() {
        let q = quelle_bauen();
        let Ok(mut stand) = pollster::block_on(Messstand::aufbauen(&q)) else {
            eprintln!("keine GPU — Farbmessung uebersprungen");
            return;
        };
        for (ziel, befunde) in ZIELE.iter().zip(pruefen(&mut stand).expect("Messlauf")) {
            let name = ziel.name;
            for b in &befunde {
                assert!(
                    b.haelt(),
                    "{name} / {}: erwartet {:?}, gemessen {:?} — {:.2} Ausgabestufen daneben",
                    b.fall,
                    b.soll,
                    b.ist,
                    b.abweichung
                );
                // Neutrales Chroma muss neutral bleiben, und zwar EXAKT: die
                // drei Kanaele durchlaufen dieselbe Rechnung mit denselben
                // Zahlen, es gibt keinen Grund fuer einen Unterschied. Der
                // schaerfste Einzeltest — ein Farbstich ist ein Unterschied
                // ZWISCHEN den Kanaelen und faellt in keinem einzelnen auf.
                assert!(
                    !b.neutral || b.kanalspreizung() == 0.0,
                    "{name} / {}: Grau ist nicht grau, R/G/B {:?}",
                    b.fall,
                    b.ist
                );
            }
        }
    }
}
