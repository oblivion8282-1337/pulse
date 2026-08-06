//! Die CUDA-Seite: das exportierte Bild einhaengen und beschreiben.
//!
//! Das ist der Teil, den die Nachbarprobe am 2026-08-07 bereits als tragfaehig
//! belegt hat. Er steht hier nicht zur Debatte, sondern liefert den Inhalt, an
//! dem sich wgpu messen lassen muss — deshalb ist er knapp gehalten, prueft
//! aber weiterhin per Rueckfrage nach (`cuArrayGetDescriptor`), ob CUDA
//! dasselbe Bild meint wie wir.

use std::ffi::c_void;

use anyhow::{bail, Result};

use crate::cuda::{self, Cuda};
use crate::ebene::{muster, Ebene};
use crate::vkseite::Bild;

pub struct Eingehaengt {
    ext_mem: cuda::CUexternalMemory,
    mip: cuda::CUmipmappedArray,
    arr: cuda::CUarray,
    quelle: cuda::CUdeviceptr,
    bytes: usize,
}

/// Das Bild bei CUDA einhaengen. Ein Fehlschlag ist hier ein **Ergebnis**, kein
/// Programmfehler — er wuerde bedeuten, dass der in der Nachbarprobe belegte
/// Weg auf wgpus Geraet nicht mehr traegt, und das waere der eigentliche
/// Befund.
pub fn einhaengen(c: &Cuda, e: &Ebene, bild: &Bild, dediziert: bool) -> Result<Eingehaengt> {
    let handle = cuda::ExternalMemoryHandleDesc::fuer_fd(bild.fd, bild.alloc, dediziert);
    let mut ext_mem: cuda::CUexternalMemory = std::ptr::null_mut();
    unsafe {
        c.pruefe((c.cuImportExternalMemory)(&mut ext_mem, &handle), "cuImportExternalMemory")?
    };

    // `depth = 0` ist kein Tippfehler: ein Vulkan-2D-Bild hat intern depth 1,
    // das CUDA-Array eines 2D-Bildes verlangt hier aber 0. Die Eins erzeugt
    // keinen Fehler, sondern ein Lochmuster (NVIDIA-Forum 278691).
    let beschreibung = cuda::ExternalMemoryMipmappedArrayDesc {
        offset: 0,
        array_desc: cuda::Array3dDescriptor {
            width: e.breite as usize,
            height: e.hoehe as usize,
            depth: 0,
            format: e.cu_format,
            num_channels: e.kanaele,
            flags: 0,
        },
        num_levels: 1,
        reserved: [0; 16],
    };
    let mut mip: cuda::CUmipmappedArray = std::ptr::null_mut();
    unsafe {
        c.pruefe(
            (c.cuExternalMemoryGetMappedMipmappedArray)(&mut mip, ext_mem, &beschreibung),
            "cuExternalMemoryGetMappedMipmappedArray",
        )?;
    }
    let mut arr: cuda::CUarray = std::ptr::null_mut();
    unsafe {
        c.pruefe((c.cuMipmappedArrayGetLevel)(&mut arr, mip, 0), "cuMipmappedArrayGetLevel")?
    };

    // Kontrolle: meint CUDA dasselbe Bild wie wir? Ohne diese Rueckfrage
    // koennte etwas anderes eingehaengt sein (halbe Breite, anderes Format),
    // und alles Folgende pruefte brav die falsche Sache.
    let mut zurueck = cuda::ArrayDescriptor::default();
    unsafe { c.pruefe((c.cuArrayGetDescriptor)(&mut zurueck, arr), "cuArrayGetDescriptor")? };
    if zurueck.width != e.breite as usize
        || zurueck.height != e.hoehe as usize
        || zurueck.format != e.cu_format
        || zurueck.num_channels != e.kanaele
    {
        bail!(
            "CUDA meldet {}x{} Format 0x{:x} mit {} Kanaelen zurueck, beschrieben war \
             {}x{} Format 0x{:x} mit {} Kanaelen",
            zurueck.width,
            zurueck.height,
            zurueck.format,
            zurueck.num_channels,
            e.breite,
            e.hoehe,
            e.cu_format,
            e.kanaele
        );
    }

    let bytes = e.bytes();
    let mut quelle: cuda::CUdeviceptr = 0;
    unsafe { c.pruefe((c.cuMemAlloc)(&mut quelle, bytes), "cuMemAlloc")? };
    Ok(Eingehaengt { ext_mem, mip, arr, quelle, bytes })
}

impl Eingehaengt {
    /// Eine Runde schreiben: Muster der Variante in den CUDA-Geraetespeicher,
    /// von dort ins eingehaengte Array.
    ///
    /// Aus Geraetespeicher und nicht vom Host — so liegt der fertige
    /// Decoder-Frame im Player.
    pub fn schreiben(&self, c: &Cuda, e: &Ebene, variante: u32) -> Result<Vec<u8>> {
        let soll: Vec<u8> = (0..self.bytes).map(|i| muster(i, variante)).collect();
        unsafe {
            c.pruefe(
                (c.cuMemcpyHtoD)(self.quelle, soll.as_ptr() as *const c_void, self.bytes),
                "cuMemcpyHtoD",
            )?;
            let kopie = cuda::Memcpy2d::geraet_nach_array(
                self.quelle,
                e.zeilenbytes(),
                self.arr,
                e.zeilenbytes(),
                e.hoehe as usize,
            );
            c.pruefe((c.cuMemcpy2d)(&kopie), "cuMemcpy2D Geraet -> Array")?;
            c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize")?;
        }
        Ok(soll)
    }

    pub fn aufraeumen(self, c: &Cuda) -> Result<()> {
        unsafe {
            c.pruefe((c.cuMemFree)(self.quelle), "cuMemFree")?;
            c.pruefe((c.cuMipmappedArrayDestroy)(self.mip), "cuMipmappedArrayDestroy")?;
            c.pruefe((c.cuDestroyExternalMemory)(self.ext_mem), "cuDestroyExternalMemory")?;
        }
        Ok(())
    }
}
