//! Die Semaphor-Seite der CUDA-Treiber-API: Strukturen und Einsprungpunkte.
//!
//! **Warum das der heikelste Teil dieser Probe ist — dieselbe Begruendung wie
//! bei den Speicher-Strukturen der Nachbarkiste, nur schaerfer.** Ein falscher
//! Feld-Versatz erzeugt hier keinen Fehler, sondern eine Synchronisierung, die
//! *scheinbar* funktioniert: der Treiber liest den Zeitlinien-Wert aus dem Feld
//! daneben, wartet auf etwas anderes als gemeint, und weil das Wettrennen
//! meistens ohnehin nicht eintritt, sieht der Lauf sauber aus. Deshalb steht an
//! jedem Struct sein Versatz-Plan, und [`selbsttest_layout_semaphor`] prueft
//! Groessen UND Versaetze gegen Werte, die aus `/opt/cuda/include/cuda.h`
//! **kompiliert** abgelesen wurden.
//!
//! Abgelesen mit `gcc -I/opt/cuda/include` und `sizeof`/`offsetof`
//! (x86-64 Linux, CUDA 12.x, 2026-08-07):
//!
//! ```text
//! sizeof CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC   =  96
//!   .type 0 · .handle 8 · .handle.fd 8 · .flags 24 · .reserved 28
//! sizeof CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS = 144
//!   .params.fence.value 0 · .params.nvSciSync 8 · .params.keyedMutex.key 16
//!   · .params.reserved 24 · .flags 72 · .reserved 76
//! sizeof CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS   = 144
//!   .params.fence.value 0 · .params.nvSciSync 8 · .params.keyedMutex.key 16
//!   · .params.keyedMutex.timeoutMs 24 · .params.reserved 32 · .flags 72
//!   · .reserved 76
//! ```
//!
//! **Die 96 sind eine Falle, wenn man sie aus dem Gedaechtnis schreibt.** Das
//! Speicher-Gegenstueck `CUDA_EXTERNAL_MEMORY_HANDLE_DESC` misst 104, weil es
//! zwischen union und `flags` noch ein `size` traegt. Hier gibt es das nicht —
//! ein Semaphor hat keine Groesse. Wer 104 uebernimmt, verschiebt `flags` und
//! `reserved` um acht Bytes und uebergibt dem Treiber Muell in `flags`.

use std::ffi::{c_int, c_uint, c_void};

use anyhow::{bail, Context, Result};
use libloading::{Library, Symbol};

use crate::cuda::{CUdeviceptr, CUresult};

pub type CUexternalSemaphore = *mut c_void;
pub type CUstream = *mut c_void;

/// `CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD` (cuda.h Z. 4048) — ein
/// **binaeres** Vulkan-Semaphor, ueber `vkGetSemaphoreFdKHR` exportiert.
pub const CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD: c_uint = 1;

/// `CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_TIMELINE_SEMAPHORE_FD` (cuda.h Z. 4080) —
/// ein **Zeitlinien**-Semaphor. Das ist ein anderer Fall, nicht bloss ein
/// anderer Zahlenwert: die Zaehlweise ist eine andere (monoton wachsender Wert
/// statt signalisiert/nicht signalisiert), und der Treiber darf den einen Weg
/// tragen und den anderen nicht. Deshalb prueft diese Kiste beide getrennt.
pub const CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_TIMELINE_SEMAPHORE_FD: c_uint = 9;

