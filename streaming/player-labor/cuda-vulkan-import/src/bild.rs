//! Stufe 2: kann CUDA in ein von Vulkan exportiertes **BILD** schreiben?
//!
//! Stufe 1 hat einen Puffer geteilt. Der Player braucht aber eine Textur, die
//! ein Shader abtastet — und ein Vulkan-Bild liegt undurchsichtig gekachelt im
//! Speicher, seine Adressberechnung kennt nur der Treiber. CUDA muss es also
//! als **Array** einhaengen (`cuExternalMemoryGetMappedMipmappedArray`), nicht
//! als Zeigerbereich. Ob das traegt, entscheidet ueber eine GPU-lokale Kopie je
//! Bild: traegt es nicht, bleibt nur der Weg Puffer + `vkCmdCopyBufferToImage`.
//!
//! **Warum getrennte Ebenen statt eines mehrplanigen Bildes.**
//! `CUDA_ARRAY3D_DESCRIPTOR` kann strukturell nur EIN Format und EINE
//! Kanalzahl beschreiben; fuer NV12 gibt es aber zwei Ebenen mit
//! unterschiedlicher Groesse und Kanalzahl. Der naheliegende Weg sind deshalb
//! zwei getrennte Vulkan-Bilder (R8 + R8G8 bzw. R16 + R16G16) — das ist auch
//! die Form, in der ein Shader sie ohnehin am liebsten abtastet.
//! Weil `cuda.h` daneben ein `CU_AD_FORMAT_NV12` fuehrt, wird der Ein-Bild-Weg
//! trotzdem **versucht** statt weggeschlossen: die Frage soll gemessen
//! beantwortet sein, nicht erschlossen.
//!
//! Fuer P010 wird 16-bit-Speicher geprueft, nicht die Farbdeutung — P010 legt
//! seine 10 Bit in den oberen Bits eines 16-bit-Wortes ab, die Speicherlage ist
//! also die von R16/R16G16. Was hier gemessen wird, ist Speichertreue.

use std::ffi::{c_uint, c_void};

use anyhow::{bail, Result};
use ash::vk;

use crate::cuda::{self, Cuda};
use crate::vk::Vulkan;
use crate::{muster, streifen_diagnose, vergleichen};

/// Der Vorher-Wert, mit dem jedes Bild gefuellt wird, bevor CUDA schreibt.
///
/// Ohne ihn waere "CUDA hat richtig geschrieben" nicht von "CUDA hat gar nichts
/// getan und wir vergleichen frischen Nullspeicher" zu unterscheiden — es sei
/// denn, das Muster traefe zufaellig Null. 0x5A kommt im Muster vor, aber nie
/// flaechendeckend.
const VORHER: u8 = 0x5A;

/// Die Schalter eines Laufs — zusammengefasst, weil zwei davon **Gegenproben**
/// sind und nur zusammen mit den anderen Sinn ergeben.
pub struct Schalter {
    pub dediziert: bool,
    pub surface_ldst: bool,
    /// Gegenprobe: CUDA schreibt absichtlich NICHT.
    ///
    /// Das ist die schaerfste Kontrolle der ganzen Probe. Ein Erfolg heisst nur
    /// dann etwas, wenn ein Nicht-Schreiben zuverlaessig als Misserfolg
    /// herauskommt — sonst waere "alle Bytes stimmen" auch mit einem
    /// Vergleich vereinbar, der in Wahrheit nichts prueft. Im Labor sind
    /// mehrfach Befunde entstanden, weil ein Werkzeug stillschweigend nichts
    /// gemessen hat; hier ist der Nachweis eingebaut.
    pub ohne_schreiben: bool,
    /// Gegenprobe: Vulkan alloziert dediziert, CUDA bekommt das Flag NICHT.
    ///
    /// Laut NVIDIA-Forum 278691 erzeugt diese Fehlanpassung senkrechte
    /// Streifen — ohne Fehlermeldung. Ob das auf dieser Karte und diesem
    /// Treiber so ist, wird gemessen statt geglaubt: faellt es auf, ist die
    /// Empfindlichkeit der Probe fuer stille Speicherlage-Fehler belegt.
    pub dedi_fehlanpassung: bool,
}

