//! Vulkan von Hand — nur die Deklarationen, keine Logik.
//!
//! **Kein `ash`.** Das wäre eine neue Abhängigkeit für ein paar Dutzend
//! Konstanten und zwölf Funktionszeiger; alles Nötige kommt ohnehin über
//! FFmpegs `get_proc_addr`. Gleiche Bauart wie die AVD3D11VA-Spiegel im
//! Sidecar.
//!
//! **Eigene Datei, weil es reine Bindungsfläche ist.** Wer den Import
//! nachvollziehen will, liest [`super`]; hier steht nichts, was man verstehen
//! müsste — nur Zahlen und Feldreihenfolgen, die exakt zu Vulkan bzw. FFmpeg
//! passen müssen. Die Trennung hält die Datei mit der Mechanik lesbar.

use std::ffi::c_void;


pub(super) const VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO: i32 = 14;
pub(super) const VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO: i32 = 5;
pub(super) const VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO: i32 = 1_000_072_001;
pub(super) const VK_STRUCTURE_TYPE_IMPORT_MEMORY_WIN32_HANDLE_INFO_KHR: i32 = 1_000_073_000;
pub(super) const VK_STRUCTURE_TYPE_MEMORY_WIN32_HANDLE_PROPERTIES_KHR: i32 = 1_000_073_002;
pub(super) const VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO: i32 = 1_000_127_001;
pub(super) const VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO: i32 = 9;
pub(super) const VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO: i32 = 1_000_207_002;
pub(super) const VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO: i32 = 1_000_207_003;

pub(super) const VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT: u32 = 0x0000_0008;
pub(super) const VK_SEMAPHORE_TYPE_TIMELINE: i32 = 1;
pub(super) const VK_IMAGE_TYPE_2D: i32 = 1;
pub(super) const VK_IMAGE_TILING_OPTIMAL: i32 = 0;
pub(super) const VK_SHARING_MODE_EXCLUSIVE: i32 = 0;
pub(super) const VK_SHARING_MODE_CONCURRENT: i32 = 1;
pub(super) const VK_IMAGE_LAYOUT_UNDEFINED: i32 = 0;
/// `VK_IMAGE_USAGE_VIDEO_ENCODE_SRC_BIT_KHR` — ohne das nimmt der
/// Video-Encoder das Bild nicht als Quelle an. Die uebrigen Zwecke (Sampled,
/// Storage, Transfer) kommen aus [`AVVulkanFramesContext::usage`].
///
/// **`0x4000`, nicht `0x2000`.** Hier stand bis 2026-08-02 der Nachbarwert —
/// das ist `VIDEO_ENCODE_DST`, der Zweck einer Encoder-AUSGABE. Das Bild trug
/// den Quell-Zweck damit gar nicht, dafuer einen sinnlosen, und FFmpeg legte
/// darueber eine `VkImageViewUsageCreateInfo` mit dem Quell-Zweck an — nach
/// Spezifikation unzulaessig. Gemerkt hat es niemand: es gab keine
/// Fehlermeldung, `vkCreateImage` nahm beides an.
pub(super) const VK_IMAGE_USAGE_VIDEO_ENCODE_SRC_BIT_KHR: u32 = 0x0000_4000;
pub(super) const VK_QUEUE_FAMILY_IGNORED: u32 = u32::MAX;
pub(super) const VK_SUCCESS: i32 = 0;

/// `VK_IMAGE_CREATE_VIDEO_PROFILE_INDEPENDENT_BIT_KHR` — „dieses Bild gehoert
/// zu keinem bestimmten Video-Profil".
///
/// Ohne dieses Bit darf der Treiber fuer ein Bild mit `VIDEO_ENCODE_SRC_BIT`
/// ein profil-spezifisches internes Layout waehlen. Fuer ein IMPORTIERTES Bild
/// waere das die falsche Freiheit — die Bytes hat D3D11 hingelegt, und D3D11
/// kennt keine Vulkan-Video-Profile. FFmpeg setzt es an seinen eigenen
/// Encode-Quellbildern, also setzen wir es auch.
///
/// **Es behebt das 10-Bit-Magenta nicht** — das war der Verdacht und ist
/// nachgemessen widerlegt (Messakte Abschnitt 11); die Ursache liegt im
/// Encoder, nicht im Bild.
///
/// Braucht `VK_KHR_video_maintenance1`. Deshalb wird das Bit nie hier gesetzt,
/// sondern nur aus [`AVVulkanFramesContext::img_flags`] uebernommen — dort
/// steht es genau dann, wenn FFmpeg die Erweiterung eingeschaltet hat.
pub(super) const VK_IMAGE_CREATE_VIDEO_PROFILE_INDEPENDENT_BIT_KHR: u32 = 0x0010_0000;

