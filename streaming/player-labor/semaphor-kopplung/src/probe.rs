//! **Frage 1**: traegt `cuImportExternalSemaphore` gegen ein Vulkan-Semaphor?
//!
//! Die Frage zerfaellt in vier Stufen, und sie werden getrennt berichtet, weil
//! ein „ja" auf Stufe A ueber Stufe D nichts aussagt:
//!
//! | Stufe | Frage |
//! |---|---|
//! | A | laesst sich der Dateideskriptor ueberhaupt importieren? |
//! | B | traegt die RUECKRICHTUNG (Vulkan signalisiert, CUDA wartet)? |
//! | C | **Empfindlichkeitsnachweis**: bemerkt die Probe ein FEHLENDES Warten? |
//! | D | ordnet das Semaphor die Zugriffe wirklich (CUDA schreibt, Vulkan liest)? |
//!
//! **Stufe C ist die entscheidende, nicht D.** Eine Synchronisierung, die
//! nichts tut, faellt nicht auf, wenn das Wettrennen zufaellig nie eintritt —
//! ein sauberes D ohne bestandenes C ist deshalb kein Erfolg, sondern ein
//! „kann die Sache nicht entscheiden". Genau dafuer gibt es
//! [`Ausgang::Unentscheidbar`].

use std::ffi::c_void;

use anyhow::{Context, Result};

use crate::cuda::{self, Cuda};
use crate::cudasem::{self, Semapi};
use crate::muster::{fuellen, vergleichen, Vergleich};
use crate::vksem::{Bauart, Vkseite};
use crate::Schalter;

/// Die beiden Musterkennungen. Fest statt je Wiederholung neu: der geteilte
/// Puffer wird zu Beginn jeder Wiederholung SYNCHRON auf „alt" zurueckgesetzt,
/// eine Verschleppung ueber Wiederholungen hinweg ist damit ausgeschlossen —
/// und ein Neubefuellen der Quellpuffer vom Host kostete bei mehreren hundert
/// MiB je Wiederholung mehr Zeit als die ganze Messung.
const ALT: u8 = 0;
const NEU: u8 = 1;

pub enum Ausgang {
    /// Der Schalter hat diese Bauart abgewaehlt.
    NichtGeprueft,
    /// Stufe A gescheitert — mit dem Klartext des Treibers.
    NichtImportierbar(String),
    /// Alles bestanden: Empfindlichkeitsnachweis geglueckt UND mit Semaphor
    /// fehlerfrei.
    Traegt,
    /// Mit Semaphor kamen falsche Bytes heraus.
    TraegtNicht,
    /// **Der eigene, klar benannte Ausgang.** Mit Semaphor sauber, aber der
    /// Aufbau OHNE Semaphor war ebenfalls sauber — die Probe kann ein
    /// fehlendes Warten nicht bemerken und damit auch nicht bestaetigen, dass
    /// das Warten etwas tut.
    Unentscheidbar,
}

pub struct Befund {
    pub bauart: &'static str,
    pub ausgang: Ausgang,
    /// Stufe B, getrennt: die Rueckrichtung ist ein FUNKTIONSnachweis (laeuft
    /// durch, liefert die richtigen Daten), kein Wettrennen-Nachweis. Das
    /// gehoert dazugesagt und nicht mit Stufe D vermengt.
    pub rueckrichtung: Option<bool>,
    pub ohne_sync: Vec<Vergleich>,
    pub mit_sync: Vec<Vergleich>,
}

impl Befund {
    pub fn traegt(&self) -> bool {
        matches!(self.ausgang, Ausgang::Traegt | Ausgang::NichtGeprueft)
    }
}

