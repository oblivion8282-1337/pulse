//! Die Vulkan-Seite: exportierbarer Speicher, exportierbare Semaphoren, und
//! ein Absenden, das wahlweise auf ein Semaphor wartet oder eben NICHT.
//!
//! Das „eben nicht" ist kein Bequemlichkeitsschalter, sondern die Gegenprobe:
//! eine Synchronisierung, die nichts tut, faellt nicht auf, wenn das Wettrennen
//! zufaellig nie eintritt. Erst der Lauf OHNE Warten zeigt, ob die Probe ein
//! fehlendes Warten ueberhaupt bemerken kann.
//!
//! Gearbeitet wird mit PUFFERN, nicht mit Bildern. Grund: die Bild-Frage ist in
//! `../cuda-vulkan-import` und `../wgpu-cuda-import` bereits beantwortet, und
//! ein Puffer laesst sich Byte fuer Byte gegen ein Muster pruefen, ohne dass
//! eine undurchsichtige Kachelung dazwischensteht. Ein Wettrennen wuerde man in
//! einem gekachelten Bild schlechter sehen, nicht besser.

use anyhow::{bail, Context, Result};
use ash::vk;

use crate::geraet::Geraet;

/// Welche Bauart von Semaphor. Die beiden sind zwei verschiedene Faelle, keine
/// zwei Zahlenwerte — siehe Begruendung an
/// `cudasem::CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_TIMELINE_SEMAPHORE_FD`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Bauart {
    Binaer,
    Zeitlinie,
}

impl Bauart {
    pub fn name(self) -> &'static str {
        match self {
            Bauart::Binaer => "BINAER (OPAQUE_FD)",
            Bauart::Zeitlinie => "ZEITLINIE (TIMELINE_SEMAPHORE_FD)",
        }
    }
}

pub struct Semaphor {
    pub roh: vk::Semaphore,
    /// Wandert beim CUDA-Import in CUDAs Besitz — hier wird er NICHT
    /// geschlossen, ein doppeltes `close` fiele erst viel spaeter auf. Dieselbe
    /// Regel wie beim Speicher-Deskriptor der Nachbarkiste.
    pub fd: i32,
}

pub struct Puffer {
    pub roh: vk::Buffer,
    /// Wird nach dem Export nicht mehr angefasst — die Allokation muss aber
    /// benannt bleiben, sonst waere nicht mehr erkennbar, dass sie absichtlich
    /// bis zum Programmende steht (CUDA haelt sie ueber den importierten
    /// Deskriptor).
    #[allow(dead_code)]
    pub speicher: vk::DeviceMemory,
    pub fd: i32,
    /// Die vom Treiber **erfragte** Allokationsgroesse — CUDA muss beim Import
    /// diese Zahl bekommen, nicht die angeforderte.
    pub alloc: u64,
}

pub struct Vkseite<'a> {
    g: &'a Geraet,
    pool: vk::CommandPool,
}

