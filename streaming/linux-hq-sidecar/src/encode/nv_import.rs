//! Zero-Copy-Import: DMABUF (PipeWire-Capture) → ffmpeg-CUDA-Frame (NVENC).
//!
//! niri/Mutter liefern auf NVIDIA Block-Linear-DMABUFs (Modifier
//! `0x03...`) — reines `cuImportExternalMemory` kann nur lineare Layouts,
//! deshalb der GSR-Weg über die Grafik-Treiber-Interop-Kette:
//!
//! DMABUF-fds → `eglCreateImageKHR` (EGL_LINUX_DMA_BUF_EXT + Modifier)
//!   → GL-Textur (`glEGLImageTargetTexture2DOES`)
//!   → `glBlitFramebuffer` (LINEAR) in eine EIGENE RGBA8-Staging-Textur in
//!     AUSGABE-Größe — skaliert dabei, wenn Capture ≠ Ziel; CUDA kann
//!     EGLImage-gebundene Texturen ohnehin nicht registrieren (INVALID_VALUE),
//!     GSR kopiert deshalb ebenfalls erst in eigene Texturen. Der Blit ist
//!     KOMPONENTENWEISE (nicht byte-roh): BGRx-Quelle → RGBA8-Staging heißt,
//!     die Bytes liegen danach als R,G,B,X.
//!   → `cuGraphicsGLRegisterImage` (einmalig, auf der Staging-Textur) /
//!     `cuGraphicsSubResourceGetMappedArray`
//!   → `cuMemcpy2D` (ARRAY→DEVICE) in den linearen ffmpeg-CUDA-Frame
//!     (sw_format RGB0, passend zur Blit-Byte-Ordnung — NVENC nimmt RGB
//!     direkt, keine CPU-Kopie nötig).
//!
//! Der GPU-seitige Copy detiled dabei Block-Linear→Linear; ein CPU-Roundtrip
//! findet nie statt. Voraussetzung: FFmpegs CUDA-Device nutzt den
//! **Primary-Context** (Flag in `hw::HwContext::create`), denn unser Interop
//! läuft ebenfalls auf dem Primary-Context — Device-Pointer sind pro Context.
//!
//! libEGL/libcuda werden per dlopen geladen (kein Link-Time-Dep, wie
//! `egl_modifiers`). EGL-Display über `EGL_EXT_platform_device`, Context
//! surfaceless + configless (EGL_KHR_no_config_context /
//! EGL_KHR_surfaceless_context — NVIDIA kann beides). Devices werden
//! durchprobiert, bis eins einen NVIDIA-GL-Context liefert.
//!
//! Threading: EGL-Context ist thread-affin (`eglMakeCurrent` in `new`) —
//! Importer auf DEM Thread erzeugen und benutzen, der encodiert. Bewusst
//! nicht `Send`.

use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_void};
use std::ptr;

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::{AVFrame, av_frame_free};

use crate::capture::pipewire_stream::DmabufFrame;
use crate::capture::egl_modifiers::DRM_FORMAT_MOD_INVALID;
use super::hw::HwContext;

// ── EGL/GL-Konstanten (eglext.h / gl.h) ─────────────────────────────────────
const EGL_PLATFORM_DEVICE_EXT: u32 = 0x313F;
const EGL_OPENGL_API: u32 = 0x30A2;
const EGL_NONE: i32 = 0x3038;
const EGL_TRUE: u32 = 1;
const EGL_WIDTH: i32 = 0x3057;
const EGL_HEIGHT: i32 = 0x3056;
const EGL_LINUX_DMA_BUF_EXT: u32 = 0x3270;
const EGL_LINUX_DRM_FOURCC_EXT: i32 = 0x3271;
// fd/offset/pitch pro Plane 0..3 (Plane 3 liegt bei 0x3440ff).
const EGL_DMA_BUF_PLANE_FD_EXT: [i32; 4] = [0x3272, 0x3275, 0x3278, 0x3440];
const EGL_DMA_BUF_PLANE_OFFSET_EXT: [i32; 4] = [0x3273, 0x3276, 0x3279, 0x3441];
const EGL_DMA_BUF_PLANE_PITCH_EXT: [i32; 4] = [0x3274, 0x3277, 0x327A, 0x3442];
const EGL_DMA_BUF_PLANE_MODIFIER_LO_EXT: [i32; 4] = [0x3443, 0x3445, 0x3447, 0x3449];
const EGL_DMA_BUF_PLANE_MODIFIER_HI_EXT: [i32; 4] = [0x3444, 0x3446, 0x3448, 0x344A];

const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_VERSION: u32 = 0x1F02;
const GL_NO_ERROR: u32 = 0;
const GL_RGBA8: u32 = 0x8058;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_NEAREST: i32 = 0x2600;
// Framebuffer-Blit (Downscale-Pfad): Quelle ≠ Zielgröße → glBlitFramebuffer
// mit LINEAR-Filter statt glCopyImageSubData (das kann nur 1:1).
const GL_READ_FRAMEBUFFER: u32 = 0x8CA8;
const GL_DRAW_FRAMEBUFFER: u32 = 0x8CA9;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_COLOR_BUFFER_BIT: u32 = 0x0000_4000;
const GL_LINEAR: u32 = 0x2601;
/// Dasselbe Bit als `i32` — `glTexParameteri` nimmt einen Integer-Wert,
/// `glBlitFramebuffer` einen Enum-Wert.
const GL_LINEAR_FILTER: i32 = 0x2601;
const GL_TEXTURE_WRAP_S: u32 = 0x2802;
const GL_TEXTURE_WRAP_T: u32 = 0x2803;
const GL_CLAMP_TO_EDGE: i32 = 0x812F;

// ── CUDA-Konstanten/-Typen (cuda.h) ─────────────────────────────────────────
const CUDA_SUCCESS: i32 = 0;
const CU_GRAPHICS_REGISTER_FLAGS_READ_ONLY: u32 = 1;
const CU_MEMORYTYPE_HOST: u32 = 1;
const CU_MEMORYTYPE_DEVICE: u32 = 2;
const CU_MEMORYTYPE_ARRAY: u32 = 3;

type EglDisplay = *mut c_void;
type EglContext = *mut c_void;
type EglImage = *mut c_void;
type CuContext = *mut c_void;
type CuArray = *mut c_void;
type CuGraphicsResource = *mut c_void;

/// `CUDA_MEMCPY2D` (cuda.h, v2-ABI: alle Größen `size_t`).
#[repr(C)]
struct CudaMemcpy2D {
    src_x_in_bytes: usize,
    src_y: usize,
    src_memory_type: u32,
    src_host: *const c_void,
    src_device: u64,
    src_array: CuArray,
    src_pitch: usize,
    dst_x_in_bytes: usize,
    dst_y: usize,
    dst_memory_type: u32,
    dst_host: *mut c_void,
    dst_device: u64,
    dst_array: CuArray,
    dst_pitch: usize,
    width_in_bytes: usize,
    height: usize,
}

// ── Funktions-Signaturen ────────────────────────────────────────────────────
type FnGetProcAddress = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type FnEglQueryDevices = unsafe extern "C" fn(i32, *mut *mut c_void, *mut i32) -> u32;
type FnEglGetPlatformDisplay = unsafe extern "C" fn(u32, *mut c_void, *const i32) -> EglDisplay;
type FnEglInitialize = unsafe extern "C" fn(EglDisplay, *mut i32, *mut i32) -> u32;
type FnEglBindApi = unsafe extern "C" fn(u32) -> u32;
type FnEglCreateContext =
    unsafe extern "C" fn(EglDisplay, *mut c_void, EglContext, *const i32) -> EglContext;
