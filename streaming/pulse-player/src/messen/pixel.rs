//! Rueckgelesene Bildpunkte auspacken — je Ausgabeformat anders.
//!
//! Getrennt von [`super::gpu`], weil es hier nur um Bit-Belegungen geht und
//! nicht um GPU-Ablaeufe: welches Byte traegt Rot, wo sitzen die zehn Bit,
//! wie liest man ein Halbfliesskomma. Einmal falsch herum gelesen, und die
//! Messung zaehlt die Stufen des blauen Kanals — bei einem farblosen Testbild
//! ohne jeden sichtbaren Hinweis.

pub fn bytes_pro_punkt(format: wgpu::TextureFormat) -> u32 {
    // wgpu weiss es selbst — eine eigene Tabelle waere die dritte im Crate und
    // die einzige, die bei einem neuen Format still etwas Falsches liefert.
    format.block_copy_size(None).unwrap_or(4)
}

/// Rot, Gruen und Blau aus dem zurueckgelesenen Puffer, auf 0..1 normiert.
///
/// **Alle drei Kanaele, nicht nur Rot.** Bis zum 2026-08-06 gab es hier nur den
/// roten — das genuegte fuer die Stufenzaehlung an einem farblosen Testbild,
/// beantwortet aber die Frage „bleibt Grau grau?" grundsaetzlich nicht: ein
/// Farbstich ist ein Unterschied ZWISCHEN den Kanaelen und im roten allein
/// unsichtbar.
///
/// **`Rgba16Float` wird NICHT begrenzt.** Werte ueber 1,0 (Spitzlichter) und
/// unter 0,0 (Farben ausserhalb von BT.709) sind auf dem scRGB-Weg der
/// eigentliche Inhalt; wer sie hier kappte, maesse die Begrenzung statt der
/// Rechnung.
pub fn punkte(
    roh: &[u8],
    format: wgpu::TextureFormat,
    breite: usize,
    hoehe: usize,
    zeile: usize,
) -> Vec<[f32; 3]> {
    let bpp = bytes_pro_punkt(format) as usize;
    // Die Formatwahl EINMAL, nicht je Bildpunkt (hier sind es 3,7 Millionen).
    let lies: fn(&[u8]) -> [f32; 3] = match format {
        // Gepackt in ein u32: R in Bit 0..9, G 10..19, B 20..29.
        wgpu::TextureFormat::Rgb10a2Unorm => |p| {
            let v = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
            [0u32, 10, 20].map(|schiebe| ((v >> schiebe) & 0x3FF) as f32 / 1023.0)
        },
        wgpu::TextureFormat::Rgba16Float => {
            |p| [0usize, 2, 4].map(|i| half_to_f32(u16::from_le_bytes([p[i], p[i + 1]])))
        }
        // Bgra8Unorm: B, G, R, A — Rot ist das dritte Byte.
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
            |p| [2usize, 1, 0].map(|i| f32::from(p[i]) / 255.0)
        }
        _ => |p| [0usize, 1, 2].map(|i| f32::from(p[i]) / 255.0),
    };

    let mut out = Vec::with_capacity(breite * hoehe);
    for y in 0..hoehe {
        let row = &roh[y * zeile..y * zeile + breite * bpp];
        out.extend(row.chunks_exact(bpp).map(lies));
    }
    out
}

/// Abstand zweier benachbarter Halbfliesskomma-Zahlen an dieser Stelle.
///
/// **Steht hier und nicht bei der Messung, obwohl nur sie es braucht:** es ist
/// dasselbe Wissen wie in [`half_to_f32`] direkt darunter — zehn Mantissenbits,
/// kleinster normaler Exponent -14. Zwei Stellen, an denen dieselben zwei
/// Zahlen stehen, laufen auseinander; hier deckt sie derselbe Test mit ab.
///
/// Unterhalb des kleinsten normalen Exponenten ist der Abstand konstant
/// (subnormaler Bereich), daher die untere Schranke.
pub fn fp16_stufe(wert: f32) -> f32 {
    (wert.abs().log2().floor().max(-14.0) - 10.0).exp2()
}

