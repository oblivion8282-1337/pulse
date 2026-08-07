//! Die Vulkan-Seite der Linux-Bruecke: exportierbare Bilder auf **wgpus
//! eigenem** Geraet anlegen.
//!
//! **Auf wgpus Geraet, nicht auf einem eigenen** — das ist der Punkt, an dem
//! die Bauart haengt. Ein `VkImage` gehoert unaufloesbar zu seinem `VkDevice`,
//! und `texture_from_raw` nimmt keins von einem fremden entgegen. Ein eigenes
//! Geraet zwaenge dazu, den Speicher ein zweites Mal ueber einen
//! Dateideskriptor zu wgpu zurueckzureichen — zwei Importe statt einem, ohne
//! Gegenwert.
//!
//! Dass das ueberhaupt geht, haengt an `VK_KHR_external_memory_fd`. wgpu-hal 29
//! fordert sie an, wenn die Karte sie anbietet (`vulkan/adapter.rs:1296`) —
//! aber „fordert an, wenn" ist keine Zusage, deshalb wird sie am laufenden
//! Geraet **nachgesehen** statt vorausgesetzt (s. [`Vkseite::neu`]).
//!
//! Belegt in `streaming/player-labor/wgpu-cuda-import/`, Messakte
//! `profiles/player-2026-08-07-wgpu29-vkimage-import.json`: wgpu 29.0.4
//! uebernimmt ein so angelegtes und von CUDA beschriebenes Bild **mitsamt
//! Inhalt**, schon beim ersten Zugriff, ueber 720p bis 4K.

use anyhow::{bail, Context, Result};
use ash::vk;

/// Die Erweiterung, ohne die kein Dateideskriptor herausfaellt.
const SPEICHER_FD: &str = "VK_KHR_external_memory_fd";

/// Geklonte Griffe auf wgpus Vulkan-Geraet.
///
/// **`ash::Device` ist nur Handle plus Funktionstabelle**; der Klon haelt
/// nichts am Leben und zerstoert beim Fallenlassen nichts. Daraus folgt die
/// Lebensdauer-Auflage dieses Moduls: die `Vkseite` darf ihr wgpu-Geraet nicht
/// ueberleben. Sie tut es nicht, weil sie in der `Bruecke` des Decoders sitzt
/// und der Decoder mit seiner Sitzung endet, waehrend das Geraet am Fenster
/// haengt — und das Fenster ueberlebt die Sitzung (s. `app::Session`).
pub struct Vkseite {
    device: ash::Device,
    instance: ash::Instance,
    phys: vk::PhysicalDevice,
}

// SAFETY: `ash::Device`/`Instance` sind bereits `Send`+`Sync`;
// `vk::PhysicalDevice` ist ein reiner Zahlenwert. Die Struktur wandert mit dem
// Decoder auf genau einen Thread.
unsafe impl Send for Vkseite {}

impl Vkseite {
    /// Die rohen Griffe aus einem wgpu-Geraet entnehmen — und dabei pruefen,
    /// dass der Weg ueberhaupt offen ist.
    ///
    /// Zwei Fehlschlaege sind hier moeglich und **beide sind Ergebnisse, keine
    /// Programmfehler**: das Geraet laeuft nicht auf Vulkan (dann gibt es
    /// keinen Dateideskriptor-Weg), oder die Erweiterung fehlt. In beiden
    /// Faellen faellt der Aufrufer auf das Ruecklesen zurueck.
    pub fn neu(geraet: &wgpu::Device) -> Result<Self> {
        // SAFETY: alle Griffe stammen aus demselben, lebenden wgpu-Geraet; die
        // geklonten ash-Griffe zerstoeren beim Fallenlassen nichts.
        unsafe {
            let hal = geraet
                .as_hal::<wgpu::hal::api::Vulkan>()
                .context("das wgpu-Geraet ist kein Vulkan-Geraet")?;
            let hat = hal
                .enabled_device_extensions()
                .iter()
                .any(|e| e.to_string_lossy() == SPEICHER_FD);
            if !hat {
                bail!(
                    "wgpus Geraet fuehrt {SPEICHER_FD} nicht — ohne sie laesst sich kein \
                     Speicher an CUDA weiterreichen"
                );
            }
            Ok(Self {
                device: hal.raw_device().clone(),
                instance: hal.shared_instance().raw_instance().clone(),
                phys: hal.raw_physical_device(),
            })
        }
    }

    /// Die UUID der Karte, die wgpu benutzt — zum Abgleich mit CUDA.
    ///
    /// **Ohne diesen Abgleich schluege der Import auf einer Maschine mit zwei
    /// Karten fehl, und zwar aus einem Grund, der wie ein Treiberfehler
    /// aussaehe.** Ein Notebook mit eingebauter Grafik und NVIDIA daneben ist
    /// genau dieser Fall.
    pub fn uuid(&self) -> [u8; 16] {
        let mut id = vk::PhysicalDeviceIDProperties::default();
        let mut props = vk::PhysicalDeviceProperties2::default().push_next(&mut id);
        // SAFETY: `phys` gehoert zu `instance`, beide leben; der Aufruf
        // schreibt nur in die uebergebenen Strukturen.
        unsafe { self.instance.get_physical_device_properties2(self.phys, &mut props) };
        id.device_uuid
    }

