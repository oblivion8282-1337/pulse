//! Probe: laesst sich eine D3D11-NV12-Textur zero-copy nach Vulkan importieren?
//!
//! **Die Frage, an der der ganze Vulkan-Weg haengt.** WGC liefert D3D11;
//! Intra-Refresh gibt es auf AMD/Windows nur ueber Vulkan (gemessen). FFmpeg
//! hat fuer D3D11 keine Bruecke — seine Vulkan-Schicht kennt nur DRM, VAAPI
//! und CUDA. Also selbst bauen: Textur als NT-Handle teilen, in Vulkan
//! importieren, an ein VkImage binden.
//!
//! Der Treiber bietet `VK_KHR_external_memory_win32` an (geprueft). Ob er auch
//! ein MEHRPLANIGES Format (NV12) ueber diesen Weg annimmt, ist die offene
//! Frage — und sie entscheidet, ob der Sendeweg zero-copy bleiben kann oder
//! ueber die CPU muss.
//!
//! Geprueft wird ohne Capture, ohne Encoder, ohne Server: eine Textur, ein
//! Import, ein Ergebnis.
//!
//!     cargo run --release --example probe_d3d11_vulkan_import

use std::ffi::{CString, c_void};

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11CreateDevice, ID3D11Device,
    ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIResource1;
use windows::core::Interface;

// ── Vulkan von Hand, wie die AVD3D11VA*-Spiegel im Sidecar. Kein `ash`:
//    das waere eine neue Abhaengigkeit, und alles Noetige kommt ohnehin ueber
//    FFmpegs `get_proc_addr`. ────────────────────────────────────────────────

const VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO: i32 = 14;
const VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO: i32 = 5;
const VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO: i32 = 1_000_072_001;
const VK_STRUCTURE_TYPE_IMPORT_MEMORY_WIN32_HANDLE_INFO_KHR: i32 = 1_000_073_000;
const VK_STRUCTURE_TYPE_MEMORY_WIN32_HANDLE_PROPERTIES_KHR: i32 = 1_000_073_002;
const VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO: i32 = 1_000_127_001;

const VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT: u32 = 0x0000_0008;
/// `VK_FORMAT_G8_B8R8_2PLANE_420_UNORM` — das Vulkan-Gegenstueck zu NV12.
const VK_FORMAT_G8_B8R8_2PLANE_420_UNORM: i32 = 1_000_156_003;
/// `VK_FORMAT_G10X6_B10X6R10X6_2PLANE_420_UNORM_3PACK16` - das Vulkan-
/// Gegenstueck zu P010 (10 bit).
const VK_FORMAT_G10X6_B10X6R10X6_2PLANE_420_UNORM_3PACK16: i32 = 1_000_156_013;
const VK_IMAGE_TYPE_2D: i32 = 1;
const VK_IMAGE_TILING_OPTIMAL: i32 = 0;
const VK_SHARING_MODE_EXCLUSIVE: i32 = 0;
const VK_IMAGE_LAYOUT_UNDEFINED: i32 = 0;
const VK_IMAGE_USAGE_SAMPLED_BIT: u32 = 0x0000_0004;
const VK_IMAGE_USAGE_TRANSFER_SRC_BIT: u32 = 0x0000_0001;
const VK_IMAGE_USAGE_TRANSFER_DST_BIT: u32 = 0x0000_0002;
const VK_SUCCESS: i32 = 0;

#[repr(C)]
struct VkExtent3D {
    width: u32,
    height: u32,
    depth: u32,
}

#[repr(C)]
struct VkExternalMemoryImageCreateInfo {
    s_type: i32,
    p_next: *const c_void,
    handle_types: u32,
}

#[repr(C)]
struct VkImageCreateInfo {
    s_type: i32,
    p_next: *const c_void,
    flags: u32,
    image_type: i32,
    format: i32,
    extent: VkExtent3D,
    mip_levels: u32,
    array_layers: u32,
    samples: u32,
    tiling: i32,
    usage: u32,
    sharing_mode: i32,
    queue_family_index_count: u32,
    p_queue_family_indices: *const u32,
    initial_layout: i32,
}

#[repr(C)]
struct VkImportMemoryWin32HandleInfoKHR {
    s_type: i32,
    p_next: *const c_void,
    handle_type: u32,
    handle: *mut c_void,
    name: *const u16,
}

#[repr(C)]
struct VkMemoryDedicatedAllocateInfo {
    s_type: i32,
    p_next: *const c_void,
    image: u64,
    buffer: u64,
}

