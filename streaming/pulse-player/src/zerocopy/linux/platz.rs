//! Der Ringplatz und das Bild, das ihn belegt — Aufbau, Lebensdauer, Abbau.
//!
//! Getrennt von der Bruecke nebenan, weil beides verschiedene Fragen
//! beantwortet: hier steht, was ein Platz IST und wie lange er lebt; dort, wann
//! einer genommen und beschrieben wird.

use std::sync::Arc;

use anyhow::{bail, Result};
use ash::vk;

use super::cuda;
use super::ebene::Ebene;
use super::kern::Kern;
use super::vkbild::{VkBild, Vkseite};
use crate::zerocopy::freigabe::Freigabe;

/// Wie viele Bildpaare im Umlauf sind.
///
/// Dieselbe Ueberlegung wie auf Windows (`bruecke.rs`), deshalb dieselbe Zahl
/// und derselbe Schalter: `app::takt` haelt die Bilder rund `vorhalt_ms` lang
/// zurueck (Vorgabe 60 ms), bei 60 Bildern je Sekunde haengen dort allein vier
/// Stueck; dazu das Bild in `pending`, das gerade gezeichnete und das, dessen
/// Zeichendurchgang noch laeuft. Vier waren dort zu wenig, zwoelf tragen auch
/// 144 Bilder je Sekunde.
///
/// Der Preis ist Grafikspeicher: ein Platz ist bei 1440p10 rund 11 MB
/// (Y 2560x1440x2 B plus UV 1280x720x4 B, dazu der Aufschlag des Treibers von
/// 0,74 bis 18,5 Prozent), also rund 130 MB fuer den ganzen Ring.
pub(super) fn ringgroesse() -> usize {
    std::env::var("PULSE_PLAYER_ZEROCOPY_RING")
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|n| (2..=64).contains(n))
        .unwrap_or(12)
}

/// Eine Ebene, wie sie im Platz liegt: das Vulkan-Bild und die drei Griffe, mit
/// denen CUDA darauf sieht.
///
/// **Ein Verbund statt vier gleichlanger Felder im [`Ringplatz`]**: die vier
/// Dinge gehoeren zu genau einer Ebene, und getrennte Felder liessen ein
/// Auseinanderrutschen der Indizes zu, das der Compiler nicht bemerken kann.
struct Eingehaengt {
    bild: VkBild,
    ext_mem: cuda::CUexternalMemory,
    mip: cuda::CUmipmappedArray,
    array: cuda::CUarray,
}

/// Ein Ringplatz: zwei Bilder, zweimal bei CUDA eingehaengt — und wer sie am
/// Leben haelt.
///
/// **Das `Arc` darauf ist kein Beiwerk, sondern die Absicherung gegen einen
/// Fehler, den man nicht sieht, sondern an dem die Karte stirbt.** Der Ring
/// wird abgebaut, wenn die Aufloesung wechselt oder die Sitzung endet — zu
/// diesem Zeitpunkt kann der Renderer aber noch eine `wgpu::Texture` halten,
/// die auf genau dieses `VkImage` zeigt, und einen abgeschickten
/// Zeichendurchgang darauf offen haben. Ein `vkDestroyImage` dazwischen ist
/// eine Benutzung nach der Freigabe.
///
/// **Die Windows-Bruecke hat dieses Problem nicht**, und deshalb steht der
/// Absatz hier und nicht dort: `ID3D12Device::OpenSharedHandle` nimmt eine
/// eigene Referenz auf die Ressource, das Schliessen des NT-Handles kann ihr
/// also nichts anhaben. Vulkan kennt nichts Vergleichbares.
///
/// Gehalten wird der Anker von zwei Seiten: von jedem [`GpuBild`] dieses
/// Platzes und — ueber den `drop_callback` von `texture_from_raw` — von wgpus
/// Textur selbst (s. `render::fremdbild`). Freigegeben wird erst, wenn beide
/// los sind.
pub struct Ringplatz {
    ebenen: [Eingehaengt; 2],
    /// Zum Freigeben gebraucht, und nur dafuer.
    vk: Arc<Vkseite>,
    kern: &'static Kern,
}

// SAFETY: die CUDA-Griffe sind undurchsichtige Zeiger, die nur im `Drop`
// beruehrt werden; `vk::Image`/`vk::DeviceMemory` sind Zahlenwerte. Der `Drop`
// kann auf dem Fenster-Thread laufen (wenn wgpu die Textur zuletzt loslaesst),
// deshalb muessen beide Merkmale da sein.
unsafe impl Send for Ringplatz {}
unsafe impl Sync for Ringplatz {}

impl Ringplatz {
    /// Beide Ebenen anlegen, bei CUDA einhaengen und gegenpruefen.
    pub(super) fn bauen(
        vk: &Arc<Vkseite>,
        kern: &'static Kern,
        ebenen: &[Ebene; 2],
    ) -> Result<Self> {
        let y = Self::einhaengen(vk, kern, &ebenen[0])?;
        let uv = Self::einhaengen(vk, kern, &ebenen[1])?;
        Ok(Self { ebenen: [y, uv], vk: vk.clone(), kern })
    }

