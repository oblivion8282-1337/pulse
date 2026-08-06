//! Die Vulkan-Seite — aber auf **wgpus eigenem** Geraet.
//!
//! Das ist der Unterschied zur Nachbarprobe und der Grund, warum sie sich nicht
//! wiederverwenden liess: dort legt die Probe ihr eigenes `VkDevice` an. Hier
//! MUSS das Bild auf genau dem Geraet entstehen, das wgpu fuehrt — ein
//! `VkImage` gehoert unaufloesbar zu seinem `VkDevice`, und
//! `texture_from_raw` nimmt keins von einem fremden entgegen.
//!
//! Dass das ueberhaupt geht, haengt an `VK_KHR_external_memory_fd` — warum das
//! nicht angenommen, sondern abgefragt wird, steht bei `wgpu_aufbauen` in
//! `main.rs`, wo die Abfrage sitzt.
//!
//! Alle Befehle laufen ueber wgpus Warteschlange (`raw_queue`). Das ist
//! zulaessig, solange nichts anderes gleichzeitig darauf sendet — die Probe ist
//! einfaedig und leert wgpu vor jedem eigenen Absenden. Im Player waere das
//! anders und braeuchte Semaphoren; das steht als Auflage in der Messakte.

use anyhow::{bail, Context, Result};
use ash::vk;

/// Layout-Uebergaenge und die beiden Kopierwege. Kindmodul statt Nachbardatei,
/// damit die Felder von `Vkseite` privat bleiben koennen.
mod befehle;

pub struct Vkseite {
    /// Geklonte Griffe auf wgpus Geraet. `ash::Device` ist nur Handle plus
    /// Funktionstabelle; der Klon zerstoert beim Fallenlassen nichts.
    pub device: ash::Device,
    instance: ash::Instance,
    phys: vk::PhysicalDevice,
    queue: vk::Queue,
    familie: u32,
}

impl Vkseite {
    /// # Safety
    /// `device` muss zu `instance`/`phys`/`queue` gehoeren; alle vier werden aus
    /// demselben wgpu-Geraet entnommen.
    pub unsafe fn neu(
        device: ash::Device,
        instance: ash::Instance,
        phys: vk::PhysicalDevice,
        queue: vk::Queue,
        familie: u32,
    ) -> Self {
        Self { device, instance, phys, queue, familie }
    }

    /// Die UUID der Karte, die wgpu benutzt — zum Abgleich mit CUDA.
    pub fn uuid(&self) -> [u8; 16] {
        let mut id = vk::PhysicalDeviceIDProperties::default();
        let mut props = vk::PhysicalDeviceProperties2::default().push_next(&mut id);
        unsafe { self.instance.get_physical_device_properties2(self.phys, &mut props) };
        id.device_uuid
    }

    fn speichertyp(&self, erlaubt: u32, noetig: vk::MemoryPropertyFlags) -> Result<u32> {
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

    /// Ein exportierbares Bild anlegen — dieselbe Bauart wie in der
    /// Nachbarprobe (OPTIMAL gekachelt, dedizierte Allokation waehlbar), damit
    /// ein Unterschied im Ergebnis nicht an der Bauart des Bildes liegen kann.
    ///
    /// Die Nutzungsangabe traegt `SAMPLED`, weil wgpu genau das damit tun soll,
    /// und `TRANSFER_SRC|DST` fuer die eigenen Kontrollen. `STORAGE` ist
    /// bewusst dabei: die Nachbarprobe hatte es, und ein weggelassenes Bit
    /// aenderte womoeglich die Speicherlage.
    pub fn exportierbares_bild(
        &self,
        format: vk::Format,
        breite: u32,
        hoehe: u32,
        dediziert: bool,
    ) -> Result<Bild> {
        let mut ext_info = vk::ExternalMemoryImageCreateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
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
        // 18,5 Prozent mehr als die dichte Bildgroesse (gemessen, Messakte
        // player-2026-08-07). Wer `breite*hoehe*bytes` an CUDA weiterreicht,
        // liegt bis zu 18,5 Prozent daneben.
        let bedarf = unsafe { self.device.get_image_memory_requirements(image) };
        let typ = self.speichertyp(bedarf.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)?;
        let mut export = vk::ExportMemoryAllocateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let mut dedi = vk::MemoryDedicatedAllocateInfo::default().image(image);
        let mut info = vk::MemoryAllocateInfo::default()
            .allocation_size(bedarf.size)
            .memory_type_index(typ)
            .push_next(&mut export);
        if dediziert {
            info = info.push_next(&mut dedi);
        }
        let memory = unsafe { self.device.allocate_memory(&info, None) }?;
        unsafe { self.device.bind_image_memory(image, memory, 0) }?;

        let fd_api = ash::khr::external_memory_fd::Device::new(&self.instance, &self.device);
        let fd = unsafe {
            fd_api.get_memory_fd(
                &vk::MemoryGetFdInfoKHR::default()
                    .memory(memory)
                    .handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD),
            )
        }
        .context("vkGetMemoryFdKHR — ist VK_KHR_external_memory_fd am Geraet an?")?;

        Ok(Bild { image, memory, fd, alloc: bedarf.size, breite, hoehe })
    }

    /// Host-sichtbarer Zwischenspeicher zum Fuellen und Auslesen.
    pub fn ablage(&self, bytes: usize) -> Result<(vk::Buffer, vk::DeviceMemory)> {
        let puffer = unsafe {
            self.device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(bytes as u64)
                    .usage(vk::BufferUsageFlags::TRANSFER_SRC | vk::BufferUsageFlags::TRANSFER_DST)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE),
                None,
            )
        }?;
        let bedarf = unsafe { self.device.get_buffer_memory_requirements(puffer) };
        let typ = self.speichertyp(
            bedarf.memory_type_bits,
            vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
        )?;
        let mem = unsafe {
            self.device.allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(bedarf.size)
                    .memory_type_index(typ),
                None,
            )
        }?;
        unsafe { self.device.bind_buffer_memory(puffer, mem, 0) }?;
        Ok((puffer, mem))
    }


    pub fn lesen(&self, mem: vk::DeviceMemory, bytes: usize) -> Result<Vec<u8>> {
        unsafe {
            let p = self.device.map_memory(mem, 0, bytes as u64, vk::MemoryMapFlags::empty())?;
            let v = std::slice::from_raw_parts(p as *const u8, bytes).to_vec();
            self.device.unmap_memory(mem);
            Ok(v)
        }
    }

    pub fn schreiben(&self, mem: vk::DeviceMemory, daten: &[u8]) -> Result<()> {
        unsafe {
            let p =
                self.device.map_memory(mem, 0, daten.len() as u64, vk::MemoryMapFlags::empty())?;
            std::ptr::copy_nonoverlapping(daten.as_ptr(), p as *mut u8, daten.len());
            self.device.unmap_memory(mem);
        }
        Ok(())
    }
}

pub struct Bild {
    pub image: vk::Image,
    pub memory: vk::DeviceMemory,
    /// Wandert beim CUDA-Import in CUDAs Besitz — hier wird er NICHT
    /// geschlossen, ein doppeltes `close` fiele erst viel spaeter auf.
    pub fd: i32,
    /// Die vom Treiber **erfragte** Allokationsgroesse.
    pub alloc: u64,
    pub breite: u32,
    pub hoehe: u32,
}