impl<'a> Vkseite<'a> {
    pub fn neu(g: &'a Geraet) -> Result<Self> {
        let pool = unsafe {
            g.ash_device.create_command_pool(
                &vk::CommandPoolCreateInfo::default()
                    .queue_family_index(g.familie)
                    .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER),
                None,
            )
        }?;
        Ok(Self { g, pool })
    }

    /// Die UUID der Karte, die wgpu benutzt — zum Abgleich mit CUDA. Auf einer
    /// Maschine mit zwei Karten schluege der Import sonst aus einem Grund fehl,
    /// der mit der Frage nichts zu tun hat.
    pub fn uuid(&self) -> [u8; 16] {
        let mut id = vk::PhysicalDeviceIDProperties::default();
        let mut props = vk::PhysicalDeviceProperties2::default().push_next(&mut id);
        unsafe { self.g.instance.get_physical_device_properties2(self.g.phys, &mut props) };
        id.device_uuid
    }

    fn speichertyp(&self, erlaubt: u32, noetig: vk::MemoryPropertyFlags) -> Result<u32> {
        let props =
            unsafe { self.g.instance.get_physical_device_memory_properties(self.g.phys) };
        for i in 0..props.memory_type_count {
            if erlaubt & (1 << i) != 0
                && props.memory_types[i as usize].property_flags.contains(noetig)
            {
                return Ok(i);
            }
        }
        bail!("kein Speichertyp mit {noetig:?}")
    }

    /// Geraetelokaler, exportierbarer Puffer — das gemeinsame Stueck Speicher,
    /// in das CUDA schreibt und aus dem Vulkan liest.
    pub fn geteilter_puffer(&self, bytes: usize) -> Result<Puffer> {
        let mut ext = vk::ExternalMemoryBufferCreateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let roh = unsafe {
            self.g.ash_device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(bytes as u64)
                    .usage(
                        vk::BufferUsageFlags::TRANSFER_SRC | vk::BufferUsageFlags::TRANSFER_DST,
                    )
                    .sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .push_next(&mut ext),
                None,
            )
        }?;
        let bedarf = unsafe { self.g.ash_device.get_buffer_memory_requirements(roh) };
        let typ = self.speichertyp(bedarf.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)?;
        let mut export = vk::ExportMemoryAllocateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let mut dedi = vk::MemoryDedicatedAllocateInfo::default().buffer(roh);
        let speicher = unsafe {
            self.g.ash_device.allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(bedarf.size)
                    .memory_type_index(typ)
                    .push_next(&mut export)
                    .push_next(&mut dedi),
                None,
            )
        }?;
        unsafe { self.g.ash_device.bind_buffer_memory(roh, speicher, 0) }?;
        let fd_api =
            ash::khr::external_memory_fd::Device::new(&self.g.instance, &self.g.ash_device);
        let fd = unsafe {
            fd_api.get_memory_fd(
                &vk::MemoryGetFdInfoKHR::default()
                    .memory(speicher)
                    .handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD),
            )
        }
        .context("vkGetMemoryFdKHR")?;
        Ok(Puffer { roh, speicher, fd, alloc: bedarf.size })
    }

    /// Host-sichtbarer Puffer zum Auslesen.
    pub fn ablage(&self, bytes: usize) -> Result<(vk::Buffer, vk::DeviceMemory)> {
        let roh = unsafe {
            self.g.ash_device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(bytes as u64)
                    .usage(vk::BufferUsageFlags::TRANSFER_DST)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE),
                None,
            )
        }?;
        let bedarf = unsafe { self.g.ash_device.get_buffer_memory_requirements(roh) };
        let typ = self.speichertyp(
            bedarf.memory_type_bits,
            vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
        )?;
        let speicher = unsafe {
            self.g.ash_device.allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(bedarf.size)
                    .memory_type_index(typ),
                None,
            )
        }?;
        unsafe { self.g.ash_device.bind_buffer_memory(roh, speicher, 0) }?;
        Ok((roh, speicher))
    }

    pub fn lesen(&self, speicher: vk::DeviceMemory, bytes: usize) -> Result<Vec<u8>> {
        unsafe {
            let p = self.g.ash_device.map_memory(
                speicher,
                0,
                bytes as u64,
                vk::MemoryMapFlags::empty(),
            )?;
            let v = std::slice::from_raw_parts(p as *const u8, bytes).to_vec();
            self.g.ash_device.unmap_memory(speicher);
            Ok(v)
        }
    }

    /// Ein exportierbares Semaphor anlegen und seinen Dateideskriptor holen.
    ///
    /// `VkExportSemaphoreCreateInfo` MUSS beim Anlegen dabei sein — ein
    /// nachtraeglicher Export ist nicht vorgesehen, und `vkGetSemaphoreFdKHR`
    /// wuerde ihn mit `ERROR_INVALID_EXTERNAL_HANDLE` abweisen.
    pub fn semaphor(&self, bauart: Bauart) -> Result<Semaphor> {
        let mut export = vk::ExportSemaphoreCreateInfo::default()
            .handle_types(vk::ExternalSemaphoreHandleTypeFlags::OPAQUE_FD);
        // Der Zeitlinien-Typ haengt an `VK_KHR_timeline_semaphore` bzw. dem
        // Kernbestand ab Vulkan 1.2. wgpu-hal fordert die Erweiterung
        // ohnehin an — sie ist die einzige Semaphor-Erweiterung, die es
        // anfordert (adapter.rs) — der Zeitlinien-Weg ist also auch auf dem
        // wgpu-Geraet baubar. Nur der Export fehlt dort.
        let mut typinfo =
            vk::SemaphoreTypeCreateInfo::default().semaphore_type(vk::SemaphoreType::TIMELINE).initial_value(0);
        let mut info = vk::SemaphoreCreateInfo::default().push_next(&mut export);
        if bauart == Bauart::Zeitlinie {
            info = info.push_next(&mut typinfo);
        }
        let roh = unsafe { self.g.ash_device.create_semaphore(&info, None) }
            .context("vkCreateSemaphore mit Export-Absicht")?;

        let fd_api =
            ash::khr::external_semaphore_fd::Device::new(&self.g.instance, &self.g.ash_device);
        let fd = unsafe {
            fd_api.get_semaphore_fd(
                &vk::SemaphoreGetFdInfoKHR::default()
                    .semaphore(roh)
                    .handle_type(vk::ExternalSemaphoreHandleTypeFlags::OPAQUE_FD),
            )
        }
        .context(
            "vkGetSemaphoreFdKHR — ist VK_KHR_external_semaphore_fd am Geraet an? \
             Auf dem von wgpu 29 selbst geoeffneten Geraet ist sie es NICHT.",
        )?;
        Ok(Semaphor { roh, fd })
    }

    /// Eine Kopie geteilter Puffer -> Ablage absenden.
    ///
    /// `warten` = `None` ist die Gegenprobe: dieselbe Kopie, ohne jede
    /// Synchronisierung gegen CUDA. `Some((sem, wert))` wartet — bei einem
    /// binaeren Semaphor wird `wert` ignoriert, bei einem Zeitlinien-Semaphor
    /// ist er der Wert, auf den gewartet wird.
    ///
    /// **Es wird NICHT auf das Ende gewartet.** Der Aufrufer bestimmt selbst,
    /// wann er `queue_wait_idle` ruft — sonst waere schon das Absenden eine
    /// Synchronisierung und die Gegenprobe koennte nichts mehr zeigen.
    pub fn absenden_kopie(
        &self,
        von: vk::Buffer,
        nach: vk::Buffer,
        bytes: usize,
        warten: Option<(&Semaphor, u64)>,
    ) -> Result<()> {
        let cb = unsafe {
            self.g.ash_device.allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(self.pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1),
            )
        }?[0];
        unsafe {
            self.g.ash_device.begin_command_buffer(
                cb,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )?;
            self.g.ash_device.cmd_copy_buffer(
                cb,
                von,
                nach,
                &[vk::BufferCopy::default().size(bytes as u64)],
            );
            self.g.ash_device.end_command_buffer(cb)?;

            let cbs = [cb];
            let sems = warten.map(|(s, _)| [s.roh]).unwrap_or([vk::Semaphore::null()]);
            let werte = [warten.map(|(_, w)| w).unwrap_or(0)];
            // ALL_COMMANDS statt TRANSFER: die Frage ist, ob das Semaphor
            // ueberhaupt ordnet, nicht wie eng sich die Stufe fassen laesst.
            // Eine zu enge Stufe waere eine zweite moegliche Fehlerquelle.
            let stufen = [vk::PipelineStageFlags::ALL_COMMANDS];
            let mut zeitlinie =
                vk::TimelineSemaphoreSubmitInfo::default().wait_semaphore_values(&werte);
            let mut submit = vk::SubmitInfo::default().command_buffers(&cbs);
            if warten.is_some() {
                submit = submit.wait_semaphores(&sems).wait_dst_stage_mask(&stufen);
                submit = submit.push_next(&mut zeitlinie);
            }
            self.g.ash_device.queue_submit(self.g.queue, &[submit], vk::Fence::null())?;
        }
        Ok(())
    }

    /// Ein Semaphor von der VULKAN-Seite signalisieren — fuer die
    /// Gegenrichtung (Vulkan gibt das Bild frei, CUDA wartet darauf).
    pub fn absenden_signal(&self, sem: &Semaphor, wert: u64) -> Result<()> {
        unsafe {
            let sems = [sem.roh];
            let werte = [wert];
            let mut zeitlinie =
                vk::TimelineSemaphoreSubmitInfo::default().signal_semaphore_values(&werte);
            let submit = vk::SubmitInfo::default()
                .signal_semaphores(&sems)
                .push_next(&mut zeitlinie);
            self.g.ash_device.queue_submit(self.g.queue, &[submit], vk::Fence::null())?;
        }
        Ok(())
    }

    pub fn warteschlange_leeren(&self) -> Result<()> {
        unsafe { self.g.ash_device.queue_wait_idle(self.g.queue) }?;
        Ok(())
    }
}

impl Drop for Vkseite<'_> {
    fn drop(&mut self) {
        unsafe {
            let _ = self.g.ash_device.queue_wait_idle(self.g.queue);
            self.g.ash_device.destroy_command_pool(self.pool, None);
        }
    }
}
