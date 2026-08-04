//! Eine D3D11-Textur nach Vulkan einführen — der Schritt, der die Brücke
//! wirklich schlägt.
//!
//! Steht getrennt von [`super`], weil es die längste zusammenhängende Mechanik
//! des Moduls ist und dort die Übersicht über den Ablauf verdeckte: dort die
//! Übergabe je Bild samt Reihenfolge, hier der einmalige Import je Textur.
//!
//! Aufgerufen wird das genau einmal je Pool-Textur; das Ergebnis liegt danach
//! im Cache (`VulkanImport::cache`). Bei 16 Pool-Texturen und 30 Bildern je
//! Sekunde ist das der Unterschied zwischen 16 Importen und 1800 je Minute.

use std::ffi::c_void;

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Graphics::Dxgi::IDXGIResource1;
use windows::core::Interface;

use super::VulkanImport;
use super::vk::*;

/// Ein importiertes Bild — eine D3D11-Textur, in Vulkan sichtbar gemacht.
pub(super) struct Importiert {
    pub(super) image: u64,
    pub(super) mem: u64,
    /// Der `AVVkFrame`, den der Encoder sieht. Heap-stabil, weil `AVFrame`
    /// nur einen Zeiger darauf hält.
    pub(super) vk: Box<AVVkFrame>,
    /// Bleibt offen, solange das Bild lebt — schliesst man ihn früher, zieht
    /// man dem Import den Boden weg.
    pub(super) _handle: HANDLE,
}

