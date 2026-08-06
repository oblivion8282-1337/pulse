//! Was geprueft wird: eine Bildebene, in allen drei Sprachen zugleich.
//!
//! NV12 und P010 werden — wie in der Nachbarprobe belegt — als **zwei
//! getrennte** Bilder gefuehrt: `CUDA_ARRAY3D_DESCRIPTOR` kann strukturell nur
//! ein Format und eine Kanalzahl beschreiben, ein mehrplaniges Einzelbild wird
//! abgewiesen. Getrennte Ebenen sind ohnehin die Form, in der ein Shader sie am
//! liebsten abtastet.
//!
//! Jede Ebene traegt hier **drei** Formatangaben, die zueinander passen
//! muessen: das Vulkan-Format (womit das Bild angelegt wird), das
//! CUDA-Format (womit CUDA es einhaengt) und das wgpu-Format (womit wgpu es
//! uebernimmt). Sie stehen absichtlich beieinander statt an drei Stellen im
//! Programm — ein Auseinanderdriften waere sonst nicht zu sehen.

use std::ffi::c_uint;

use ash::vk;

use crate::cuda;

pub struct Ebene {
    pub name: &'static str,
    pub vk_format: vk::Format,
    pub cu_format: c_uint,
    pub wgpu_format: wgpu::TextureFormat,
    pub kanaele: u32,
    pub breite: u32,
    pub hoehe: u32,
    /// Groesster darstellbarer Codewert (255 bzw. 65535). Der Shader liefert
    /// normierte Gleitkommawerte; ohne diese Zahl liesse sich daraus kein
    /// Codewert zurueckrechnen.
    pub hoechster_code: u32,
}

impl Ebene {
    pub fn bytes_je_texel(&self) -> usize {
        let breite = if self.hoechster_code == 65535 { 2 } else { 1 };
        breite * self.kanaele as usize
    }
    pub fn zeilenbytes(&self) -> usize {
        self.breite as usize * self.bytes_je_texel()
    }
    pub fn bytes(&self) -> usize {
        self.zeilenbytes() * self.hoehe as usize
    }
    pub fn texel(&self) -> usize {
        self.breite as usize * self.hoehe as usize
    }

    /// Der Soll-Codewert eines Texels, aus **denselben** Bytes gerechnet, die
    /// CUDA hineinschreibt.
    ///
    /// Dass Quelldaten und Erwartung aus einer Rechnung kommen, ist keine
    /// Bequemlichkeit: gingen sie auseinander, beschriebe der Vergleich eine
    /// andere Speicherlage als die geschriebene, und die Abweichung saehe nach
    /// einem Treiberbefund aus.
    pub fn soll(&self, x: u32, y: u32, variante: u32) -> (u32, u32) {
        let b = self.bytes_je_texel() / self.kanaele as usize;
        let i = y as usize * self.zeilenbytes() + x as usize * self.bytes_je_texel();
        let wort = |k: usize| -> u32 {
            // Kleinstwertiges Byte zuerst — so legt sowohl der Speicher als
            // auch `R16_UNORM` seinen Wert ab.
            (0..b).map(|n| (muster(i + k * b + n, variante) as u32) << (8 * n)).sum()
        };
        (wort(0), if self.kanaele > 1 { wort(1) } else { 0 })
    }
}

/// Positionsabhaengiges Muster, mit einer **Variante** je Runde.
///
/// Ohne Positionsabhaengigkeit kaeme ein Weg als fehlerfrei durch, der versetzt
/// liest, nur den Anfang trifft oder eine falsche Zeilenlaenge annimmt (genau
/// dieser Fehler ist auf der Windows-Seite aufgetreten).
///
/// Die Variante ist die zweite Absicherung, und sie zielt auf eine Falle, die
/// in diesem Labor schon zugeschlagen hat: **ein Schalter, der stillschweigend
/// nichts tut.** Weil jede Runde ein anderes Muster schreibt, faellt eine
/// Runde, die in Wahrheit gar nichts neu geschrieben hat, zwingend auf — sie
/// traegt dann noch das Muster der Vorrunde. Bei `variante = 0` ist die
/// Rechnung Byte fuer Byte dieselbe wie in der Nachbarprobe, die Zahlen
/// bleiben also vergleichbar.
pub fn muster(i: usize, variante: u32) -> u8 {
    let versatz = (variante as usize).wrapping_mul(4099);
    let i = i.wrapping_add(versatz);
    ((i.wrapping_mul(31).wrapping_add(i >> 8).wrapping_add(7)) & 0xFF) as u8
}

/// Die zwei Ebenen eines NV12- bzw. P010-Bildes.
///
/// Die Farbebene hat halbe Breite und halbe Hoehe (4:2:0) und zwei Kanaele
/// (U und V verschraenkt).
pub fn ebenen(zehn_bit: bool, breite: u32, hoehe: u32) -> Vec<Ebene> {
    if zehn_bit {
        vec![
            Ebene {
                name: "Y (Helligkeit, 10 bit)",
                vk_format: vk::Format::R16_UNORM,
                cu_format: cuda::CU_AD_FORMAT_UNSIGNED_INT16,
                wgpu_format: wgpu::TextureFormat::R16Unorm,
                kanaele: 1,
                breite,
                hoehe,
                hoechster_code: 65535,
            },
            Ebene {
                name: "UV (Farbe, 10 bit, 4:2:0)",
                vk_format: vk::Format::R16G16_UNORM,
                cu_format: cuda::CU_AD_FORMAT_UNSIGNED_INT16,
                wgpu_format: wgpu::TextureFormat::Rg16Unorm,
                kanaele: 2,
                breite: breite / 2,
                hoehe: hoehe / 2,
                hoechster_code: 65535,
            },
        ]
    } else {
        vec![
            Ebene {
                name: "Y (Helligkeit, 8 bit)",
                vk_format: vk::Format::R8_UNORM,
                cu_format: cuda::CU_AD_FORMAT_UNSIGNED_INT8,
                wgpu_format: wgpu::TextureFormat::R8Unorm,
                kanaele: 1,
                breite,
                hoehe,
                hoechster_code: 255,
            },
            Ebene {
                name: "UV (Farbe, 8 bit, 4:2:0)",
                vk_format: vk::Format::R8G8_UNORM,
                cu_format: cuda::CU_AD_FORMAT_UNSIGNED_INT8,
                wgpu_format: wgpu::TextureFormat::Rg8Unorm,
                kanaele: 2,
                breite: breite / 2,
                hoehe: hoehe / 2,
                hoechster_code: 255,
            },
        ]
    }
}
