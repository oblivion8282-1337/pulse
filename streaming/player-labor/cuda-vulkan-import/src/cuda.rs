//! CUDA-Treiber-API, nur die Handvoll Aufrufe dieser Probe, per `dlopen`.
//!
//! **Warum von Hand und nicht ueber eine Crate:** `libcuda.so` gehoert zum
//! Grafiktreiber, nicht zum CUDA-Toolkit. Eine Bindungs-Crate wie `cust`
//! verlangt ein installiertes SDK; hier soll die Probe auf jeder Maschine mit
//! NVIDIA-Treiber laufen. Der Linux-Sidecar bindet EGL aus demselben Grund so.
//!
//! **Die Struct-Layouts sind der heikle Teil.** Sie muessen `cuda.h` exakt
//! treffen — ein falsches Feld-Offset erzeugt keinen Fehler, sondern stille
//! Falschergebnisse. Deshalb steht an jedem Feld sein Byte-Versatz, und
//! [`selbsttest_layout`] prueft die Groessen gegen die Werte aus dem Header.

use std::ffi::{c_char, c_int, c_uint, c_void, CStr};

use anyhow::{bail, Context, Result};
use libloading::{Library, Symbol};

pub type CUresult = c_int;
pub type CUdevice = c_int;
pub type CUdeviceptr = u64;
pub type CUcontext = *mut c_void;
pub type CUexternalMemory = *mut c_void;

pub const CUDA_SUCCESS: CUresult = 0;

/// `CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD` — der Linux-Weg. Windows nutzt
/// an derselben Stelle `OPAQUE_WIN32` (Typ 2), was der Grund ist, warum die
/// Probe von der Windows-Seite nicht uebertragbar ist.
pub const CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD: c_uint = 1;

/// `CUDA_EXTERNAL_MEMORY_DEDICATED` — muss gesetzt sein, wenn die Vulkan-Seite
/// mit `VkMemoryDedicatedAllocateInfo` alloziert hat. Fuer Bilder ist das auf
/// NVIDIA die Regel, fuer Puffer nicht.
pub const CUDA_EXTERNAL_MEMORY_DEDICATED: c_uint = 0x01;

/// `CUDA_EXTERNAL_MEMORY_HANDLE_DESC` aus `cuda.h`.
///
/// Versaetze (64-bit): `type` 0, union 8..24 (`int fd` liegt am Anfang, die
/// groesste Variante ist `struct {void*, const void*}` = 16 B), `size` 24,
/// `flags` 32, `reserved[16]` 36..100. Gesamtgroesse 104 mit Endauffuellung.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ExternalMemoryHandleDesc {
    pub typ: c_uint,
    _auffuellung_vor_union: c_uint,
    /// Erste Variante der union: `int fd`.
    pub fd: c_int,
    /// Rest der union — die Win32-Variante ist breiter als `int`.
    _rest_der_union: [u8; 12],
    pub size: u64,
    pub flags: c_uint,
    pub reserved: [c_uint; 16],
}

impl ExternalMemoryHandleDesc {
    /// Beschreibung fuer einen Dateideskriptor aus Vulkan.
    ///
    /// `dediziert` MUSS zur Vulkan-Seite passen: hat diese mit
    /// `VkMemoryDedicatedAllocateInfo` alloziert, verlangt CUDA das Flag —
    /// fehlt es, rechnet der Treiber mit einer anderen Speicherlage.
    pub fn fuer_fd(fd: c_int, size: u64, dediziert: bool) -> Self {
        Self {
            typ: CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD,
            _auffuellung_vor_union: 0,
            fd,
            _rest_der_union: [0; 12],
            size,
            flags: if dediziert { CUDA_EXTERNAL_MEMORY_DEDICATED } else { 0 },
            reserved: [0; 16],
        }
    }
}