#[repr(C)]
struct VkMemoryAllocateInfo {
    s_type: i32,
    p_next: *const c_void,
    allocation_size: u64,
    memory_type_index: u32,
}

#[repr(C)]
struct VkMemoryWin32HandlePropertiesKHR {
    s_type: i32,
    p_next: *mut c_void,
    memory_type_bits: u32,
}

#[repr(C)]
struct VkMemoryType {
    property_flags: u32,
    heap_index: u32,
}

#[repr(C)]
struct VkMemoryHeap {
    size: u64,
    flags: u32,
}

#[repr(C)]
struct VkPhysicalDeviceMemoryProperties {
    memory_type_count: u32,
    memory_types: [VkMemoryType; 32],
    memory_heap_count: u32,
    memory_heaps: [VkMemoryHeap; 16],
}

/// Die Felder von `AVVulkanDeviceContext`, die wir brauchen — in der
/// Reihenfolge des Headers. Wie die AVD3D11VA-Spiegel im Sidecar: bricht das
/// Layout, kracht es sofort, nicht schleichend.
#[repr(C)]
struct AVVulkanDeviceContextHead {
    alloc: *const c_void,
    get_proc_addr: Option<unsafe extern "C" fn(u64, *const i8) -> *const c_void>,
    inst: u64,
    phys_dev: u64,
    act_dev: u64,
}

type PfnGetImageMemReq = unsafe extern "C" fn(u64, u64, *mut VkMemoryRequirements);
type PfnCreateImage =
    unsafe extern "C" fn(u64, *const VkImageCreateInfo, *const c_void, *mut u64) -> i32;
type PfnAllocateMemory =
    unsafe extern "C" fn(u64, *const VkMemoryAllocateInfo, *const c_void, *mut u64) -> i32;
type PfnBindImageMemory = unsafe extern "C" fn(u64, u64, u64, u64) -> i32;
type PfnGetMemWin32Props =
    unsafe extern "C" fn(u64, u32, *mut c_void, *mut VkMemoryWin32HandlePropertiesKHR) -> i32;
type PfnGetPhysMemProps = unsafe extern "C" fn(u64, *mut VkPhysicalDeviceMemoryProperties);
type PfnDestroyImage = unsafe extern "C" fn(u64, u64, *const c_void);
type PfnFreeMemory = unsafe extern "C" fn(u64, u64, *const c_void);

#[repr(C)]
struct VkMemoryRequirements {
    size: u64,
    alignment: u64,
    memory_type_bits: u32,
}

const BREITE: u32 = 1920;
const HOEHE: u32 = 1080;