impl VulkanImport {
    pub(super) fn importiere(&mut self, tex: &ID3D11Texture2D) -> Result<Importiert> {
        let res: IDXGIResource1 = tex.cast()?;
        let handle = unsafe { res.CreateSharedHandle(None, 0x8000_0000, None) }
            .map_err(|e| anyhow!("CreateSharedHandle: {e}"))?;

        let exklusiv = pulse_win_hq_sidecar::env::flag("PULSE_LABOR_EXKLUSIV");
        // **Die Profil-Liste nur dann, wenn das Bild NICHT profilunabhängig
        // ist.** Bei `VIDEO_ENCODE_SRC_BIT` verlangt die Spezifikation eine von
        // beidem; profilunabhängig ist für ein importiertes Bild das Richtige
        // (Herleitung an [`super::VulkanImport::new`]), und dann wäre die Liste
        // sogar widersprüchlich — sie sagt „genau dieses Profil", das Bit sagt
        // „keines".
        let profilunabhaengig =
            self.img_flags & VK_IMAGE_CREATE_VIDEO_PROFILE_INDEPENDENT_BIT_KHR != 0;
        let ext = VkExternalMemoryImageCreateInfo {
            s_type: VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO,
            p_next: if profilunabhaengig { std::ptr::null() } else { self.profil.kette() },
            handle_types: VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT,
        };
        let ici = VkImageCreateInfo {
            s_type: VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
            p_next: &ext as *const _ as *const c_void,
            // **Beide von FFmpeg übernommen, nicht selbst gewählt** — s.
            // [`super::VulkanImport::new`].
            flags: self.img_flags,
            image_type: VK_IMAGE_TYPE_2D,
            format: self.vk_format,
            extent: VkExtent3D { width: self.breite, height: self.hoehe, depth: 1 },
            mip_levels: 1,
            array_layers: 1,
            samples: 1,
            tiling: VK_IMAGE_TILING_OPTIMAL,
            usage: self.usage,
            // **CONCURRENT über alle Queue-Familien, nicht EXCLUSIVE.**
            //
            // FFmpeg erzeugt seine eigenen Bilder so (`hwcontext_vulkan.c`:
            // `sharingMode = nb_img_qfs > 1 ? CONCURRENT : EXCLUSIVE`) und setzt
            // in seinen Barrieren `queueFamilyIndex = IGNORED`. Für ein
            // EXCLUSIVE-Bild ist das ungültig: dort gehört die Ressource genau
            // einer Familie, und ohne Eigentumsübergabe ist der Zugriff aus
            // einer anderen undefiniert.
            //
            // Wie sich das äußert, ist die eigentliche Lehre: NICHT als
            // Fehlermeldung an der Ursache, sondern als `VK_ERROR_DEVICE_LOST`
            // beim Absenden — und erst beim DRITTEN Bild, weil die ersten
            // beiden noch durchliefen. Wer hier nach einem Fehler im dritten
            // Bild sucht, sucht am falschen Ende.
            //
            // Alle Familien statt nur der genutzten: das ist immer zulässig,
            // kostet etwas Leistung und macht uns unabhängig von FFmpegs
            // privater Familienliste (`p->img_qfs` ist nicht öffentlich).
            //
            // **`PULSE_LABOR_EXKLUSIV=1` schaltet auf EXCLUSIVE** — zum Messen,
            // ob die geteilte Nutzung den Treiber in ein allgemeineres Layout
            // zwingt. Ohne den Schalter bleibt es bei CONCURRENT.
            sharing_mode: if exklusiv || self.queue_families.len() <= 1 {
                VK_SHARING_MODE_EXCLUSIVE
            } else {
                VK_SHARING_MODE_CONCURRENT
            },
            queue_family_index_count: if exklusiv { 0 } else { self.queue_families.len() as u32 },
            p_queue_family_indices: if exklusiv {
                std::ptr::null()
            } else {
                self.queue_families.as_ptr()
            },
            initial_layout: VK_IMAGE_LAYOUT_UNDEFINED,
        };
        let mut image: u64 = 0;
        let rc = unsafe { (self.fns.create_image)(self.act_dev, &ici, std::ptr::null(), &mut image) };
        if rc != VK_SUCCESS {
            return Err(anyhow!("vkCreateImage(extern) rc={rc}"));
        }

        let mut props = VkMemoryWin32HandlePropertiesKHR {
            s_type: VK_STRUCTURE_TYPE_MEMORY_WIN32_HANDLE_PROPERTIES_KHR,
            p_next: std::ptr::null_mut(),
            memory_type_bits: 0,
        };
        let rc = unsafe {
            (self.fns.get_mem_win32_props)(
                self.act_dev,
                VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT,
                handle.0,
                &mut props,
            )
        };
        if rc != VK_SUCCESS {
            unsafe { (self.fns.destroy_image)(self.act_dev, image, std::ptr::null()) };
            return Err(anyhow!("vkGetMemoryWin32HandlePropertiesKHR rc={rc}"));
        }

        let mut req = VkMemoryRequirements { size: 0, alignment: 0, memory_type_bits: 0 };
        unsafe { (self.fns.get_image_mem_req)(self.act_dev, image, &mut req) };
        let mut mem_props: VkPhysicalDeviceMemoryProperties = unsafe { std::mem::zeroed() };
        unsafe { (self.fns.get_phys_mem_props)(self.phys_dev, &mut mem_props) };
        let erlaubt = req.memory_type_bits & props.memory_type_bits;
        let idx = (0..mem_props.memory_type_count)
            .find(|i| erlaubt & (1 << i) != 0)
            .ok_or_else(|| {
                anyhow!(
                    "kein Speichertyp passt zu Bild ({:#x}) UND Handle ({:#x})",
                    req.memory_type_bits,
                    props.memory_type_bits
                )
            })?;

        let ded = VkMemoryDedicatedAllocateInfo {
            s_type: VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO,
            p_next: std::ptr::null(),
            image,
            buffer: 0,
        };
        let imp = VkImportMemoryWin32HandleInfoKHR {
            s_type: VK_STRUCTURE_TYPE_IMPORT_MEMORY_WIN32_HANDLE_INFO_KHR,
            p_next: &ded as *const _ as *const c_void,
            handle_type: VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT,
            handle: handle.0,
            name: std::ptr::null(),
        };
        let mai = VkMemoryAllocateInfo {
            s_type: VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
            p_next: &imp as *const _ as *const c_void,
            allocation_size: req.size,
            memory_type_index: idx,
        };
        let mut mem: u64 = 0;
        let rc =
            unsafe { (self.fns.allocate_memory)(self.act_dev, &mai, std::ptr::null(), &mut mem) };
        if rc != VK_SUCCESS {
            unsafe { (self.fns.destroy_image)(self.act_dev, image, std::ptr::null()) };
            return Err(anyhow!("vkAllocateMemory(Import) rc={rc}"));
        }
        let rc = unsafe { (self.fns.bind_image_memory)(self.act_dev, image, mem, 0) };
        if rc != VK_SUCCESS {
            unsafe {
                (self.fns.free_memory)(self.act_dev, mem, std::ptr::null());
                (self.fns.destroy_image)(self.act_dev, image, std::ptr::null());
            }
            return Err(anyhow!("vkBindImageMemory rc={rc}"));
        }

        // `internal` MUSS belegt sein. FFmpeg sperrt darin einen Mutex
        // (`hwcontext_vulkan.c`: `pthread_mutex_lock(&vkf->internal->update_mutex)`);
        // bei NULL ist das ein Nullzeiger-Zugriff, und der aeussert sich als
        // Absturz ohne jede Fehlermeldung — genau so ist die erste Fassung
        // dieser Verdrahtung gestorben.
        //
        // Genullt genuegt: FFmpegs `pthread_mutex_t` ist unter Windows ein
        // `SRWLOCK`, und dessen gueltiger Anfangszustand IST null
        // (`InitializeSRWLock` setzt genau das). Grosszuegig bemessen, weil die
        // Struktur je nach FFmpeg-Bauart (CUDA an/aus) laenger ist; wir fassen
        // ohnehin nur das erste Feld an. Ueber `av_mallocz`, damit ein
        // etwaiges `av_freep` von FFmpeg legal bliebe.
        const INTERNAL_RESERVE: usize = 512;
        let internal = unsafe { av_mallocz(INTERNAL_RESERVE) };
        if internal.is_null() {
            unsafe {
                (self.fns.free_memory)(self.act_dev, mem, std::ptr::null());
                (self.fns.destroy_image)(self.act_dev, image, std::ptr::null());
            }
            return Err(anyhow!("av_mallocz(AVVkFrameInternal) fehlgeschlagen"));
        }

        let sti = VkSemaphoreTypeCreateInfo {
            s_type: VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO,
            p_next: std::ptr::null(),
            semaphore_type: VK_SEMAPHORE_TYPE_TIMELINE,
            initial_value: 0,
        };
        let sci = VkSemaphoreCreateInfo {
            s_type: VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO,
            p_next: &sti as *const _ as *const c_void,
            flags: 0,
        };
        let mut sem: u64 = 0;
        let rc = unsafe { (self.fns.create_semaphore)(self.act_dev, &sci, std::ptr::null(), &mut sem) };
        if rc != VK_SUCCESS {
            return Err(anyhow!("vkCreateSemaphore(timeline) rc={rc}"));
        }

        let mut vk: Box<AVVkFrame> = Box::new(unsafe { std::mem::zeroed() });
        // `AV_VK_FRAME_FLAG_NONE` — trotz des Namens Bit 0, nicht 0. FFmpeg
        // setzt es an seinen eigenen Bildern; wir liessen das Feld auf 0.
        vk.flags = 1;
        vk.internal = internal;
        vk.img[0] = image;
        vk.mem[0] = mem;
        vk.size[0] = req.size as usize;
        vk.tiling = VK_IMAGE_TILING_OPTIMAL;
        vk.layout[0] = VK_IMAGE_LAYOUT_UNDEFINED;
        // Eigene Zeitleisten-Semaphore JE TEXTUR. Eine gemeinsame ginge nicht:
        // FFmpeg erhoeht `sem_value` je Bild, und die zweite Textur wollte dann
        // einen Wert signalisieren, der nicht groesser ist als der aktuelle.
        vk.sem[0] = sem;
        vk.sem_value[0] = 0;
        vk.queue_family[0] = VK_QUEUE_FAMILY_IGNORED;

        Ok(Importiert { image, mem, vk, _handle: handle })
    }
}