/// `CUDA_EXTERNAL_MEMORY_BUFFER_DESC` aus `cuda.h`.
///
/// Versaetze: `offset` 0, `size` 8, `flags` 16, `reserved[16]` 20..84.
/// Gesamtgroesse 88 mit Endauffuellung.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ExternalMemoryBufferDesc {
    pub offset: u64,
    pub size: u64,
    pub flags: c_uint,
    pub reserved: [c_uint; 16],
}

/// Die Groessen aus `cuda.h` gegenpruefen. Laeuft beim Start, nicht als Test:
/// stimmt hier etwas nicht, ist jede Zahl der Probe wertlos, und das soll
/// SOFORT auffallen statt in den Messwerten.
pub fn selbsttest_layout() -> Result<()> {
    let paare: [(&str, usize, usize); 2] = [
        ("CUDA_EXTERNAL_MEMORY_HANDLE_DESC", std::mem::size_of::<ExternalMemoryHandleDesc>(), 104),
        ("CUDA_EXTERNAL_MEMORY_BUFFER_DESC", std::mem::size_of::<ExternalMemoryBufferDesc>(), 88),
    ];
    for (name, ist, soll) in paare {
        if ist != soll {
            bail!("{name}: {ist} Bytes, erwartet {soll} — Layout weicht von cuda.h ab");
        }
    }
    Ok(())
}

macro_rules! sym {
    ($lib:expr, $name:literal, $typ:ty) => {{
        let s: Symbol<$typ> = unsafe { $lib.get(concat!($name, "\0").as_bytes()) }
            .with_context(|| format!("libcuda kennt {} nicht", $name))?;
        // `Symbol<T>` dereferenziert bereits zu `T` (Funktionszeiger sind
        // `Copy`) — kein `transmute` noetig, `*s` ist schon der richtige Typ.
        *s
    }};
}

// Ein Typalias je CUDA-Signatur, damit sie nicht doppelt ausgeschrieben
// werden muss: einmal fuer das Struct-Feld unten, einmal fuer den `sym!`-
// Aufruf in `laden()`. Reine Schreibabkuerzung, keine Aenderung der Typen.
type FnCuInit = unsafe extern "C" fn(c_uint) -> CUresult;
type FnCuDeviceGet = unsafe extern "C" fn(*mut CUdevice, c_int) -> CUresult;
type FnCuDeviceGetUuid = unsafe extern "C" fn(*mut [u8; 16], CUdevice) -> CUresult;
type FnCuDevicePrimaryCtxRetain = unsafe extern "C" fn(*mut CUcontext, CUdevice) -> CUresult;
type FnCuCtxSetCurrent = unsafe extern "C" fn(CUcontext) -> CUresult;
type FnCuCtxSynchronize = unsafe extern "C" fn() -> CUresult;
type FnCuImportExternalMemory =
    unsafe extern "C" fn(*mut CUexternalMemory, *const ExternalMemoryHandleDesc) -> CUresult;
type FnCuExternalMemoryGetMappedBuffer = unsafe extern "C" fn(
    *mut CUdeviceptr,
    CUexternalMemory,
    *const ExternalMemoryBufferDesc,
) -> CUresult;
type FnCuDestroyExternalMemory = unsafe extern "C" fn(CUexternalMemory) -> CUresult;
type FnCuMemcpyHtoD = unsafe extern "C" fn(CUdeviceptr, *const c_void, usize) -> CUresult;
type FnCuMemcpyDtoH = unsafe extern "C" fn(*mut c_void, CUdeviceptr, usize) -> CUresult;
type FnCuMemsetD8 = unsafe extern "C" fn(CUdeviceptr, u8, usize) -> CUresult;
type FnCuGetErrorString = unsafe extern "C" fn(CUresult, *mut *const c_char) -> CUresult;

