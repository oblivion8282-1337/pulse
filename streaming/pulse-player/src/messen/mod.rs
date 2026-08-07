//! `pulse-player --stufen` — wieviel Helligkeitsaufloesung ueberlebt den Player?
//!
//! Warum es das gibt: am 2026-08-04 stand als Befund im Raum, der Player gebe
//! „41 von 41 Stufen" durch, auf einer 8-bit-Oberflaeche waeren „nur 13 uebrig
//! geblieben". Beide Zahlen stammten aus einer numpy-Nachrechnung der
//! Farbmatrix — und die laesst **Deband und Dither weg**, also die zwei
//! Shader-Stufen, die danach kommen und im Player beide standardmaessig AN
//! sind (`deband: 0.6`, `dither: true`, s. `proto.rs`). Gemessen wurde damit
//! eine Einstellung, die der Player nie faehrt.
//!
//! Dieser Pfad rechnet nichts nach, sondern zeichnet mit der echten Pipeline
//! (s. [`gpu`]) in eine Textur des jeweiligen Formats und liest sie zurueck.
//!
//! Aufruf:
//! ```text
//! pulse-player --stufen datei.yuv [--breite 2560] [--hoehe 1440] [--bild 50]
//! ```
//! Die Datei ist ein roher `yuv420p10le`-Strom, wie ihn
//! `ffmpeg -i … -pix_fmt yuv420p10le -f rawvideo` abliefert. Passend dazu:
//! `streaming/testbench/graustufen-testbild.py` erzeugt die vier Baender, auf
//! die sich die Ausgabe bezieht.

pub mod farbwerte;
pub mod flimmern;
mod gpu;
mod pixel;
mod sollwerte;

use anyhow::{bail, Context, Result};
use std::io::{Read, Seek, SeekFrom};

use crate::render::output_levels;
use gpu::{Ausgabe, Lauf, Messstand, Quelle};

/// Vier Baender uebereinander, wie im Testbild.
const BAND_NAMEN: [&str; 4] =
    ["1 Vollverlauf 8bit", "2 Vollverlauf 10bit", "3 FLACH 8bit", "4 FLACH 10bit"];

/// Zeilenfenster innerhalb eines Bandes: unter der Beschriftung, weg von den
/// Trennlinien.
///
/// Eine Entscheidung DIESES Werkzeugs, nicht des Testbilds — dort kommen die
/// Zahlen nicht vor. Sie muessen nur zwischen Quelle und Ausgabe dieselben
/// sein, sonst vergleicht man zwei verschiedene Bildausschnitte.
const ROI: std::ops::Range<usize> = 150..250;

/// Das Messfenster eines Bandes in Bildzeilen.
fn fenster(hoehe: usize, band: usize) -> std::ops::Range<usize> {
    let oben = band * (hoehe / BAND_NAMEN.len());
    oben + ROI.start..oben + ROI.end
}

struct Args {
    datei: String,
    breite: u32,
    hoehe: u32,
    bild: u64,
    /// Die Codewerte selbst mit ausgeben, nicht nur ihre Anzahl.
    werte: bool,
}

fn args_lesen(argv: &[String]) -> Result<Args> {
    let mut a = Args { datei: String::new(), breite: 2560, hoehe: 1440, bild: 50, werte: false };
    let mut i = 0;
    while i < argv.len() {
        // Ein Helfer statt dreimal desselben Musters: so kann das
        // Weiterruecken nicht in einem Zweig vergessen werden.
        let zahl = |i: &mut usize| -> Result<u64> {
            let opt = &argv[*i];
            *i += 1;
            argv.get(*i)
                .with_context(|| format!("{opt} braucht einen Wert"))?
                .parse()
                .with_context(|| format!("{opt}: keine Zahl"))
        };
        match argv[i].as_str() {
            "--breite" => a.breite = zahl(&mut i)? as u32,
            "--hoehe" => a.hoehe = zahl(&mut i)? as u32,
            "--bild" => a.bild = zahl(&mut i)?,
            "--werte" => a.werte = true,
            other if other.starts_with("--") => bail!("unbekannte Option: {other}"),
            other => a.datei = other.to_string(),
        }
        i += 1;
    }
    if a.datei.is_empty() {
        bail!(
            "Aufruf: pulse-player --stufen datei.yuv \
             [--breite N] [--hoehe N] [--bild N] [--werte]"
        );
    }
    Ok(a)
}

fn quelle_lesen(a: &Args) -> Result<Quelle> {
    let (w, h) = (a.breite as usize, a.hoehe as usize);
    let ysz = w * h * 2;
    let csz = w.div_ceil(2) * h.div_ceil(2) * 2;
    let bildgroesse = ysz + 2 * csz;
    let mut f = std::fs::File::open(&a.datei)
        .with_context(|| format!("{} liess sich nicht oeffnen", a.datei))?;
    let laenge = f.metadata()?.len();
    let noetig = (a.bild + 1) * bildgroesse as u64;
    if laenge < noetig {
        bail!(
            "{}: {} Bytes, fuer Bild {} bei {}x{} braucht es {} — stimmen --breite/--hoehe?",
            a.datei,
            laenge,
            a.bild,
            w,
            h,
            noetig
        );
    }
    f.seek(SeekFrom::Start(a.bild * bildgroesse as u64))?;
    let mut y = vec![0u8; ysz];
    let mut u = vec![0u8; csz];
    let mut v = vec![0u8; csz];
    f.read_exact(&mut y)?;
    f.read_exact(&mut u)?;
    f.read_exact(&mut v)?;
    Ok(Quelle {
        breite: a.breite,
        hoehe: a.hoehe,
        y,
        u,
        v,
        // Der Sidecar signalisiert `tv`; das Testbild ist danach gebaut.
        voller_bereich: false,
    })
}

