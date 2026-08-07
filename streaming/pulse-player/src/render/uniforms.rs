//! Uniform-Block des Shaders: zwanzig `f32` in genau der Reihenfolge, in der
//! `shader.wgsl` sie erwartet.

/// Groesse des Blocks in Bytes (20 x `f32`).
pub const UNIFORM_BYTES: usize = 80;

/// Bewusst ohne `bytemuck`: der Block ist ein fester Puffer aus `f32`-Werten,
/// den wir von Hand little-endian schreiben. Das spart eine Dependency und
/// kommt ohne `unsafe` aus.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Uniforms {
    pub crop: [f32; 4],
    pub params: [f32; 4],
    pub flags: [f32; 4],
    /// x = Ausgabe erwartet lineare Werte, y = Matrix-Kennzahl (0 = BT.709,
    /// 1 = BT.601, 2 = BT.2020 NCL), z = Codewert-Massstab
    /// (s. [`crate::render::farbe::scales`]), w frei.
    ///
    /// **`y` war frueher ein Ja/Nein („BT.601?")**. Dass 0 weiter BT.709 und 1
    /// weiter BT.601 heisst, ist kein Zufall, sondern die Bedingung dafuer,
    /// dass die Umstellung auf drei Matrizen nichts an den beiden alten
    /// Faellen aendert.
    pub output: [f32; 4],
    /// Alles, was nur HDR betrifft — und zwar so, dass ein SDR-Strom auf einem
    /// SDR-Schirm exakt den bisherigen Weg nimmt (`x = 0`, `y = 0`).
    ///
    /// * `x` — Transferkurve der QUELLE: 0 = SDR-artig, 1 = PQ.
    /// * `y` — Betriebsart der AUSGABE: 0 = SDR-Fenster (herunterrechnen),
    ///   1 = HDR-Fenster (scRGB, lineares Licht, 1,0 = 80 cd/m²).
    /// * `z` — Spitzenhelligkeit des Inhalts in cd/m². Sagt beim
    ///   Herunterrechnen, wo die Kurve enden muss.
    /// * `w` — frei.
    pub hdr: [f32; 4],
}

impl Uniforms {
    pub fn as_bytes(&self) -> [u8; UNIFORM_BYTES] {
        let mut out = [0u8; UNIFORM_BYTES];
        let values = self
            .crop
            .iter()
            .chain(&self.params)
            .chain(&self.flags)
            .chain(&self.output)
            .chain(&self.hdr);
        for (slot, value) in out.chunks_exact_mut(4).zip(values) {
            slot.copy_from_slice(&value.to_le_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uniforms_serialisieren_als_zwanzig_floats() {
        let u = Uniforms {
            crop: [0.25, 0.5, 0.5, 0.5],
            params: [1.0, 0.0, 1024.0, 2.0],
            flags: [1.0, 0.0, 1.0, 0.0],
            output: [1.0, 0.0, 0.0, 0.0],
            hdr: [1.0, 1.0, 1000.0, 0.0],
        };
        let b = u.as_bytes();
        assert_eq!(b.len(), 80);
        assert_eq!(f32::from_le_bytes(b[0..4].try_into().unwrap()), 0.25);
        assert_eq!(f32::from_le_bytes(b[8..12].try_into().unwrap()), 0.5);
        assert_eq!(f32::from_le_bytes(b[24..28].try_into().unwrap()), 1024.0);
        // Der Linear-Flag muss im VIERTEN vec4 landen, sonst liest der Shader
        // ihn an der Stelle eines Farb-Flags.
        assert_eq!(f32::from_le_bytes(b[48..52].try_into().unwrap()), 1.0);
        // Und der HDR-Block dahinter: Spitzenhelligkeit an dritter Stelle des
        // fuenften vec4. Ein Versatz hier faellt am Bild NICHT auf — er
        // verschoebe nur die Helligkeitskurve, und die kennt niemand auswendig.
        assert_eq!(f32::from_le_bytes(b[72..76].try_into().unwrap()), 1000.0);
    }
}