type FnEglDestroyContext = unsafe extern "C" fn(EglDisplay, EglContext) -> u32;
type FnEglMakeCurrent =
    unsafe extern "C" fn(EglDisplay, *mut c_void, *mut c_void, EglContext) -> u32;
type FnEglCreateImage =
    unsafe extern "C" fn(EglDisplay, EglContext, u32, *mut c_void, *const i32) -> EglImage;
type FnEglDestroyImage = unsafe extern "C" fn(EglDisplay, EglImage) -> u32;
type FnEglGetError = unsafe extern "C" fn() -> i32;

type FnGlGenTextures = unsafe extern "C" fn(i32, *mut u32);
type FnGlDeleteTextures = unsafe extern "C" fn(i32, *const u32);
type FnGlBindTexture = unsafe extern "C" fn(u32, u32);
type FnGlEglImageTargetTexture2D = unsafe extern "C" fn(u32, EglImage);
type FnGlGetError = unsafe extern "C" fn() -> u32;
type FnGlGetString = unsafe extern "C" fn(u32) -> *const c_char;
type FnGlTexStorage2D = unsafe extern "C" fn(u32, i32, u32, i32, i32);
type FnGlTexParameteri = unsafe extern "C" fn(u32, u32, i32);
type FnGlGenFramebuffers = unsafe extern "C" fn(i32, *mut u32);
type FnGlDeleteFramebuffers = unsafe extern "C" fn(i32, *const u32);
type FnGlBindFramebuffer = unsafe extern "C" fn(u32, u32);
type FnGlFramebufferTexture2D = unsafe extern "C" fn(u32, u32, u32, u32, i32);
#[allow(clippy::type_complexity)]
type FnGlBlitFramebuffer = unsafe extern "C" fn(
    i32, i32, i32, i32, // src x0 y0 x1 y1
    i32, i32, i32, i32, // dst x0 y0 x1 y1
    u32, u32, // mask, filter
);
type FnGlTexSubImage2D =
    unsafe extern "C" fn(u32, i32, i32, i32, i32, i32, u32, u32, *const c_void);

type FnCuInit = unsafe extern "C" fn(u32) -> i32;
type FnCuDeviceGet = unsafe extern "C" fn(*mut i32, i32) -> i32;
type FnCuPrimaryCtxRetain = unsafe extern "C" fn(*mut CuContext, i32) -> i32;
type FnCuPrimaryCtxRelease = unsafe extern "C" fn(i32) -> i32;
type FnCuCtxPushCurrent = unsafe extern "C" fn(CuContext) -> i32;
type FnCuCtxPopCurrent = unsafe extern "C" fn(*mut CuContext) -> i32;
type FnCuGraphicsGlRegisterImage =
    unsafe extern "C" fn(*mut CuGraphicsResource, u32, u32, u32) -> i32;
type FnCuGraphicsMapResources =
    unsafe extern "C" fn(u32, *mut CuGraphicsResource, *mut c_void) -> i32;
type FnCuGraphicsSubResourceGetMappedArray =
    unsafe extern "C" fn(*mut CuArray, CuGraphicsResource, u32, u32) -> i32;
type FnCuGraphicsUnmapResources =
    unsafe extern "C" fn(u32, *mut CuGraphicsResource, *mut c_void) -> i32;
type FnCuGraphicsUnregisterResource = unsafe extern "C" fn(CuGraphicsResource) -> i32;
type FnCuMemcpy2D = unsafe extern "C" fn(*const CudaMemcpy2D) -> i32;
type FnCuCtxSynchronize = unsafe extern "C" fn() -> i32;

/// Bittiefe des Encoder-Eingangs — bestimmt zugleich das `sw_format` des
/// CUDA-Frame-Pools und WIE die Farbwandlung passiert.
///
/// * [`Rgba8`](StagingFormat::Rgba8): eine RGBA8-Staging-Textur, **NVENC
///   wandelt RGB→YUV selbst**. Byte-Reihenfolge `R,G,B,X` (der GL-Blit
///   kopiert komponentenweise), deshalb Pool-`sw_format` `RGB0` — nicht
///   `BGR0`, das war schon einmal ein Rot/Blau-Tausch.
/// * [`P010`](StagingFormat::P010): zwei Ebenen (`R16` Luma + `RG16`
///   verschränktes Chroma), **wir wandeln selbst** ([`nv_p010`]). Nötig, weil
///   FFmpegs CUDA-Frame-Kontext kein 10-bit-RGB trägt und `scale_cuda` RGB
///   nicht nach 10-bit-YUV wandelt — beides gemessen, Begründung im
///   Modul-Kopf von [`nv_p010`].
///
/// Zwei weitere Wege wurden probiert und verworfen, damit sie niemand erneut
/// aufgreift: eine gepackte `GL_RGB10_A2`-Textur lässt CUDA nicht registrieren
/// (`cuGraphicsGLRegisterImage` → `CUDA_ERROR_INVALID_VALUE`), und der Umweg
/// über einen Pixel-Pack-Buffer scheitert danach am Frame-Pool, der
/// `x2bgr10le` ebenfalls ablehnt.
///
/// [`nv_p010`]: super::nv_p010
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagingFormat {
    /// 8 bit je Kanal → Encoder-Pool `RGB0`.
    Rgba8,
    /// 10 bit, 4:2:0 semiplanar → Encoder-Pool `P010LE`.
    P010,
}

impl StagingFormat {
    /// Passendes `sw_format` für den ffmpeg-CUDA-Frame-Pool.
    pub fn av_pix_fmt(self) -> ffmpeg_next::ffi::AVPixelFormat {
        use ffmpeg_next::ffi::AVPixelFormat;
        match self {
            StagingFormat::Rgba8 => AVPixelFormat::AV_PIX_FMT_RGB0,
            StagingFormat::P010 => AVPixelFormat::AV_PIX_FMT_P010LE,
        }
    }

    pub fn is_ten_bit(self) -> bool {
        self == StagingFormat::P010
    }
}

/// Mehr Ebenen kann keiner der beiden Pfade haben: RGBA8 hat eine, P010 zwei.
const MAX_COPY_PLANES: usize = 2;

/// Eine Ebene, die in einer gemeinsamen Runde kopiert wird.
struct PlaneCopy {
    res: CuGraphicsResource,
    plane: usize,
    row_bytes: u32,
    rows: u32,
}

/// Das Ziel des GPU-Copies samt der bei CUDA registrierten Resource(n).
struct Staging {
    width: u32,
    height: u32,
    kind: StagingKind,
}

enum StagingKind {
    /// Eine RGBA8-Textur, direkt bei CUDA registriert.
    Rgba8 { tex: u32, cu_res: CuGraphicsResource },
    /// Zwei P010-Ebenen aus dem Shader-Durchgang, je einzeln registriert.
    /// Der Wandler steckt in einer Box: er traegt das ganze Buendel
    /// GL-Funktionszeiger (>300 Byte) und wuerde die Variante sonst um ein
    /// Vielfaches groesser machen als die 8-bit-Variante.
    P010 {
        conv: Box<super::nv_p010::RgbToP010>,
        cu_y: CuGraphicsResource,
        cu_uv: CuGraphicsResource,
    },
}

/// Pro PipeWire-Buffer gecachtes EGLImage + daran gebundene GL-Textur — der
/// Compositor reicht dieselben 2–8 Buffer im Kreis, Neuanlegen pro Frame wäre
/// Wegwerf-Arbeit. Key = `DmabufFrame::buffer_key`, Invalidierung über
/// `DmabufFrame::epoch`.
struct CachedImage {
    image: EglImage,
    tex: u32,
}

