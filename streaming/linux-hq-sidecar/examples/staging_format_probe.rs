//! Prüft den 10-bit-Pfad des NVENC-Importers gegen echte Hardware: dass die
//! Ebenen bei CUDA registrierbar sind, dass die Farbmathematik stimmt und dass
//! die 10 Bit in den OBEREN Bits der 16-bit-Wörter liegen (P010).
//!
//! Das ist nicht aus der Doku ableitbar und sonst nur am laufenden Stream mit
//! dem Auge prüfbar — und genau diese Fehlerklasse (Rot/Blau getauscht, Bild um
//! Faktor 64 zu dunkel) hat in diesem Projekt schon zweimal zugeschlagen.
//!
//! `cargo run --release --example staging_format_probe`

use pulse_linux_hq_sidecar::encode::nv_import::{NvDmabufImporter, StagingFormat};

/// 4×2 Blöcke à 2×2 Bildpunkte — jeder Block einfarbig, damit das
/// 2×2-Chroma-Mittel eindeutig der Blockfarbe entspricht.
const BLOCKS_X: u32 = 4;
const BLOCKS_Y: u32 = 2;
const W: u32 = BLOCKS_X * 2;
const H: u32 = BLOCKS_Y * 2;

/// Farben, die eine Kanal-Verwechslung nicht überlebt: reine Primärfarben
/// (die Luma-Gewichte 0.2126/0.7152/0.0722 liegen weit auseinander) plus
/// Grautöne als Gegenprobe.
const COLORS: [[u8; 3]; (BLOCKS_X * BLOCKS_Y) as usize] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
    [0, 0, 0],
    [128, 128, 128],
    [200, 100, 50],
    [17, 34, 51],
];

/// Unabhängige Nachrechnung der Erwartung: BT.709, begrenzter Wertebereich,
/// 10 bit. Absichtlich hier ausgeschrieben und nicht aus dem Shader übernommen
/// — sonst prüfte der Test seine eigene Annahme.
fn expected(c: [u8; 3]) -> (i32, i32, i32) {
    let (r, g, b) = (c[0] as f64 / 255.0, c[1] as f64 / 255.0, c[2] as f64 / 255.0);
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let cb = (b - y) / 1.8556;
    let cr = (r - y) / 1.5748;
    (
        (y * 876.0 + 64.0).round() as i32,
        (cb * 896.0 + 512.0).round() as i32,
        (cr * 896.0 + 512.0).round() as i32,
    )
}

/// Unabhängige Nachrechnung der Erwartung für den gepackten RGB10-Pfad:
/// der Blit skaliert 8→10 bit (255 → 1023, NVENC macht die YUV-Wandlung
/// erst danach — hier nicht Teil der Prüfung).
fn expected_rgb10(c: [u8; 3]) -> (i32, i32, i32) {
    (
        (c[0] as f64 * 1023.0 / 255.0).round() as i32,
        (c[1] as f64 * 1023.0 / 255.0).round() as i32,
        (c[2] as f64 * 1023.0 / 255.0).round() as i32,
    )
}

/// 16-bit-Wort → 10-bit-Code. `None`, wenn die unteren 6 Bit nicht null sind:
/// dann liegen die Daten nicht wie von P010 gefordert oben.
fn code(word: u16) -> Option<i32> {
    (word & 0x3F == 0).then_some((word >> 6) as i32)
}

fn word_at(plane: &[u8], row_bytes: u32, x: u32, y: u32, comp: u32, comps: u32) -> u16 {
    let i = (y * row_bytes + (x * comps + comp) * 2) as usize;
    u16::from_le_bytes([plane[i], plane[i + 1]])
}