    fn speichertyp(&self, erlaubt: u32, noetig: vk::MemoryPropertyFlags) -> Result<u32> {
        // SAFETY: `phys` gehoert zu `instance`, beide leben.
        let props = unsafe { self.instance.get_physical_device_memory_properties(self.phys) };
        for i in 0..props.memory_type_count {
            if erlaubt & (1 << i) != 0
                && props.memory_types[i as usize].property_flags.contains(noetig)
            {
                return Ok(i);
            }
        }
        bail!("kein Speichertyp mit {noetig:?}")
    }

    /// Ein exportierbares Bild anlegen und seinen Dateideskriptor holen.
    ///
    /// Dieselbe Bauart wie in der Laborprobe (OPTIMAL gekachelt, **immer**
    /// dediziert alloziert): eine Abweichung davon waere eine ungemessene
    /// Bauart, und die Messakte gaelte dann nicht mehr fuer das, was hier
    /// laeuft. `SAMPLED` ist die Nutzung, die wgpu darauf ausuebt.
    pub fn exportierbares_bild(
        &self,
        format: vk::Format,
        breite: u32,
        hoehe: u32,
    ) -> Result<VkBild> {
        let mut ext_info = vk::ExternalMemoryImageCreateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        // SAFETY: das Geraet lebt; alle uebergebenen Strukturen sind lokal und
        // ueberdauern den Aufruf.
        let image = unsafe {
            self.device.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(format)
                    .extent(vk::Extent3D { width: breite, height: hoehe, depth: 1 })
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(
                        vk::ImageUsageFlags::SAMPLED
                            | vk::ImageUsageFlags::STORAGE
                            | vk::ImageUsageFlags::TRANSFER_SRC
                            | vk::ImageUsageFlags::TRANSFER_DST,
                    )
                    .sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .initial_layout(vk::ImageLayout::UNDEFINED)
                    .push_next(&mut ext_info),
                None,
            )
        }
        .with_context(|| format!("vkCreateImage {format:?} {breite}x{hoehe}"))?;

        // **Erfragt, nicht gerechnet.** Ein `VkImage` belegt zwischen 0,74 und
        // 18,5 Prozent mehr als die dichte Bildgroesse, ohne einfache Regel
        // (gemessen, `player-2026-08-07-cuda-vulkan-bild-import.json`). Wer
        // `breite*hoehe*bytes` an CUDA weiterreicht, liegt bis zu 18,5 Prozent
        // daneben — und CUDA weist eine zu kleine Groesse ab, waehrend eine zu
        // grosse nirgends auffaellt.
        //
        // SAFETY: `image` wurde gerade von diesem Geraet angelegt.
        let bedarf = unsafe { self.device.get_image_memory_requirements(image) };
        let typ = self.speichertyp(bedarf.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)?;
        let mut export = vk::ExportMemoryAllocateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let mut dedi = vk::MemoryDedicatedAllocateInfo::default().image(image);
        let info = vk::MemoryAllocateInfo::default()
            .allocation_size(bedarf.size)
            .memory_type_index(typ)
            .push_next(&mut export)
            .push_next(&mut dedi);
        // SAFETY: dasselbe Geraet, lokale Strukturen.
        let memory = unsafe { self.device.allocate_memory(&info, None) }
            .context("vkAllocateMemory fuer das exportierbare Bild")?;
        // SAFETY: Bild und Speicher stammen aus diesem Geraet und sind noch
        // nicht gebunden.
        unsafe { self.device.bind_image_memory(image, memory, 0) }
            .context("vkBindImageMemory")?;

        let fd_api = ash::khr::external_memory_fd::Device::new(&self.instance, &self.device);
        // SAFETY: `memory` gehoert diesem Geraet und wurde mit
        // `ExportMemoryAllocateInfo` alloziert.
        let fd = unsafe {
            fd_api.get_memory_fd(
                &vk::MemoryGetFdInfoKHR::default()
                    .memory(memory)
                    .handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD),
            )
        }
        .context("vkGetMemoryFdKHR")?;

        Ok(VkBild { image, memory, fd, alloc: bedarf.size })
    }

    /// Bild und Speicher freigeben.
    ///
    /// # Safety
    /// Weder das Bild noch sein Speicher duerfen noch benutzt werden — weder
    /// von wgpu (die Textur muss fallengelassen sein) noch von CUDA (die
    /// Einhaengung muss zerstoert sein). Die Reihenfolge steht im `Drop` der
    /// [`super::Bruecke`].
    pub unsafe fn freigeben(&self, bild: &VkBild) {
        self.device.destroy_image(bild.image, None);
        self.device.free_memory(bild.memory, None);
    }
}

/// Ein exportierbares Bild samt allem, was zu seiner Freigabe gehoert.
pub struct VkBild {
    pub image: vk::Image,
    pub memory: vk::DeviceMemory,
    /// **Wandert beim CUDA-Import in CUDAs Besitz** und wird hier NICHT
    /// geschlossen. `cuImportExternalMemory` uebernimmt den Deskriptor bei
    /// `OPAQUE_FD` ausdruecklich; ein zusaetzliches `close` fiele erst viel
    /// spaeter auf, als fremder Deskriptor, den jemand anderes wiederverwendet
    /// hat.
    pub fd: i32,
    /// Die vom Treiber **erfragte** Allokationsgroesse (s. oben).
    pub alloc: u64,
}
