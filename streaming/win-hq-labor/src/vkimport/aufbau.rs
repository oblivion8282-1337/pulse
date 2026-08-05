//! Der Aufbau des Importers — einmal je Stream.
//!
//! Steht getrennt von [`super`], weil es die zweite lange zusammenhängende
//! Mechanik des Moduls ist: dort die Übergabe je Bild, in [`super::einfuhr`]
//! der Import je Textur, hier das Gerät, der Frames-Kontext, die
//! Funktionszeiger und der Fence.

use std::collections::HashMap;
use std::ffi::{CString, c_void};

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_FENCE_FLAG_SHARED, ID3D11Device, ID3D11Device5, ID3D11DeviceContext4, ID3D11Fence,
};
use windows::Win32::System::Threading::CRITICAL_SECTION;
use windows::core::Interface;

use super::VulkanImport;
use super::profil::{Videocodec, Videoprofil};
use super::vk::*;

impl VulkanImport {
    /// `vk_format` ist [`VK_FORMAT_NV12`](super::VK_FORMAT_NV12) oder
    /// [`VK_FORMAT_P010`](super::VK_FORMAT_P010) und muss zum DXGI-Format der
    /// Pool-Texturen passen.
    ///
    /// `codec` sagt, für welchen Encoder die Bilder gedacht sind. Er landet im
    /// Video-Profil, das die Bild-Erzeugung nur noch als **Rückfall** braucht
    /// (s. unten und [`Videoprofil`]).
    ///
    /// # Warum die Bild-Flags von FFmpeg kommen und nicht von hier
    ///
    /// Ein importiertes Bild muss so angelegt werden, wie FFmpeg seine eigenen
    /// anlegt — sonst bekommt der Encoder zwei verschiedene Sorten Bild und
    /// verhält sich bei einer davon anders. Welche Flags und Zwecke das sind,
    /// rechnet `hwcontext_vulkan.c` je Frames-Kontext aus (`img_flags`,
    /// `usage`, `format[]`), und es sind nicht wenige:
    /// `MUTABLE_FORMAT | ALIAS | EXTENDED_USAGE`, dazu
    /// `VIDEO_PROFILE_INDEPENDENT`, sobald das Bild Encode-Quelle sein soll und
    /// keine Profil-Liste mitgegeben wurde — und die Zwecke Sampled, Storage,
    /// Transfer und Video-Encode-Quelle.
    ///
    /// Deshalb wird hier **nichts nachgebaut, sondern zurückgelesen**:
    /// `av_hwframe_ctx_init` füllt den [`AVVulkanFramesContext`], und genau
    /// diese Werte gehen in unsere `VkImageCreateInfo`. Das hat zwei Vorteile,
    /// die beide teuer erkauft sind:
    ///
    /// * **Es kann sich nicht verrechnen.** Die selbst gepflegte Fassung hatte
    ///   `VIDEO_ENCODE_SRC` auf `0x2000` stehen — das ist `VIDEO_ENCODE_DST`.
    ///   Das Bild trug den Quell-Zweck also gar nicht, und niemand hat es
    ///   gemerkt: `vkCreateImage` nimmt beides an, und ein Bild kam trotzdem
    ///   heraus.
    /// * **Es setzt kein Bit, dessen Erweiterung fehlt.**
    ///   `VIDEO_PROFILE_INDEPENDENT` braucht `VK_KHR_video_maintenance1`;
    ///   FFmpeg prüft das, bevor es das Bit einträgt, und wir erben die
    ///   Prüfung.
    ///
    /// Der Preis: `create_pnext` muss leer bleiben, sonst rechnete FFmpeg mit
    /// Profil-Liste und ohne das Bit. Das Profil bleibt trotzdem gebaut — fehlt
    /// die Erweiterung, ist die Liste Pflicht, und dann hängt
    /// [`VulkanImport::importiere`](super::VulkanImport) sie an.
    ///
    /// **Was das NICHT behebt:** das magentafarbene 10-Bit-Bild. Der Verdacht
    /// lag lange hier, und er war falsch — gemessen am 2026-08-02, Einzelheiten
    /// an [`crate::vulkan_encoder`]. Die Angleichung ist trotzdem richtig; sie
    /// ist nur nicht die Ursache gewesen.
    ///
    /// `lock_ptr` ist die `CRITICAL_SECTION` des Pools, aus dem die Texturen
    /// stammen. **Sie ist nicht Zierrat:** dieser Import gibt Befehle auf dem
    /// *immediate* `ID3D11DeviceContext` (`Signal`, `Flush`), und derselbe
    /// Kontext trägt bereits die Aufnahme-Kopie auf dem WGC-Faden und den Blt.
    /// Der immediate Kontext ist nicht thread-sicher; ohne die Section ist das
    /// ein Datenrennen, und das zeigt sich als sporadisch zerrissenes Bild,
    /// nicht als Absturz.
    ///
    /// # Safety
    ///
    /// `lock_ptr` zeigt auf eine gültige `CRITICAL_SECTION`, die länger lebt
    /// als dieser Importer.
    pub unsafe fn new(
        d3d_device: &ID3D11Device,
        d3d_ctx: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
        lock_ptr: *mut CRITICAL_SECTION,
        breite: u32,
        hoehe: u32,
        vk_format: i32,
        codec: Videocodec,
    ) -> Result<Self> {
        let mut device_ref: *mut AVBufferRef = std::ptr::null_mut();
        let rc = unsafe {
            av_hwdevice_ctx_create(
                &mut device_ref,
                AVHWDeviceType::AV_HWDEVICE_TYPE_VULKAN,
                std::ptr::null(),
                std::ptr::null_mut(),
                0,
            )
        };
        if rc < 0 || device_ref.is_null() {
            return Err(anyhow!("av_hwdevice_ctx_create(VULKAN) rc={rc}"));
        }

        let (act_dev, phys_dev, inst, gpa) = unsafe {
            let hdr = (*device_ref).data as *mut AVHWDeviceContext;
            let vk = (*hdr).hwctx as *mut AVVulkanDeviceContextHead;
            ((*vk).act_dev, (*vk).phys_dev, (*vk).inst, (*vk).get_proc_addr)
        };
        let gpa = gpa.ok_or_else(|| anyhow!("FFmpeg lieferte keinen get_proc_addr"))?;

        macro_rules! hole {
            ($name:literal, $t:ty) => {{
                let n = CString::new($name).unwrap();
                // SAFETY: `inst` stammt aus FFmpegs Gerätekontext und ist gültig.
                let p = unsafe { gpa(inst, n.as_ptr()) };
                if p.is_null() {
                    return Err(anyhow!(concat!($name, " nicht auflösbar")));
                }
                // SAFETY: Vulkan garantiert die Signatur zum Namen.
                unsafe { std::mem::transmute::<*const c_void, $t>(p) }
            }};
        }
        let fns = VkFns {
            create_image: hole!("vkCreateImage", PfnCreateImage),
            destroy_image: hole!("vkDestroyImage", PfnDestroyImage),
            allocate_memory: hole!("vkAllocateMemory", PfnAllocateMemory),
            free_memory: hole!("vkFreeMemory", PfnFreeMemory),
            bind_image_memory: hole!("vkBindImageMemory", PfnBindImageMemory),
            get_image_mem_req: hole!("vkGetImageMemoryRequirements", PfnGetImageMemReq),
            get_mem_win32_props: hole!("vkGetMemoryWin32HandlePropertiesKHR", PfnGetMemWin32Props),
            get_phys_mem_props: hole!("vkGetPhysicalDeviceMemoryProperties", PfnGetPhysMemProps),
            get_queue_family_props: hole!(
                "vkGetPhysicalDeviceQueueFamilyProperties",
                PfnGetQueueFamilyProps
            ),
            create_semaphore: hole!("vkCreateSemaphore", PfnCreateSemaphore),
            destroy_semaphore: hole!("vkDestroySemaphore", PfnDestroySemaphore),
            wait_semaphores: hole!("vkWaitSemaphores", PfnWaitSemaphores),
        };

        // Frames-Kontext ohne eigenen Pool: unsere Bilder kommen von aussen.
        // `initial_pool_size = 0` verhindert, dass FFmpeg daneben ungenutzte
        // Bilder allokiert.
        let frames_ref = unsafe { av_hwframe_ctx_alloc(device_ref) };
        if frames_ref.is_null() {
            unsafe { av_buffer_unref(&mut { device_ref }) };
            return Err(anyhow!("av_hwframe_ctx_alloc(VULKAN) returned NULL"));
        }
        let (img_flags, usage, ff_format) = unsafe {
            let hdr = (*frames_ref).data as *mut AVHWFramesContext;
            (*hdr).format = AVPixelFormat::AV_PIX_FMT_VULKAN;
            (*hdr).sw_format = if vk_format == VK_FORMAT_P010 {
                AVPixelFormat::AV_PIX_FMT_P010LE
            } else {
                AVPixelFormat::AV_PIX_FMT_NV12
            };
            (*hdr).width = breite as i32;
            (*hdr).height = hoehe as i32;
            (*hdr).initial_pool_size = 0;
            let rc = av_hwframe_ctx_init(frames_ref);
            if rc < 0 {
                av_buffer_unref(&mut { frames_ref });
                av_buffer_unref(&mut { device_ref });
                return Err(anyhow!("av_hwframe_ctx_init(VULKAN) rc={rc}"));
            }
            // **Was FFmpeg für DIESEN Kontext ausgerechnet hat, zurücklesen.**
            //
            // Der Encode-Zweck wird ausdrücklich dazugesetzt, obwohl FFmpeg ihn
            // hier ohnehin einträgt (gemessen: `usage = 0x400f`, das Bit ist
            // drin). Er ist die einzige Anforderung, die aus UNSERER Verwendung
            // folgt und nicht aus dem Frames-Kontext; ohne ihn wäre das Bild als
            // Encoder-Quelle unbrauchbar, und dann soll `vkCreateImage`
            // scheitern statt der Encoder still danebenzugreifen. Genau EINMAL
            // hier, damit die Log-Zeile den Wert zeigt, der auch benutzt wird.
            let fc = (*hdr).hwctx as *const AVVulkanFramesContext;
            (
                (*fc).img_flags,
                (*fc).usage | VK_IMAGE_USAGE_VIDEO_ENCODE_SRC_BIT_KHR,
                (*fc).format[0],
            )
        };
        // Ein anderes Format hiesse: FFmpeg legt die Ebenen auf MEHRERE Bilder,
        // unser Import liefert aber genau eines. Das ginge lautlos schief.
        if ff_format != vk_format {
            unsafe {
                av_buffer_unref(&mut { frames_ref });
                av_buffer_unref(&mut { device_ref });
            }
            return Err(anyhow!(
                "FFmpeg erwartet VkFormat {ff_format} fuer diesen Kontext, \
                 importiert wird {vk_format}"
            ));
        }
        eprintln!(
            "[vkimport] Bild-Erzeugung wie FFmpeg: img_flags={img_flags:#x} usage={usage:#x} \
             profilunabhaengig={}",
            img_flags & VK_IMAGE_CREATE_VIDEO_PROFILE_INDEPENDENT_BIT_KHR != 0
        );

        // Fence nur für das kurze Warten auf der CPU — NICHT nach Vulkan
        // importiert (Begründung an `VulkanImport::uebergib`). `SHARED` bleibt
        // gesetzt, damit ein späterer Anlauf über den Import ohne Umbau
        // möglich ist.
        let dev5: ID3D11Device5 = d3d_device.cast()?;
        let mut fence_opt: Option<ID3D11Fence> = None;
        unsafe { dev5.CreateFence(0, D3D11_FENCE_FLAG_SHARED, &mut fence_opt) }
            .map_err(|e| anyhow!("CreateFence(SHARED): {e}"))?;
        let fence = fence_opt.ok_or_else(|| anyhow!("CreateFence lieferte nichts"))?;
        let ereignis =
            unsafe { windows::Win32::System::Threading::CreateEventW(None, false, false, None) }
                .map_err(|e| anyhow!("CreateEventW: {e}"))?;

        // Familien einmal abfragen; die Liste aendert sich zur Laufzeit nicht.
        let mut anzahl: u32 = 0;
        unsafe { (fns.get_queue_family_props)(phys_dev, &mut anzahl, std::ptr::null_mut()) };
        let queue_families: Vec<u32> = (0..anzahl).collect();

        let ctx4: ID3D11DeviceContext4 = d3d_ctx.cast()?;

        Ok(Self {
            device_ref,
            frames_ref,
            act_dev,
            phys_dev,
            fns,
            fence,
            ereignis,
            ctx4,
            lock_ptr,
            cache: HashMap::new(),
            timeline: 0,
            queue_families,
            img_flags,
            usage,
            vk_format,
            profil: Videoprofil::neu(codec, vk_format == VK_FORMAT_P010),
            breite,
            hoehe,
        })
    }
}