fn main() -> Result<()> {
    let zehn_bit = std::env::var("PULSE_PROBE_P010").is_ok();
    let (dxgi_fmt, vk_fmt, fmt_name) = if zehn_bit {
        (windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_P010,
         VK_FORMAT_G10X6_B10X6R10X6_2PLANE_420_UNORM_3PACK16, "P010 (10 bit)")
    } else {
        (DXGI_FORMAT_NV12, VK_FORMAT_G8_B8R8_2PLANE_420_UNORM, "NV12 (8 bit)")
    };
    println!("== Probe: D3D11-{fmt_name}-Textur zero-copy nach Vulkan ==\n");

    // ── 1. D3D11-Textur, teilbar als NT-Handle ────────────────────────────
    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            windows::Win32::Foundation::HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    }?;
    let device = device.ok_or_else(|| anyhow!("D3D11CreateDevice lieferte kein Device"))?;

    // Welche Flag-Kombination NV12 als teilbare Textur zulaesst, ist nicht
    // dokumentiert und je Treiber verschieden. Statt zu raten: durchprobieren
    // und melden, welche traegt. `SHARED_NTHANDLE` verlangt laut Doku
    // zusaetzlich `SHARED_KEYEDMUTEX` — genau das ist der erste Verdacht.
    const MISC_SHARED: u32 = 0x2; // D3D11_RESOURCE_MISC_SHARED
    const MISC_KEYEDMUTEX: u32 = 0x100;
    const MISC_NTHANDLE: u32 = 0x800;
    let kandidaten: [(&str, u32, u32); 8] = [
        ("SR|RT + NTHANDLE|SHARED",
         (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
         MISC_NTHANDLE | MISC_SHARED),
        ("SR|RT + NTHANDLE nur", (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
         MISC_NTHANDLE),
        ("SR|RT + NTHANDLE|KEYEDMUTEX",
         (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
         MISC_NTHANDLE | MISC_KEYEDMUTEX),
        ("SR + NTHANDLE|KEYEDMUTEX", D3D11_BIND_SHADER_RESOURCE.0 as u32,
         MISC_NTHANDLE | MISC_KEYEDMUTEX),
        ("SR|RT + SHARED", (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
         MISC_SHARED),
        ("SR + SHARED", D3D11_BIND_SHADER_RESOURCE.0 as u32, MISC_SHARED),
        ("RT + NTHANDLE|KEYEDMUTEX", D3D11_BIND_RENDER_TARGET.0 as u32,
         MISC_NTHANDLE | MISC_KEYEDMUTEX),
        ("nichts + NTHANDLE|KEYEDMUTEX", 0, MISC_NTHANDLE | MISC_KEYEDMUTEX),
    ];

    let mut tex: Option<ID3D11Texture2D> = None;
    let mut gewaehlt = "";
    for (name, bind, misc) in kandidaten {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: BREITE,
            Height: HOEHE,
            MipLevels: 1,
            ArraySize: 1,
            Format: dxgi_fmt,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind,
            CPUAccessFlags: 0,
            MiscFlags: misc,
        };
        let mut t: Option<ID3D11Texture2D> = None;
        match unsafe { device.CreateTexture2D(&desc, None, Some(&mut t)) } {
            Ok(()) => {
                println!("  [1] {fmt_name}-Textur mit {name}: ok");
                tex = t;
                gewaehlt = name;
                break;
            }
            Err(e) => println!("      {name}: {e}"),
        }
    }
    let tex = tex.ok_or_else(|| {
        anyhow!("keine Flag-Kombination laesst eine teilbare {fmt_name}-Textur zu")
    })?;
    let _ = gewaehlt;

    let res: IDXGIResource1 = tex.cast()?;
    let handle = unsafe { res.CreateSharedHandle(None, 0x8000_0000 /* GENERIC_ALL */, None) }
        .map_err(|e| anyhow!("CreateSharedHandle: {e}"))?;
    println!("  [2] NT-Handle erzeugt: {:?}", handle.0);

    // ── 2. Vulkan-Gerät von FFmpeg ────────────────────────────────────────
    let mut dev_ref: *mut AVBufferRef = std::ptr::null_mut();
    let rc = unsafe {
        av_hwdevice_ctx_create(
            &mut dev_ref,
            AVHWDeviceType::AV_HWDEVICE_TYPE_VULKAN,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        )
    };
    if rc < 0 {
        return Err(anyhow!("av_hwdevice_ctx_create(VULKAN) rc={rc}"));
    }
    let (act_dev, phys_dev, inst, gpa) = unsafe {
        let hdr = (*dev_ref).data as *mut AVHWDeviceContext;
        let vk = (*hdr).hwctx as *mut AVVulkanDeviceContextHead;
        ((*vk).act_dev, (*vk).phys_dev, (*vk).inst, (*vk).get_proc_addr)
    };
    let gpa = gpa.ok_or_else(|| anyhow!("FFmpeg lieferte keinen get_proc_addr"))?;
    println!("  [3] Vulkan-Gerät von FFmpeg: act_dev={act_dev:#x}");

    macro_rules! hole {
        ($name:literal, $t:ty) => {{
            let n = CString::new($name).unwrap();
            let p = unsafe { gpa(inst, n.as_ptr()) };
            if p.is_null() {
                return Err(anyhow!(concat!($name, " nicht auflösbar")));
            }
            unsafe { std::mem::transmute::<*const c_void, $t>(p) }
        }};
    }
    let vk_create_image = hole!("vkCreateImage", PfnCreateImage);
    let vk_alloc_mem = hole!("vkAllocateMemory", PfnAllocateMemory);
    let vk_bind = hole!("vkBindImageMemory", PfnBindImageMemory);
    let vk_mem_req = hole!("vkGetImageMemoryRequirements", PfnGetImageMemReq);
    let vk_win32_props = hole!("vkGetMemoryWin32HandlePropertiesKHR", PfnGetMemWin32Props);
    let vk_phys_props = hole!("vkGetPhysicalDeviceMemoryProperties", PfnGetPhysMemProps);
    let vk_destroy_image = hole!("vkDestroyImage", PfnDestroyImage);
    let vk_free_mem = hole!("vkFreeMemory", PfnFreeMemory);
    println!("  [4] Vulkan-Funktionen aufgelöst (inkl. vkGetMemoryWin32HandlePropertiesKHR)");

    // ── 3. VkImage mit externem Speicher ──────────────────────────────────
    let ext = VkExternalMemoryImageCreateInfo {
        s_type: VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO,
        p_next: std::ptr::null(),
        handle_types: VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT,
    };
    let ici = VkImageCreateInfo {
        s_type: VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
        p_next: &ext as *const _ as *const c_void,
        flags: 0,
        image_type: VK_IMAGE_TYPE_2D,
        format: vk_fmt,
        extent: VkExtent3D { width: BREITE, height: HOEHE, depth: 1 },
        mip_levels: 1,
        array_layers: 1,
        samples: 1,
        tiling: VK_IMAGE_TILING_OPTIMAL,
        usage: VK_IMAGE_USAGE_SAMPLED_BIT
            | VK_IMAGE_USAGE_TRANSFER_SRC_BIT
            | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
        sharing_mode: VK_SHARING_MODE_EXCLUSIVE,
        queue_family_index_count: 0,
        p_queue_family_indices: std::ptr::null(),
        initial_layout: VK_IMAGE_LAYOUT_UNDEFINED,
    };
    let mut image: u64 = 0;
    let rc = unsafe { vk_create_image(act_dev, &ici, std::ptr::null(), &mut image) };
    if rc != VK_SUCCESS {
        return Err(anyhow!("vkCreateImage (extern, NV12) rc={rc}"));
    }
    println!("  [5] VkImage (G8_B8R8_2PLANE_420_UNORM, extern) erzeugt");

    // ── 4. Speicher importieren ───────────────────────────────────────────
    let mut props = VkMemoryWin32HandlePropertiesKHR {
        s_type: VK_STRUCTURE_TYPE_MEMORY_WIN32_HANDLE_PROPERTIES_KHR,
        p_next: std::ptr::null_mut(),
        memory_type_bits: 0,
    };
    let rc = unsafe {
        vk_win32_props(
            act_dev,
            VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT,
            handle.0,
            &mut props,
        )
    };
    if rc != VK_SUCCESS {
        unsafe { vk_destroy_image(act_dev, image, std::ptr::null()) };
        return Err(anyhow!(
            "vkGetMemoryWin32HandlePropertiesKHR rc={rc} — der Treiber nimmt dieses Handle nicht"
        ));
    }
    println!("  [6] Handle-Eigenschaften: memory_type_bits={:#x}", props.memory_type_bits);

    let mut req = VkMemoryRequirements { size: 0, alignment: 0, memory_type_bits: 0 };
    unsafe { vk_mem_req(act_dev, image, &mut req) };

    let mut mem_props: VkPhysicalDeviceMemoryProperties = unsafe { std::mem::zeroed() };
    unsafe { vk_phys_props(phys_dev, &mut mem_props) };
    // Ein Typ, der SOWOHL zum Bild als AUCH zum importierten Handle passt.
    let erlaubt = req.memory_type_bits & props.memory_type_bits;
    let idx = (0..mem_props.memory_type_count).find(|i| erlaubt & (1 << i) != 0);
    let idx = match idx {
        Some(i) => i,
        None => {
            unsafe { vk_destroy_image(act_dev, image, std::ptr::null()) };
            return Err(anyhow!(
                "kein Speichertyp passt zu Bild ({:#x}) UND Handle ({:#x})",
                req.memory_type_bits,
                props.memory_type_bits
            ));
        }
    };

    // Import-Allokationen fuer D3D11-Texturen muessen dediziert sein.
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
    let rc = unsafe { vk_alloc_mem(act_dev, &mai, std::ptr::null(), &mut mem) };
    if rc != VK_SUCCESS {
        unsafe { vk_destroy_image(act_dev, image, std::ptr::null()) };
        return Err(anyhow!("vkAllocateMemory (Import) rc={rc}"));
    }
    println!("  [7] Speicher importiert (dediziert, Typ {idx}, {} Bytes)", req.size);

    let rc = unsafe { vk_bind(act_dev, image, mem, 0) };
    if rc != VK_SUCCESS {
        unsafe {
            vk_free_mem(act_dev, mem, std::ptr::null());
            vk_destroy_image(act_dev, image, std::ptr::null());
        }
        return Err(anyhow!("vkBindImageMemory rc={rc}"));
    }

    // -- 5. Synchronisierung: D3D11-Fence als Vulkan-Zeitleisten-Semaphore --
    //
    // Ohne die greift der Encoder auf ein Bild zu, das der Video-Prozessor noch
    // schreibt. FFmpeg wartet je Bild auf `AVVkFrame.sem`; die Semaphore muss
    // also von der D3D11-Seite signalisiert werden koennen. Der Weg dafuer ist
    // ein geteilter `ID3D11Fence`, in Vulkan als Zeitleisten-Semaphore
    // importiert. Kann der Treiber das nicht, bliebe nur ein CPU-Warten je
    // Bild - kein Kopieren, aber ein Latenz-Posten.
    println!("\n  -- Synchronisierung --");
    let dev5: windows::Win32::Graphics::Direct3D11::ID3D11Device5 = device.cast()?;
    let mut fence_opt: Option<windows::Win32::Graphics::Direct3D11::ID3D11Fence> = None;
    unsafe {
        dev5.CreateFence(
            0,
            windows::Win32::Graphics::Direct3D11::D3D11_FENCE_FLAG_SHARED,
            &mut fence_opt,
        )
    }
    .map_err(|e| anyhow!("ID3D11Device5::CreateFence(SHARED): {e}"))?;
    let fence = fence_opt.ok_or_else(|| anyhow!("CreateFence lieferte nichts"))?;
    let fence_handle = unsafe { fence.CreateSharedHandle(None, 0x8000_0000, None) }
        .map_err(|e| anyhow!("Fence::CreateSharedHandle: {e}"))?;
    println!("  [8] geteilter D3D11-Fence: Handle {:?}", fence_handle.0);

    const VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO: i32 = 9;
    const VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO: i32 = 1_000_207_002;
    const VK_STRUCTURE_TYPE_IMPORT_SEMAPHORE_WIN32_HANDLE_INFO_KHR: i32 = 1_000_078_000;
    const VK_SEMAPHORE_TYPE_TIMELINE: i32 = 1;
    const VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_D3D11_FENCE_BIT: u32 = 0x0000_0008;

    #[repr(C)]
    struct VkSemaphoreTypeCreateInfo {
        s_type: i32,
        p_next: *const c_void,
        semaphore_type: i32,
        initial_value: u64,
    }
    #[repr(C)]
    struct VkSemaphoreCreateInfo {
        s_type: i32,
        p_next: *const c_void,
        flags: u32,
    }
    #[repr(C)]
    struct VkImportSemaphoreWin32HandleInfoKHR {
        s_type: i32,
        p_next: *const c_void,
        semaphore: u64,
        flags: u32,
        handle_type: u32,
        handle: *mut c_void,
        name: *const u16,
    }
    type PfnCreateSemaphore =
        unsafe extern "C" fn(u64, *const VkSemaphoreCreateInfo, *const c_void, *mut u64) -> i32;
    type PfnImportSemWin32 =
        unsafe extern "C" fn(u64, *const VkImportSemaphoreWin32HandleInfoKHR) -> i32;
    type PfnDestroySemaphore = unsafe extern "C" fn(u64, u64, *const c_void);

    let vk_create_sem = hole!("vkCreateSemaphore", PfnCreateSemaphore);
    let vk_import_sem = hole!("vkImportSemaphoreWin32HandleKHR", PfnImportSemWin32);
    let vk_destroy_sem = hole!("vkDestroySemaphore", PfnDestroySemaphore);

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
    let rc = unsafe { vk_create_sem(act_dev, &sci, std::ptr::null(), &mut sem) };
    if rc != VK_SUCCESS {
        return Err(anyhow!("vkCreateSemaphore (timeline) rc={rc}"));
    }
    let isi = VkImportSemaphoreWin32HandleInfoKHR {
        s_type: VK_STRUCTURE_TYPE_IMPORT_SEMAPHORE_WIN32_HANDLE_INFO_KHR,
        p_next: std::ptr::null(),
        semaphore: sem,
        flags: 0,
        handle_type: VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_D3D11_FENCE_BIT,
        handle: fence_handle.0,
        name: std::ptr::null(),
    };
    let rc = unsafe { vk_import_sem(act_dev, &isi) };
    if rc != VK_SUCCESS {
        println!("  [9] Fence-Import SCHEITERT (rc={rc}) - Sync braucht einen anderen Weg");
    } else {
        println!("  [9] D3D11-Fence als Vulkan-Zeitleisten-Semaphore importiert: ok");
    }
    unsafe { vk_destroy_sem(act_dev, sem, std::ptr::null()) };

    println!("\n  ERGEBNIS: Import GELUNGEN — der Weg traegt zero-copy.\n");

    unsafe {
        vk_free_mem(act_dev, mem, std::ptr::null());
        vk_destroy_image(act_dev, image, std::ptr::null());
        av_buffer_unref(&mut dev_ref);
    }
    Ok(())
}
