//! Die CUDA-Treiber-API, so weit die Bruecke sie braucht — per `dlopen`.
//!
//! **Warum von Hand und nicht ueber eine Crate.** `libcuda.so.1` gehoert zum
//! Grafiktreiber, nicht zum CUDA-Toolkit. Eine Bindungs-Crate wie `cust`
//! verlangt ein installiertes SDK; der Player soll auf jeder Maschine mit
//! NVIDIA-Treiber laufen und auf jeder anderen sauber danebengreifen, statt
//! nicht zu starten. Der Linux-Sidecar bindet EGL aus demselben Grund so.
//!
//! **Die Struktur-Beschreibungen sind der heikelste Teil**, und zwar aus einem
//! Grund, der ohne diesen Absatz beim naechsten Anfassen verlorengeht: ein
//! falscher Feld-Versatz erzeugt **keinen Fehler**. Der Treiber liest dann eine
//! Groesse aus dem Feld daneben und tut etwas Plausibles, aber Falsches — man
//! sieht es als Streifen oder Lochmuster im Bild, nicht als Rueckgabewert.
//! Deshalb steht an jedem Struct sein Versatz-Plan, und
//! [`selbsttest_layout`] prueft die Groessen gegen Werte, die aus
//! `/opt/cuda/include/cuda.h` **kompiliert** abgelesen wurden — nicht aus der
//! Doku, nicht aus dem Gedaechtnis, nicht von Hand gerechnet.
//!
//! Herkunft: uebernommen aus `streaming/player-labor/cuda-vulkan-import/`,
//! dort gemessen und belegt
//! (`profiles/player-2026-08-07-cuda-vulkan-bild-import.json`). Uebernommen ist
//! nur, was die Bruecke wirklich aufruft; die Puffer- und Kontrollwege der
//! Probe (`cuMemcpyDtoH`, `cuExternalMemoryGetMappedBuffer`, …) bleiben dort.

use std::ffi::{c_char, c_int, c_uint, c_void, CStr};

use anyhow::{bail, Context, Result};
use libloading::{Library, Symbol};

pub type CUresult = c_int;
pub type CUdevice = c_int;
pub type CUdeviceptr = u64;
pub type CUcontext = *mut c_void;
pub type CUexternalMemory = *mut c_void;
pub type CUmipmappedArray = *mut c_void;
pub type CUarray = *mut c_void;

pub const CUDA_SUCCESS: CUresult = 0;

/// `CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD` — der Linux-Weg. Windows nutzt an
/// derselben Stelle `OPAQUE_WIN32` (Typ 2); das ist der Grund, warum die
/// Windows-Bruecke nebenan nichts hiervon teilen kann.
pub const CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD: c_uint = 1;

/// `CUDA_EXTERNAL_MEMORY_DEDICATED` — muss gesetzt sein, wenn die Vulkan-Seite
/// mit `VkMemoryDedicatedAllocateInfo` alloziert hat, und darf sonst NICHT
/// gesetzt sein. Eine Fehlanpassung wird nicht abgewiesen (NVIDIA-Forum 278691
/// beschreibt senkrechte Streifen). Die Bruecke alloziert **immer** dediziert
/// und setzt das Flag deshalb **immer** — beides an einer Stelle, damit es
/// nicht auseinanderlaufen kann.
pub const CUDA_EXTERNAL_MEMORY_DEDICATED: c_uint = 0x01;

pub const CU_AD_FORMAT_UNSIGNED_INT8: c_uint = 0x01;
pub const CU_AD_FORMAT_UNSIGNED_INT16: c_uint = 0x02;

pub const CU_MEMORYTYPE_DEVICE: c_uint = 0x02;
pub const CU_MEMORYTYPE_ARRAY: c_uint = 0x03;

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
    /// **`size` MUSS die vom Treiber erfragte Allokationsgroesse sein**, nicht
    /// Breite mal Hoehe mal Tiefe: ein `VkImage` belegt zwischen 0,74 und
    /// 18,5 Prozent mehr, ohne einfache Regel (gemessen, Messakte
    /// `player-2026-08-07-cuda-vulkan-bild-import.json`).
    pub fn fuer_fd(fd: c_int, size: u64) -> Self {
        Self {
            typ: CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD,
            _auffuellung_vor_union: 0,
            fd,
            _rest_der_union: [0; 12],
            size,
            flags: CUDA_EXTERNAL_MEMORY_DEDICATED,
            reserved: [0; 16],
        }
    }
}

