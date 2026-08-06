//! Die Beschreibungs-Strukturen der CUDA-Treiber-API, von Hand nachgebaut.
//!
//! **Warum das der heikelste Teil der Probe ist.** Ein falscher Feld-Versatz
//! erzeugt keinen Fehler, sondern stille Falschergebnisse — der Treiber liest
//! dann eine Groesse aus dem Feld daneben und tut etwas Plausibles, aber
//! Falsches. Deshalb steht an jedem Struct sein Versatz-Plan, und
//! [`selbsttest_layout`] prueft die Groessen beim Start gegen die Werte, die
//! aus `/opt/cuda/include/cuda.h` **kompiliert** abgelesen wurden (nicht aus
//! dem Gedaechtnis und nicht von Hand gerechnet).
//!
//! Belegte Groessen (gcc, x86-64 Linux, CUDA 12.x):
//! `CUDA_EXTERNAL_MEMORY_HANDLE_DESC` 104 · `CUDA_EXTERNAL_MEMORY_BUFFER_DESC`
//! 88 · `CUDA_ARRAY3D_DESCRIPTOR` 40 ·
//! `CUDA_EXTERNAL_MEMORY_MIPMAPPED_ARRAY_DESC` 120 · `CUDA_MEMCPY2D` 128 ·
//! `CUDA_ARRAY_DESCRIPTOR` 24.

use std::ffi::{c_int, c_uint, c_void};

use anyhow::{bail, Result};

pub type CUresult = c_int;
pub type CUdevice = c_int;
pub type CUdeviceptr = u64;
pub type CUcontext = *mut c_void;
pub type CUexternalMemory = *mut c_void;
pub type CUmipmappedArray = *mut c_void;
pub type CUarray = *mut c_void;

pub const CUDA_SUCCESS: CUresult = 0;

/// `CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD` — der Linux-Weg. Windows nutzt
/// an derselben Stelle `OPAQUE_WIN32` (Typ 2), was der Grund ist, warum die
/// Probe von der Windows-Seite nicht uebertragbar ist.
pub const CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD: c_uint = 1;

/// `CUDA_EXTERNAL_MEMORY_DEDICATED` — muss gesetzt sein, wenn die Vulkan-Seite
/// mit `VkMemoryDedicatedAllocateInfo` alloziert hat, und darf sonst NICHT
/// gesetzt sein. Eine Fehlanpassung wird nicht abgewiesen: sie erzeugt
/// senkrechte Streifen im Bild (NVIDIA-Forum 278691). Genau die Sorte Fehler,
/// gegen die diese Probe ihr positionsabhaengiges Muster hat.
pub const CUDA_EXTERNAL_MEMORY_DEDICATED: c_uint = 0x01;

// CUarray_format (cuda.h). NV12 und P010 sind eigene, mehrplanige Formate —
// dass es sie ueberhaupt gibt, ist der Grund, den Ein-Bild-Weg zu probieren
// statt ihn wegen der Struktur des Deskriptors von vornherein auszuschliessen.
pub const CU_AD_FORMAT_UNSIGNED_INT8: c_uint = 0x01;
pub const CU_AD_FORMAT_UNSIGNED_INT16: c_uint = 0x02;
pub const CU_AD_FORMAT_NV12: c_uint = 0xb0;
pub const CU_AD_FORMAT_P010: c_uint = 0x9f;

// CUmemorytype
pub const CU_MEMORYTYPE_DEVICE: c_uint = 0x02;
pub const CU_MEMORYTYPE_ARRAY: c_uint = 0x03;

/// `CUDA_ARRAY3D_SURFACE_LDST` — noetig, wenn das Array als Surface
/// beschrieben/gelesen wird. Fuer `cuMemcpy2D` in ein Array verlangt die Doku
/// es nicht; die Probe kann es ueber einen Schalter zuschalten, weil das
/// offizielle NVIDIA-Beispiel es weglaesst und wir das nicht raten wollen.
pub const CUDA_ARRAY3D_SURFACE_LDST: c_uint = 0x02;

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
    /// `dediziert` MUSS zur Vulkan-Seite passen — Begruendung an
    /// [`CUDA_EXTERNAL_MEMORY_DEDICATED`].
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
/// `num_levels` muss exakt den `mipLevels` des Vulkan-Bildes entsprechen —
/// die Header-Doku sagt das ausdruecklich, und bei uns ist beides 1.
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
    /// Der Fall, auf den es fuer den Player ankommt: aus CUDA-Geraetespeicher
    /// (dort liegt der fertige Decoder-Frame) in ein CUDA-Array, das in
    /// Wahrheit ein Vulkan-Bild ist.
    ///
    /// `src_pitch` ist die Zeilenlaenge der Quelle in Byte; die Zielseite hat
    /// keine — ein Array ist undurchsichtig gekachelt, seine Zeilenlaenge
    /// kennt nur der Treiber. Genau das ist der Grund, warum der Weg ueber ein
    /// Array ueberhaupt noetig ist und man nicht einfach in den rohen Speicher
    /// des Bildes schreiben kann.
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
/// beschrieben haben? Sonst hat der Import etwas anderes eingehaengt, als wir
/// glauben, und jeder folgende Vergleich prueft die falsche Sache.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ArrayDescriptor {
    pub width: usize,
    pub height: usize,
    pub format: c_uint,
    pub num_channels: c_uint,
}

/// Die Groessen aus `cuda.h` gegenpruefen. Laeuft beim Start, nicht als Test:
/// stimmt hier etwas nicht, ist jede Zahl der Probe wertlos, und das soll
/// SOFORT auffallen statt in den Messwerten.
pub fn selbsttest_layout() -> Result<()> {
    let paare: [(&str, usize, usize); 6] = [
        ("CUDA_EXTERNAL_MEMORY_HANDLE_DESC", size_of::<ExternalMemoryHandleDesc>(), 104),
        ("CUDA_EXTERNAL_MEMORY_BUFFER_DESC", size_of::<ExternalMemoryBufferDesc>(), 88),
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