/// Was ein Band ueber die Ausgabe verraet.
struct Kennzahlen {
    /// Verschiedene Codewerte im Band — die naive Zaehlung, aus der die „13"
    /// stammte. Mit Dither ist sie NICHT die Antwort auf „sieht man Stufen":
    /// das Rauschen erzeugt Werte, die kein Verlauf hergibt.
    stufen: usize,
    /// Verschiedene Spaltenmittel (ueber die 100 Zeilen des Fensters), auf
    /// 1/4096 gerundet. Das ist, was das Auge ueber die Flaeche integriert —
    /// und der einzige der drei Werte, der Dither richtig bewertet.
    spaltenmittel: usize,
    /// Groesster Sprung zwischen benachbarten Spaltenmitteln, in 10-bit-Stufen.
    /// Sichtbares Banding heisst: grosse Spruenge an wenigen Stellen.
    max_sprung: f32,
    /// Die Codewerte selbst, aufsteigend, auf dem Raster des Ausgabeformats.
    ///
    /// Ohne sie ist eine abweichende Stufenzahl nicht aufzuklaeren: „12 statt
    /// 13" kann heissen, dass oben oder unten einer fehlt, oder dass in der
    /// Mitte zwei zusammengefallen sind. Das sind verschiedene Ursachen — und
    /// genau diese Liste hat am 2026-08-04 den halben Chroma-Code gefunden.
    ///
    /// **Bei `Rgba16Float` ist die Liste KUERZER als `stufen`.** Fliesskomma
    /// liegt nicht auf einem festen Raster; die Liste ist dort eine auf 1/2047
    /// gerundete Ansicht zum Lesen, `stufen` bleibt die Zahl der wirklich
    /// verschiedenen geschriebenen Werte. Bei den Unorm-Formaten sind beide
    /// zwangslaeufig gleich.
    codes: Vec<i64>,
}

fn kennzahlen(aus: &Ausgabe, band: usize, raster: f32) -> Kennzahlen {
    let zeilen = fenster(aus.hoehe, band);
    let anzahl = zeilen.len() as f64;

    let mut codes = std::collections::HashSet::new();
    let mut mittel = vec![0.0f64; aus.breite];
    for y in zeilen {
        for x in 0..aus.breite {
            // Rot genuegt hier: das Stufen-Testbild ist farblos (Chroma auf der
            // Mitte), R, G und B tragen denselben Wert. Ob sie das WIRKLICH
            // tun, ist eine andere Frage — die beantwortet `farbwerte`.
            let v = aus.punkte[y * aus.breite + x][0];
            codes.insert(v.to_bits());
            mittel[x] += f64::from(v);
        }
    }
    for m in mittel.iter_mut() {
        *m /= anzahl;
    }

    let mut grob = std::collections::HashSet::new();
    let mut max_sprung = 0.0f64;
    for (i, m) in mittel.iter().enumerate() {
        grob.insert((m * 4096.0).round() as i64);
        if i > 0 {
            max_sprung = max_sprung.max((m - mittel[i - 1]).abs());
        }
    }
    let mut liste: Vec<i64> =
        codes.iter().map(|b| (f64::from(f32::from_bits(*b)) * f64::from(raster)).round() as i64).collect();
    liste.sort_unstable();
    liste.dedup();
    Kennzahlen {
        stufen: codes.len(),
        spaltenmittel: grob.len(),
        max_sprung: (max_sprung * 1023.0) as f32,
        codes: liste,
    }
}

/// Verschiedene Luma-Werte der QUELLE je Band — der Bezugspunkt, gegen den die
/// Ausgabe zu lesen ist.
fn quell_stufen(q: &Quelle, band: usize) -> usize {
    let w = q.breite as usize;
    let mut werte = std::collections::HashSet::new();
    for y in fenster(q.hoehe as usize, band) {
        for x in 0..w {
            let off = (y * w + x) * 2;
            werte.insert(u16::from_le_bytes([q.y[off], q.y[off + 1]]) & 0x03FF);
        }
    }
    werte.len()
}