// ── Video-Profil ────────────────────────────────────────────────────────────
//
// Bei `VIDEO_ENCODE_SRC_BIT` verlangt die Spezifikation eine Profil-Liste im
// `pNext` der Bild-Erzeugung — **es sei denn**, das Bild traegt
// `VIDEO_PROFILE_INDEPENDENT` (die Erweiterung `VK_KHR_video_maintenance1`
// erlaubt genau diese Ausnahme). Wir brauchen beides: die Liste als Rueckfall,
// wenn die Erweiterung fehlt, und ansonsten das Bit.
//
// **Die Liste allein behebt das 10-Bit-Magenta NICHT** — nachgemessen am
// 2026-08-02, Messakte Abschnitt 11. Sie ist trotzdem richtig und bleibt.

pub(super) const VK_STRUCTURE_TYPE_VIDEO_PROFILE_INFO_KHR: i32 = 1_000_023_000;
pub(super) const VK_STRUCTURE_TYPE_VIDEO_PROFILE_LIST_INFO_KHR: i32 = 1_000_023_013;
pub(super) const VK_STRUCTURE_TYPE_VIDEO_ENCODE_USAGE_INFO_KHR: i32 = 1_000_299_004;
pub(super) const VK_STRUCTURE_TYPE_VIDEO_ENCODE_H264_PROFILE_INFO_KHR: i32 = 1_000_038_007;
pub(super) const VK_STRUCTURE_TYPE_VIDEO_ENCODE_AV1_PROFILE_INFO_KHR: i32 = 1_000_513_005;

pub(super) const VK_VIDEO_CODEC_OPERATION_ENCODE_H264_BIT_KHR: u32 = 0x0001_0000;
pub(super) const VK_VIDEO_CODEC_OPERATION_ENCODE_AV1_BIT_KHR: u32 = 0x0004_0000;
pub(super) const VK_VIDEO_CHROMA_SUBSAMPLING_420_BIT_KHR: u32 = 0x0000_0002;
pub(super) const VK_VIDEO_COMPONENT_BIT_DEPTH_8_BIT_KHR: u32 = 0x0000_0001;
pub(super) const VK_VIDEO_COMPONENT_BIT_DEPTH_10_BIT_KHR: u32 = 0x0000_0004;

/// `StdVideoAV1Profile` / `StdVideoH264ProfileIdc` — beide Main/High.
pub(super) const STD_VIDEO_AV1_PROFILE_MAIN: i32 = 0;
pub(super) const STD_VIDEO_H264_PROFILE_IDC_HIGH: i32 = 100;

#[repr(C)]
pub(super) struct VkVideoProfileInfoKHR {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) video_codec_operation: u32,
    pub(super) chroma_subsampling: u32,
    pub(super) luma_bit_depth: u32,
    pub(super) chroma_bit_depth: u32,
}

#[repr(C)]
pub(super) struct VkVideoProfileListInfoKHR {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) profile_count: u32,
    pub(super) p_profiles: *const VkVideoProfileInfoKHR,
}

#[repr(C)]
pub(super) struct VkVideoEncodeUsageInfoKHR {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) video_usage_hints: u32,
    pub(super) video_content_hints: u32,
    pub(super) tuning_mode: i32,
}

/// Deckt `VkVideoEncodeAV1ProfileInfoKHR` und
/// `VkVideoEncodeH264ProfileInfoKHR` ab — beide haben dasselbe Layout, nur der
/// `sType` und die Bedeutung des letzten Feldes unterscheiden sich.
#[repr(C)]
pub(super) struct VkVideoEncodeCodecProfileInfo {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) std_profile: i32,
}

/// `VK_FORMAT_G8_B8R8_2PLANE_420_UNORM` — Gegenstück zu DXGI NV12.
pub const VK_FORMAT_NV12: i32 = 1_000_156_003;
/// `VK_FORMAT_G10X6_B10X6R10X6_2PLANE_420_UNORM_3PACK16` — zu DXGI P010.
pub const VK_FORMAT_P010: i32 = 1_000_156_013;