/// DMABUF→CUDA-Importer. Hält EGL-Display+Context (current auf dem
/// erzeugenden Thread) und den retained CUDA-Primary-Context.
pub struct NvDmabufImporter {
    // Libraries müssen so lange leben wie die Funktions-Pointer.

    dpy: EglDisplay,
    ctx: EglContext,

    egl_destroy_context: FnEglDestroyContext,
    egl_make_current: FnEglMakeCurrent,
    egl_create_image: FnEglCreateImage,
    egl_destroy_image: FnEglDestroyImage,
    egl_get_error: FnEglGetError,

    gl_gen_textures: FnGlGenTextures,
    gl_delete_textures: FnGlDeleteTextures,
    gl_bind_texture: FnGlBindTexture,
    gl_image_target_texture: FnGlEglImageTargetTexture2D,
    gl_get_error: FnGlGetError,
    gl_tex_storage_2d: FnGlTexStorage2D,
    gl_tex_parameteri: FnGlTexParameteri,
    gl_gen_framebuffers: FnGlGenFramebuffers,
    gl_delete_framebuffers: FnGlDeleteFramebuffers,
    gl_bind_framebuffer: FnGlBindFramebuffer,
    gl_framebuffer_texture_2d: FnGlFramebufferTexture2D,
    gl_blit_framebuffer: FnGlBlitFramebuffer,
    gl_tex_sub_image_2d: FnGlTexSubImage2D,

    /// RGBA8-Staging-Textur (einmal bei CUDA registriert) — Ziel des
    /// GPU-Copies/-Blits aus der EGLImage-Textur, Quelle des cuMemcpy2D.
    /// Hat IMMER die Ausgabe-Größe (`out_w`×`out_h`) — weicht die Capture-
    /// Größe ab, skaliert der Blit (LINEAR) beim Kopieren.
    staging: Option<Staging>,
    /// Format der Staging-Textur (8 oder 10 bit je Kanal).
    staging_format: StagingFormat,
    /// Matrix des 10-bit-Shaders (SDR BT.709 gegen HDR BT.2020).
    farbmodell: super::nv_p010::Farbmodell,
    /// FBO-Paar für den Blit-Pfad (read = EGLImage-Textur, draw = Staging).
    fbos: [u32; 2],
    out_w: u32,
    out_h: u32,
    /// EGLImage+Textur pro Capture-Buffer (s. [`CachedImage`]).
    image_cache: HashMap<u64, CachedImage>,
    cache_epoch: u64,

    cu_device: i32,
    cu_ctx: CuContext,
    cu_primary_ctx_release: FnCuPrimaryCtxRelease,
    cu_ctx_push: FnCuCtxPushCurrent,
    cu_ctx_pop: FnCuCtxPopCurrent,
    cu_register_image: FnCuGraphicsGlRegisterImage,
    cu_map_resources: FnCuGraphicsMapResources,
    cu_get_mapped_array: FnCuGraphicsSubResourceGetMappedArray,
    cu_unmap_resources: FnCuGraphicsUnmapResources,
    cu_unregister_resource: FnCuGraphicsUnregisterResource,
    cu_memcpy_2d: FnCuMemcpy2D,
    cu_ctx_synchronize: FnCuCtxSynchronize,
}

macro_rules! egl_proc {
    ($get:expr, $name:literal, $ty:ty) => {{
        let p = $get(concat!($name, "\0").as_ptr() as *const c_char);
        if p.is_null() {
            return Err(anyhow!(concat!("eglGetProcAddress(", $name, ") → NULL")));
        }
        std::mem::transmute::<*mut c_void, $ty>(p)
    }};
}

/// libcuda prozessweit laden, nie dlclosen (Treiber-Threads/Primary-Context).
fn cuda_library() -> Result<&'static libloading::Library> {
    static LIB: std::sync::OnceLock<Option<libloading::Library>> = std::sync::OnceLock::new();
    LIB.get_or_init(|| unsafe {
        libloading::Library::new("libcuda.so.1")
            .or_else(|_| libloading::Library::new("libcuda.so"))
            .ok()
    })
    .as_ref()
    .ok_or_else(|| anyhow!("libcuda laden fehlgeschlagen — NVIDIA-Treiber installiert?"))
}

macro_rules! cu_sym {
    ($lib:expr, $name:literal, $ty:ty) => {{
        let s: libloading::Symbol<$ty> = $lib
            .get(concat!($name, "\0").as_bytes())
            .map_err(|e| anyhow!(concat!("libcuda: ", $name, ": {}"), e))?;
        *s
    }};
}

