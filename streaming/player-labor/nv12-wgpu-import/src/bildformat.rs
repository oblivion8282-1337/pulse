//! Welches Bildformat geprueft wird — und was daran haengt.
//!
//! **Der Unterschied zwischen NV12 und P010 ist nicht nur die Bittiefe.** P010
//! legt seine zehn Bit in die OBEREN Bits eines 16-Bit-Wortes, hat andere
//! Ebenen-Formate und haengt an einem eigenen wgpu-Merkmal. Alles davon steht
//! hier beieinander, damit es nicht an fuenf Stellen einzeln entschieden wird —
//! genau die Sorte Streuung, bei der ein Weg spaeter halb umgestellt ist.

use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT, DXGI_FORMAT_NV12, DXGI_FORMAT_P010};

pub const BREITE: u32 = 64;
pub const HOEHE: u32 = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Bildformat {
    Nv12,
    P010,
}

impl Bildformat {
    pub fn name(self) -> &'static str {
        match self {
            Bildformat::Nv12 => "NV12 (8 bit)",
            Bildformat::P010 => "P010 (10 bit)",
        }
    }
    pub fn dxgi(self) -> DXGI_FORMAT {
        match self {
            Bildformat::Nv12 => DXGI_FORMAT_NV12,
            Bildformat::P010 => DXGI_FORMAT_P010,
        }
    }
    pub fn wgpu(self) -> wgpu::TextureFormat {
        match self {
            Bildformat::Nv12 => wgpu::TextureFormat::NV12,
            Bildformat::P010 => wgpu::TextureFormat::P010,
        }
    }
    /// Ebenen-Ansichten: Luma einkanalig, Chroma zweikanalig verschraenkt.
    pub fn ebenen(self) -> (wgpu::TextureFormat, wgpu::TextureFormat) {
        match self {
            Bildformat::Nv12 => (wgpu::TextureFormat::R8Unorm, wgpu::TextureFormat::Rg8Unorm),
            Bildformat::P010 => (wgpu::TextureFormat::R16Unorm, wgpu::TextureFormat::Rg16Unorm),
        }
    }
    /// Alle Merkmale, die dieses Format braucht — **auch die der
    /// Ebenen-Ansichten.**
    ///
    /// Bei P010 sind das zwei: das Format selbst UND `TEXTURE_FORMAT_16BIT_NORM`
    /// fuer `R16Unorm`/`Rg16Unorm`. Ohne das zweite gelingt der Import, und erst
    /// `create_view` scheitert — mitten in Stufe 3, mit einer Meldung ueber
    /// Merkmale statt ueber den Import. Genau die Sorte Fehlschlag, die man
    /// zuerst dem geteilten Speicher anlastet.
    pub fn merkmal(self) -> wgpu::Features {
        match self {
            Bildformat::Nv12 => wgpu::Features::TEXTURE_FORMAT_NV12,
            Bildformat::P010 => {
                wgpu::Features::TEXTURE_FORMAT_P010 | wgpu::Features::TEXTURE_FORMAT_16BIT_NORM
            }
        }
    }
    /// Byte je Abtastwert im Speicher — 1 bei NV12, 2 bei P010.
    pub fn bytes(self) -> usize {
        match self {
            Bildformat::Nv12 => 1,
            Bildformat::P010 => 2,
        }
    }
    pub fn hoechster_code(self) -> u32 {
        match self {
            Bildformat::Nv12 => 255,
            Bildformat::P010 => 1023,
        }
    }
    /// Wie ein Codewert im Speicher steht.
    ///
    /// **P010 schiebt um sechs Bit nach oben.** Wer das vergisst, schreibt ein
    /// um Faktor 64 zu dunkles Bild und sieht es dem Ergebnis nicht an — es ist
    /// dann nur „fast schwarz" statt schwarz.
    pub fn gespeichert(self, code: u32) -> u16 {
        match self {
            Bildformat::Nv12 => code as u16,
            Bildformat::P010 => (code << 6) as u16,
        }
    }
    /// Was der Sampler daraus macht, normiert auf [0,1] — der Sollwert, gegen
    /// den Stufe 4 prueft. Beide Ebenen-Formate sind `*Unorm`, der Wert ist
    /// also der gespeicherte geteilt durch den Hoechstwert des SPEICHERWORTES,
    /// nicht durch den des Codes.
    pub fn abtastwert(self, code: u32) -> f64 {
        match self {
            Bildformat::Nv12 => code as f64 / 255.0,
            Bildformat::P010 => self.gespeichert(code) as f64 / 65535.0,
        }
    }
}

/// Was in die Textur geschrieben wird — und wogegen spaeter geprueft wird.
///
/// Luma laeuft als Rampe ueber die Zeile, Chroma steht fest. Eine Rampe deckt
/// Zeilenabstands-Fehler auf (bei falschem Abstand verrutscht sie sichtbar),
/// zwei verschiedene feste Chroma-Werte decken vertauschte U/V-Kanaele auf —
/// mit 128/128 waere beides unsichtbar geblieben.
///
/// **`schicht` geht mit ein, und das ist der Zweck der Stapel-Pruefung.**
/// Jede Schicht traegt ein anderes Bild; ein Weg, der immer Schicht 0 liest
/// oder den Abstand zwischen den Schichten falsch berechnet, faellt damit auf.
///
/// **Bei 10 Bit tragen die unteren zwei Bit eine eigene Stufe.** Ohne das
/// bestuenden alle Werte aus Vielfachen von vier, und ein Weg, der still auf
/// 8 Bit kappt, kaeme als fehlerfrei durch — also genau der Fehler, um den es
/// bei 10 Bit geht.
pub fn luma_code(f: Bildformat, x: u32, y: u32, schicht: u32) -> u32 {
    let acht = (x * 4 + y + schicht * 37) % 256;
    match f {
        Bildformat::Nv12 => acht,
        Bildformat::P010 => acht * 4 + (x + y) % 4,
    }
}

/// Feste Chroma-Werte. Bei 10 Bit bewusst UNGERADE Vielfache gewaehlt (257 und
/// 771 statt 256 und 768) — dieselbe Ueberlegung wie bei der Luma-Rampe: ein
/// Weg, der auf 8 Bit kappt, liefert dann sichtbar etwas anderes.
pub fn chroma_codes(f: Bildformat) -> (u32, u32) {
    match f {
        Bildformat::Nv12 => (64, 192),
        Bildformat::P010 => (257, 771),
    }
}