/// CUDA hochfahren und gegen die Karte abgleichen, die wgpu benutzt.
pub fn cuda_aufbauen(vk_uuid: [u8; 16]) -> Result<Cuda> {
    let c = Cuda::laden()?;
    unsafe { c.pruefe((c.cuInit)(0), "cuInit")? };
    let mut dev: cuda::CUdevice = 0;
    unsafe { c.pruefe((c.cuDeviceGet)(&mut dev, 0), "cuDeviceGet")? };
    let mut cu_uuid = [0u8; 16];
    unsafe { c.pruefe((c.cuDeviceGetUuid)(&mut cu_uuid, dev), "cuDeviceGetUuid")? };
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    println!("  CUDA-Geraet 0: UUID {}", hex(&cu_uuid));
    // Auf einer Maschine mit zwei Karten schluege der Import sonst aus einem
    // Grund fehl, der mit der Frage nichts zu tun hat.
    if cu_uuid != vk_uuid {
        anyhow::bail!(
            "wgpus Karte ({}) und CUDAs Karte ({}) sind verschieden — die Probe wuerde \
             etwas anderes messen als gemeint",
            hex(&vk_uuid),
            hex(&cu_uuid)
        );
    }
    println!("  UUIDs stimmen ueberein — dieselbe Karte");
    let mut ctx: cuda::CUcontext = std::ptr::null_mut();
    unsafe {
        c.pruefe((c.cuDevicePrimaryCtxRetain)(&mut ctx, dev), "cuDevicePrimaryCtxRetain")?;
        c.pruefe((c.cuCtxSetCurrent)(ctx), "cuCtxSetCurrent")?;
    }
    Ok(c)
}

/// Der gemeinsame Speicher, einmal auf beiden Seiten.
struct Geteilt {
    ext_mem: cuda::CUexternalMemory,
    /// Der geteilte Puffer, wie CUDA ihn sieht.
    cu: cuda::CUdeviceptr,
    /// Quellen fuer die Kopien — reiner Geraetespeicher, so wie im Player der
    /// fertige Decoder-Frame liegt. Vom Host aus zu kopieren waere ein anderer,
    /// viel langsamerer Fall und wuerde das Wettrennen kuenstlich aufblasen.
    quelle_alt: cuda::CUdeviceptr,
    quelle_neu: cuda::CUdeviceptr,
}

fn geteilt_anlegen(c: &Cuda, fd: i32, alloc: u64, bytes: usize) -> Result<Geteilt> {
    // `dediziert = true`, weil die Vulkan-Seite mit
    // `VkMemoryDedicatedAllocateInfo` alloziert. Eine Fehlanpassung wird nicht
    // abgewiesen, sondern erzeugt stille Falschergebnisse — Begruendung an
    // `cuda::CUDA_EXTERNAL_MEMORY_DEDICATED`.
    let handle = cuda::ExternalMemoryHandleDesc::fuer_fd(fd, alloc, true);
    let mut ext_mem: cuda::CUexternalMemory = std::ptr::null_mut();
    unsafe {
        c.pruefe((c.cuImportExternalMemory)(&mut ext_mem, &handle), "cuImportExternalMemory")?
    };
    let beschreibung =
        cuda::ExternalMemoryBufferDesc { offset: 0, size: bytes as u64, flags: 0, reserved: [0; 16] };
    let mut cu: cuda::CUdeviceptr = 0;
    unsafe {
        c.pruefe(
            (c.cuExternalMemoryGetMappedBuffer)(&mut cu, ext_mem, &beschreibung),
            "cuExternalMemoryGetMappedBuffer",
        )?
    };

    let mut quelle_alt: cuda::CUdeviceptr = 0;
    let mut quelle_neu: cuda::CUdeviceptr = 0;
    unsafe {
        c.pruefe((c.cuMemAlloc)(&mut quelle_alt, bytes), "cuMemAlloc alt")?;
        c.pruefe((c.cuMemAlloc)(&mut quelle_neu, bytes), "cuMemAlloc neu")?;
        let a = fuellen(bytes, ALT);
        let n = fuellen(bytes, NEU);
        c.pruefe(
            (c.cuMemcpyHtoD)(quelle_alt, a.as_ptr() as *const c_void, bytes),
            "cuMemcpyHtoD alt",
        )?;
        c.pruefe(
            (c.cuMemcpyHtoD)(quelle_neu, n.as_ptr() as *const c_void, bytes),
            "cuMemcpyHtoD neu",
        )?;
        c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize nach Befuellen")?;
    }
    Ok(Geteilt { ext_mem, cu, quelle_alt, quelle_neu })
}