impl NvDmabufImporter {
    /// Lade libEGL+libcuda, baue GL-Context auf dem NVIDIA-Device und retaine
    /// den CUDA-Primary-Context. MUSS auf dem Thread laufen, der auch
    /// `import` ruft (eglMakeCurrent ist thread-affin).
    ///
    /// `out_w`/`out_h`: Ausgabe-Größe (= Encoder-Größe). Weicht die Capture-
    /// Größe davon ab, skaliert der Import per Framebuffer-Blit auf der GPU.
    /// `staging_format` legt die Bittiefe des Encoder-Eingangs fest; der
    /// Frame-Pool des Callers MUSS mit [`StagingFormat::av_pix_fmt`] angelegt
    /// sein, sonst kopiert `cuMemcpy2D` Bytes in ein fremdes Layout.
    /// `farbmodell` waehlt die Matrix des 10-bit-Shaders und **muss zur
    /// Signalisierung des Encoders passen** (s. [`super::nv_p010::Farbmodell`]);
    /// im 8-bit-Pfad ist er ohne Wirkung, weil dort NVENC selbst wandelt.
    pub fn new(
        out_w: u32,
        out_h: u32,
        staging_format: StagingFormat,
        farbmodell: super::nv_p010::Farbmodell,
    ) -> Result<Self> {
        unsafe {
            // Beide Libs prozessweit und OHNE dlclose (s. egl_library-Doku —
            // gilt für libcuda mit seinem Primary-Context-State genauso).
            let egl_lib = crate::capture::egl_modifiers::egl_library()
                .map_err(|e| anyhow!("{e}"))?;
            let cuda_lib = cuda_library()?;

            let get_proc: libloading::Symbol<FnGetProcAddress> = egl_lib
                .get(b"eglGetProcAddress\0")
                .map_err(|e| anyhow!("eglGetProcAddress: {e}"))?;
            let get_proc = *get_proc;

            let egl_initialize = egl_proc!(get_proc, "eglInitialize", FnEglInitialize);
            let egl_bind_api = egl_proc!(get_proc, "eglBindAPI", FnEglBindApi);
            let egl_create_context = egl_proc!(get_proc, "eglCreateContext", FnEglCreateContext);
            let egl_destroy_context =
                egl_proc!(get_proc, "eglDestroyContext", FnEglDestroyContext);
            let egl_make_current = egl_proc!(get_proc, "eglMakeCurrent", FnEglMakeCurrent);
            let egl_get_error = egl_proc!(get_proc, "eglGetError", FnEglGetError);
            let egl_query_devices = egl_proc!(get_proc, "eglQueryDevicesEXT", FnEglQueryDevices);
            let egl_get_platform_display =
                egl_proc!(get_proc, "eglGetPlatformDisplayEXT", FnEglGetPlatformDisplay);
            let egl_create_image = egl_proc!(get_proc, "eglCreateImageKHR", FnEglCreateImage);
            let egl_destroy_image = egl_proc!(get_proc, "eglDestroyImageKHR", FnEglDestroyImage);

            let gl_gen_textures = egl_proc!(get_proc, "glGenTextures", FnGlGenTextures);
            let gl_delete_textures = egl_proc!(get_proc, "glDeleteTextures", FnGlDeleteTextures);
            let gl_bind_texture = egl_proc!(get_proc, "glBindTexture", FnGlBindTexture);
            let gl_image_target_texture = egl_proc!(
                get_proc,
                "glEGLImageTargetTexture2DOES",
                FnGlEglImageTargetTexture2D
            );
            let gl_get_error = egl_proc!(get_proc, "glGetError", FnGlGetError);
            let gl_get_string = egl_proc!(get_proc, "glGetString", FnGlGetString);
            let gl_tex_storage_2d = egl_proc!(get_proc, "glTexStorage2D", FnGlTexStorage2D);
            let gl_tex_parameteri = egl_proc!(get_proc, "glTexParameteri", FnGlTexParameteri);
            let gl_gen_framebuffers =
                egl_proc!(get_proc, "glGenFramebuffers", FnGlGenFramebuffers);
            let gl_delete_framebuffers =
                egl_proc!(get_proc, "glDeleteFramebuffers", FnGlDeleteFramebuffers);
            let gl_bind_framebuffer = egl_proc!(get_proc, "glBindFramebuffer", FnGlBindFramebuffer);
            let gl_framebuffer_texture_2d =
                egl_proc!(get_proc, "glFramebufferTexture2D", FnGlFramebufferTexture2D);
            let gl_blit_framebuffer =
                egl_proc!(get_proc, "glBlitFramebuffer", FnGlBlitFramebuffer);
            let gl_tex_sub_image_2d = egl_proc!(get_proc, "glTexSubImage2D", FnGlTexSubImage2D);

            // NVIDIA-Device suchen: Kandidaten durchprobieren, Context bauen,
            // GL_VENDOR prüfen. (Mesa-Devices würden bei
            // cuGraphicsGLRegisterImage scheitern.)
            let mut devices = [ptr::null_mut(); 16];
            let mut n_devices: i32 = 0;
            if egl_query_devices(devices.len() as i32, devices.as_mut_ptr(), &mut n_devices)
                != EGL_TRUE
            {
                return Err(anyhow!("eglQueryDevicesEXT fehlgeschlagen"));
            }

            let mut found: Option<(EglDisplay, EglContext)> = None;
            for &dev in devices.iter().take(n_devices.max(0) as usize) {
                let dpy = egl_get_platform_display(EGL_PLATFORM_DEVICE_EXT, dev, ptr::null());
                if dpy.is_null() {
                    continue;
                }
                let (mut major, mut minor) = (0i32, 0i32);
                if egl_initialize(dpy, &mut major, &mut minor) != EGL_TRUE {
                    continue;
                }
                // KEIN eglTerminate auf verworfenen Kandidaten: Device-Displays
                // sind prozessweit geteilt (gleiches Handle für alle Nutzer) und
                // nicht refcounted — Terminate würde z. B. `egl_modifiers` auf
                // demselben Device die Füße wegziehen. Initialisierte Displays
                // bleiben stehen (bounded: eins pro GPU).
                if egl_bind_api(EGL_OPENGL_API) != EGL_TRUE {
                    continue;
                }
                // configless (EGL_KHR_no_config_context) + surfaceless.
                let attribs = [EGL_NONE];
                let ctx =
                    egl_create_context(dpy, ptr::null_mut(), ptr::null_mut(), attribs.as_ptr());
                if ctx.is_null() {
                    continue;
                }
                if egl_make_current(dpy, ptr::null_mut(), ptr::null_mut(), ctx) != EGL_TRUE {
                    egl_destroy_context(dpy, ctx);
                    continue;
                }
                let version_ptr = gl_get_string(GL_VERSION);
                let vendor = if version_ptr.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(version_ptr).to_string_lossy().into_owned()
                };
                tracing::debug!(target: "nvenc", "EGL-Device-GL: {vendor}");
                if vendor.to_ascii_lowercase().contains("nvidia") {
                    found = Some((dpy, ctx));
                    break;
                }
                egl_make_current(dpy, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
                egl_destroy_context(dpy, ctx);
            }
            let (dpy, ctx) = found
                .ok_or_else(|| anyhow!("kein EGL-Device mit NVIDIA-GL-Context gefunden"))?;

            // Ab hier ist der Context CURRENT auf diesem Thread — jeder
            // Fehlerpfad bis zur fertigen `Self` muss ihn un-current machen und
            // zerstören, sonst leakt er UND stört als stale-current-Context
            // spätere EGL-Nutzung des Threads (CUDA kaputt/fehlend ist der
            // Alltagsfall: nvidia-Modul nicht geladen, Treiber-Reste).
            struct EglCleanup {
                dpy: EglDisplay,
                ctx: EglContext,
                make_current: FnEglMakeCurrent,
                destroy: FnEglDestroyContext,
                armed: bool,
            }
            impl Drop for EglCleanup {
                fn drop(&mut self) {
                    if self.armed {
                        unsafe {
                            (self.make_current)(
                                self.dpy,
                                ptr::null_mut(),
                                ptr::null_mut(),
                                ptr::null_mut(),
                            );
                            (self.destroy)(self.dpy, self.ctx);
                        }
                    }
                }
            }
            let mut egl_cleanup = EglCleanup {
                dpy,
                ctx,
                make_current: egl_make_current,
                destroy: egl_destroy_context,
                armed: true,
            };

            // CUDA: Primary-Context retainen (denselben nutzt FFmpeg via
            // AV_CUDA_USE_PRIMARY_CONTEXT).
            let cu_init = cu_sym!(cuda_lib, "cuInit", FnCuInit);
            let cu_device_get = cu_sym!(cuda_lib, "cuDeviceGet", FnCuDeviceGet);
            let cu_primary_ctx_retain =
                cu_sym!(cuda_lib, "cuDevicePrimaryCtxRetain", FnCuPrimaryCtxRetain);
            let cu_primary_ctx_release =
                cu_sym!(cuda_lib, "cuDevicePrimaryCtxRelease", FnCuPrimaryCtxRelease);
            let cu_ctx_push = cu_sym!(cuda_lib, "cuCtxPushCurrent_v2", FnCuCtxPushCurrent);
            let cu_ctx_pop = cu_sym!(cuda_lib, "cuCtxPopCurrent_v2", FnCuCtxPopCurrent);
            let cu_register_image =
                cu_sym!(cuda_lib, "cuGraphicsGLRegisterImage", FnCuGraphicsGlRegisterImage);
            let cu_map_resources =
                cu_sym!(cuda_lib, "cuGraphicsMapResources", FnCuGraphicsMapResources);
            let cu_get_mapped_array = cu_sym!(
                cuda_lib,
                "cuGraphicsSubResourceGetMappedArray",
                FnCuGraphicsSubResourceGetMappedArray
            );
            let cu_unmap_resources =
                cu_sym!(cuda_lib, "cuGraphicsUnmapResources", FnCuGraphicsUnmapResources);
            let cu_unregister_resource = cu_sym!(
                cuda_lib,
                "cuGraphicsUnregisterResource",
                FnCuGraphicsUnregisterResource
            );
            let cu_memcpy_2d = cu_sym!(cuda_lib, "cuMemcpy2D_v2", FnCuMemcpy2D);
            let cu_ctx_synchronize = cu_sym!(cuda_lib, "cuCtxSynchronize", FnCuCtxSynchronize);

            let r = cu_init(0);
            if r != CUDA_SUCCESS {
                return Err(anyhow!("cuInit failed (rc={r})"));
            }
            let mut cu_device: i32 = 0;
            let r = cu_device_get(&mut cu_device, 0);
            if r != CUDA_SUCCESS {
                return Err(anyhow!("cuDeviceGet(0) failed (rc={r})"));
            }
            let mut cu_ctx: CuContext = ptr::null_mut();
            let r = cu_primary_ctx_retain(&mut cu_ctx, cu_device);
            if r != CUDA_SUCCESS || cu_ctx.is_null() {
                return Err(anyhow!("cuDevicePrimaryCtxRetain failed (rc={r})"));
            }

            // Ab hier übernimmt `Self::drop` das EGL-Teardown.
            egl_cleanup.armed = false;
            let mut me = Self {
                dpy,
                ctx,
                egl_destroy_context,
                egl_make_current,
                egl_create_image,
                egl_destroy_image,
                egl_get_error,
                gl_gen_textures,
                gl_delete_textures,
                gl_bind_texture,
                gl_image_target_texture,
                gl_get_error,
                gl_tex_storage_2d,
                gl_tex_parameteri,
                gl_gen_framebuffers,
                gl_delete_framebuffers,
                gl_bind_framebuffer,
                gl_framebuffer_texture_2d,
                gl_blit_framebuffer,
                gl_tex_sub_image_2d,
                staging: None,
                staging_format,
                farbmodell,
                fbos: [0; 2],
                out_w,
                out_h,
                image_cache: HashMap::new(),
                cache_epoch: 0,
                cu_device,
                cu_ctx,
                cu_primary_ctx_release,
                cu_ctx_push,
                cu_ctx_pop,
                cu_register_image,
                cu_map_resources,
                cu_get_mapped_array,
                cu_unmap_resources,
                cu_unregister_resource,
                cu_memcpy_2d,
                cu_ctx_synchronize,
            };
            // FBO-Paar für den Skalier-Blit + Staging in Ausgabe-Größe —
            // beides einmalig (Context ist current auf diesem Thread).
            (me.gl_gen_framebuffers)(2, me.fbos.as_mut_ptr());
            me.ensure_staging()?;
            Ok(me)
        }
    }

