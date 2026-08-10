//! Was `av_hwframe_map` herausgibt — geprueft statt geglaubt.
//!
//! Der `AVDRMFrameDescriptor` ist eine offene Form: bis zu vier Objekte, bis zu
//! vier Layer, je bis zu vier Planes. Die Bruecke traegt davon **genau eine**
//! Gestalt, und zwar nicht aus Bequemlichkeit, sondern weil der fertige Helfer
//! aus wgpu-hal 30 (`texture_from_dmabuf_fd`, `vulkan/device.rs:525`) es so
//! verlangt: „Currently only supports single-plane DMA-bufs". Ein Layer mit
//! zwei Planes (Kompressions-Metadaten) braeuchte ein eigenes `VkImage` mit
//! `VkImageDrmFormatModifierExplicitCreateInfoEXT` — also den Aufwand der
//! CUDA-Bruecke.
//!
//! Auf der Messkarte (Radeon 780M, Mesa 26.1.5) ist die Gestalt **1 Objekt,
//! 2 Layer, je 1 Plane**, stabil ueber alle Bilder und ueber alle drei
//! Codec-Faelle (`profiles/player-2026-08-10-vaapi-dmabuf-export.json`). Was
//! davon abweicht, wird hier abgewiesen und nicht zurechtgebogen — ein falsch
//! gedeuteter Deskriptor faellt sonst als verschobenes Bild auf, nicht als
//! Fehler.
//!
//! **Die Pruefung arbeitet auf einer eigenen, einfachen Form** ([`RohGestalt`])
//! und nicht auf dem FFmpeg-Verbund. Der Grund ist die Pruefbarkeit: so laesst
//! sich jede abweichende Gestalt im Test hinschreiben, ohne eine GPU, einen
//! Decoder und ein Video zu brauchen.

use anyhow::{bail, Result};

/// Ein DRM-Objekt: der Dateideskriptor und der Modifier, unter dem sein Inhalt
/// zu deuten ist.
#[derive(Clone, Copy, Debug)]
pub(super) struct RohObjekt {
    pub fd: i32,
    pub modifier: u64,
}

/// Die erste (und einzig zulaessige) Plane eines Layers.
#[derive(Clone, Copy, Debug)]
pub(super) struct RohPlane {
    pub objekt: usize,
    pub offset: u64,
    pub pitch: u64,
}

/// Ein Layer: sein Fourcc, wie viele Planes er WIRKLICH hat und die erste.
///
/// **Die Zahl steht getrennt neben der Plane**, obwohl nur die erste mitkommt:
/// sonst liesse sich „hat zwei Planes" gar nicht mehr ausdruecken, und genau
/// das ist der Fall, der abgewiesen werden muss.
#[derive(Clone, Copy, Debug)]
pub(super) struct RohLayer {
    pub fourcc: u32,
    pub planes: usize,
    pub erste: RohPlane,
}

/// Der Deskriptor, auf das Noetige eingedampft.
pub(super) struct RohGestalt {
    pub objekte: Vec<RohObjekt>,
    pub layer: Vec<RohLayer>,
}

/// Eine Bildebene, fertig zum Einhaengen.
///
/// `fd` gehoert weiterhin dem abgebildeten `AVFrame`; wer eine Textur daraus
/// baut, dupliziert ihn (s. [`super::anker`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Ebene {
    pub fd: i32,
    pub modifier: u64,
    pub format: wgpu::TextureFormat,
    pub offset: u64,
    pub pitch: u64,
    pub breite: u32,
    pub hoehe: u32,
}

/// Beide Ebenen eines Bildes plus seine Bittiefe.
pub(super) struct Gestalt {
    pub ebenen: [Ebene; 2],
    pub zehn_bit: bool,
}

/// Fourcc als Zahl, so wie DRM sie fuehrt (vier Zeichen, kleinstes Byte zuerst).
const fn fourcc(z: &[u8; 4]) -> u32 {
    u32::from_le_bytes(*z)
}

const R8: u32 = fourcc(b"R8  ");
const GR88: u32 = fourcc(b"GR88");
const R16: u32 = fourcc(b"R16 ");
/// GR32 = zwei 16-bit-Kanaele, also 32 bit je Punktpaar. Der Name traegt die
/// Gesamtbreite, nicht die je Kanal — anders als bei `GR88`.
const GR32: u32 = fourcc(b"GR32");

/// Fourcc → wgpu-Format. Bewusst eine Tabelle mit genau den vier Faellen, die
/// wirklich vorkommen: ein unbekanntes Format soll auffallen und nicht auf ein
/// plausibles geraten werden.
pub(super) fn format_aus_fourcc(f: u32) -> Option<wgpu::TextureFormat> {
    match f {
        R8 => Some(wgpu::TextureFormat::R8Unorm),
        GR88 => Some(wgpu::TextureFormat::Rg8Unorm),
        R16 => Some(wgpu::TextureFormat::R16Unorm),
        GR32 => Some(wgpu::TextureFormat::Rg16Unorm),
        _ => None,
    }
}