fn main() {
    for (label, fmt) in [
        ("RGBA8 (8 bit, Textur direkt bei CUDA)", StagingFormat::Rgba8),
        ("R16 + RG16 (P010-Ebenen)", StagingFormat::P010),
        ("GL_RGB10_A2 + PBO (x2bgr10le gepackt)", StagingFormat::Rgb10),
    ] {
        match NvDmabufImporter::new(W, H, fmt) {
            Ok(_) => println!("{label}: angelegt + bei CUDA registriert"),
            Err(e) => println!("{label}: FEHLER — {e:#}"),
        }
    }

    let mut imp = match NvDmabufImporter::new(W, H, StagingFormat::P010) {
        Ok(i) => i,
        Err(e) => {
            println!("Farbmathematik nicht prüfbar: {e:#}");
            std::process::exit(1);
        }
    };

    // Testbild: Block (bx,by) trägt COLORS[by*BLOCKS_X + bx].
    let mut rgba = vec![0u8; (W * H * 4) as usize];
    for y in 0..H {
        for x in 0..W {
            let c = COLORS[((y / 2) * BLOCKS_X + x / 2) as usize];
            let i = ((y * W + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
        }
    }

    let (luma, chroma) = match imp.selftest_p010(&rgba) {
        Ok(v) => v,
        Err(e) => {
            println!("selftest_p010: FEHLER — {e:#}");
            std::process::exit(1);
        }
    };

    let mut fehler = 0;
    // Luma je Bildpunkt.
    for y in 0..H {
        for x in 0..W {
            let c = COLORS[((y / 2) * BLOCKS_X + x / 2) as usize];
            let want = expected(c).0;
            match code(word_at(&luma, W * 2, x, y, 0, 1)) {
                None => {
                    fehler += 1;
                    println!("  Luma ({x},{y}): untere 6 Bit nicht null — keine P010-Bit-Lage");
                }
                // ±1: Rundung an .5-Grenzen darf abweichen, mehr nicht.
                Some(got) if (got - want).abs() > 1 => {
                    fehler += 1;
                    println!("  Luma ({x},{y}) rgb{c:?}: {got}, erwartet {want}");
                }
                Some(_) => {}
            }
        }
    }
    // Chroma je 2×2-Block.
    for by in 0..BLOCKS_Y {
        for bx in 0..BLOCKS_X {
            let c = COLORS[(by * BLOCKS_X + bx) as usize];
            let (_, want_cb, want_cr) = expected(c);
            let row = BLOCKS_X * 4;
            for (comp, want, name) in [(0, want_cb, "Cb"), (1, want_cr, "Cr")] {
                match code(word_at(&chroma, row, bx, by, comp, 2)) {
                    None => {
                        fehler += 1;
                        println!("  {name} ({bx},{by}): untere 6 Bit nicht null");
                    }
                    Some(got) if (got - want).abs() > 1 => {
                        fehler += 1;
                        println!("  {name} ({bx},{by}) rgb{c:?}: {got}, erwartet {want}");
                    }
                    Some(_) => {}
                }
            }
        }
    }

    // ── Rgb10: gepackte 10-bit-Wörter (x2bgr10le) gegen die Nachrechnung. ──
    let mut imp10 = match NvDmabufImporter::new(W, H, StagingFormat::Rgb10) {
        Ok(i) => i,
        Err(e) => {
            println!("Rgb10 nicht anlegbar: {e:#}");
            std::process::exit(1);
        }
    };
    let packed = match imp10.selftest_rgb10(&rgba) {
        Ok(v) => v,
        Err(e) => {
            println!("selftest_rgb10: FEHLER — {e:#}");
            std::process::exit(1);
        }
    };
    for y in 0..H {
        for x in 0..W {
            let c = COLORS[((y / 2) * BLOCKS_X + x / 2) as usize];
            let i = ((y * W + x) * 4) as usize;
            let word = u32::from_le_bytes([
                packed[i],
                packed[i + 1],
                packed[i + 2],
                packed[i + 3],
            ]);
            let (want_r, want_g, want_b) = expected_rgb10(c);
            // Bits 30–31 tragen den Alphakanal der Quelle (XRGB-Capture hat
            // dort undefinierte Werte) — x2bgr10le definiert sie als unbenutzt
            // und NVENC ignoriert sie beim 4:2:0-Encoding. Maskiert raus.
            let word = word & 0x3FFF_FFFF;
            let got_r = (word & 0x3FF) as i32;
            let got_g = ((word >> 10) & 0x3FF) as i32;
            let got_b = ((word >> 20) & 0x3FF) as i32;
            // ±1 erlaubt Rundung.
            for (name, got, want) in
                [("R", got_r, want_r), ("G", got_g, want_g), ("B", got_b, want_b)]
            {
                if (got - want).abs() > 1 {
                    fehler += 1;
                    println!("  {name} ({x},{y}) rgb{c:?}: {got}, erwartet {want}");
                }
            }
        }
    }

    if fehler == 0 {
        println!(
            "Farbmathematik + Bit-Lage: OK — P010 (BT.709 begrenzt, 10 Bit oben) und Rgb10 (gepackt 8→10 skaliert) ({} Werte geprüft)",
            W * H + BLOCKS_X * BLOCKS_Y * 2
        );
    } else {
        println!("{fehler} Abweichungen — der 10-bit-Pfad wandelt FALSCH");
        std::process::exit(1);
    }
}
