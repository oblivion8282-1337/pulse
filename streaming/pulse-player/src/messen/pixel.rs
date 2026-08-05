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

/// Die rote Komponente aus dem zurueckgelesenen Puffer, auf 0..1 normiert.
pub fn rot_kanal(
    roh: &[u8],
    format: wgpu::TextureFormat,
    breite: usize,
    hoehe: usize,
    zeile: usize,
) -> Vec<f32> {
    let bpp = bytes_pro_punkt(format) as usize;
    // Die Formatwahl EINMAL, nicht je Bildpunkt (hier sind es 3,7 Millionen).
    let lies: fn(&[u8]) -> f32 = match format {
        // Gepackt in ein u32: R in Bit 0..9, G 10..19, B 20..29.
        wgpu::TextureFormat::Rgb10a2Unorm => |p| {
            (u32::from_le_bytes([p[0], p[1], p[2], p[3]]) & 0x3FF) as f32 / 1023.0
        },
        wgpu::TextureFormat::Rgba16Float => |p| half_to_f32(u16::from_le_bytes([p[0], p[1]])),
        // Bgra8Unorm: B, G, R, A — Rot ist das dritte Byte.
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
            |p| f32::from(p[2]) / 255.0
        }
        _ => |p| f32::from(p[0]) / 255.0,
    };

    let mut out = Vec::with_capacity(breite * hoehe);
    for y in 0..hoehe {
        let row = &roh[y * zeile..y * zeile + breite * bpp];
        out.extend(row.chunks_exact(bpp).map(lies));
    }
    out
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

    /// Rot muss aus der richtigen Stelle kommen: bei `Rgb10a2Unorm` aus den
    /// UNTEREN zehn Bit, bei `Bgra8Unorm` aus dem DRITTEN Byte. Beides einmal
    /// falsch herum gelesen, und die Messung zaehlte die Stufen des blauen
    /// Kanals — bei einem farblosen Testbild ohne jeden sichtbaren Hinweis.
    #[test]
    fn rot_kommt_aus_der_richtigen_stelle() {
        // Rgb10a2: R=100, G=200, B=300
        let v: u32 = 100 | (200 << 10) | (300 << 20);
        let roh = v.to_le_bytes();
        let r = rot_kanal(&roh, wgpu::TextureFormat::Rgb10a2Unorm, 1, 1, 4);
        assert!((r[0] - 100.0 / 1023.0).abs() < 1e-6, "{r:?}");

        // Bgra8: B=10, G=20, R=30
        let roh = [10u8, 20, 30, 255];
        let r = rot_kanal(&roh, wgpu::TextureFormat::Bgra8Unorm, 1, 1, 4);
        assert!((r[0] - 30.0 / 255.0).abs() < 1e-6, "{r:?}");
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
