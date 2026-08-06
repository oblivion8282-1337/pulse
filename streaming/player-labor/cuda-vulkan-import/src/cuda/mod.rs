//! CUDA-Treiber-API, nur die Handvoll Aufrufe dieser Probe, per `dlopen`.
//!
//! **Warum von Hand und nicht ueber eine Crate:** `libcuda.so` gehoert zum
//! Grafiktreiber, nicht zum CUDA-Toolkit. Eine Bindungs-Crate wie `cust`
//! verlangt ein installiertes SDK; hier soll die Probe auf jeder Maschine mit
//! NVIDIA-Treiber laufen. Der Linux-Sidecar bindet EGL aus demselben Grund so.
//!
//! Die Struktur-Beschreibungen liegen in [`typen`]; dort steht auch, warum ihr
//! Layout der heikelste Teil ist.

pub mod typen;

use std::ffi::{c_char, c_int, c_uint, c_void, CStr};

use anyhow::{bail, Context, Result};
use libloading::{Library, Symbol};

pub use typen::*;

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
type FnCuExternalMemoryGetMappedMipmappedArray = unsafe extern "C" fn(
    *mut CUmipmappedArray,
    CUexternalMemory,
    *const ExternalMemoryMipmappedArrayDesc,
) -> CUresult;
type FnCuMipmappedArrayGetLevel =
    unsafe extern "C" fn(*mut CUarray, CUmipmappedArray, c_uint) -> CUresult;
type FnCuMipmappedArrayDestroy = unsafe extern "C" fn(CUmipmappedArray) -> CUresult;
type FnCuArrayGetDescriptor = unsafe extern "C" fn(*mut ArrayDescriptor, CUarray) -> CUresult;
type FnCuDestroyExternalMemory = unsafe extern "C" fn(CUexternalMemory) -> CUresult;
type FnCuMemAlloc = unsafe extern "C" fn(*mut CUdeviceptr, usize) -> CUresult;
type FnCuMemFree = unsafe extern "C" fn(CUdeviceptr) -> CUresult;
type FnCuMemcpyHtoD = unsafe extern "C" fn(CUdeviceptr, *const c_void, usize) -> CUresult;
type FnCuMemcpyDtoH = unsafe extern "C" fn(*mut c_void, CUdeviceptr, usize) -> CUresult;
type FnCuMemcpy2d = unsafe extern "C" fn(*const Memcpy2d) -> CUresult;
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
    pub cuExternalMemoryGetMappedMipmappedArray: FnCuExternalMemoryGetMappedMipmappedArray,
    pub cuMipmappedArrayGetLevel: FnCuMipmappedArrayGetLevel,
    pub cuMipmappedArrayDestroy: FnCuMipmappedArrayDestroy,
    pub cuArrayGetDescriptor: FnCuArrayGetDescriptor,
    pub cuDestroyExternalMemory: FnCuDestroyExternalMemory,
    pub cuMemAlloc: FnCuMemAlloc,
    pub cuMemFree: FnCuMemFree,
    pub cuMemcpyHtoD: FnCuMemcpyHtoD,
    pub cuMemcpyDtoH: FnCuMemcpyDtoH,
    pub cuMemcpy2d: FnCuMemcpy2d,
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
            // Die drei Array-Aufrufe tragen KEIN `_v2` — nachgesehen mit
            // `nm -D --defined-only libcuda.so.1`, nicht angenommen. Wer hier
            // ein `_v2` anhaengt, bekommt "kennt Symbol nicht" statt eines
            // stillen Fehlers, das faellt also sofort auf.
            cuExternalMemoryGetMappedMipmappedArray: sym!(
                lib,
                "cuExternalMemoryGetMappedMipmappedArray",
                FnCuExternalMemoryGetMappedMipmappedArray
            ),
            cuMipmappedArrayGetLevel: sym!(
                lib,
                "cuMipmappedArrayGetLevel",
                FnCuMipmappedArrayGetLevel
            ),
            cuMipmappedArrayDestroy: sym!(
                lib,
                "cuMipmappedArrayDestroy",
                FnCuMipmappedArrayDestroy
            ),
            cuDestroyExternalMemory: sym!(
                lib,
                "cuDestroyExternalMemory",
                FnCuDestroyExternalMemory
            ),
            // Die Speicher-Aufrufe tragen in `cuda.h` ein `_v2` — ohne das
            // laedt man die alte 32-bit-Fassung.
            cuArrayGetDescriptor: sym!(lib, "cuArrayGetDescriptor_v2", FnCuArrayGetDescriptor),
            cuMemAlloc: sym!(lib, "cuMemAlloc_v2", FnCuMemAlloc),
            cuMemFree: sym!(lib, "cuMemFree_v2", FnCuMemFree),
            cuMemcpyHtoD: sym!(lib, "cuMemcpyHtoD_v2", FnCuMemcpyHtoD),
            cuMemcpyDtoH: sym!(lib, "cuMemcpyDtoH_v2", FnCuMemcpyDtoH),
            cuMemcpy2d: sym!(lib, "cuMemcpy2D_v2", FnCuMemcpy2d),
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
        bail!("{was}: CUDA-Fehler {r} ({})", self.fehlertext(r));
    }

    /// Klartext des Treibers zu einem Fehlercode. Getrennt von [`Self::pruefe`],
    /// weil der Bild-Weg Fehlschlaege **erwartet** und berichtet, statt
    /// abzubrechen: dass ein Weg nicht traegt, ist dort ein Ergebnis.
    pub fn fehlertext(&self, r: CUresult) -> String {
        let mut p: *const c_char = std::ptr::null();
        unsafe {
            if (self.cuGetErrorString)(r, &mut p) == CUDA_SUCCESS && !p.is_null() {
                CStr::from_ptr(p).to_string_lossy().into_owned()
            } else {
                String::from("unbekannter Fehler")
            }
        }
    }
}