    /// Importiere einen DMABUF-Frame in ein frisches HW-Frame aus dem Pool
    /// (sw_format muss das des Staging-Formats sein, s. `new`). Die fds des DmabufFrame
    /// bleiben beim Caller (er schließt sie nach dem Import).
    /// Caller besitzt das zurückgegebene Frame (`av_frame_free`).
    pub fn import(&mut self, frame: &DmabufFrame, hw: &HwContext) -> Result<*mut AVFrame> {
        self.ensure_staging()?;
        let mut dst = hw.alloc_hwframe()?;
        match self.copy_into(frame, dst) {
            Ok(()) => Ok(dst),
            Err(e) => {
                unsafe { av_frame_free(&mut dst) };
                Err(e)
            }
        }
    }

    /// Kopier-Ziel in Ausgabe-Größe anlegen und bei CUDA registrieren — je
    /// nach [`StagingFormat`] eine RGBA8-Textur oder die zwei P010-Ebenen.
    fn ensure_staging(&mut self) -> Result<()> {
        let (width, height) = (self.out_w, self.out_h);
        if let Some(s) = &self.staging {
            if s.width == width && s.height == height {
                return Ok(());
            }
        }
        self.drop_staging();
        let kind = match self.staging_format {
            StagingFormat::Rgba8 => self.create_rgba8_staging(width, height)?,
            StagingFormat::P010 => self.create_p010_staging(width, height)?,
        };
        self.staging = Some(Staging { width, height, kind });
        Ok(())
    }