/// `CUDA_ARRAY3D_DESCRIPTOR` aus `cuda.h`.
///
/// Versaetze (kompiliert geprueft): `Width` 0, `Height` 8, `Depth` 16,
/// `Format` 24, `NumChannels` 28, `Flags` 32. Gesamtgroesse 40.
///
/// **`Depth` ist eine Falle.** Ein Vulkan-2D-Bild hat intern `depth = 1`; das
/// CUDA-Array eines 2D-Bildes verlangt hier aber **0**. Wer die Eins
/// uebernimmt, bekommt kein Fehlerergebnis, sondern ein Lochmuster im Bild,
/// dessen Periode von der Aufloesung abhaengt (NVIDIA-Forum 278691).
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Array3dDescriptor {
    pub width: usize,
    pub height: usize,
    pub depth: usize,
    pub format: c_uint,
    pub num_channels: c_uint,
    pub flags: c_uint,
}

/// `CUDA_EXTERNAL_MEMORY_MIPMAPPED_ARRAY_DESC` aus `cuda.h`.
///
/// Versaetze: `offset` 0, `arrayDesc` 8..48, `numLevels` 48,
/// `reserved[16]` 52..116. Gesamtgroesse 120.
///
/// `num_levels` muss exakt den `mipLevels` des Vulkan-Bildes entsprechen — die
/// Header-Doku sagt das ausdruecklich, und bei uns ist beides 1.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ExternalMemoryMipmappedArrayDesc {
    pub offset: u64,
    pub array_desc: Array3dDescriptor,
    pub num_levels: c_uint,
    pub reserved: [c_uint; 16],
}

/// `CUDA_MEMCPY2D` (die `_v2`-Fassung) aus `cuda.h`.
///
/// Versaetze: `srcXInBytes` 0, `srcY` 8, `srcMemoryType` 16 (+4 Auffuellung),
/// `srcHost` 24, `srcDevice` 32, `srcArray` 40, `srcPitch` 48,
/// `dstXInBytes` 56, `dstY` 64, `dstMemoryType` 72 (+4), `dstHost` 80,
/// `dstDevice` 88, `dstArray` 96, `dstPitch` 104, `WidthInBytes` 112,
/// `Height` 120. Gesamtgroesse 128.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Memcpy2d {
    pub src_x_in_bytes: usize,
    pub src_y: usize,
    pub src_memory_type: c_uint,
    _auffuellung_src: c_uint,
    pub src_host: *const c_void,
    pub src_device: CUdeviceptr,
    pub src_array: CUarray,
    pub src_pitch: usize,
    pub dst_x_in_bytes: usize,
    pub dst_y: usize,
    pub dst_memory_type: c_uint,
    _auffuellung_dst: c_uint,
    pub dst_host: *mut c_void,
    pub dst_device: CUdeviceptr,
    pub dst_array: CUarray,
    pub dst_pitch: usize,
    pub width_in_bytes: usize,
    pub height: usize,
}

impl Memcpy2d {
    /// Der Fall, auf den es ankommt: aus CUDA-Geraetespeicher (dort liegt der
    /// fertige Decoder-Frame) in ein CUDA-Array, das in Wahrheit ein
    /// Vulkan-Bild ist.
    ///
    /// **`src_pitch` ist `linesize[i]` des Bildes, NICHT Breite mal Tiefe.**
    /// NVDEC fuellt auf: 1080p NV12 2048 statt 1920, 1080p P010 4096 statt
    /// 3840. Bei 1440p sind beide zufaellig gleich — dort faellt der Fehler
    /// nicht auf, und genau deshalb steht der Satz hier.
    ///
    /// Die Zielseite hat keine Zeilenlaenge: ein Array ist undurchsichtig
    /// gekachelt, seine Zeilenlaenge kennt nur der Treiber. Das ist zugleich
    /// der Grund, warum der Weg ueber ein Array ueberhaupt noetig ist und man
    /// nicht einfach in den rohen Speicher des Bildes schreiben kann.
    pub fn geraet_nach_array(
        quelle: CUdeviceptr,
        src_pitch: usize,
        ziel: CUarray,
        breite_bytes: usize,
        hoehe: usize,
    ) -> Self {
        Self {
            src_memory_type: CU_MEMORYTYPE_DEVICE,
            src_device: quelle,
            src_pitch,
            dst_memory_type: CU_MEMORYTYPE_ARRAY,
            dst_array: ziel,
            width_in_bytes: breite_bytes,
            height: hoehe,
            ..Default::default()
        }
    }
}