/// Wie viele Zeiger-Felder `AVFrame`/`AVVkFrame` führen.
pub(super) const AV_NUM_DATA_POINTERS: usize = 8;

#[repr(C)]
pub(super) struct VkExtent3D {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) depth: u32,
}

#[repr(C)]
pub(super) struct VkExternalMemoryImageCreateInfo {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) handle_types: u32,
}

#[repr(C)]
pub(super) struct VkImageCreateInfo {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) flags: u32,
    pub(super) image_type: i32,
    pub(super) format: i32,
    pub(super) extent: VkExtent3D,
    pub(super) mip_levels: u32,
    pub(super) array_layers: u32,
    pub(super) samples: u32,
    pub(super) tiling: i32,
    pub(super) usage: u32,
    pub(super) sharing_mode: i32,
    pub(super) queue_family_index_count: u32,
    pub(super) p_queue_family_indices: *const u32,
    pub(super) initial_layout: i32,
}

#[repr(C)]
pub(super) struct VkImportMemoryWin32HandleInfoKHR {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) handle_type: u32,
    pub(super) handle: *mut c_void,
    pub(super) name: *const u16,
}

#[repr(C)]
pub(super) struct VkMemoryDedicatedAllocateInfo {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) image: u64,
    pub(super) buffer: u64,
}

#[repr(C)]
pub(super) struct VkMemoryAllocateInfo {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) allocation_size: u64,
    pub(super) memory_type_index: u32,
}

#[repr(C)]
pub(super) struct VkMemoryWin32HandlePropertiesKHR {
    pub(super) s_type: i32,
    pub(super) p_next: *mut c_void,
    pub(super) memory_type_bits: u32,
}

#[repr(C)]
pub(super) struct VkMemoryRequirements {
    pub(super) size: u64,
    pub(super) alignment: u64,
    pub(super) memory_type_bits: u32,
}

#[repr(C)]
pub(super) struct VkMemoryType {
    pub(super) property_flags: u32,
    pub(super) heap_index: u32,
}

#[repr(C)]
pub(super) struct VkMemoryHeap {
    pub(super) size: u64,
    pub(super) flags: u32,
}

#[repr(C)]
pub(super) struct VkPhysicalDeviceMemoryProperties {
    pub(super) memory_type_count: u32,
    pub(super) memory_types: [VkMemoryType; 32],
    pub(super) memory_heap_count: u32,
    pub(super) memory_heaps: [VkMemoryHeap; 16],
}

#[repr(C)]
pub(super) struct VkSemaphoreTypeCreateInfo {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) semaphore_type: i32,
    pub(super) initial_value: u64,
}

#[repr(C)]
pub(super) struct VkSemaphoreWaitInfo {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) flags: u32,
    pub(super) semaphore_count: u32,
    pub(super) p_semaphores: *const u64,
    pub(super) p_values: *const u64,
}

#[repr(C)]
pub(super) struct VkSemaphoreCreateInfo {
    pub(super) s_type: i32,
    pub(super) p_next: *const c_void,
    pub(super) flags: u32,
}

/// Spiegel von `AVVulkanFramesContext` (libavutil/hwcontext_vulkan.h, FFmpeg 8.1).
///
/// **Gelesen, nicht geschrieben.** `av_hwframe_ctx_init` fuellt hier ein, wie
/// FFmpeg die Bilder DIESES Kontexts anlegen wuerde — Erzeugungs-Flags,
/// Nutzung, Vulkan-Format. Wir legen unsere importierten Bilder mit genau
/// diesen Werten an, statt sie nachzubauen; das ist die einzige Art, die beiden
/// Sorten Bild deckungsgleich zu halten, ohne FFmpegs Regeln zu verdoppeln.
///
/// Reihenfolge und Typen muessen exakt stimmen — ein Feld daneben liest die
/// falsche Zahl, und die sieht plausibel aus.
/// `avvulkanframesctx_layout_plausibel` prueft wenigstens die Gesamtgroesse.
#[repr(C)]
pub(super) struct AVVulkanFramesContext {
    pub(super) tiling: i32,
    pub(super) usage: u32,
    pub(super) create_pnext: *mut c_void,
    pub(super) alloc_pnext: [*mut c_void; AV_NUM_DATA_POINTERS],
    pub(super) flags: u32,
    pub(super) img_flags: u32,
    pub(super) format: [i32; AV_NUM_DATA_POINTERS],
    pub(super) nb_layers: i32,
    pub(super) lock_frame: Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
    pub(super) unlock_frame: Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
}