    fn create_rgba8_staging(&self, width: u32, height: u32) -> Result<StagingKind> {
        unsafe {
            let mut tex: u32 = 0;
            (self.gl_gen_textures)(1, &mut tex);
            (self.gl_bind_texture)(GL_TEXTURE_2D, tex);
            // NEAREST → Textur ist ohne Mipmaps "complete" (Register-Vorgabe).
            (self.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            (self.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            (self.gl_tex_storage_2d)(GL_TEXTURE_2D, 1, GL_RGBA8, width as i32, height as i32);
            (self.gl_bind_texture)(GL_TEXTURE_2D, 0);
            let gl_err = (self.gl_get_error)();
            if gl_err != GL_NO_ERROR {
                (self.gl_delete_textures)(1, &tex);
                return Err(anyhow!("Staging-Textur anlegen failed (glError={gl_err:#06x})"));
            }
            match self.register_image(tex) {
                Ok(cu_res) => Ok(StagingKind::Rgba8 { tex, cu_res }),
                Err(e) => {
                    (self.gl_delete_textures)(1, &tex);
                    Err(e)
                }
            }
        }
    }

    fn create_p010_staging(&self, width: u32, height: u32) -> Result<StagingKind> {
        let conv = Box::new(super::nv_p010::RgbToP010::new(width, height, self.farbmodell)?);
        // Beide Ebenen einzeln registrieren; scheitert die zweite, muss die
        // erste wieder abgemeldet werden, bevor `conv` die Texturen löscht.
        let cu_y = self.register_image(conv.y_tex())?;
        let cu_uv = match self.register_image(conv.uv_tex()) {
            Ok(res) => res,
            Err(e) => {
                self.unregister(cu_y);
                return Err(e);
            }
        };
        Ok(StagingKind::P010 { conv, cu_y, cu_uv })
    }

    /// Eine GL-Textur bei CUDA anmelden (nur lesend).
    fn register_image(&self, tex: u32) -> Result<CuGraphicsResource> {
        unsafe {
            let r = (self.cu_ctx_push)(self.cu_ctx);
            if r != CUDA_SUCCESS {
                return Err(anyhow!("cuCtxPushCurrent failed (rc={r})"));
            }
            let mut res: CuGraphicsResource = ptr::null_mut();
            let r = (self.cu_register_image)(
                &mut res,
                tex,
                GL_TEXTURE_2D,
                CU_GRAPHICS_REGISTER_FLAGS_READ_ONLY,
            );
            let mut old: CuContext = ptr::null_mut();
            (self.cu_ctx_pop)(&mut old);
            if r != CUDA_SUCCESS {
                return Err(anyhow!("cuGraphicsGLRegisterImage failed (rc={r})"));
            }
            Ok(res)
        }
    }

    /// `false` = Abmelden ist NICHT passiert; die Resource hält die Textur
    /// weiter, der Caller darf sie dann nicht löschen.
    fn unregister(&self, res: CuGraphicsResource) -> bool {
        unsafe {
            if (self.cu_ctx_push)(self.cu_ctx) == CUDA_SUCCESS {
                (self.cu_unregister_resource)(res);
                let mut old: CuContext = ptr::null_mut();
                (self.cu_ctx_pop)(&mut old);
                true
            } else {
                // Context tot (Device-Loss): die CUDA-Resource referenziert die
                // Textur weiter — sie TROTZDEM zu löschen hieße, der
                // registrierten Resource die Textur unterm Hintern wegzuziehen
                // (UB bei Treiber-Recovery). Bewusst leaken.
                tracing::warn!(
                    target: "nvenc",
                    "cuCtxPushCurrent fehlgeschlagen — Staging bleibt registriert (Device-Loss?)"
                );
                false
            }
        }
    }

    fn drop_staging(&mut self) {
        let Some(s) = self.staging.take() else { return };
        match s.kind {
            StagingKind::Rgba8 { tex, cu_res } => {
                if self.unregister(cu_res) {
                    unsafe { (self.gl_delete_textures)(1, &tex) };
                }
            }
            // `conv` löscht seine Texturen im eigenen Drop. Ließ sich eine
            // Ebene nicht abmelden, bleibt sie registriert und darf nicht
            // gelöscht werden → `conv` vergessen statt droppen (bewusstes Leck,
            // wie im 8-bit-Zweig).
            StagingKind::P010 { conv, cu_y, cu_uv } => {
                let freed = self.unregister(cu_y) && self.unregister(cu_uv);
                if freed {
                    drop(conv);
                } else {
                    std::mem::forget(conv);
                }
            }
        }
    }

    fn copy_into(&mut self, frame: &DmabufFrame, dst: *mut AVFrame) -> Result<()> {
        if frame.planes.is_empty() || frame.planes.len() > 4 {
            return Err(anyhow!("DmabufFrame mit {} Planes", frame.planes.len()));
        }

        // Epochenwechsel (Buffer-Abbau/Neuverhandlung in der Capture) →
        // gecachte EGLImages zeigen evtl. auf tote/recycelte Buffer: alles weg.
        if frame.epoch != self.cache_epoch {
            self.drop_image_cache();
            self.cache_epoch = frame.epoch;
        }
        // Notbremse gegen pathologisches Key-Churn (normal sind 2–8 Buffer).
        if self.image_cache.len() > 32 {
            tracing::warn!(target: "nvenc", "EGLImage-Cache >32 Einträge — leere (Key-Churn?)");
            self.drop_image_cache();
        }

        // Der Compositor reicht dieselben Buffer im Kreis: EGLImage + GL-Textur
        // EINMAL pro Buffer bauen und wiederverwenden — statt Anlegen+Zerstören
        // bei jedem Frame (bei 144+fps reine Wegwerf-Arbeit). EGL hält eine
        // eigene dma-buf-Referenz (EGL_EXT_image_dma_buf_import), das Image
        // bleibt also auch nach dem Schließen der dup'ten fds gültig und ist
        // eine LIVE-Sicht auf den Buffer-Inhalt.
        //
        // **`buffer_key == 0` heisst „nicht merken"** — so steht es seit jeher
        // an [`DmabufFrame::buffer_key`], umgesetzt war es nicht: der Wert 0
        // landete wie jeder andere Schluessel im Zwischenspeicher. Fuer den
        // PipeWire-Weg blieb das folgenlos (dort vergibt jeder Puffer einen
        // echten Schluessel), fuer die Scanout-Aufnahme waere es ein
        // **stehendes Bild** gewesen: der Compositor tauscht dort den Puffer
        // bei jedem Bild, und alle haetten sich denselben Eintrag geteilt.
        // Aufgefallen am 2026-08-07 an der Zeile „EGLImage-Cache: neuer
        // Capture-Buffer aufgenommen buffers=1", die bei einem 180-Bild-Lauf
        // genau einmal kam.
        if frame.buffer_key == 0 {
            let (image, tex) = self.create_image_tex(frame)?;
            let ergebnis = unsafe { self.blit_and_copy(tex, frame, dst) };
            unsafe {
                (self.gl_delete_textures)(1, &tex);
                (self.egl_destroy_image)(self.dpy, image);
            }
            return ergebnis;
        }
        let tex = match self.image_cache.get(&frame.buffer_key) {
            Some(cached) => cached.tex,
            None => {
                let (image, tex) = self.create_image_tex(frame)?;
                self.image_cache.insert(frame.buffer_key, CachedImage { image, tex });
                // Taucht nur beim ersten Umlauf jedes Buffers auf (2–8×  pro
                // Stream) — steigt die Zahl dauerhaft, ist das Caching kaputt.
                tracing::info!(
                    target: "nvenc",
                    buffers = self.image_cache.len(),
                    "EGLImage-Cache: neuer Capture-Buffer aufgenommen"
                );
                tex
            }
        };
        unsafe { self.blit_and_copy(tex, frame, dst) }
    }

    /// EGLImage aus den DMABUF-Planes + daran gebundene GL-Textur (einmal pro
    /// Buffer; landet im `image_cache`).
    fn create_image_tex(&self, frame: &DmabufFrame) -> Result<(EglImage, u32)> {
        unsafe {
            // EGLImage aus den DMABUF-Planes (+ Modifier, außer INVALID).
            let mut attribs: Vec<i32> = vec![
                EGL_WIDTH,
                frame.width as i32,
                EGL_HEIGHT,
                frame.height as i32,
                EGL_LINUX_DRM_FOURCC_EXT,
                frame.drm_fourcc as i32,
            ];
            for (i, plane) in frame.planes.iter().enumerate() {
                attribs.extend_from_slice(&[
                    EGL_DMA_BUF_PLANE_FD_EXT[i],
                    plane.fd,
                    EGL_DMA_BUF_PLANE_OFFSET_EXT[i],
                    plane.offset as i32,
                    EGL_DMA_BUF_PLANE_PITCH_EXT[i],
                    plane.stride,
                ]);
                if frame.modifier != DRM_FORMAT_MOD_INVALID {
                    attribs.extend_from_slice(&[
                        EGL_DMA_BUF_PLANE_MODIFIER_LO_EXT[i],
                        (frame.modifier & 0xFFFF_FFFF) as i32,
                        EGL_DMA_BUF_PLANE_MODIFIER_HI_EXT[i],
                        (frame.modifier >> 32) as i32,
                    ]);
                }
            }
            attribs.push(EGL_NONE);

            let image = (self.egl_create_image)(
                self.dpy,
                ptr::null_mut(), // EGL_NO_CONTEXT bei DMA_BUF-Import
                EGL_LINUX_DMA_BUF_EXT,
                ptr::null_mut(),
                attribs.as_ptr(),
            );
            if image.is_null() {
                return Err(anyhow!(
                    "eglCreateImageKHR(dmabuf) failed (eglError={:#06x})",
                    (self.egl_get_error)()
                ));
            }

            let mut tex: u32 = 0;
            (self.gl_gen_textures)(1, &mut tex);
            (self.gl_bind_texture)(GL_TEXTURE_2D, tex);
            // LINEAR + Klemmen an den Rand, EINMAL hier statt je Bild:
            // * der 8-bit-Pfad kopiert per `glBlitFramebuffer` und bringt seinen
            //   Filter im Aufruf mit — ihm ist der Sampler-Zustand gleich;
            // * der 10-bit-Pfad SAMPELT die Textur im Shader (`nv_p010`) und
            //   braucht beides: LINEAR gegen Aliasing beim Herunterskalieren,
            //   CLAMP, damit das 2x2-Chroma-Mittel am Bildrand nicht ueber die
            //   Kante greift.
            // Ohne Mipmaps ist die Textur mit LINEAR weiterhin "complete", die
            // CUDA-Registrierung bleibt also moeglich.
            (self.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_FILTER);
            (self.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR_FILTER);
            (self.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            (self.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            (self.gl_image_target_texture)(GL_TEXTURE_2D, image);
            let gl_err = (self.gl_get_error)();
            (self.gl_bind_texture)(GL_TEXTURE_2D, 0);
            if gl_err != GL_NO_ERROR {
                (self.gl_delete_textures)(1, &tex);
                (self.egl_destroy_image)(self.dpy, image);
                return Err(anyhow!(
                    "glEGLImageTargetTexture2DOES failed (glError={gl_err:#06x})"
                ));
            }
            Ok((image, tex))
        }
    }

    /// Quelltextur → Kopier-Ziel → ffmpeg-Frame. Welcher der beiden Wege
    /// gelaufen wird, entscheidet das Staging-Format.
    unsafe fn blit_and_copy(&self, tex: u32, frame: &DmabufFrame, dst: *mut AVFrame) -> Result<()> {
        let staging = self.staging.as_ref().expect("ensure_staging vor blit_and_copy");
        match &staging.kind {
            StagingKind::Rgba8 { tex: staging_tex, cu_res } => unsafe {
                self.blit_rgba8(tex, *staging_tex, frame, staging.width, staging.height)?;
                self.cuda_copy(*cu_res, dst)
            },
            StagingKind::P010 { conv, cu_y, cu_uv } => {
                // Skalierung steckt hier im Ziel-Viewport des Shaders, nicht
                // in einem Blit — die Quellgröße spielt keine Rolle mehr.
                conv.convert(tex)?;
                let (uv_w, uv_h) = conv.uv_size();
                unsafe {
                    self.cuda_copy_planes(
                        dst,
                        &[
                            // Luma: R16 → 2 Byte/Bildpunkt, dst->data[0].
                            PlaneCopy {
                                res: *cu_y,
                                plane: 0,
                                row_bytes: staging.width * 2,
                                rows: staging.height,
                            },
                            // Chroma verschränkt: RG16 → 4 Byte/Bildpunkt, data[1].
                            PlaneCopy { res: *cu_uv, plane: 1, row_bytes: uv_w * 4, rows: uv_h },
                        ],
                    )
                }
            }
        }
    }

    unsafe fn blit_rgba8(
        &self,
        tex: u32,
        staging_tex: u32,
        frame: &DmabufFrame,
        out_w: u32,
        out_h: u32,
    ) -> Result<()> {
        unsafe {
            // EGLImage-Textur → Staging, IMMER per Framebuffer-Blit (LINEAR):
            // skaliert bei Bedarf und ist bei 1:1 ein reiner Copy. Bewusst KEIN
            // glCopyImageSubData-Schnellpfad — der kopiert ROHE Bytes
            // (BGRx bliebe BGRx), der Blit dagegen KOMPONENTENWEISE: der
            // Treiber liest die BGRA-geordnete Quelle logisch korrekt und
            // schreibt in die RGBA8-Staging → Bytes liegen danach als R,G,B,X.
            // Zwei Pfade hieße zwei Byte-Ordnungen je nach Skalierung (der
            // Rot/Blau-Tausch-Bug). Deshalb: ein Pfad, und der Encoder-Pool
            // ist RGB0 (stream_controller) — passt zum Blit-Ergebnis.
            // CUDA sieht danach die Staging-Textur; die Map-Operation
            // synchronisiert implizit mit vorherigem GL.
            (self.gl_bind_framebuffer)(GL_READ_FRAMEBUFFER, self.fbos[0]);
            (self.gl_framebuffer_texture_2d)(
                GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0,
            );
            (self.gl_bind_framebuffer)(GL_DRAW_FRAMEBUFFER, self.fbos[1]);
            (self.gl_framebuffer_texture_2d)(
                GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, staging_tex, 0,
            );
            (self.gl_blit_framebuffer)(
                0, 0, frame.width as i32, frame.height as i32,
                0, 0, out_w as i32, out_h as i32,
                GL_COLOR_BUFFER_BIT, GL_LINEAR,
            );
            // Texturen detachen (die Quell-Textur lebt im Cache weiter, soll
            // aber nicht am FBO hängen bleiben) — und den FBO-Bind zurücksetzen.
            (self.gl_framebuffer_texture_2d)(
                GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0,
            );
            (self.gl_framebuffer_texture_2d)(
                GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0,
            );
            (self.gl_bind_framebuffer)(GL_FRAMEBUFFER, 0);
            let gl_err = (self.gl_get_error)();
            if gl_err != GL_NO_ERROR {
                return Err(anyhow!("GL blit → staging failed (glError={gl_err:#06x})"));
            }
        }
        Ok(())
    }

    /// Alle gecachten EGLImages + Texturen zerstören (Epochenwechsel / Drop).
    fn drop_image_cache(&mut self) {
        for (_, c) in self.image_cache.drain() {
            unsafe {
                (self.gl_delete_textures)(1, &c.tex);
                (self.egl_destroy_image)(self.dpy, c.image);
            }
        }
    }


    /// Selbsttest des 10-bit-Pfads OHNE Capture: schiebt ein bekanntes
    /// RGBA8-Bild (dicht gepackt, `out_w*out_h*4`, Reihenfolge R,G,B,A) durch
    /// dieselben Shader-Durchgänge und dieselbe CUDA-Kopie wie der Encoder und
    /// gibt `(luma, chroma)` als rohe 16-bit-Bytes zurück.
    ///
    /// Existiert, weil Farbmatrix und Bit-Lage sonst nur am laufenden Stream
    /// mit dem Auge prüfbar wären — und genau diese Fehlerklasse (Rot/Blau
    /// getauscht, Bild zu dunkel/zu hell um Faktor 64) hat in diesem Projekt
    /// schon zweimal zugeschlagen. `examples/staging_format_probe.rs` rechnet
    /// die Erwartung unabhängig nach.
    pub fn selftest_p010(&mut self, rgba8: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        const GL_UNSIGNED_BYTE: u32 = 0x1401;
        const GL_RGBA_FMT: u32 = 0x1908;
        if !self.staging_format.is_ten_bit() {
            return Err(anyhow!("selftest_p010 braucht StagingFormat::P010"));
        }
        self.ensure_staging()?;
        let (w, h) = (self.out_w, self.out_h);
        let expected = w as usize * h as usize * 4;
        if rgba8.len() != expected {
            return Err(anyhow!("rgba8: {} Bytes, erwartet {expected}", rgba8.len()));
        }
        let Some(Staging { kind: StagingKind::P010 { conv, cu_y, cu_uv }, .. }) =
            self.staging.as_ref()
        else {
            return Err(anyhow!("kein P010-Staging"));
        };
        let (uv_w, uv_h) = conv.uv_size();

        // Quelltextur in Ausgabegröße: der Shader unterscheidet nicht, woher
        // sie kommt — im Betrieb ist es die EGLImage-Textur.
        let src = unsafe {
            let mut tex = 0u32;
            (self.gl_gen_textures)(1, &mut tex);
            (self.gl_bind_texture)(GL_TEXTURE_2D, tex);
            (self.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            (self.gl_tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            (self.gl_tex_storage_2d)(GL_TEXTURE_2D, 1, GL_RGBA8, w as i32, h as i32);
            (self.gl_tex_sub_image_2d)(
                GL_TEXTURE_2D,
                0,
                0,
                0,
                w as i32,
                h as i32,
                GL_RGBA_FMT,
                GL_UNSIGNED_BYTE,
                rgba8.as_ptr() as *const c_void,
            );
            (self.gl_bind_texture)(GL_TEXTURE_2D, 0);
            let err = (self.gl_get_error)();
            if err != GL_NO_ERROR {
                (self.gl_delete_textures)(1, &tex);
                return Err(anyhow!("Selbsttest-Quelltextur: glError={err:#06x}"));
            }
            tex
        };

        let out = (|| -> Result<(Vec<u8>, Vec<u8>)> {
            conv.convert(src)?;
            let luma = unsafe { self.read_plane_to_host(*cu_y, w * 2, h)? };
            let chroma = unsafe { self.read_plane_to_host(*cu_uv, uv_w * 4, uv_h)? };
            Ok((luma, chroma))
        })();
        unsafe { (self.gl_delete_textures)(1, &src) };
        out
    }

    /// Eine registrierte Ebene in den Hauptspeicher lesen — nur für den
    /// Selbsttest, der Encode-Pfad kopiert GPU→GPU.
    unsafe fn read_plane_to_host(
        &self,
        res: CuGraphicsResource,
        row_bytes: u32,
        rows: u32,
    ) -> Result<Vec<u8>> {
        unsafe {
            let mut out = vec![0u8; row_bytes as usize * rows as usize];
            let r = (self.cu_ctx_push)(self.cu_ctx);
            if r != CUDA_SUCCESS {
                return Err(anyhow!("cuCtxPushCurrent failed (rc={r})"));
            }
            let mut res = res;
            let result = (|| -> Result<()> {
                let r = (self.cu_map_resources)(1, &mut res, ptr::null_mut());
                if r != CUDA_SUCCESS {
                    return Err(anyhow!("cuGraphicsMapResources failed (rc={r})"));
                }
                let result = (|| -> Result<()> {
                    let mut array: CuArray = ptr::null_mut();
                    let r = (self.cu_get_mapped_array)(&mut array, res, 0, 0);
                    if r != CUDA_SUCCESS {
                        return Err(anyhow!("cuGraphicsSubResourceGetMappedArray (rc={r})"));
                    }
                    let cpy = CudaMemcpy2D {
                        src_x_in_bytes: 0,
                        src_y: 0,
                        src_memory_type: CU_MEMORYTYPE_ARRAY,
                        src_host: ptr::null(),
                        src_device: 0,
                        src_array: array,
                        src_pitch: 0,
                        dst_x_in_bytes: 0,
                        dst_y: 0,
                        dst_memory_type: CU_MEMORYTYPE_HOST,
                        dst_host: out.as_mut_ptr() as *mut c_void,
                        dst_device: 0,
                        dst_array: ptr::null_mut(),
                        dst_pitch: row_bytes as usize,
                        width_in_bytes: row_bytes as usize,
                        height: rows as usize,
                    };
                    let r = (self.cu_memcpy_2d)(&cpy);
                    if r != CUDA_SUCCESS {
                        return Err(anyhow!("cuMemcpy2D(→host) failed (rc={r})"));
                    }
                    Ok(())
                })();
                (self.cu_unmap_resources)(1, &mut res, ptr::null_mut());
                result
            })();
            let mut old: CuContext = ptr::null_mut();
            (self.cu_ctx_pop)(&mut old);
            result?;
            Ok(out)
        }
    }

    /// 8-bit-Pfad: die RGBA8-Staging in `dst->data[0]`.
    unsafe fn cuda_copy(&self, res: CuGraphicsResource, dst: *mut AVFrame) -> Result<()> {
        // Schutzgurt gegen abweichende Frame-Maße (Pool und Staging sind beide
        // out_w×out_h, aber ein Copy über den Frame hinaus wäre fatal).
        let w = unsafe { self.out_w.min((*dst).width.max(0) as u32) };
        let h = unsafe { self.out_h.min((*dst).height.max(0) as u32) };
        unsafe { self.cuda_copy_planes(dst, &[PlaneCopy { res, plane: 0, row_bytes: w * 4, rows: h }]) }
    }

    /// Registrierte GL-Texturen (ARRAY) → Ebenen des ffmpeg-Frames.
    ///
    /// **In EINER Runde**, und das ist kein Detail: `cuGraphicsMapResources` und
    /// `cuCtxSynchronize` sind Zwangspausen, in denen die CPU auf die GPU
    /// wartet. Je Ebene eine eigene Runde zu fahren verdoppelte sie beim
    /// 10-bit-Pfad und machte die Bildrate sichtbar unruhig, während der
    /// 8-bit-Pfad mit einer Runde glatt lief.
    ///
    /// `row_bytes`/`rows` beziehen sich auf die QUELLE; die Zielschrittweite
    /// kommt aus `linesize[plane]`. Für P010 heißt das: Luma `width*2`,
    /// verschränktes Chroma `uv_width*4`.
    unsafe fn cuda_copy_planes(&self, dst: *mut AVFrame, planes: &[PlaneCopy]) -> Result<()> {
        unsafe {
            for p in planes {
                if (*dst).data[p.plane].is_null() {
                    return Err(anyhow!("Frame-Ebene {} fehlt (falsches sw_format?)", p.plane));
                }
            }
            let r = (self.cu_ctx_push)(self.cu_ctx);
            if r != CUDA_SUCCESS {
                return Err(anyhow!("cuCtxPushCurrent failed (rc={r})"));
            }
            // Feste Groesse statt `Vec` je Bild: es sind immer eine (RGBA8) oder
            // zwei (P010) Ebenen, und das laeuft 60-mal je Sekunde.
            let mut resources = [ptr::null_mut(); MAX_COPY_PLANES];
            let count = planes.len().min(MAX_COPY_PLANES);
            for (slot, p) in resources.iter_mut().zip(planes) {
                *slot = p.res;
            }
            let resources = &mut resources[..count];
            let result = (|| -> Result<()> {
                let r = (self.cu_map_resources)(
                    count as u32,
                    resources.as_mut_ptr(),
                    ptr::null_mut(),
                );
                if r != CUDA_SUCCESS {
                    return Err(anyhow!("cuGraphicsMapResources failed (rc={r})"));
                }
                let result = (|| -> Result<()> {
                    for (p, res) in planes.iter().zip(resources.iter()) {
                        let mut array: CuArray = ptr::null_mut();
                        let r = (self.cu_get_mapped_array)(&mut array, *res, 0, 0);
                        if r != CUDA_SUCCESS {
                            return Err(anyhow!(
                                "cuGraphicsSubResourceGetMappedArray failed (rc={r})"
                            ));
                        }
                        let cpy = CudaMemcpy2D {
                            src_x_in_bytes: 0,
                            src_y: 0,
                            src_memory_type: CU_MEMORYTYPE_ARRAY,
                            src_host: ptr::null(),
                            src_device: 0,
                            src_array: array,
                            src_pitch: 0,
                            dst_x_in_bytes: 0,
                            dst_y: 0,
                            dst_memory_type: CU_MEMORYTYPE_DEVICE,
                            dst_host: ptr::null_mut(),
                            dst_device: (*dst).data[p.plane] as u64,
                            dst_array: ptr::null_mut(),
                            dst_pitch: (*dst).linesize[p.plane].max(0) as usize,
                            width_in_bytes: p.row_bytes as usize,
                            height: p.rows as usize,
                        };
                        let r = (self.cu_memcpy_2d)(&cpy);
                        if r != CUDA_SUCCESS {
                            return Err(anyhow!("cuMemcpy2D(plane {}) failed (rc={r})", p.plane));
                        }
                    }
                    // EINMAL für alle Ebenen: NVENC liest auf FFmpegs eigenem
                    // Stream, also muss vor der Übergabe alles durch sein.
                    let r = (self.cu_ctx_synchronize)();
                    if r != CUDA_SUCCESS {
                        return Err(anyhow!("cuCtxSynchronize failed (rc={r})"));
                    }
                    Ok(())
                })();
                (self.cu_unmap_resources)(
                    count as u32,
                    resources.as_mut_ptr(),
                    ptr::null_mut(),
                );
                result
            })();
            let mut old: CuContext = ptr::null_mut();
            (self.cu_ctx_pop)(&mut old);
            result
        }
    }
}

impl Drop for NvDmabufImporter {
    fn drop(&mut self) {
        self.drop_image_cache();
        self.drop_staging();
        unsafe {
            if self.fbos != [0; 2] {
                (self.gl_delete_framebuffers)(2, self.fbos.as_ptr());
            }
            (self.egl_make_current)(self.dpy, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
            (self.egl_destroy_context)(self.dpy, self.ctx);
            // KEIN eglTerminate: das Device-Display ist prozessweit geteilt
            // (egl_modifiers fragt es bei jedem Capture-Start ab) und nicht
            // refcounted — Terminate würde fremde Contexts/Images zerstören.
            (self.cu_primary_ctx_release)(self.cu_device);
        }
    }
}