/// `CUDA_ARRAY_DESCRIPTOR` aus `cuda.h` — nur zum **Zurueckfragen**.
///
/// Versaetze: `Width` 0, `Height` 8, `Format` 16, `NumChannels` 20.
/// Gesamtgroesse 24. Wird nicht zum Anlegen gebraucht, sondern als Kontrolle:
/// meldet CUDA dieselbe Groesse und dasselbe Format zurueck, das wir
/// beschrieben haben? Sonst ist etwas anderes eingehaengt, als wir glauben, und
/// die Kopie danach schriebe brav an die falsche Stelle.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ArrayDescriptor {
    pub width: usize,
    pub height: usize,
    pub format: c_uint,
    pub num_channels: c_uint,
}

/// Die Groessen aus `cuda.h` gegenpruefen.
///
/// **Laeuft beim Aufbau der Bruecke, nicht nur als Test.** Stimmt hier etwas
/// nicht, ist jedes Bild dieses Weges verdaechtig, und das soll den Weg
/// abschalten statt sich als Streifenmuster zeigen. Der `#[test]` darunter
/// prueft dieselbe Sache noch einmal beim Bauen — auf einer Maschine ohne
/// NVIDIA-Treiber ist er das Einzige, was hier je laeuft.
pub fn selbsttest_layout() -> Result<()> {
    let paare: [(&str, usize, usize); 5] = [
        ("CUDA_EXTERNAL_MEMORY_HANDLE_DESC", size_of::<ExternalMemoryHandleDesc>(), 104),
        ("CUDA_ARRAY3D_DESCRIPTOR", size_of::<Array3dDescriptor>(), 40),
        (
            "CUDA_EXTERNAL_MEMORY_MIPMAPPED_ARRAY_DESC",
            size_of::<ExternalMemoryMipmappedArrayDesc>(),
            120,
        ),
        ("CUDA_MEMCPY2D", size_of::<Memcpy2d>(), 128),
        ("CUDA_ARRAY_DESCRIPTOR", size_of::<ArrayDescriptor>(), 24),
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

type FnCuInit = unsafe extern "C" fn(c_uint) -> CUresult;
type FnCuDeviceGetCount = unsafe extern "C" fn(*mut c_int) -> CUresult;
type FnCuDeviceGet = unsafe extern "C" fn(*mut CUdevice, c_int) -> CUresult;
type FnCuDeviceGetUuid = unsafe extern "C" fn(*mut [u8; 16], CUdevice) -> CUresult;
type FnCuDevicePrimaryCtxRetain = unsafe extern "C" fn(*mut CUcontext, CUdevice) -> CUresult;
type FnCuCtxSetCurrent = unsafe extern "C" fn(CUcontext) -> CUresult;
type FnCuCtxSynchronize = unsafe extern "C" fn() -> CUresult;
type FnCuImportExternalMemory =
    unsafe extern "C" fn(*mut CUexternalMemory, *const ExternalMemoryHandleDesc) -> CUresult;
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
type FnCuMemcpy2d = unsafe extern "C" fn(*const Memcpy2d) -> CUresult;
type FnCuGetErrorString = unsafe extern "C" fn(CUresult, *mut *const c_char) -> CUresult;

/// Die geladenen Einsprungpunkte. `_lib` haelt die Bibliothek am Leben — faellt
/// sie, zeigen alle Zeiger ins Leere.
#[allow(non_snake_case)]
pub struct Cuda {
    _lib: Library,
    pub cuInit: FnCuInit,
    pub cuDeviceGetCount: FnCuDeviceGetCount,
    pub cuDeviceGet: FnCuDeviceGet,
    pub cuDeviceGetUuid: FnCuDeviceGetUuid,
    pub cuDevicePrimaryCtxRetain: FnCuDevicePrimaryCtxRetain,
    pub cuCtxSetCurrent: FnCuCtxSetCurrent,
    pub cuCtxSynchronize: FnCuCtxSynchronize,
    pub cuImportExternalMemory: FnCuImportExternalMemory,
    pub cuExternalMemoryGetMappedMipmappedArray: FnCuExternalMemoryGetMappedMipmappedArray,
    pub cuMipmappedArrayGetLevel: FnCuMipmappedArrayGetLevel,
    pub cuMipmappedArrayDestroy: FnCuMipmappedArrayDestroy,
    pub cuArrayGetDescriptor: FnCuArrayGetDescriptor,
    pub cuDestroyExternalMemory: FnCuDestroyExternalMemory,
    pub cuMemcpy2d: FnCuMemcpy2d,
    pub cuGetErrorString: FnCuGetErrorString,
}

impl Cuda {
    /// `libcuda.so.1`, nicht `libcuda.so`: letzteres ist der Entwicklungs-Link
    /// und fehlt auf reinen Laufzeit-Installationen.
    pub fn laden() -> Result<Self> {
        // SAFETY: `Library::new` ist unsafe, weil das Laden einer fremden
        // Bibliothek deren Initialisierungscode ausfuehrt. `libcuda.so.1` ist
        // die Treiberbibliothek des Systems; sie zu laden ist genau das, was
        // jedes CUDA-Programm tut.
        let lib = unsafe { Library::new("libcuda.so.1") }
            .context("libcuda.so.1 nicht ladbar — NVIDIA-Treiber installiert?")?;
        Ok(Self {
            cuInit: sym!(lib, "cuInit", FnCuInit),
            cuDeviceGetCount: sym!(lib, "cuDeviceGetCount", FnCuDeviceGetCount),
            cuDeviceGet: sym!(lib, "cuDeviceGet", FnCuDeviceGet),
            cuDeviceGetUuid: sym!(lib, "cuDeviceGetUuid", FnCuDeviceGetUuid),
            cuDevicePrimaryCtxRetain: sym!(
                lib,
                "cuDevicePrimaryCtxRetain",
                FnCuDevicePrimaryCtxRetain
            ),
            cuCtxSetCurrent: sym!(lib, "cuCtxSetCurrent", FnCuCtxSetCurrent),
            cuCtxSynchronize: sym!(lib, "cuCtxSynchronize", FnCuCtxSynchronize),
            cuImportExternalMemory: sym!(lib, "cuImportExternalMemory", FnCuImportExternalMemory),
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
            // Diese beiden tragen in `cuda.h` ein `_v2` — ohne das laedt man
            // die alte 32-bit-Fassung.
            cuArrayGetDescriptor: sym!(lib, "cuArrayGetDescriptor_v2", FnCuArrayGetDescriptor),
            cuMemcpy2d: sym!(lib, "cuMemcpy2D_v2", FnCuMemcpy2d),
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
        let mut text: *const c_char = std::ptr::null();
        // SAFETY: `cuGetErrorString` schreibt einen Zeiger auf eine statische,
        // treibereigene Zeichenkette; sie wird nur gelesen und sofort kopiert.
        let klartext = unsafe {
            if (self.cuGetErrorString)(r, &mut text) == CUDA_SUCCESS && !text.is_null() {
                CStr::from_ptr(text).to_string_lossy().into_owned()
            } else {
                "unbekannter Fehler".to_string()
            }
        };
        bail!("{was}: {klartext} (rc={r})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Der einzige Test dieses Moduls, der auf jeder Maschine laeuft**, und
    /// er deckt die Fehlerklasse ab, die sonst nur als verzerrtes Bild
    /// auffiele. Ohne ihn wuerde ein falscher Feld-Versatz erst auf einer
    /// NVIDIA-Maschine bemerkt — und dort auch nur, wenn jemand hinsieht.
    #[test]
    fn die_struktur_groessen_stimmen_mit_cuda_h() {
        selbsttest_layout().expect("Layout weicht von cuda.h ab");
    }

    /// Gegenprobe: der Selbsttest muss eine Abweichung ueberhaupt bemerken
    /// koennen. Ohne sie waere „alle fuenf stimmen" nicht davon zu
    /// unterscheiden, dass er gar nichts vergleicht.
    ///
    /// Geprueft wird an einer Struktur mit BEKANNT anderer Groesse: haette der
    /// Vergleich keine Wirkung, kaeme auch hier „stimmt" heraus.
    #[test]
    fn der_selbsttest_kann_anschlagen() {
        #[repr(C)]
        struct Verstuemmelt {
            _a: u32,
        }
        assert_ne!(
            size_of::<Verstuemmelt>(),
            size_of::<Memcpy2d>(),
            "die Groessenabfrage selbst muss unterscheiden koennen"
        );
    }
}
