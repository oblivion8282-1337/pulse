//! Die Vulkan-Seite der Probe: Geraet aufbauen, exportierbaren Speicher und
//! exportierbare Bilder anlegen, Inhalte hinein- und herausschaffen.
//!
//! Hier steckt bewusst kein Urteil und keine Pruefung — nur Handwerk. Was
//! geprueft wird, steht in `puffer.rs` und `bild.rs`.

use anyhow::{bail, Context, Result};
use ash::vk;

pub struct Vulkan {
    _entry: ash::Entry,
    pub instance: ash::Instance,
    pub device: ash::Device,
    phys: vk::PhysicalDevice,
    queue: vk::Queue,
    queue_familie: u32,
    pub uuid: [u8; 16],
    /// Ob das Geraet mehrplanige YCbCr-Formate zulaesst. Ohne diese Faehigkeit
    /// darf `VK_FORMAT_G8_B8R8_2PLANE_420_UNORM` gar nicht erst angelegt
    /// werden — der Ein-Bild-Versuch in `bild.rs` waere dann nicht "gescheitert",
    /// sondern "nicht durchgefuehrt", und das ist ein Unterschied.
    pub ycbcr: bool,
}

impl Vulkan {
    pub fn aufbauen() -> Result<Self> {
        let entry = unsafe { ash::Entry::load() }.context("Vulkan-Laufzeit nicht ladbar")?;
        let app = vk::ApplicationInfo::default()
            .api_version(vk::API_VERSION_1_2)
            .application_name(c"cuda-vulkan-import");
        let instance = unsafe {
            entry.create_instance(&vk::InstanceCreateInfo::default().application_info(&app), None)
        }
        .context("vkCreateInstance")?;

        let phys_liste = unsafe { instance.enumerate_physical_devices() }?;
        // Die Karte wird ueber die UUID gewaehlt, die auch CUDA meldet — auf
        // einer Maschine mit zwei GPUs waere "die erste" sonst womoeglich eine
        // andere als die, die CUDA benutzt, und der Import scheiterte aus einem
        // Grund, der nichts mit der Sache zu tun hat.
        let mut gewaehlt = None;
        for p in phys_liste {
            let mut id = vk::PhysicalDeviceIDProperties::default();
            let mut props = vk::PhysicalDeviceProperties2::default().push_next(&mut id);
            unsafe { instance.get_physical_device_properties2(p, &mut props) };
            let name = unsafe { std::ffi::CStr::from_ptr(props.properties.device_name.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            println!("  Vulkan-Geraet: {name}  UUID {}", super::hex(&id.device_uuid));
            if gewaehlt.is_none() {
                gewaehlt = Some((p, id.device_uuid, name));
            }
        }
        let (phys, uuid, name) = gewaehlt.context("keine Vulkan-faehige Karte gefunden")?;
        println!("  gewaehlt: {name}");

        // Grafik-faehige Familie bevorzugen: eine reine Transfer-Familie darf
        // laut Spezifikation weniger (Layout-Uebergaenge, Pipeline-Stufen), und
        // ein Fehlschlag daran haette mit der Frage nichts zu tun. Auf NVIDIA
        // ist beides ohnehin Familie 0, der Puffer-Weg misst also unveraendert
        // dasselbe wie vor der Erweiterung.
        let familien = unsafe { instance.get_physical_device_queue_family_properties(phys) };
        let queue_familie = familien
            .iter()
            .position(|f| f.queue_flags.contains(vk::QueueFlags::GRAPHICS))
            .or_else(|| familien.iter().position(|f| f.queue_flags.contains(vk::QueueFlags::TRANSFER)))
            .context("keine Queue-Familie mit Grafik oder Transfer")? as u32;

        // Mehrplanige Formate haengen an dieser Faehigkeit. Abgefragt statt
        // angenommen: wer sie beim Geraet anfordert, ohne dass sie da ist,
        // bekommt kein Geraet — und damit auch keinen Puffer-Befund mehr.
        let mut vk11 = vk::PhysicalDeviceVulkan11Features::default();
        let mut merkmale = vk::PhysicalDeviceFeatures2::default().push_next(&mut vk11);
        unsafe { instance.get_physical_device_features2(phys, &mut merkmale) };
        let ycbcr = vk11.sampler_ycbcr_conversion == vk::TRUE;

        let prio = [1.0f32];
        let qinfo = [vk::DeviceQueueCreateInfo::default()
            .queue_family_index(queue_familie)
            .queue_priorities(&prio)];
        // `VK_KHR_external_memory_fd` ist der Kern der Sache: ohne sie gibt es
        // keinen Dateideskriptor zum Weiterreichen. `external_memory` selbst ist
        // seit Vulkan 1.1 Kernbestand und braucht keine Anforderung.
        let ext = [c"VK_KHR_external_memory_fd".as_ptr()];
        let mut an = vk::PhysicalDeviceVulkan11Features::default().sampler_ycbcr_conversion(ycbcr);
        let device = unsafe {
            instance.create_device(
                phys,
                &vk::DeviceCreateInfo::default()
                    .queue_create_infos(&qinfo)
                    .enabled_extension_names(&ext)
                    .push_next(&mut an),
                None,
            )
        }
        .context("vkCreateDevice — fehlt VK_KHR_external_memory_fd?")?;
        let queue = unsafe { device.get_device_queue(queue_familie, 0) };

        Ok(Self { _entry: entry, instance, device, phys, queue, queue_familie, uuid, ycbcr })
    }

    /// Speichertyp mit den geforderten Eigenschaften suchen.
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

    /// Geraetelokalen, exportierbaren Speicher fuer einen Bedarf zuteilen.
    ///
    /// Geraetespeicher, weil das die Lage der spaeteren Zieltextur ist — ein
    /// host-sichtbarer Speicher waere ein anderer Fall und wuerde die Frage
    /// nicht beantworten.
    ///
    /// `dedi` wird durchgereicht statt hier entschieden: ob dediziert alloziert
    /// wird, MUSS die aufrufende Seite bestimmen, weil dieselbe Entscheidung
    /// beim CUDA-Import noch einmal faellt und beide uebereinstimmen muessen
    /// (Begruendung an `CUDA_EXTERNAL_MEMORY_DEDICATED`). Puffer und Bild
    /// beschreiben ihr Ziel unterschiedlich, der Rest der Zuteilung ist fuer
    /// beide derselbe.
    fn exportierbar_zuteilen(
        &self,
        bedarf: vk::MemoryRequirements,
        dedi: Option<&mut vk::MemoryDedicatedAllocateInfo<'_>>,
    ) -> Result<vk::DeviceMemory> {
        let typ = self.speichertyp(bedarf.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)?;
        let mut export = vk::ExportMemoryAllocateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let mut info = vk::MemoryAllocateInfo::default()
            .allocation_size(bedarf.size)
            .memory_type_index(typ)
            .push_next(&mut export);
        if let Some(d) = dedi {
            info = info.push_next(d);
        }
        Ok(unsafe { self.device.allocate_memory(&info, None) }?)
    }

    /// Puffer im Geraetespeicher anlegen und seinen Speicher exportierbar
    /// machen.
    pub fn exportierbarer_puffer(
        &self,
        bytes: usize,
        dediziert: bool,
    ) -> Result<(vk::Buffer, vk::DeviceMemory, i32)> {
        let mut ext_info = vk::ExternalMemoryBufferCreateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let puffer = unsafe {
            self.device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(bytes as u64)
                    .usage(vk::BufferUsageFlags::TRANSFER_SRC | vk::BufferUsageFlags::TRANSFER_DST)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .push_next(&mut ext_info),
                None,
            )
        }?;

        let bedarf = unsafe { self.device.get_buffer_memory_requirements(puffer) };
        let mut dedi = vk::MemoryDedicatedAllocateInfo::default().buffer(puffer);
        let speicher = self.exportierbar_zuteilen(bedarf, dediziert.then_some(&mut dedi))?;
        unsafe { self.device.bind_buffer_memory(puffer, speicher, 0) }?;
        Ok((puffer, speicher, self.deskriptor(speicher)?))
    }

    /// Bild im GERAETESPEICHER anlegen und seinen Speicher exportierbar machen.
    ///
    /// `VK_IMAGE_TILING_OPTIMAL` ist Absicht und keine Bequemlichkeit: das
    /// offizielle NVIDIA-Beispiel `vulkanImageCUDA` nutzt es, und zu `LINEAR`
    /// gibt es den Nutzerbericht, `cuExternalMemoryGetMappedMipmappedArray`
    /// weise es mit `CUDA_ERROR_INVALID_VALUE` ab (NVIDIA-Forum 236523; nicht
    /// von NVIDIA bestaetigt). Genau die undurchsichtige Kachelung ist auch der
    /// Grund, warum CUDA hier ein Array braucht und nicht einfach in den rohen
    /// Speicher schreiben kann.
    ///
    /// Rueckgabe schliesst die Allokationsgroesse ein — CUDA muss beim Import
    /// **diese** Zahl bekommen, nicht `breite * hoehe * bytes`: Kachelung und
    /// Ausrichtung machen die Allokation regelmaessig groesser.
    pub fn exportierbares_bild(
        &self,
        format: vk::Format,
        breite: u32,
        hoehe: u32,
        dediziert: bool,
    ) -> Result<(vk::Image, vk::DeviceMemory, i32, u64)> {
        let mut ext_info = vk::ExternalMemoryImageCreateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let bild = unsafe {
            self.device.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(format)
                    .extent(vk::Extent3D { width: breite, height: hoehe, depth: 1 })
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    // Dieselbe Kombination wie im NVIDIA-Beispiel. `SAMPLED` ist
                    // die spaetere Nutzung im Player (ein Shader tastet ab),
                    // `TRANSFER_*` braucht die Probe zum Vor- und Auslesen.
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

        let bedarf = unsafe { self.device.get_image_memory_requirements(bild) };
        let mut dedi = vk::MemoryDedicatedAllocateInfo::default().image(bild);
        let speicher = self.exportierbar_zuteilen(bedarf, dediziert.then_some(&mut dedi))?;
        unsafe { self.device.bind_image_memory(bild, speicher, 0) }?;
        Ok((bild, speicher, self.deskriptor(speicher)?, bedarf.size))
    }

    /// Den Dateideskriptor zu einer Allokation holen.
    ///
    /// Er gehoert danach UNS; CUDA uebernimmt ihn beim Import und schliesst ihn
    /// selbst. Deshalb wird er hier nicht geschlossen — ein doppeltes `close`
    /// waere ein Fehler, der erst viel spaeter auffiele.
    fn deskriptor(&self, speicher: vk::DeviceMemory) -> Result<i32> {
        let fd_api = ash::khr::external_memory_fd::Device::new(&self.instance, &self.device);
        Ok(unsafe {
            fd_api.get_memory_fd(
                &vk::MemoryGetFdInfoKHR::default()
                    .memory(speicher)
                    .handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD),
            )
        }?)
    }

    /// Host-sichtbarer Puffer zum Hinein- und Herauskopieren.
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
        let speicher = unsafe {
            self.device.allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(bedarf.size)
                    .memory_type_index(typ),
                None,
            )
        }?;
        unsafe { self.device.bind_buffer_memory(puffer, speicher, 0) }?;
        Ok((puffer, speicher))
    }

    /// Befehle aufzeichnen, abschicken und auf ihr Ende warten.
    ///
    /// Das Warten ist grob, aber hier richtig: die Probe will einen sauber
    /// getrennten Ablauf schreiben-warten-lesen. Im Betrieb schreibt der
    /// Decoder, waehrend gezeichnet wird — dafuer braucht es Semaphoren ueber
    /// dieselbe Grenze (`VK_KHR_external_semaphore_fd`), und das ist bewusst
    /// NICHT Gegenstand dieser Probe.
    pub fn mit_befehlen(&self, f: impl FnOnce(vk::CommandBuffer)) -> Result<()> {
        let pool = unsafe {
            self.device.create_command_pool(
                &vk::CommandPoolCreateInfo::default().queue_family_index(self.queue_familie),
                None,
            )
        }?;
        let cb = unsafe {
            self.device.allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1),
            )
        }?[0];
        unsafe {
            self.device.begin_command_buffer(
                cb,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )?;
            f(cb);
            self.device.end_command_buffer(cb)?;
            let cbs = [cb];
            let submit = [vk::SubmitInfo::default().command_buffers(&cbs)];
            self.device.queue_submit(self.queue, &submit, vk::Fence::null())?;
            self.device.queue_wait_idle(self.queue)?;
            self.device.destroy_command_pool(pool, None);
        }
        Ok(())
    }

    /// Eine Puffer-zu-Puffer-Kopie ausfuehren und auf ihr Ende warten.
    pub fn kopieren(&self, von: vk::Buffer, nach: vk::Buffer, bytes: usize) -> Result<()> {
        self.mit_befehlen(|cb| unsafe {
            self.device.cmd_copy_buffer(
                cb,
                von,
                nach,
                &[vk::BufferCopy::default().size(bytes as u64)],
            );
        })
    }

    /// Das Bild einmalig nach `GENERAL` bringen.
    ///
    /// `GENERAL` ist die einzige Wahl, die sowohl den Zugriff von aussen als
    /// auch `vkCmdCopy*Image` zulaesst. Welches Layout CUDA beim Schreiben
    /// erwartet, ist **nirgends dokumentiert** — weder im Header noch im
    /// NVIDIA-Beispiel; `GENERAL` ist die konservative Annahme, und ein
    /// Fehlgriff hier saehe man an verfaelschten Bildpunkten.
    pub fn nach_allgemein(&self, bild: vk::Image, aspekt: vk::ImageAspectFlags) -> Result<()> {
        self.mit_befehlen(|cb| unsafe {
            self.device.cmd_pipeline_barrier(
                cb,
                vk::PipelineStageFlags::TOP_OF_PIPE,
                vk::PipelineStageFlags::ALL_COMMANDS,
                vk::DependencyFlags::empty(),
                &[],
                &[],
                &[vk::ImageMemoryBarrier::default()
                    .old_layout(vk::ImageLayout::UNDEFINED)
                    .new_layout(vk::ImageLayout::GENERAL)
                    .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                    .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                    .image(bild)
                    .dst_access_mask(vk::AccessFlags::MEMORY_WRITE | vk::AccessFlags::MEMORY_READ)
                    .subresource_range(bereich(aspekt))],
            );
        })
    }

    /// Puffer nach Bild — der Weg, den man nehmen MUESSTE, wenn der direkte
    /// Bild-Import nicht traegt. Er wird hier nicht nur als Rueckfallweg
    /// gebraucht, sondern auch zum Vorfuellen: ein Bild mit erkennbarem
    /// Vorher-Wert unterscheidet "CUDA hat richtig geschrieben" von
    /// "CUDA hat gar nichts geschrieben, und der Vergleich schaut auf Nullen".
    pub fn puffer_nach_bild(
        &self,
        quelle: vk::Buffer,
        bild: vk::Image,
        aspekt: vk::ImageAspectFlags,
        breite: u32,
        hoehe: u32,
    ) -> Result<()> {
        self.mit_befehlen(|cb| unsafe {
            self.device.cmd_copy_buffer_to_image(
                cb,
                quelle,
                bild,
                vk::ImageLayout::GENERAL,
                &[bereich_kopie(aspekt, breite, hoehe)],
            );
        })
    }

    /// Bild nach Puffer — so wird nach dem CUDA-Schreibzugriff ausgelesen.
    ///
    /// Die Sperre davor ist keine Foermelei: CUDA hat ausserhalb jeder
    /// Vulkan-Warteschlange geschrieben, und ohne sichtbar gemachten
    /// Schreibzugriff darf der Treiber aus einem Zwischenspeicher lesen.
    pub fn bild_nach_puffer(
        &self,
        bild: vk::Image,
        ziel: vk::Buffer,
        aspekt: vk::ImageAspectFlags,
        breite: u32,
        hoehe: u32,
    ) -> Result<()> {
        self.mit_befehlen(|cb| unsafe {
            self.device.cmd_pipeline_barrier(
                cb,
                vk::PipelineStageFlags::ALL_COMMANDS,
                vk::PipelineStageFlags::TRANSFER,
                vk::DependencyFlags::empty(),
                &[],
                &[],
                &[vk::ImageMemoryBarrier::default()
                    .old_layout(vk::ImageLayout::GENERAL)
                    .new_layout(vk::ImageLayout::GENERAL)
                    .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                    .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                    .image(bild)
                    .src_access_mask(vk::AccessFlags::MEMORY_WRITE)
                    .dst_access_mask(vk::AccessFlags::TRANSFER_READ)
                    .subresource_range(bereich(aspekt))],
            );
            self.device.cmd_copy_image_to_buffer(
                cb,
                bild,
                vk::ImageLayout::GENERAL,
                ziel,
                &[bereich_kopie(aspekt, breite, hoehe)],
            );
        })
    }

    pub fn lesen(&self, speicher: vk::DeviceMemory, bytes: usize) -> Result<Vec<u8>> {
        unsafe {
            let p =
                self.device.map_memory(speicher, 0, bytes as u64, vk::MemoryMapFlags::empty())?;
            let v = std::slice::from_raw_parts(p as *const u8, bytes).to_vec();
            self.device.unmap_memory(speicher);
            Ok(v)
        }
    }

    pub fn schreiben(&self, speicher: vk::DeviceMemory, daten: &[u8]) -> Result<()> {
        unsafe {
            let p = self.device.map_memory(
                speicher,
                0,
                daten.len() as u64,
                vk::MemoryMapFlags::empty(),
            )?;
            std::ptr::copy_nonoverlapping(daten.as_ptr(), p as *mut u8, daten.len());
            self.device.unmap_memory(speicher);
        }
        Ok(())
    }
}

fn bereich(aspekt: vk::ImageAspectFlags) -> vk::ImageSubresourceRange {
    vk::ImageSubresourceRange::default().aspect_mask(aspekt).level_count(1).layer_count(1)
}

/// `buffer_row_length`/`buffer_image_height` bleiben 0: das heisst "dicht
/// gepackt nach `image_extent`". Damit ist die Zeilenlaenge auf der Puffer-
/// Seite genau `breite * bytes_je_texel`, und der Vergleich braucht keine
/// Annahme ueber eine Ausrichtung, die er falsch treffen koennte.
fn bereich_kopie(
    aspekt: vk::ImageAspectFlags,
    breite: u32,
    hoehe: u32,
) -> vk::BufferImageCopy {
    vk::BufferImageCopy::default()
        .image_subresource(
            vk::ImageSubresourceLayers::default().aspect_mask(aspekt).layer_count(1),
        )
        .image_extent(vk::Extent3D { width: breite, height: hoehe, depth: 1 })
}
