//! Uniform-Block des Shaders: sechzehn `f32` in genau der Reihenfolge, in der
//! `shader.wgsl` sie erwartet.

/// Groesse des Blocks in Bytes (16 x `f32`).
pub const UNIFORM_BYTES: usize = 64;

/// Bewusst ohne `bytemuck`: der Block ist ein fester Puffer aus `f32`-Werten,
/// den wir von Hand little-endian schreiben. Das spart eine Dependency und
/// kommt ohne `unsafe` aus.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Uniforms {
    pub crop: [f32; 4],
    pub params: [f32; 4],
    pub flags: [f32; 4],
    /// x = Ausgabe erwartet lineare Werte, yzw frei.
    pub output: [f32; 4],
}

impl Uniforms {
    pub fn as_bytes(&self) -> [u8; UNIFORM_BYTES] {
        let mut out = [0u8; UNIFORM_BYTES];
        let values =
            self.crop.iter().chain(&self.params).chain(&self.flags).chain(&self.output);
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
    fn uniforms_serialisieren_als_sechzehn_floats() {
        let u = Uniforms {
            crop: [0.25, 0.5, 0.5, 0.5],
            params: [1.0, 0.0, 1024.0, 2.0],
            flags: [1.0, 0.0, 1.0, 0.0],
            output: [1.0, 0.0, 0.0, 0.0],
        };
        let b = u.as_bytes();
        assert_eq!(b.len(), 64);
        assert_eq!(f32::from_le_bytes(b[0..4].try_into().unwrap()), 0.25);
        assert_eq!(f32::from_le_bytes(b[8..12].try_into().unwrap()), 0.5);
        assert_eq!(f32::from_le_bytes(b[24..28].try_into().unwrap()), 1024.0);
        // Der Linear-Flag muss im letzten vec4 landen, sonst liest der Shader
        // ihn an der Stelle eines Farb-Flags.
        assert_eq!(f32::from_le_bytes(b[48..52].try_into().unwrap()), 1.0);
    }
}