pub struct Ebene {
    pub name: &'static str,
    pub vk_format: vk::Format,
    pub cu_format: c_uint,
    pub kanaele: u32,
    pub breite: u32,
    pub hoehe: u32,
}

impl Ebene {
    fn bytes_je_texel(&self) -> usize {
        let breite = if self.cu_format == cuda::CU_AD_FORMAT_UNSIGNED_INT16 { 2 } else { 1 };
        breite * self.kanaele as usize
    }
    /// Zeilenlaenge in Byte, dicht gepackt.
    ///
    /// Dass Quell-Zeilenlaenge, Kopierbreite und die Zeilenaufteilung der
    /// Diagnose aus **einer** Rechnung kommen, ist keine Bequemlichkeit: gingen
    /// sie auseinander, beschriebe der Vergleich eine andere Speicherlage als
    /// die kopierte, und die Abweichung saehe nach einem Treiberbefund aus.
    fn zeilenbytes(&self) -> usize {
        self.breite as usize * self.bytes_je_texel()
    }
    fn bytes(&self) -> usize {
        self.zeilenbytes() * self.hoehe as usize
    }
}

/// NV12/P010 als zwei getrennte Bilder. Die Farbebene hat halbe Breite und
/// halbe Hoehe (4:2:0) und zwei Kanaele (U und V verschraenkt).
pub fn ebenen(zehn_bit: bool, breite: u32, hoehe: u32) -> Vec<Ebene> {
    let (y_fmt, uv_fmt, cu_fmt) = if zehn_bit {
        (vk::Format::R16_UNORM, vk::Format::R16G16_UNORM, cuda::CU_AD_FORMAT_UNSIGNED_INT16)
    } else {
        (vk::Format::R8_UNORM, vk::Format::R8G8_UNORM, cuda::CU_AD_FORMAT_UNSIGNED_INT8)
    };
    vec![
        Ebene {
            name: "Y (Helligkeit)",
            vk_format: y_fmt,
            cu_format: cu_fmt,
            kanaele: 1,
            breite,
            hoehe,
        },
        Ebene {
            name: "UV (Farbe, 4:2:0)",
            vk_format: uv_fmt,
            cu_format: cu_fmt,
            kanaele: 2,
            breite: breite / 2,
            hoehe: hoehe / 2,
        },
    ]
}