/// Eine Bauart vollstaendig pruefen.
pub fn pruefen(
    c: &Cuda,
    s: &Semapi,
    v: &Vkseite,
    bauart: Bauart,
    sch: &Schalter,
) -> Result<Befund> {
    let bytes = sch.mib * 1024 * 1024;
    println!("\n=== {} ===", bauart.name());

    let sem_vk = v.semaphor(bauart)?;
    let typ = match bauart {
        Bauart::Binaer => cudasem::CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD,
        Bauart::Zeitlinie => cudasem::CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_TIMELINE_SEMAPHORE_FD,
    };

    // --- Stufe A: Import ---------------------------------------------------
    let beschreibung = cudasem::ExternalSemaphoreHandleDesc::fuer_fd(sem_vk.fd, typ);
    let mut sem_cu: cudasem::CUexternalSemaphore = std::ptr::null_mut();
    let r = unsafe { (s.cuImportExternalSemaphore)(&mut sem_cu, &beschreibung) };
    if r != cuda::CUDA_SUCCESS {
        let text = c.fehlertext(r);
        println!("  Stufe A Import: GESCHEITERT — CUDA-Fehler {r} ({text})");
        return Ok(Befund {
            bauart: bauart.name(),
            ausgang: Ausgang::NichtImportierbar(format!("{r} ({text})")),
            rueckrichtung: None,
            ohne_sync: Vec::new(),
            mit_sync: Vec::new(),
        });
    }
    println!("  Stufe A Import: ok (Griff {sem_cu:p})");

    let mut strom: cudasem::CUstream = std::ptr::null_mut();
    unsafe { c.pruefe((s.cuStreamCreate)(&mut strom, 0), "cuStreamCreate")? };

    let puffer = v.geteilter_puffer(bytes)?;
    let (ablage, ablage_mem) = v.ablage(bytes)?;
    let g = geteilt_anlegen(c, puffer.fd, puffer.alloc, bytes)?;

    // --- Stufe B: Rueckrichtung -------------------------------------------
    // Vulkan signalisiert, CUDA wartet. Zuerst signalisieren und die
    // Warteschlange leeren: ein CUDA-Warten auf ein NIE signalisiertes
    // binaeres Semaphor haengt endlos, und ein haengender Prueflauf ist kein
    // Befund, sondern ein verlorener Abend.
    v.absenden_signal(&sem_vk, 1)?;
    v.warteschlange_leeren()?;
    let warten = cudasem::ExternalSemaphoreWaitParams::fuer_wert(1);
    let rw = unsafe { (s.cuWaitExternalSemaphoresAsync)(&sem_cu, &warten, 1, strom) };
    let rueck = if rw == cuda::CUDA_SUCCESS {
        unsafe { (s.cuStreamSynchronize)(strom) == cuda::CUDA_SUCCESS }
    } else {
        false
    };
    println!(
        "  Stufe B Rueckrichtung (Vulkan signalisiert, CUDA wartet): {} — Funktionsnachweis, \
         KEIN Wettrennen-Nachweis",
        if rueck { "ok" } else { "gescheitert" }
    );
    if !rueck && rw != cuda::CUDA_SUCCESS {
        println!("      cuWaitExternalSemaphoresAsync: {rw} ({})", c.fehlertext(rw));
    }

    // --- Stufen C und D ----------------------------------------------------
    let ohne_sync = if sch.empfindlichkeit {
        durchgaenge(c, s, v, &g, &puffer, ablage, ablage_mem, bytes, sch, None, strom)?
    } else {
        Vec::new()
    };
    let mit_sync = if sch.hauptlauf {
        durchgaenge(
            c,
            s,
            v,
            &g,
            &puffer,
            ablage,
            ablage_mem,
            bytes,
            sch,
            Some((&sem_vk, sem_cu)),
            strom,
        )?
    } else {
        Vec::new()
    };

    unsafe {
        c.pruefe((s.cuStreamDestroy)(strom), "cuStreamDestroy")?;
        c.pruefe((s.cuDestroyExternalSemaphore)(sem_cu), "cuDestroyExternalSemaphore")?;
        c.pruefe((c.cuMemFree)(g.quelle_alt), "cuMemFree alt")?;
        c.pruefe((c.cuMemFree)(g.quelle_neu), "cuMemFree neu")?;
        c.pruefe((c.cuDestroyExternalMemory)(g.ext_mem), "cuDestroyExternalMemory")?;
    }

    let ausgang = urteilen(&ohne_sync, &mit_sync, sch);
    Ok(Befund { bauart: bauart.name(), ausgang, rueckrichtung: Some(rueck), ohne_sync, mit_sync })
}