/// Spiegel von `AVVulkanDeviceContext`, so weit wir ihn lesen.
#[repr(C)]
pub(super) struct AVVulkanDeviceContextHead {
    pub(super) alloc: *const c_void,
    pub(super) get_proc_addr: Option<unsafe extern "C" fn(u64, *const i8) -> *const c_void>,
    pub(super) inst: u64,
    pub(super) phys_dev: u64,
    pub(super) act_dev: u64,
}

/// Spiegel von `AVVkFrame` (libavutil/hwcontext_vulkan.h, FFmpeg 8.1).
///
/// **Reihenfolge und Typen müssen exakt stimmen.** Ein falsches Layout
/// schreibt in fremde Felder — und anders als bei einem Absturz zeigt sich das
/// als sporadisch kaputtes Bild. Gegen den Header geprüft; ändert sich FFmpeg,
/// gehört das hier mitgeprüft.
#[repr(C)]
pub struct AVVkFrame {
    pub img: [u64; AV_NUM_DATA_POINTERS],
    pub tiling: i32,
    pub mem: [u64; AV_NUM_DATA_POINTERS],
    pub size: [usize; AV_NUM_DATA_POINTERS],
    pub flags: i32,
    pub access: [i32; AV_NUM_DATA_POINTERS],
    pub layout: [i32; AV_NUM_DATA_POINTERS],
    pub sem: [u64; AV_NUM_DATA_POINTERS],
    pub sem_value: [u64; AV_NUM_DATA_POINTERS],
    pub internal: *mut c_void,
    pub offset: [isize; AV_NUM_DATA_POINTERS],
    pub queue_family: [u32; AV_NUM_DATA_POINTERS],
}

pub(super) type PfnCreateImage =
    unsafe extern "C" fn(u64, *const VkImageCreateInfo, *const c_void, *mut u64) -> i32;
pub(super) type PfnDestroyImage = unsafe extern "C" fn(u64, u64, *const c_void);
pub(super) type PfnAllocateMemory =
    unsafe extern "C" fn(u64, *const VkMemoryAllocateInfo, *const c_void, *mut u64) -> i32;
pub(super) type PfnFreeMemory = unsafe extern "C" fn(u64, u64, *const c_void);
pub(super) type PfnBindImageMemory = unsafe extern "C" fn(u64, u64, u64, u64) -> i32;
pub(super) type PfnGetImageMemReq = unsafe extern "C" fn(u64, u64, *mut VkMemoryRequirements);
pub(super) type PfnGetMemWin32Props =
    unsafe extern "C" fn(u64, u32, *mut c_void, *mut VkMemoryWin32HandlePropertiesKHR) -> i32;
pub(super) type PfnGetPhysMemProps = unsafe extern "C" fn(u64, *mut VkPhysicalDeviceMemoryProperties);
pub(super) type PfnGetQueueFamilyProps = unsafe extern "C" fn(u64, *mut u32, *mut c_void);
pub(super) type PfnCreateSemaphore =
    unsafe extern "C" fn(u64, *const VkSemaphoreCreateInfo, *const c_void, *mut u64) -> i32;
pub(super) type PfnDestroySemaphore = unsafe extern "C" fn(u64, u64, *const c_void);
pub(super) type PfnWaitSemaphores = unsafe extern "C" fn(u64, *const VkSemaphoreWaitInfo, u64) -> i32;

pub(super) struct VkFns {
    pub(super) create_image: PfnCreateImage,
    pub(super) destroy_image: PfnDestroyImage,
    pub(super) allocate_memory: PfnAllocateMemory,
    pub(super) free_memory: PfnFreeMemory,
    pub(super) bind_image_memory: PfnBindImageMemory,
    pub(super) get_image_mem_req: PfnGetImageMemReq,
    pub(super) get_mem_win32_props: PfnGetMemWin32Props,
    pub(super) get_phys_mem_props: PfnGetPhysMemProps,
    pub(super) get_queue_family_props: PfnGetQueueFamilyProps,
    pub(super) create_semaphore: PfnCreateSemaphore,
    pub(super) destroy_semaphore: PfnDestroySemaphore,
    pub(super) wait_semaphores: PfnWaitSemaphores,
}