/// `CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC` aus `cuda.h` (Z. 4090).
///
/// Versaetze (64-bit, kompiliert geprueft): `type` 0, union `handle` 8..24
/// (`int fd` liegt am Anfang, die groesste Variante ist
/// `struct { void*, const void* }` = 16 B), `flags` 24, `reserved[16]` 28..92.
/// Gesamtgroesse 96 mit Endauffuellung.
///
/// **`align(8)` ist Pflicht und war der erste Fehlgriff dieser Kiste.** Alle
/// Felder hier sind vier Byte breit oder Byte-Felder; Rust rechnet daraus eine
/// Ausrichtung von 4 und eine Gesamtgroesse von **92**. C kommt auf 96, weil
/// die union eine Variante mit Zeigern enthaelt (`struct { void*, const void* }`)
/// und damit auf 8 ausgerichtet ist — eine Information, die in der
/// nachgebauten Fassung verschwindet, sobald man die union durch ein Byte-Feld
/// ersetzt. Das Speicher-Gegenstueck der Nachbarkiste hat das Problem nicht,
/// weil es ein `u64 size` traegt, das die Ausrichtung von selbst erzwingt —
/// wer von dort abschreibt, uebersieht es deshalb. Der Selbsttest hat es beim
/// ersten Lauf gefangen (92 statt 96); ohne ihn haette der Treiber `flags` und
/// `reserved` um vier Byte verschoben gelesen.
#[repr(C, align(8))]
#[derive(Clone, Copy)]
pub struct ExternalSemaphoreHandleDesc {
    pub typ: c_uint,
    /// Die union beginnt bei 8, nicht bei 4: sie enthaelt Zeiger und ist damit
    /// auf 8 ausgerichtet. Dieses Feld ist die Auffuellung dazwischen.
    _auffuellung_vor_union: c_uint,
    /// Erste Variante der union: `int fd`.
    pub fd: c_int,
    /// Rest der union — die Win32-Variante ist zwei Zeiger breit.
    _rest_der_union: [u8; 12],
    pub flags: c_uint,
    pub reserved: [c_uint; 16],
}

impl ExternalSemaphoreHandleDesc {
    /// Beschreibung fuer einen Dateideskriptor aus Vulkan.
    ///
    /// `flags` ist laut Header „reserved for the future. Must be zero" — es
    /// gibt hier also, anders als beim Speicher-Import, KEIN Gegenstueck zu
    /// `CUDA_EXTERNAL_MEMORY_DEDICATED`, das zur Vulkan-Seite passen muesste.
    pub fn fuer_fd(fd: c_int, typ: c_uint) -> Self {
        Self {
            typ,
            _auffuellung_vor_union: 0,
            fd,
            _rest_der_union: [0; 12],
            flags: 0,
            reserved: [0; 16],
        }
    }
}

/// `CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS` aus `cuda.h` (Z. 4145).
///
/// Versaetze (kompiliert geprueft): `params.fence.value` 0,
/// `params.nvSciSync` 8, `params.keyedMutex.key` 16, `params.reserved[12]`
/// 24..72, `flags` 72, `reserved[16]` 76..140. Gesamtgroesse 144.
///
/// Der innere `params`-Verbund ist im Header eine anonyme `struct` — die
/// Felder liegen also HINTEREINANDER, nicht uebereinander. Wer ihn faelschlich
/// fuer eine union haelt, legt `flags` auf Versatz 24 und beschreibt damit
/// `params.reserved`.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ExternalSemaphoreSignalParams {
    /// `params.fence.value` — der Wert, auf den ein **Zeitlinien**-Semaphor
    /// gesetzt wird. Bei einem binaeren Semaphor ignoriert der Treiber ihn.
    pub fence_value: u64,
    _nv_sci_sync: u64,
    _keyed_mutex_key: u64,
    _params_reserved: [c_uint; 12],
    pub flags: c_uint,
    pub reserved: [c_uint; 16],
}

impl ExternalSemaphoreSignalParams {
    /// Alles auf null ausser dem Zeitlinien-Wert.
    ///
    /// Ein Bauwerk statt `..Default::default()`: die Auffuellfelder sind privat,
    /// damit niemand von aussen etwas hineinschreibt, was der Treiber als
    /// NvSciSync-Zeiger auslegen wuerde.
    pub fn fuer_wert(wert: u64) -> Self {
        Self { fence_value: wert, ..Default::default() }
    }
}