/// IEEE-754-Halbfliesskomma nach `f32`. Von Hand statt per Crate: es geht um
/// sechs Zeilen, und `half` waere eine neue direkte Dependency allein fuer den
/// Messpfad. In Arithmetik statt Bitgeschiebe, dann braucht der subnormale
/// Fall keine Normalisierungsschleife.
fn half_to_f32(bits: u16) -> f32 {
    let vorzeichen = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exponent = i32::from((bits >> 10) & 0x1F);
    let mantisse = f32::from(bits & 0x3FF);
    vorzeichen
        * match exponent {
            // Subnormal: kein gesetztes fuehrendes Bit, fester Exponent 2^-14.
            0 => mantisse * 2f32.powi(-24),
            31 if mantisse == 0.0 => f32::INFINITY,
            31 => f32::NAN,
            _ => (1.0 + mantisse / 1024.0) * 2f32.powi(exponent - 15),
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halbfliesskomma_trifft_die_bekannten_werte() {
        assert_eq!(half_to_f32(0x0000), 0.0);
        assert_eq!(half_to_f32(0x3C00), 1.0);
        assert_eq!(half_to_f32(0x3800), 0.5);
        assert_eq!(half_to_f32(0xBC00), -1.0);
        // Groesster Wert unter 1.0 — genau der Bereich, in dem die Ausgabe liegt.
        assert!((half_to_f32(0x3BFF) - 0.99951172).abs() < 1e-6);
        // Kleinster subnormaler Wert: der Zweig ohne fuehrendes Bit.
        assert!((half_to_f32(0x0001) - 5.9604645e-8).abs() < 1e-12);
        assert!(half_to_f32(0x7C00).is_infinite());
        assert!(half_to_f32(0x7C01).is_nan());
    }

    /// Die Stufengroesse muss zu den darstellbaren Zahlen passen: der Abstand
    /// an einer Stelle ist genau die Differenz zweier benachbarter Werte.
    /// Stimmt das nicht, misst die Farbmessung ihre Abweichungen an einem
    /// falschen Massstab — und meldet „unter einer Stufe", wo es zwei sind.
    #[test]
    fn die_stufengroesse_passt_zu_den_darstellbaren_zahlen() {
        // 1.0 (0x3C00) und der naechste Wert darueber (0x3C01).
        let (a, b) = (half_to_f32(0x3C00), half_to_f32(0x3C01));
        assert!((fp16_stufe(a) - (b - a)).abs() < 1e-9, "{}", fp16_stufe(a));
        // Zwei Oktaven hoeher ist die Stufe viermal so gross.
        assert!((fp16_stufe(4.0) - 4.0 * fp16_stufe(1.0)).abs() < 1e-9);
        // Unter dem kleinsten normalen Exponenten bleibt sie stehen.
        assert_eq!(fp16_stufe(0.0), fp16_stufe(1e-9));
    }

    /// Die Kanaele muessen aus der richtigen Stelle kommen: bei `Rgb10a2Unorm`
    /// aus je zehn Bit ab 0/10/20, bei `Bgra8Unorm` in umgekehrter Byte-Folge.
    /// Einmal falsch herum gelesen, und die Messung zaehlte die Stufen des
    /// blauen Kanals — bei einem farblosen Testbild ohne jeden sichtbaren
    /// Hinweis. Fuer die Farbmessung waere es schlimmer: ein vertauschtes
    /// Kanalpaar sieht wie ein Farbstich des Shaders aus.
    #[test]
    fn kanaele_kommen_aus_der_richtigen_stelle() {
        // Rgb10a2: R=100, G=200, B=300
        let v: u32 = 100 | (200 << 10) | (300 << 20);
        let p = punkte(&v.to_le_bytes(), wgpu::TextureFormat::Rgb10a2Unorm, 1, 1, 4);
        for (i, soll) in [100.0, 200.0, 300.0].iter().enumerate() {
            assert!((p[0][i] - soll / 1023.0).abs() < 1e-6, "{p:?}");
        }

        // Bgra8: B=10, G=20, R=30
        let p = punkte(&[10u8, 20, 30, 255], wgpu::TextureFormat::Bgra8Unorm, 1, 1, 4);
        assert_eq!(p[0].map(|v| (v * 255.0).round() as u8), [30, 20, 10]);
    }

    /// **Fliesskomma darf nicht begrenzt werden.** Ein Spitzlicht ueber 1,0 und
    /// eine Farbe unter 0,0 sind auf dem scRGB-Weg der Inhalt, nicht der
    /// Fehler; wer sie hier kappte, maesse die Begrenzung.
    #[test]
    fn fliesskomma_traegt_ueber_eins_und_unter_null() {
        // 8.0 (0x4800), -0.5 (0xB800), 1.0 (0x3C00), Alpha egal.
        let roh = [0x00u8, 0x48, 0x00, 0xB8, 0x00, 0x3C, 0x00, 0x3C];
        let p = punkte(&roh, wgpu::TextureFormat::Rgba16Float, 1, 1, 8);
        assert_eq!(p[0], [8.0, -0.5, 1.0]);
    }

    /// wgpu muss die Punktgroessen liefern, die der Rueckleser annimmt —
    /// stimmt das nicht, verschiebt sich das Bild zeilenweise, ohne Fehler.
    #[test]
    fn punktgroessen_kommen_von_wgpu() {
        assert_eq!(bytes_pro_punkt(wgpu::TextureFormat::Rgb10a2Unorm), 4);
        assert_eq!(bytes_pro_punkt(wgpu::TextureFormat::Bgra8Unorm), 4);
        assert_eq!(bytes_pro_punkt(wgpu::TextureFormat::Rgba16Float), 8);
    }
}