pub fn ausfuehren(argv: &[String]) -> Result<()> {
    let a = args_lesen(argv)?;
    let q = quelle_lesen(&a)?;
    let mut stand = pollster::block_on(Messstand::aufbauen(&q))?;

    println!("Datei     {}  (Bild {}, {}x{}, yuv420p10le)", a.datei, a.bild, a.breite, a.hoehe);
    println!("GPU       {}", stand.adaptername);
    println!(
        "16-bit-Texturen (TEXTURE_FORMAT_16BIT_NORM): {}",
        if stand.breite_texturen { "ja" } else { "NEIN — 10 bit wird beim Hochladen gekappt" }
    );
    println!("Codewert-Massstab im Shader: {:.3}", stand.code_massstab());
    println!("\nQuelle je Band (verschiedene Luma-Werte im Messfenster):");
    for (b, name) in BAND_NAMEN.iter().enumerate() {
        println!("  {name:20} {:5}", quell_stufen(&q, b));
    }

    println!(
        "\n{:20}  {:20}  {:>7}  {:>13}  {:>12}",
        "Ausgabe", "Band", "Stufen", "Spaltenmittel", "max. Sprung"
    );
    println!("{}", "-".repeat(80));
    // Zweimal die Einstellung, jeweils ueber alle drei Formate: ohne die
    // „roh"-Zeilen liesse sich die alte Nachrechnung nicht wiederfinden, ohne
    // die „Vorgabe"-Zeilen nicht der echte Player. Der Name entsteht aus dem
    // Format selbst — zweimal geschrieben liefe er beim Tauschen auseinander.
    for (satz, deband, dither) in [("roh", 0.0, false), ("Vorgabe", 0.6, true)] {
        for format in [
            wgpu::TextureFormat::Rgb10a2Unorm,
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba16Float,
        ] {
            let aus = stand.zeichnen(&Lauf::sdr(format, deband, dither))?;
            let name = format!("{:13}{satz}", format!("{format:?}"));
            // Nur die flachen Baender: die Vollverlaeufe spreizen 220 bzw. 877
            // Werte ueber die Breite, dort sagt die Stufenzahl nichts.
            for (b, band) in BAND_NAMEN.iter().enumerate().skip(2) {
                let k = kennzahlen(&aus, b, output_levels(format) - 1.0);
                println!(
                    "{:20}  {:20}  {:7}  {:13}  {:9.2} LSB",
                    if b == 2 { name.as_str() } else { "" },
                    band,
                    k.stufen,
                    k.spaltenmittel,
                    k.max_sprung
                );
                if a.werte {
                    println!("{:44}{:?}", "", k.codes);
                }
            }
        }
    }
    println!(
        "\n„roh\" = ohne Deband und ohne Dither (so rechnete die numpy-Nachpruefung).\n\
         „Vorgabe\" = deband 0.6 + dither an, also so, wie der Player wirklich zeichnet.\n\
         „max. Sprung\" in 10-bit-Stufen: das ist die Groesse einer sichtbaren Kante."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_haben_brauchbare_vorgaben() {
        let a = args_lesen(&["x.yuv".into()]).unwrap();
        assert_eq!((a.breite, a.hoehe, a.bild), (2560, 1440, 50));
        assert_eq!(a.datei, "x.yuv");
    }

    #[test]
    fn args_lesen_die_ueberschreibungen() {
        let argv: Vec<String> =
            ["--breite", "1280", "--hoehe", "720", "--bild", "3", "y.yuv"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        let a = args_lesen(&argv).unwrap();
        assert_eq!((a.breite, a.hoehe, a.bild), (1280, 720, 3));
        assert_eq!(a.datei, "y.yuv");
    }

    /// Ohne Datei darf nicht stillschweigend etwas gemessen werden.
    #[test]
    fn ohne_datei_ist_es_ein_fehler() {
        assert!(args_lesen(&[]).is_err());
        assert!(args_lesen(&["--breite".into(), "8".into()]).is_err());
    }

    /// Eine flache Flaeche hat genau eine Stufe und keinen Sprung — die
    /// Gegenprobe dafuer, dass die Kennzahlen nicht aus dem Rauschen kommen.
    #[test]
    fn flaeche_ohne_verlauf_hat_eine_stufe() {
        let (w, h) = (16usize, 4 * (ROI.end + 10));
        let aus = Ausgabe { punkte: vec![[0.5f32; 3]; w * h], breite: w, hoehe: h };
        let k = kennzahlen(&aus, 3, 1023.0);
        assert_eq!(k.stufen, 1);
        assert_eq!(k.spaltenmittel, 1);
        assert_eq!(k.max_sprung, 0.0);
    }

    /// Ein Verlauf mit N verschiedenen Werten muss auch N melden.
    #[test]
    fn verlauf_wird_vollstaendig_gezaehlt() {
        let (w, h) = (8usize, 4 * (ROI.end + 10));
        let mut werte = vec![[0.0f32; 3]; w * h];
        for y in 0..h {
            for x in 0..w {
                werte[y * w + x] = [x as f32 / 1023.0; 3];
            }
        }
        let k = kennzahlen(&Ausgabe { punkte: werte, breite: w, hoehe: h }, 3, 1023.0);
        assert_eq!(k.stufen, w);
        assert_eq!(k.spaltenmittel, w);
        assert!((k.max_sprung - 1.0).abs() < 1e-3, "eine 10-bit-Stufe: {}", k.max_sprung);
    }
}