/// `CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS` aus `cuda.h` (Z. 4193).
///
/// Versaetze (kompiliert geprueft): `params.fence.value` 0,
/// `params.nvSciSync` 8, `params.keyedMutex.key` 16,
/// `params.keyedMutex.timeoutMs` 24, `params.reserved[10]` 32..72, `flags` 72,
/// `reserved[16]` 76..140. Gesamtgroesse 144.
///
/// **Nicht identisch mit der Signal-Fassung, obwohl beide 144 messen.** Der
/// `keyedMutex`-Verbund traegt hier zusaetzlich `timeoutMs` und ist damit 16
/// statt 8 Bytes gross; das reserved-Feld darunter ist entsprechend um zwei
/// `unsigned int` kuerzer. Wer die Signal-Struktur wiederverwendet, trifft
/// zufaellig dieselbe Gesamtgroesse — der Selbsttest ueber `size_of` allein
/// wuerde das NICHT bemerken. Genau deshalb prueft
/// [`selbsttest_layout_semaphor`] auch Versaetze.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ExternalSemaphoreWaitParams {
    pub fence_value: u64,
    _nv_sci_sync: u64,
    _keyed_mutex_key: u64,
    _keyed_mutex_timeout_ms: c_uint,
    _auffuellung_nach_timeout: c_uint,
    _params_reserved: [c_uint; 10],
    pub flags: c_uint,
    pub reserved: [c_uint; 16],
}

impl ExternalSemaphoreWaitParams {
    /// Alles auf null ausser dem Zeitlinien-Wert — Begruendung wie bei
    /// [`ExternalSemaphoreSignalParams::fuer_wert`].
    pub fn fuer_wert(wert: u64) -> Self {
        Self { fence_value: wert, ..Default::default() }
    }
}

/// Groessen UND Versaetze gegen `cuda.h` gegenpruefen.
///
/// Laeuft beim Start, nicht als Test: stimmt hier etwas nicht, ist jede Aussage
/// dieser Probe wertlos, und das soll SOFORT auffallen statt in den Ergebnissen.
///
/// Die Versatzpruefung ist der Grund, warum diese Funktion nicht bloss drei
/// `size_of` vergleicht — Begruendung an [`ExternalSemaphoreWaitParams`].
pub fn selbsttest_layout_semaphor() -> Result<()> {
    let groessen: [(&str, usize, usize); 3] = [
        ("CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC", size_of::<ExternalSemaphoreHandleDesc>(), 96),
        (
            "CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS",
            size_of::<ExternalSemaphoreSignalParams>(),
            144,
        ),
        ("CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS", size_of::<ExternalSemaphoreWaitParams>(), 144),
    ];
    for (name, ist, soll) in groessen {
        if ist != soll {
            bail!("{name}: {ist} Bytes, erwartet {soll} — Layout weicht von cuda.h ab");
        }
    }
    let versaetze: [(&str, usize, usize); 7] = [
        ("HANDLE_DESC.handle.fd", core::mem::offset_of!(ExternalSemaphoreHandleDesc, fd), 8),
        ("HANDLE_DESC.flags", core::mem::offset_of!(ExternalSemaphoreHandleDesc, flags), 24),
        (
            "SIGNAL_PARAMS.params.fence.value",
            core::mem::offset_of!(ExternalSemaphoreSignalParams, fence_value),
            0,
        ),
        ("SIGNAL_PARAMS.flags", core::mem::offset_of!(ExternalSemaphoreSignalParams, flags), 72),
        (
            "WAIT_PARAMS.params.fence.value",
            core::mem::offset_of!(ExternalSemaphoreWaitParams, fence_value),
            0,
        ),
        ("WAIT_PARAMS.flags", core::mem::offset_of!(ExternalSemaphoreWaitParams, flags), 72),
        ("HANDLE_DESC.reserved", core::mem::offset_of!(ExternalSemaphoreHandleDesc, reserved), 28),
    ];
    for (name, ist, soll) in versaetze {
        if ist != soll {
            bail!("{name}: Versatz {ist}, erwartet {soll} — Layout weicht von cuda.h ab");
        }
    }
    Ok(())
}

macro_rules! sym {
    ($lib:expr, $name:literal, $typ:ty) => {{
        let s: Symbol<$typ> = unsafe { $lib.get(concat!($name, "\0").as_bytes()) }
            .with_context(|| format!("libcuda kennt {} nicht", $name))?;
        *s
    }};
}

