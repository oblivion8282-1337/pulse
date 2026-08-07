//! Eine Bildebene in allen drei Sprachen zugleich — Vulkan, CUDA, wgpu.
//!
//! **Die Formatangaben stehen absichtlich beieinander** statt an drei Stellen
//! im Programm: das Vulkan-Format (womit das Bild angelegt wird), das
//! CUDA-Format (womit CUDA es einhaengt) und das wgpu-Format (womit wgpu es
//! uebernimmt) muessen zueinander passen, und ein Auseinanderdriften waere
//! sonst nicht zu sehen — es zeigte sich als verschobene Farben, nicht als
//! Fehler. Die Tests unten sind die einzige Stelle, die es bemerken kann.

use super::cuda;

/// Eine Bildebene mit allem, was die drei Schnittstellen ueber sie wissen
/// muessen.
#[derive(Clone, Copy)]
pub(super) struct Ebene {
    pub vk_format: ash::vk::Format,
    pub cu_format: std::ffi::c_uint,
    pub kanaele: u32,
    pub breite: u32,
    pub hoehe: u32,
    pub bytes_je_texel: usize,
}

impl Ebene {
    pub fn zeilenbytes(self) -> usize {
        self.breite as usize * self.bytes_je_texel
    }
}

/// Die zwei Ebenen eines NV12- bzw. P010-Bildes.
///
/// Die Farbebene hat halbe Breite und halbe Hoehe (4:2:0) und zwei Kanaele
/// (U und V verschraenkt). **Aufgerundet, nicht abgerundet**: bei ungerader
/// Bildgroesse waere die abgerundete Ebene zu klein, und die Kopie schnitte die
/// letzte Zeile ab.
pub(super) fn ebenen(zehn_bit: bool, breite: u32, hoehe: u32) -> [Ebene; 2] {
    use ash::vk::Format;
    let (y_fmt, uv_fmt, cu, tiefe) = if zehn_bit {
        (Format::R16_UNORM, Format::R16G16_UNORM, cuda::CU_AD_FORMAT_UNSIGNED_INT16, 2usize)
    } else {
        (Format::R8_UNORM, Format::R8G8_UNORM, cuda::CU_AD_FORMAT_UNSIGNED_INT8, 1usize)
    };
    [
        Ebene {
            vk_format: y_fmt,
            cu_format: cu,
            kanaele: 1,
            breite,
            hoehe,
            bytes_je_texel: tiefe,
        },
        Ebene {
            vk_format: uv_fmt,
            cu_format: cu,
            kanaele: 2,
            breite: breite.div_ceil(2),
            hoehe: hoehe.div_ceil(2),
            bytes_je_texel: tiefe * 2,
        },
    ]
}

/// Das Format der wgpu-Ansicht einer Ebene.
///
/// **Muss zu `render::farbe::ebenenformate` passen** — dort rechnet `scales`
/// mit genau dieser Zuordnung, deshalb wird es von dort geholt statt hier ein
/// zweites Mal hingeschrieben. Der Renderer bekommt es nicht von hier, sondern
/// gebuendelt aus `GpuBild::ebenen`.
pub(super) fn wgpu_ebenenformate(
    zehn_bit: bool,
) -> (wgpu::TextureFormat, wgpu::TextureFormat) {
    crate::render::farbe::ebenenformate(zehn_bit, crate::decode::PixelLayout::BiPlanar420)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ash::vk;

    /// Die Farbebene muss **aufgerundet** halbiert werden. Bei ungerader
    /// Bildgroesse waere die abgerundete Ebene zu klein, die Kopie schnitte die
    /// letzte Zeile ab, und im Bild saehe man einen Farbstreifen am Rand — kein
    /// Fehler, nur ein falsches Bild.
    #[test]
    fn die_farbebene_wird_aufgerundet_halbiert() {
        let [_, uv] = ebenen(false, 1921, 1081);
        assert_eq!((uv.breite, uv.hoehe), (961, 541));
    }

    /// Die drei Formatangaben je Ebene muessen zusammenpassen: 10 bit fuehrt
    /// zwei Byte je Kanal, 8 bit eines. Laufen sie auseinander, rechnet
    /// `zeilenbytes` eine Kopierbreite aus, die nicht zum angelegten Bild passt.
    #[test]
    fn die_bittiefe_bestimmt_alle_drei_formatangaben() {
        let [y8, uv8] = ebenen(false, 64, 64);
        assert_eq!(y8.vk_format, vk::Format::R8_UNORM);
        assert_eq!(y8.cu_format, cuda::CU_AD_FORMAT_UNSIGNED_INT8);
        assert_eq!(y8.zeilenbytes(), 64);
        assert_eq!(uv8.zeilenbytes(), 64);

        let [y10, uv10] = ebenen(true, 64, 64);
        assert_eq!(y10.vk_format, vk::Format::R16_UNORM);
        assert_eq!(y10.cu_format, cuda::CU_AD_FORMAT_UNSIGNED_INT16);
        assert_eq!(y10.zeilenbytes(), 128);
        assert_eq!(uv10.zeilenbytes(), 128);
    }

    /// Die Ebenen-Formate der Bruecke und die des Renderers muessen dieselben
    /// sein. **Sie stehen in zwei Dateien**, und eine Abweichung saehe man
    /// nicht als Fehler, sondern als falsche Farben.
    #[test]
    fn die_wgpu_formate_passen_zur_bittiefe() {
        assert_eq!(
            wgpu_ebenenformate(false),
            (wgpu::TextureFormat::R8Unorm, wgpu::TextureFormat::Rg8Unorm)
        );
        assert_eq!(
            wgpu_ebenenformate(true),
            (wgpu::TextureFormat::R16Unorm, wgpu::TextureFormat::Rg16Unorm)
        );
    }
}