/// Eine Ebene vollstaendig durchpruefen. Gibt `Ok(true)` zurueck, wenn der Weg
/// fuer diese Ebene traegt, und `Ok(false)`, wenn er nicht traegt — ein
/// Fehlschlag ist hier ein **Ergebnis** und kein Abbruchgrund. Nur wenn die
/// Probe selbst unbrauchbar wird (Kontrolle schlaegt nicht an), bricht sie ab.
pub fn ebene_pruefen(v: &Vulkan, c: &Cuda, e: &Ebene, s: &Schalter) -> Result<bool> {
    let bytes = e.bytes();
    println!(
        "\n  Ebene {} — {:?}, {}x{}, {} Byte je Texel, {bytes} Byte",
        e.name,
        e.vk_format,
        e.breite,
        e.hoehe,
        e.bytes_je_texel()
    );

    let (bild, bild_mem, fd, alloc) =
        v.exportierbares_bild(e.vk_format, e.breite, e.hoehe, s.dediziert)?;
    // Die Allokation ist wegen Kachelung und Ausrichtung regelmaessig groesser
    // als die dichte Bildgroesse. CUDA muss beim Import DIESE Zahl bekommen.
    println!("    exportiert, Deskriptor {fd}, Allokation {alloc} Byte (dicht waeren {bytes})");

    let (ablage, ablage_mem) = v.ablage(bytes)?;
    v.nach_allgemein(bild, vk::ImageAspectFlags::COLOR)?;

    // ── Kontrolle A: traegt der reine Vulkan-Weg ueberhaupt? ────────────────
    // Vorfuellen und sofort zurueckliefern. Scheitert das, sagt jede folgende
    // Zahl nichts ueber CUDA aus, sondern nur ueber unser eigenes Hantieren.
    v.schreiben(ablage_mem, &vec![VORHER; bytes])?;
    v.puffer_nach_bild(ablage, bild, vk::ImageAspectFlags::COLOR, e.breite, e.hoehe)?;
    let vorher = auslesen(v, bild, ablage, ablage_mem, e)?;
    if vorher.iter().any(|&b| b != VORHER) {
        bail!(
            "Kontrolle A fehlgeschlagen: der Vorher-Wert 0x{VORHER:02x} kam nicht \
             unveraendert zurueck — der Vulkan-eigene Bildweg ist kaputt, damit \
             ist die CUDA-Frage hier gar nicht messbar"
        );
    }
    println!("    Kontrolle A: Vulkan fuellt und liest das Bild verlustfrei — Weg messbar");

    // ── CUDA haengt das Bild als Array ein ──────────────────────────────────
    // Bei der Gegenprobe wird hier absichtlich das falsche Flag gesetzt.
    // Ausschliessendes Oder statt "und nicht", damit BEIDE Richtungen der
    // Fehlanpassung pruefbar sind: Vulkan dediziert / CUDA nicht, und umgekehrt.
    // Nur eine Richtung zu pruefen hiesse, die halbe Aussage fuer die ganze zu
    // nehmen.
    let cuda_dediziert = s.dediziert ^ s.dedi_fehlanpassung;
    let handle = cuda::ExternalMemoryHandleDesc::fuer_fd(fd, alloc, cuda_dediziert);
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
            flags: if s.surface_ldst { cuda::CUDA_ARRAY3D_SURFACE_LDST } else { 0 },
        },
        // Muss den `mipLevels` des Vulkan-Bildes entsprechen; beides ist 1.
        num_levels: 1,
        reserved: [0; 16],
    };
    let mut mip: cuda::CUmipmappedArray = std::ptr::null_mut();
    let r = unsafe { (c.cuExternalMemoryGetMappedMipmappedArray)(&mut mip, ext_mem, &beschreibung) };
    if r != cuda::CUDA_SUCCESS {
        println!(
            "    cuExternalMemoryGetMappedMipmappedArray: FEHLGESCHLAGEN, \
             Code {r} ({}) — dieser Weg traegt fuer diese Ebene nicht",
            c.fehlertext(r)
        );
        aufraeumen(v, c, ext_mem, std::ptr::null_mut(), (bild, bild_mem), (ablage, ablage_mem))?;
        return Ok(false);
    }
    let mut arr: cuda::CUarray = std::ptr::null_mut();
    unsafe { c.pruefe((c.cuMipmappedArrayGetLevel)(&mut arr, mip, 0), "cuMipmappedArrayGetLevel")? };

    // ── Kontrolle B: meint CUDA dasselbe Bild wie wir? ──────────────────────
    // Ohne diese Rueckfrage koennte der Import etwas anderes eingehaengt haben
    // (halbe Breite, anderes Format), und der Vergleich prueft dann brav die
    // falsche Sache — genau die Fehlerklasse, an der dieses Labor sich schon
    // mehrfach verbrannt hat.
    let mut zurueck = cuda::ArrayDescriptor::default();
    unsafe { c.pruefe((c.cuArrayGetDescriptor)(&mut zurueck, arr), "cuArrayGetDescriptor")? };
    if zurueck.width != e.breite as usize
        || zurueck.height != e.hoehe as usize
        || zurueck.format != e.cu_format
        || zurueck.num_channels != e.kanaele
    {
        bail!(
            "Kontrolle B fehlgeschlagen: CUDA meldet {}x{} Format 0x{:x} mit {} Kanaelen \
             zurueck, beschrieben war {}x{} Format 0x{:x} mit {} Kanaelen",
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
    println!("    Kontrolle B: CUDA meldet dieselbe Groesse und dasselbe Format zurueck");

    // ── Der Fall, auf den es ankommt: CUDA-Geraetespeicher -> Bild ──────────
    // Nicht vom Host aus, sondern aus Geraetespeicher: so liegt der fertige
    // Decoder-Frame im Player.
    let soll: Vec<u8> = (0..bytes).map(muster).collect();
    let mut quelle: cuda::CUdeviceptr = 0;
    unsafe {
        c.pruefe((c.cuMemAlloc)(&mut quelle, bytes), "cuMemAlloc")?;
        c.pruefe(
            (c.cuMemcpyHtoD)(quelle, soll.as_ptr() as *const c_void, bytes),
            "cuMemcpyHtoD",
        )?;
        if s.ohne_schreiben {
            println!("    GEGENPROBE: cuMemcpy2D wird uebersprungen — es MUSS abweichen");
        } else {
            let kopie = cuda::Memcpy2d::geraet_nach_array(
                quelle,
                e.zeilenbytes(),
                arr,
                e.zeilenbytes(),
                e.hoehe as usize,
            );
            c.pruefe((c.cuMemcpy2d)(&kopie), "cuMemcpy2D Geraet -> Array")?;
        }
        c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize")?;
    }

    let gelesen = auslesen(v, bild, ablage, ablage_mem, e)?;

    let traegt = match vergleichen(&soll, &gelesen) {
        None => {
            println!("    ERGEBNIS: alle {bytes} Bytes stimmen — CUDA schreibt direkt ins Bild");
            true
        }
        Some((i, s, g)) => {
            let unveraendert = gelesen.iter().filter(|&&b| b == VORHER).count();
            println!(
                "    ERGEBNIS: ABWEICHUNG bei Byte {i} (erwartet {s}, gelesen {g}); \
                 {} von {bytes} abweichend, davon {unveraendert} noch auf dem Vorher-Wert",
                soll.iter().zip(&gelesen).filter(|(a, b)| a != b).count()
            );
            println!("    {}", streifen_diagnose(&soll, &gelesen, e.zeilenbytes()));
            false
        }
    };

    // ── Kontrolle C: schlaegt der Vergleich ueberhaupt an? ──────────────────
    let mut verdorben = soll.clone();
    verdorben[bytes / 2] ^= 0xFF;
    if vergleichen(&verdorben, &gelesen).is_none() {
        bail!("Kontrolle C fehlgeschlagen: ein verfaelschtes Byte fiel NICHT auf");
    }
    println!("    Kontrolle C: ein verfaelschtes Byte faellt auf — der Vergleich greift");

    unsafe { c.pruefe((c.cuMemFree)(quelle), "cuMemFree")? };
    aufraeumen(v, c, ext_mem, mip, (bild, bild_mem), (ablage, ablage_mem))?;
    Ok(traegt)
}

/// Der Ein-Bild-Versuch: ein einziges mehrplaniges Vulkan-Bild, importiert mit
/// `CU_AD_FORMAT_NV12` bzw. `CU_AD_FORMAT_P010`.
///
/// Erwartet wird ein Fehlschlag — `CUDA_ARRAY3D_DESCRIPTOR` hat kein Feld, mit
/// dem sich zwei Ebenen beschreiben liessen, und kein NVIDIA-Beispiel nutzt
/// mehrplanige Formate. Aber die Formate stehen in `cuda.h`, und "steht in der
/// Doku nicht drin" ist kein Beleg fuer "geht nicht". Also gemessen.
pub fn ein_bild_versuchen(v: &Vulkan, c: &Cuda, zehn_bit: bool, breite: u32, hoehe: u32) -> bool {
    let (vk_format, cu_format) = if zehn_bit {
        (vk::Format::G10X6_B10X6R10X6_2PLANE_420_UNORM_3PACK16, cuda::CU_AD_FORMAT_P010)
    } else {
        (vk::Format::G8_B8R8_2PLANE_420_UNORM, cuda::CU_AD_FORMAT_NV12)
    };
    println!("\n  Ein-Bild-Versuch: {vk_format:?} als CUDA-Format 0x{cu_format:x}");

    if !v.ycbcr {
        println!("    NICHT DURCHGEFUEHRT: das Geraet meldet kein samplerYcbcrConversion");
        return false;
    }
    let (bild, bild_mem, fd, alloc) = match v.exportierbares_bild(vk_format, breite, hoehe, true) {
        Ok(x) => x,
        Err(e) => {
            println!("    NICHT DURCHGEFUEHRT: Vulkan legt dieses Bild nicht an ({e:#})");
            return false;
        }
    };
    println!("    exportiert, Deskriptor {fd}, Allokation {alloc} Byte");

    let handle = cuda::ExternalMemoryHandleDesc::fuer_fd(fd, alloc, true);
    let mut ext_mem: cuda::CUexternalMemory = std::ptr::null_mut();
    let r = unsafe { (c.cuImportExternalMemory)(&mut ext_mem, &handle) };
    if r != cuda::CUDA_SUCCESS {
        println!("    cuImportExternalMemory: Code {r} ({})", c.fehlertext(r));
        unsafe { entsorgen_bild(v, bild, bild_mem) };
        return false;
    }
    let beschreibung = cuda::ExternalMemoryMipmappedArrayDesc {
        array_desc: cuda::Array3dDescriptor {
            width: breite as usize,
            height: hoehe as usize,
            depth: 0,
            format: cu_format,
            // NV12-Arrays fuehren laut Header-Doku zu `cuArrayGetPlane` einen
            // Kanal auf Ebene 0 und zwei auf Ebene 1; beschrieben wird das
            // Gesamtbild mit einem.
            num_channels: 1,
            flags: 0,
        },
        num_levels: 1,
        ..Default::default()
    };
    let mut mip: cuda::CUmipmappedArray = std::ptr::null_mut();
    let r = unsafe { (c.cuExternalMemoryGetMappedMipmappedArray)(&mut mip, ext_mem, &beschreibung) };
    let erfolg = r == cuda::CUDA_SUCCESS;
    if erfolg {
        println!("    cuExternalMemoryGetMappedMipmappedArray: ANGENOMMEN — nachverfolgen!");
        unsafe { (c.cuMipmappedArrayDestroy)(mip) };
    } else {
        println!(
            "    cuExternalMemoryGetMappedMipmappedArray: abgewiesen, Code {r} ({}) — \
             ein mehrplaniges Bild am Stueck geht auf diesem Treiber nicht",
            c.fehlertext(r)
        );
    }
    unsafe {
        (c.cuDestroyExternalMemory)(ext_mem);
        entsorgen_bild(v, bild, bild_mem);
    }
    erfolg
}

/// Das Bild ueber die Ablage auslesen.
///
/// Die Ablage wird vorher genullt. Das ist keine Foermelei: bliebe dort der
/// vorige Inhalt stehen, saehe ein ausgefallener Bild-nach-Puffer-Weg genauso
/// aus wie ein gelungener, und der Vergleich meldete den alten Inhalt als
/// frisch gelesen.
fn auslesen(
    v: &Vulkan,
    bild: vk::Image,
    ablage: vk::Buffer,
    ablage_mem: vk::DeviceMemory,
    e: &Ebene,
) -> Result<Vec<u8>> {
    v.schreiben(ablage_mem, &vec![0u8; e.bytes()])?;
    v.bild_nach_puffer(bild, ablage, vk::ImageAspectFlags::COLOR, e.breite, e.hoehe)?;
    v.lesen(ablage_mem, e.bytes())
}

/// `mip` darf null sein — der Weg, der beim abgewiesenen Array-Import genommen
/// wird, hat noch keins.
fn aufraeumen(
    v: &Vulkan,
    c: &Cuda,
    ext_mem: cuda::CUexternalMemory,
    mip: cuda::CUmipmappedArray,
    bild: (vk::Image, vk::DeviceMemory),
    ablage: (vk::Buffer, vk::DeviceMemory),
) -> Result<()> {
    unsafe {
        if !mip.is_null() {
            c.pruefe((c.cuMipmappedArrayDestroy)(mip), "cuMipmappedArrayDestroy")?;
        }
        c.pruefe((c.cuDestroyExternalMemory)(ext_mem), "cuDestroyExternalMemory")?;
        entsorgen_bild(v, bild.0, bild.1);
        v.device.destroy_buffer(ablage.0, None);
        v.device.free_memory(ablage.1, None);
    }
    Ok(())
}

unsafe fn entsorgen_bild(v: &Vulkan, bild: vk::Image, mem: vk::DeviceMemory) {
    v.device.destroy_image(bild, None);
    v.device.free_memory(mem, None);
}