/// Die geladenen Einsprungpunkte. `_lib` haelt die Bibliothek am Leben — faellt
/// sie, zeigen alle Zeiger ins Leere.
#[allow(non_snake_case)]
pub struct Cuda {
    _lib: Library,
    pub cuInit: FnCuInit,
    pub cuDeviceGet: FnCuDeviceGet,
    pub cuDeviceGetUuid: FnCuDeviceGetUuid,
    pub cuDevicePrimaryCtxRetain: FnCuDevicePrimaryCtxRetain,
    pub cuCtxSetCurrent: FnCuCtxSetCurrent,
    pub cuCtxSynchronize: FnCuCtxSynchronize,
    pub cuImportExternalMemory: FnCuImportExternalMemory,
    pub cuExternalMemoryGetMappedBuffer: FnCuExternalMemoryGetMappedBuffer,
    pub cuDestroyExternalMemory: FnCuDestroyExternalMemory,
    pub cuMemcpyHtoD: FnCuMemcpyHtoD,
    pub cuMemcpyDtoH: FnCuMemcpyDtoH,
    pub cuMemsetD8: FnCuMemsetD8,
    pub cuGetErrorString: FnCuGetErrorString,
}

impl Cuda {
    /// `libcuda.so.1`, nicht `libcuda.so`: letzteres ist der Entwicklungs-Link
    /// und fehlt auf reinen Laufzeit-Installationen.
    pub fn laden() -> Result<Self> {
        let lib = unsafe { Library::new("libcuda.so.1") }
            .context("libcuda.so.1 nicht ladbar — NVIDIA-Treiber installiert?")?;
        Ok(Self {
            cuInit: sym!(lib, "cuInit", FnCuInit),
            cuDeviceGet: sym!(lib, "cuDeviceGet", FnCuDeviceGet),
            cuDeviceGetUuid: sym!(lib, "cuDeviceGetUuid", FnCuDeviceGetUuid),
            cuDevicePrimaryCtxRetain: sym!(
                lib,
                "cuDevicePrimaryCtxRetain",
                FnCuDevicePrimaryCtxRetain
            ),
            cuCtxSetCurrent: sym!(lib, "cuCtxSetCurrent", FnCuCtxSetCurrent),
            cuCtxSynchronize: sym!(lib, "cuCtxSynchronize", FnCuCtxSynchronize),
            cuImportExternalMemory: sym!(
                lib,
                "cuImportExternalMemory",
                FnCuImportExternalMemory
            ),
            cuExternalMemoryGetMappedBuffer: sym!(
                lib,
                "cuExternalMemoryGetMappedBuffer",
                FnCuExternalMemoryGetMappedBuffer
            ),
            cuDestroyExternalMemory: sym!(
                lib,
                "cuDestroyExternalMemory",
                FnCuDestroyExternalMemory
            ),
            // Die Speicher-Aufrufe tragen in `cuda.h` ein `_v2` — ohne das
            // laedt man die alte 32-bit-Fassung.
            cuMemcpyHtoD: sym!(lib, "cuMemcpyHtoD_v2", FnCuMemcpyHtoD),
            cuMemcpyDtoH: sym!(lib, "cuMemcpyDtoH_v2", FnCuMemcpyDtoH),
            cuMemsetD8: sym!(lib, "cuMemsetD8_v2", FnCuMemsetD8),
            cuGetErrorString: sym!(lib, "cuGetErrorString", FnCuGetErrorString),
            _lib: lib,
        })
    }

    /// Rueckgabewert pruefen und im Fehlerfall den Klartext des Treibers
    /// mitgeben — `CUDA_ERROR_INVALID_VALUE` allein sagt bei diesen Aufrufen zu
    /// wenig, um den Fehler zu finden.
    pub fn pruefe(&self, r: CUresult, was: &str) -> Result<()> {
        if r == CUDA_SUCCESS {
            return Ok(());
        }
        let mut p: *const c_char = std::ptr::null();
        let text = unsafe {
            if (self.cuGetErrorString)(r, &mut p) == CUDA_SUCCESS && !p.is_null() {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            } else {
                String::from("unbekannter Fehler")
            }
        };
        bail!("{was}: CUDA-Fehler {r} ({text})");
    }
}