    /// Ein exportierbares Vulkan-Bild anlegen und CUDA darauf sehen lassen.
    fn einhaengen(vk: &Vkseite, kern: &Kern, e: &Ebene) -> Result<Eingehaengt> {
        let c = &kern.cuda;
        let bild = vk.exportierbares_bild(e.vk_format, e.breite, e.hoehe)?;
        let handle = cuda::ExternalMemoryHandleDesc::fuer_fd(bild.fd, bild.alloc);
        let mut ext_mem = std::ptr::null_mut();
        let mut mip = std::ptr::null_mut();
        let mut array = std::ptr::null_mut();
        // `depth = 0` ist kein Tippfehler: ein Vulkan-2D-Bild hat intern
        // depth 1, das CUDA-Array eines 2D-Bildes verlangt hier aber 0. Die
        // Eins erzeugt keinen Fehler, sondern ein Lochmuster im Bild, dessen
        // Periode von der Aufloesung abhaengt (NVIDIA-Forum 278691).
        let beschreibung = cuda::ExternalMemoryMipmappedArrayDesc {
            offset: 0,
            array_desc: cuda::Array3dDescriptor {
                width: e.breite as usize,
                height: e.hoehe as usize,
                depth: 0,
                format: e.cu_format,
                num_channels: e.kanaele,
                flags: 0,
            },
            num_levels: 1,
            reserved: [0; 16],
        };
        let mut zurueck = cuda::ArrayDescriptor::default();
        // SAFETY: der Deskriptor beschreibt genau die eben angelegte
        // Allokation, jede Stufe wird vor der naechsten geprueft, und
        // `cuArrayGetDescriptor` schreibt nur in `zurueck`.
        unsafe {
            c.pruefe(
                (c.cuImportExternalMemory)(&mut ext_mem, &handle),
                "cuImportExternalMemory",
            )?;
            c.pruefe(
                (c.cuExternalMemoryGetMappedMipmappedArray)(&mut mip, ext_mem, &beschreibung),
                "cuExternalMemoryGetMappedMipmappedArray",
            )?;
            c.pruefe(
                (c.cuMipmappedArrayGetLevel)(&mut array, mip, 0),
                "cuMipmappedArrayGetLevel",
            )?;
            c.pruefe((c.cuArrayGetDescriptor)(&mut zurueck, array), "cuArrayGetDescriptor")?;
        }
        // **Kontrolle: meint CUDA dasselbe Bild wie wir?** Ohne diese
        // Rueckfrage koennte etwas anderes eingehaengt sein (halbe Breite,
        // anderes Format), und `cuMemcpy2D` schriebe brav an die falsche
        // Stelle — sichtbar als verschobenes Bild, nicht als Fehler.
        if zurueck.width != e.breite as usize
            || zurueck.height != e.hoehe as usize
            || zurueck.format != e.cu_format
            || zurueck.num_channels != e.kanaele
        {
            bail!(
                "CUDA meldet {}x{} Format 0x{:x} mit {} Kanaelen zurueck, beschrieben war \
                 {}x{} Format 0x{:x} mit {} Kanaelen",
                zurueck.width,
                zurueck.height,
                zurueck.format,
                zurueck.num_channels,
                e.breite,
                e.hoehe,
                e.cu_format,
                e.kanaele
            );
        }
        Ok(Eingehaengt { bild, ext_mem, mip, array })
    }

    /// Das CUDA-Array einer Ebene — das Ziel der Kopie.
    pub(super) fn array(&self, i: usize) -> cuda::CUarray {
        self.ebenen[i].array
    }
}

impl Drop for Ringplatz {
    /// **Die Reihenfolge ist verbindlich**: erst CUDAs Einhaengung, dann das
    /// Vulkan-Bild. Andersherum haette CUDA kurzzeitig eine Abbildung auf
    /// freigegebenen Speicher.
    fn drop(&mut self) {
        let c = &self.kern.cuda;
        // Faellt das Setzen des Kontexts um, wird trotzdem weiter aufgeraeumt —
        // ein halb abgebauter Platz waere schlimmer als ein fehlgeschlagenes
        // `destroy`.
        let _ = self.kern.kontext_setzen();
        for e in &self.ebenen {
            // SAFETY: der Kontext gehoert zu allen folgenden Griffen, und keiner
            // von ihnen wird nach diesem `drop` noch benutzt (s. Kopfabsatz).
            unsafe {
                if !e.mip.is_null() {
                    let _ = (c.cuMipmappedArrayDestroy)(e.mip);
                }
                if !e.ext_mem.is_null() {
                    let _ = (c.cuDestroyExternalMemory)(e.ext_mem);
                }
                self.vk.freigeben(&e.bild);
            }
        }
    }
}