type FnImport = unsafe extern "C" fn(
    *mut CUexternalSemaphore,
    *const ExternalSemaphoreHandleDesc,
) -> CUresult;
type FnZerstoeren = unsafe extern "C" fn(CUexternalSemaphore) -> CUresult;
type FnSignal = unsafe extern "C" fn(
    *const CUexternalSemaphore,
    *const ExternalSemaphoreSignalParams,
    c_uint,
    CUstream,
) -> CUresult;
type FnWarten = unsafe extern "C" fn(
    *const CUexternalSemaphore,
    *const ExternalSemaphoreWaitParams,
    c_uint,
    CUstream,
) -> CUresult;
type FnStreamCreate = unsafe extern "C" fn(*mut CUstream, c_uint) -> CUresult;
type FnStreamSync = unsafe extern "C" fn(CUstream) -> CUresult;
type FnStreamDestroy = unsafe extern "C" fn(CUstream) -> CUresult;
type FnMemcpyDtoDAsync =
    unsafe extern "C" fn(CUdeviceptr, CUdeviceptr, usize, CUstream) -> CUresult;
type FnMemcpyDtoD = unsafe extern "C" fn(CUdeviceptr, CUdeviceptr, usize) -> CUresult;

/// Die Einsprungpunkte, die die Nachbarkiste nicht laedt.
///
/// **Warum eine zweite `Library` statt einer Erweiterung von `Cuda`:** die
/// Nachbarkiste wird per `#[path]` eingebunden und bleibt dabei unveraendert —
/// eine Aenderung dort traefe zwei Messakten, die auf ihrem heutigen Stand
/// beruhen. `dlopen` zaehlt Referenzen; beide Griffe zeigen auf dieselbe
/// geladene Bibliothek, es gibt also keine zweite Fassung des Treibers.
#[allow(non_snake_case)]
pub struct Semapi {
    _lib: Library,
    pub cuImportExternalSemaphore: FnImport,
    pub cuDestroyExternalSemaphore: FnZerstoeren,
    pub cuSignalExternalSemaphoresAsync: FnSignal,
    pub cuWaitExternalSemaphoresAsync: FnWarten,
    pub cuStreamCreate: FnStreamCreate,
    pub cuStreamSynchronize: FnStreamSync,
    pub cuStreamDestroy: FnStreamDestroy,
    pub cuMemcpyDtoDAsync: FnMemcpyDtoDAsync,
    pub cuMemcpyDtoD: FnMemcpyDtoD,
}

impl Semapi {
    pub fn laden() -> Result<Self> {
        let lib = unsafe { Library::new("libcuda.so.1") }
            .context("libcuda.so.1 nicht ladbar — NVIDIA-Treiber installiert?")?;
        Ok(Self {
            // Die vier Semaphor-Aufrufe tragen KEIN `_v2` und kein `_ptsz` —
            // nachgesehen mit `nm -D --defined-only libcuda.so.1`, nicht
            // angenommen. (Die `_ptsz`-Fassungen existieren daneben; sie sind
            // die per-thread-default-stream-Varianten und wuerden einen
            // ANDEREN Strom benutzen als `cuStreamCreate` liefert.)
            cuImportExternalSemaphore: sym!(lib, "cuImportExternalSemaphore", FnImport),
            cuDestroyExternalSemaphore: sym!(lib, "cuDestroyExternalSemaphore", FnZerstoeren),
            cuSignalExternalSemaphoresAsync: sym!(
                lib,
                "cuSignalExternalSemaphoresAsync",
                FnSignal
            ),
            cuWaitExternalSemaphoresAsync: sym!(lib, "cuWaitExternalSemaphoresAsync", FnWarten),
            cuStreamCreate: sym!(lib, "cuStreamCreate", FnStreamCreate),
            cuStreamSynchronize: sym!(lib, "cuStreamSynchronize", FnStreamSync),
            cuStreamDestroy: sym!(lib, "cuStreamDestroy", FnStreamDestroy),
            // Die Speicher-Aufrufe tragen ein `_v2` — ohne das laedt man die
            // alte 32-bit-Fassung.
            cuMemcpyDtoDAsync: sym!(lib, "cuMemcpyDtoDAsync_v2", FnMemcpyDtoDAsync),
            cuMemcpyDtoD: sym!(lib, "cuMemcpyDtoD_v2", FnMemcpyDtoD),
            _lib: lib,
        })
    }
}