/// Aus den beiden Reihen den Ausgang bilden.
///
/// Die Reihenfolge der Pruefungen ist bewusst: erst „traegt nicht", dann
/// „unentscheidbar". Ein Lauf, der mit Semaphor falsche Bytes liefert, ist ein
/// Fehlschlag — auch wenn die Gegenprobe nichts gezeigt hat.
fn urteilen(ohne: &[Vergleich], mit: &[Vergleich], sch: &Schalter) -> Ausgang {
    if !sch.hauptlauf {
        return Ausgang::NichtGeprueft;
    }
    if mit.iter().any(|v| v.abweichend() != 0) {
        return Ausgang::TraegtNicht;
    }
    if sch.empfindlichkeit && !ohne.iter().any(|v| v.abweichend() != 0) {
        return Ausgang::Unentscheidbar;
    }
    Ausgang::Traegt
}

/// Mehrere Wiederholungen desselben Aufbaus. Ein Lauf je Variante traegt keine
/// Entscheidung — bei einem Wettrennen schon gar nicht.
#[allow(clippy::too_many_arguments)]
fn durchgaenge(
    c: &Cuda,
    s: &Semapi,
    v: &Vkseite,
    g: &Geteilt,
    puffer: &crate::vksem::Puffer,
    ablage: ash::vk::Buffer,
    ablage_mem: ash::vk::DeviceMemory,
    bytes: usize,
    sch: &Schalter,
    sem: Option<(&crate::vksem::Semaphor, cudasem::CUexternalSemaphore)>,
    strom: cudasem::CUstream,
) -> Result<Vec<Vergleich>> {
    let mit = sem.is_some();
    println!(
        "  Stufe {} ({} Semaphor), {} Wiederholungen je {} MiB, {} Vorkopien:",
        if mit { "D" } else { "C" },
        if mit { "MIT" } else { "OHNE" },
        sch.runden,
        sch.mib,
        sch.vorkopien
    );
    let mut aus = Vec::new();
    // Ein Zeitlinien-Wert je Absendung, monoton wachsend. Bei einem binaeren
    // Semaphor ignoriert der Treiber ihn — der Zaehler laeuft trotzdem mit,
    // damit beide Zweige denselben Ablauf haben.
    let mut wert = 100u64;
    for runde in 0..sch.runden {
        // Ausgangslage herstellen: geteilter Puffer traegt das ALTE Muster,
        // und zwar nachweislich fertig geschrieben.
        unsafe {
            c.pruefe((s.cuMemcpyDtoD)(g.cu, g.quelle_alt, bytes), "cuMemcpyDtoD Ausgangslage")?;
            c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize Ausgangslage")?;
        }
        v.warteschlange_leeren()?;

        // CUDA-Arbeit auf den Strom legen: erst `vorkopien` Kopien des ALTEN
        // Musters (sie kosten nur Zeit und weiten damit das Zeitfenster), dann
        // EINE Kopie des neuen. Wer zu frueh liest, sieht deshalb ALT und
        // nicht bloss halb geschriebene Bytes — das ist der Unterschied
        // zwischen einem auswertbaren und einem ratenden Befund.
        unsafe {
            for _ in 0..sch.vorkopien {
                c.pruefe(
                    (s.cuMemcpyDtoDAsync)(g.cu, g.quelle_alt, bytes, strom),
                    "cuMemcpyDtoDAsync alt",
                )?;
            }
            c.pruefe(
                (s.cuMemcpyDtoDAsync)(g.cu, g.quelle_neu, bytes, strom),
                "cuMemcpyDtoDAsync neu",
            )?;
            if let Some((_, sem_cu)) = sem {
                wert += 1;
                let signal = cudasem::ExternalSemaphoreSignalParams::fuer_wert(wert);
                c.pruefe(
                    (s.cuSignalExternalSemaphoresAsync)(&sem_cu, &signal, 1, strom),
                    "cuSignalExternalSemaphoresAsync",
                )?;
            }
        }

        // Sofort absenden — ohne jedes Warten auf CUDA. Genau hier entscheidet
        // sich, ob das Semaphor etwas tut.
        v.absenden_kopie(puffer.roh, ablage, bytes, sem.map(|(sv, _)| (sv, wert)))?;
        v.warteschlange_leeren()?;
        unsafe { c.pruefe((s.cuStreamSynchronize)(strom), "cuStreamSynchronize")? };

        let gelesen = v.lesen(ablage_mem, bytes).context("Ablage auslesen")?;
        let vgl = vergleichen(&gelesen, NEU, ALT);
        println!("      Wiederholung {}: {}", runde + 1, vgl.kurz());
        aus.push(vgl);
    }
    Ok(aus)
}
