//! Welcher der beiden Linux-Wege fuer dieses Bild gilt.
//!
//! Unter Linux gibt es **zwei** Bruecken, und welche greift, entscheidet allein
//! das Pixelformat des dekodierten Bildes: `Pixel::CUDA` (NVIDIA, ueber
//! `av1_cuvid`/`h264_cuvid`) geht ueber [`super::linux`], `Pixel::VAAPI` (AMD,
//! Intel) ueber [`super::vaapi`]. Beides zugleich kann in einer Sitzung nicht
//! vorkommen — der Decoder wird einmal geoeffnet und liefert eines von beiden.
//!
//! **Warum die Weiche hier steht und nicht in `decode.rs` oder `render/`:**
//! dort steht ueberall genau ein Typ (`Option<Arc<GpuBild>>`, `Bruecke`), und
//! das soll so bleiben. Eine Weiche im Decoder hiesse zwei Felder, eine im
//! Renderer zwei Zwischenspeicher — und jeder neue Weg beruehrte wieder beide
//! Dateien. Hier ist es eine Datei, und die Plattformen ausserhalb von Linux
//! sehen die Weiche gar nicht.
//!
//! Was sie NICHT tut: sie waehlt nicht aus. Der Decoder hat sich beim Oeffnen
//! fuer ein Hardware-Geraet entschieden (`decode::Hwaccel`), diese Weiche liest
//! das Ergebnis nur ab.

use std::sync::Arc;

use anyhow::{bail, Result};
use ffmpeg_next as ffmpeg;

use super::{linux, vaapi};

/// Die Bruecke dieser Sitzung.
pub enum Bruecke {
    Cuda(linux::Bruecke),
    Vaapi(vaapi::Bruecke),
}

/// Ein Bild, das im Grafikspeicher liegen bleibt — auf dem einen oder dem
/// anderen Weg.
pub enum GpuBild {
    Cuda(linux::GpuBild),
    Vaapi(vaapi::GpuBild),
}

/// Wie der Renderer dieses Bild einhaengt.
///
/// **Die beiden Faelle sind grundverschieden**, und deshalb steht hier ein
/// `enum` und keine gemeinsame Beschreibung: auf dem CUDA-Weg gehoeren die
/// beiden `VkImage` bereits diesem Geraet und werden nur uebergeben; auf dem
/// VAAPI-Weg legt wgpu die Bilder selbst an und importiert fremden Speicher.
/// Eine Form, die beides abdeckte, muesste die Haelfte ihrer Felder leer
/// lassen.
pub enum Einhaengung {
    /// Zwei fertige Vulkan-Bilder samt ihrem Lebensanker (s.
    /// `linux::Ringplatz`).
    Vulkanbilder {
        ebenen: [(ash::vk::Image, wgpu::TextureFormat, u32, u32); 2],
        anker: Arc<linux::Ringplatz>,
    },
    /// Zwei DMA-BUF-Ebenen. **Ohne Anker** — der wandert hier nicht im Plan
    /// mit, sondern als ganzes [`GpuBild`] im Import des Renderers
    /// (Begruendung im Kopf von `render::fremdlinux`).
    Dmabuf { ebenen: [vaapi::Dmabufebene; 2] },
}

impl Bruecke {
    pub fn neu(
        frame: &ffmpeg::util::frame::video::Video,
        briefkasten: Arc<crate::einfrieren::Briefkasten>,
        geraet: &Option<wgpu::Device>,
    ) -> Result<Self> {
        match frame.format() {
            ffmpeg::format::Pixel::CUDA => {
                Ok(Self::Cuda(linux::Bruecke::neu(frame, briefkasten, geraet)?))
            }
            ffmpeg::format::Pixel::VAAPI => {
                Ok(Self::Vaapi(vaapi::Bruecke::neu(frame, briefkasten, geraet)?))
            }
            anderes => bail!("fuer {anderes:?} gibt es unter Linux keine Bruecke"),
        }
    }

    /// Ein Bild ueber die Bruecke nehmen. `Ok(None)` heisst „gerade nicht" —
    /// beide Wege kennen den Fall, wenn auch aus verschiedenen Gruenden (kein
    /// freier Ringplatz bzw. Deckel erreicht).
    ///
    /// **Das `Arc` entsteht hier und nicht in den beiden Bruecken.** Sie geben
    /// ihr Bild nackt heraus; erst hier bekommt es seine gemeinsame Huelle.
    /// Andernfalls steckte ein `Arc` im anderen — zwei Zaehler fuer eine
    /// Lebensdauer.
    pub fn uebernehmen(
        &mut self,
        frame: &ffmpeg::util::frame::video::Video,
    ) -> Result<Option<Arc<GpuBild>>> {
        let bild = match self {
            Self::Cuda(b) => b.uebernehmen(frame)?.map(GpuBild::Cuda),
            Self::Vaapi(b) => b.uebernehmen(frame)?.map(GpuBild::Vaapi),
        };
        Ok(bild.map(Arc::new))
    }
}

impl GpuBild {
    pub fn textur_masse(&self) -> (u32, u32) {
        match self {
            Self::Cuda(b) => b.textur_masse(),
            Self::Vaapi(b) => b.textur_masse(),
        }
    }

    pub fn zehn_bit(&self) -> bool {
        match self {
            Self::Cuda(b) => b.zehn_bit(),
            Self::Vaapi(b) => b.zehn_bit(),
        }
    }

    pub fn handle(&self) -> isize {
        match self {
            Self::Cuda(b) => b.handle(),
            Self::Vaapi(b) => b.handle(),
        }
    }

    pub fn briefkasten(&self) -> &Arc<crate::einfrieren::Briefkasten> {
        match self {
            Self::Cuda(b) => b.briefkasten(),
            Self::Vaapi(b) => b.briefkasten(),
        }
    }

    /// Alles, was der Renderer zum Einhaengen braucht.
    ///
    /// `Result`, weil der VAAPI-Weg dafuer Dateideskriptoren dupliziert und das
    /// scheitern kann; der CUDA-Weg reicht nur Zahlenwerte weiter.
    pub fn einhaengung(&self) -> Result<Einhaengung> {
        match self {
            Self::Cuda(b) => Ok(Einhaengung::Vulkanbilder {
                ebenen: b.ebenen(),
                anker: b.lebensanker(),
            }),
            Self::Vaapi(b) => Ok(Einhaengung::Dmabuf { ebenen: b.ebenen_zum_einhaengen()? }),
        }
    }

    /// Muss der Renderer je Bild neu einhaengen?
    ///
    /// **Ja auf dem VAAPI-Weg, nein auf dem CUDA-Weg** — und das ist keine
    /// Abwaegung, sondern die Sache selbst: dort zeigt jedes Bild auf eine
    /// andere Surface mit einer frisch angelegten Abbildung, hier rotiert ein
    /// fester Ring, dessen Plaetze ueber die ganze Sitzung dieselben bleiben.
    /// Der Renderer haengt daran seine Aufbewahrungsregel (`render::fremdbild`).
    pub fn import_je_bild(&self) -> bool {
        matches!(self, Self::Vaapi(_))
    }
}