/// Vier Zeichen zum Anzeigen — ein Fourcc als Zahl sagt in einer Fehlermeldung
/// niemandem etwas.
fn lesbar(f: u32) -> String {
    f.to_le_bytes()
        .iter()
        .map(|&c| if (0x20..0x7f).contains(&c) { c as char } else { '?' })
        .collect()
}

/// Das **Paar** deuten, nicht jeden Layer fuer sich: 8 bit heisst R8 + GR88,
/// 10 bit R16 + GR32. Ein gemischtes Paar (R8 + GR32) waere keine Bittiefe,
/// sondern ein Missverstaendnis — und der Shader tastet danach mit der
/// falschen Skalierung ab.
fn zehn_bit_aus_paar(l0: u32, l1: u32) -> Option<bool> {
    match (l0, l1) {
        (R8, GR88) => Some(false),
        (R16, GR32) => Some(true),
        _ => None,
    }
}

/// Den Deskriptor pruefen und in zwei einhaengbare Ebenen uebersetzen.
///
/// `breite`/`hoehe` sind die Masse des dekodierten Bildes; die Farbebene ist
/// halb so gross, **aufgerundet** — bei ungerader Bildgroesse waere die
/// abgerundete Ebene zu klein und der Shader taste ueber ihren Rand hinaus
/// (dieselbe Regel wie in `zerocopy::linux::ebene`).
pub(super) fn pruefen(roh: &RohGestalt, breite: u32, hoehe: u32) -> Result<Gestalt> {
    if breite == 0 || hoehe == 0 {
        bail!("Bild ohne Masse");
    }
    if roh.layer.len() != 2 {
        bail!(
            "{} Layer statt zwei — erwartet sind Luma und Chroma getrennt \
             (VA_EXPORT_SURFACE_SEPARATE_LAYERS)",
            roh.layer.len()
        );
    }
    for (i, l) in roh.layer.iter().enumerate() {
        if l.planes != 1 {
            bail!(
                "Layer {i} hat {} Planes — der wgpu-Helfer traegt nur einplanige \
                 (mehrplanig braeuchte ein eigenes VkImage)",
                l.planes
            );
        }
    }
    let zehn_bit = zehn_bit_aus_paar(roh.layer[0].fourcc, roh.layer[1].fourcc).ok_or_else(|| {
        anyhow::anyhow!(
            "Formatpaar {}/{} ist weder 8 bit (R8/GR88) noch 10 bit (R16/GR32)",
            lesbar(roh.layer[0].fourcc),
            lesbar(roh.layer[1].fourcc)
        )
    })?;
    // **Das Format nimmt jede Ebene aus IHREM Fourcc**, nicht aus der Bittiefe:
    // was eingehaengt wird, muss beschreiben, was der Deskriptor sagt. Dass
    // diese Tabelle dasselbe meint wie `render::farbe::ebenenformate` — womit
    // der Shader abtastet und `scales` rechnet —, haelt der Test unten fest;
    // ein Auseinanderlaufen saehe man sonst als falsche Farben, nicht als
    // Fehler.
    let masse = [(breite, hoehe), (breite.div_ceil(2), hoehe.div_ceil(2))];
    let mut ebenen = Vec::with_capacity(2);
    for (i, l) in roh.layer.iter().enumerate() {
        let objekt = roh.objekte.get(l.erste.objekt).ok_or_else(|| {
            anyhow::anyhow!(
                "Layer {i} zeigt auf Objekt {}, es gibt aber nur {}",
                l.erste.objekt,
                roh.objekte.len()
            )
        })?;
        if l.erste.pitch == 0 {
            bail!("Layer {i} ohne Zeilenabstand");
        }
        let format = format_aus_fourcc(l.fourcc)
            .ok_or_else(|| anyhow::anyhow!("unbekanntes Fourcc {}", lesbar(l.fourcc)))?;
        ebenen.push(Ebene {
            fd: objekt.fd,
            modifier: objekt.modifier,
            format,
            offset: l.erste.offset,
            pitch: l.erste.pitch,
            breite: masse[i].0,
            hoehe: masse[i].1,
        });
    }
    Ok(Gestalt { ebenen: [ebenen[0], ebenen[1]], zehn_bit })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::PixelLayout;

    fn layer(fourcc: u32, planes: usize, offset: u64) -> RohLayer {
        RohLayer { fourcc, planes, erste: RohPlane { objekt: 0, offset, pitch: 2048 } }
    }

    /// Die Gestalt der Messung: EIN Objekt, zwei Layer, je eine Plane, das
    /// Chroma mit Versatz. Genau so kommt es von der Karte
    /// (`player-2026-08-10-vaapi-dmabuf-export.json`).
    fn amd_8bit() -> RohGestalt {
        RohGestalt {
            objekte: vec![RohObjekt { fd: 7, modifier: 0x0200_0000_1040_1b04 }],
            layer: vec![layer(R8, 1, 0), layer(GR88, 1, 2_621_440)],
        }
    }

    #[test]
    fn die_gemessene_gestalt_wird_angenommen() {
        let g = pruefen(&amd_8bit(), 1920, 1080).expect("gemessene Gestalt muss tragen");
        assert!(!g.zehn_bit);
        assert_eq!(g.ebenen[0].format, wgpu::TextureFormat::R8Unorm);
        assert_eq!(g.ebenen[1].format, wgpu::TextureFormat::Rg8Unorm);
        assert_eq!((g.ebenen[0].breite, g.ebenen[0].hoehe), (1920, 1080));
        // Die Farbebene ist halb so gross und traegt den Versatz mit — an ihm
        // haengt, ob das Chroma an der richtigen Stelle im Objekt gelesen wird.
        assert_eq!((g.ebenen[1].breite, g.ebenen[1].hoehe), (960, 540));
        assert_eq!(g.ebenen[1].offset, 2_621_440);
        // Beide Ebenen teilen ein Objekt, also denselben fd und Modifier.
        assert_eq!(g.ebenen[0].fd, g.ebenen[1].fd);
        assert_eq!(g.ebenen[0].modifier, 0x0200_0000_1040_1b04);
    }

    #[test]
    fn zehn_bit_wird_am_formatpaar_erkannt() {
        let roh = RohGestalt {
            objekte: vec![RohObjekt { fd: 7, modifier: 0 }],
            layer: vec![layer(R16, 1, 0), layer(GR32, 1, 4_718_592)],
        };
        let g = pruefen(&roh, 1920, 1080).expect("10 bit muss tragen");
        assert!(g.zehn_bit);
        assert_eq!(g.ebenen[0].format, wgpu::TextureFormat::R16Unorm);
        assert_eq!(g.ebenen[1].format, wgpu::TextureFormat::Rg16Unorm);
    }

    /// **Der wichtigste Test dieser Datei.** Ein Layer mit zwei Planes traegt
    /// Kompressions-Metadaten; der wgpu-Helfer kann ihn nicht, und ihn trotzdem
    /// einzuhaengen ergaebe ein Bild, das aussieht wie Rauschen. Er MUSS
    /// abgewiesen werden, damit der Rueckfall auf das Ruecklesen greift.
    #[test]
    fn mehrplanige_layer_werden_abgewiesen() {
        let mut roh = amd_8bit();
        roh.layer[0].planes = 2;
        assert!(pruefen(&roh, 1920, 1080).is_err());
    }

    /// Ein komponiertes Bild (ein Layer, NV12 als Ganzes) ist eine andere
    /// Abtastung — der Shader erwartet zwei getrennte Ebenen.
    #[test]
    fn ein_einzelner_layer_wird_abgewiesen() {
        let mut roh = amd_8bit();
        roh.layer.truncate(1);
        assert!(pruefen(&roh, 1920, 1080).is_err());
    }

    /// Unbekannte oder gemischte Formatpaare durchzulassen hiesse, mit der
    /// falschen Bittiefe abzutasten — sichtbar als falsche Farben, nicht als
    /// Fehler.
    #[test]
    fn fremde_formatpaare_werden_abgewiesen() {
        let mut roh = amd_8bit();
        roh.layer[1].fourcc = GR32;
        assert!(pruefen(&roh, 1920, 1080).is_err());
        roh.layer[0].fourcc = fourcc(b"NV12");
        assert!(pruefen(&roh, 1920, 1080).is_err());
    }

    /// Ein Layer, der auf ein nicht vorhandenes Objekt zeigt, waere ein
    /// Lesezugriff ins Leere — hier faellt er als Fehler auf, nicht als
    /// Absturz beim Einhaengen.
    #[test]
    fn ein_layer_ohne_objekt_wird_abgewiesen() {
        let mut roh = amd_8bit();
        roh.layer[1].erste.objekt = 3;
        assert!(pruefen(&roh, 1920, 1080).is_err());
    }

    /// Die Fourcc-Tabelle und die Ebenenformate des Renderers muessen dasselbe
    /// sagen. **Sie stehen in zwei Dateien**, und eine Abweichung saehe man
    /// nicht als Fehler, sondern als falsche Farben.
    #[test]
    fn die_fourcc_tabelle_passt_zu_den_ebenenformaten() {
        for (zehn_bit, l0, l1) in [(false, R8, GR88), (true, R16, GR32)] {
            let erwartet =
                crate::render::farbe::ebenenformate(zehn_bit, PixelLayout::BiPlanar420);
            assert_eq!(
                (format_aus_fourcc(l0).unwrap(), format_aus_fourcc(l1).unwrap()),
                erwartet
            );
        }
        assert_eq!(format_aus_fourcc(fourcc(b"NV12")), None);
    }
}