/// Ein dekodiertes Bild, das im Grafikspeicher liegen bleibt.
///
/// Gegenstueck zu `zerocopy::platz::GpuBild` auf Windows; die
/// Lebensdauer-Regel steht dort und gilt hier genauso.
pub struct GpuBild {
    /// Der Ringplatz, aus dem dieses Bild stammt — zugleich der Lebensanker
    /// seiner beiden `VkImage` (s. [`Ringplatz`]).
    platz: Arc<Ringplatz>,
    breite: u32,
    hoehe: u32,
    zehn_bit: bool,
    slot: usize,
    frei: Arc<Freigabe>,
    briefkasten: Arc<crate::einfrieren::Briefkasten>,
}

impl GpuBild {
    pub(super) fn neu(
        platz: Arc<Ringplatz>,
        bauart: super::Bauart,
        slot: usize,
        frei: Arc<Freigabe>,
        briefkasten: Arc<crate::einfrieren::Briefkasten>,
    ) -> Self {
        Self {
            platz,
            breite: bauart.breite,
            hoehe: bauart.hoehe,
            zehn_bit: bauart.zehn_bit,
            slot,
            frei,
            briefkasten,
        }
    }

    /// Masse der angelegten Bilder.
    ///
    /// **Hier sind sie gleich den Bildmassen**, anders als auf Windows: dort
    /// gehoert die Textur dem Decoder und ist aufgerundet, hier legt die
    /// Bruecke sie selbst an und nimmt genau die Bildgroesse. `nutzanteil` im
    /// Renderer rechnet damit die Eins aus — richtig, nur wirkungslos.
    pub fn textur_masse(&self) -> (u32, u32) {
        (self.breite, self.hoehe)
    }
    pub fn zehn_bit(&self) -> bool {
        self.zehn_bit
    }
    /// Der Schluessel, unter dem der Renderer seinen Import zwischenspeichert.
    ///
    /// Auf Windows ist das ein NT-Handle, hier der Zahlenwert des
    /// Y-`VkImage` — beides ist je Ringplatz fest und ueber die Lebensdauer der
    /// Bruecke eindeutig. Der Name ist von der Windows-Seite geerbt; die
    /// Ansprueche an ihn sind dieselben, und ein zweiter Name fuer dieselbe
    /// Rolle waere teurer als der leicht schiefe.
    pub fn handle(&self) -> isize {
        use ash::vk::Handle;
        self.platz.ebenen[0].bild.image.as_raw() as isize
    }
    /// Alles, was der Renderer je Ebene braucht (Y, dann UV): das `VkImage`,
    /// sein wgpu-Format und seine Masse.
    ///
    /// **In einem Stueck und aus DERSELBEN Rechnung**, mit der die Bilder
    /// angelegt wurden. Der Renderer holte sich das Format frueher einzeln und
    /// halbierte die Farbebene selbst — damit stand die Regel „halb, und zwar
    /// aufgerundet" an zwei Stellen, und ein Auseinanderlaufen saehe man als
    /// verschobenes Bild, nicht als Fehler.
    pub fn ebenen(&self) -> [(vk::Image, wgpu::TextureFormat, u32, u32); 2] {
        let masse = super::ebene::ebenen(self.zehn_bit, self.breite, self.hoehe);
        let (y_fmt, uv_fmt) = super::ebene::wgpu_ebenenformate(self.zehn_bit);
        [
            (self.platz.ebenen[0].bild.image, y_fmt, masse[0].breite, masse[0].hoehe),
            (self.platz.ebenen[1].bild.image, uv_fmt, masse[1].breite, masse[1].hoehe),
        ]
    }
    /// Der Lebensanker der beiden Bilder — der Renderer haengt ihn an seine
    /// wgpu-Textur, damit die Bilder nicht unter ihr weggeraeumt werden
    /// (Begruendung bei [`Ringplatz`]).
    pub fn lebensanker(&self) -> Arc<Ringplatz> {
        self.platz.clone()
    }
    pub fn briefkasten(&self) -> &Arc<crate::einfrieren::Briefkasten> {
        &self.briefkasten
    }
}

impl Drop for GpuBild {
    fn drop(&mut self) {
        self.frei.zurueck(self.slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Ringgroesse muss in einem Bereich bleiben, in dem der Weg
    /// funktioniert: unter zwei Plaetzen gibt es keinen Umlauf, ueber 64 waere
    /// der Grafikspeicher das Problem. Ein unsinniger Wert in der Umgebung
    /// faellt auf die Vorgabe zurueck, statt den Player unbrauchbar zu machen.
    #[test]
    fn die_ringgroesse_bleibt_im_rahmen() {
        assert_eq!(ringgroesse(), 12, "ohne Umgebungsvariable gilt die Vorgabe");
    }
}
