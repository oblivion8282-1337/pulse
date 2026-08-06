//! Stufe 1: teilen sich CUDA und Vulkan denselben **Puffer**?
//!
//! Das ist die Grundfrage, und sie ist am 2026-08-06 mit Ja beantwortet
//! (Messakte `player-2026-08-06-cuda-vulkan-linux.json`). Der Code steht
//! unveraendert hier, damit der Befund jederzeit nachvollziehbar bleibt und
//! damit ein Fehlschlag der Bild-Stufe von einem Fehlschlag der Grundlage
//! unterscheidbar ist.

use std::ffi::c_void;

use anyhow::{bail, Result};

use crate::cuda::{self, Cuda};
use crate::vk::Vulkan;
use crate::{ergebnis_melden, muster, vergleichen};

pub fn pruefen(vk_seite: &Vulkan, c: &Cuda, bytes: usize, dediziert: bool) -> Result<()> {
    println!("Stufe Puffer: {bytes} Bytes, dedizierte Allokation: {dediziert}");

    // ── Vulkan legt den geteilten Speicher an und exportiert ihn ────────────
    let (geteilt, geteilt_mem, fd) = vk_seite.exportierbarer_puffer(bytes, dediziert)?;
    println!("  Vulkan-Speicher exportiert, Deskriptor {fd}");

    // ── CUDA haengt ihn ein ─────────────────────────────────────────────────
    // Das Flag fuer die dedizierte Allokation muss zur Vulkan-Seite passen —
    // die Begruendung steht am Konstruktor.
    let beschreibung = cuda::ExternalMemoryHandleDesc::fuer_fd(fd, bytes as u64, dediziert);
    let mut ext_mem: cuda::CUexternalMemory = std::ptr::null_mut();
    unsafe {
        c.pruefe(
            (c.cuImportExternalMemory)(&mut ext_mem, &beschreibung),
            "cuImportExternalMemory",
        )?
    };
    let mut zeiger: cuda::CUdeviceptr = 0;
    let puffer_desc =
        cuda::ExternalMemoryBufferDesc { offset: 0, size: bytes as u64, ..Default::default() };
    unsafe {
        c.pruefe(
            (c.cuExternalMemoryGetMappedBuffer)(&mut zeiger, ext_mem, &puffer_desc),
            "cuExternalMemoryGetMappedBuffer",
        )?
    };
    println!("  CUDA hat ihn eingehaengt, Geraetezeiger 0x{zeiger:x}");

    let (ablage, ablage_mem) = vk_seite.ablage(bytes)?;
    let soll: Vec<u8> = (0..bytes).map(muster).collect();
    let mut fehler = 0usize;

    // ── Hauptfall: CUDA schreibt, Vulkan liest ──────────────────────────────
    // Das ist die Richtung, auf die es fuer den Player ankommt.
    unsafe {
        c.pruefe((c.cuMemsetD8)(zeiger, 0, bytes), "cuMemsetD8")?;
        c.pruefe(
            (c.cuMemcpyHtoD)(zeiger, soll.as_ptr() as *const c_void, bytes),
            "cuMemcpyHtoD",
        )?;
        c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize")?;
    }
    vk_seite.kopieren(geteilt, ablage, bytes)?;
    let gelesen = vk_seite.lesen(ablage_mem, bytes)?;
    if ergebnis_melden("CUDA schreibt -> Vulkan liest", &soll, &gelesen) {
        fehler += 1;
    }

    // ── Gegenrichtung: Vulkan schreibt, CUDA liest ──────────────────────────
    // Nicht der Anwendungsfall, aber sie trennt zwei Ursachen: schluege nur der
    // Hauptfall fehl, laege es an der Schreibrichtung, nicht am geteilten
    // Speicher.
    let soll2: Vec<u8> = (0..bytes).map(|i| muster(i.wrapping_add(12345))).collect();
    vk_seite.schreiben(ablage_mem, &soll2)?;
    vk_seite.kopieren(ablage, geteilt, bytes)?;
    let mut zurueck = vec![0u8; bytes];
    unsafe {
        c.pruefe(
            (c.cuMemcpyDtoH)(zurueck.as_mut_ptr() as *mut c_void, zeiger, bytes),
            "cuMemcpyDtoH",
        )?;
        c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize")?;
    }
    if ergebnis_melden("Vulkan schreibt -> CUDA liest", &soll2, &zurueck) {
        fehler += 1;
    }

    // ── Kontrolle: schlaegt die Pruefung ueberhaupt an? ─────────────────────
    // Ohne sie waere "alles stimmt" nicht von "die Pruefung vergleicht nichts"
    // zu unterscheiden — dieselbe Klasse Werkzeugfehler, die in diesem Labor
    // schon mehrfach falsche Befunde erzeugt hat.
    let mut verdorben = soll2.clone();
    verdorben[bytes / 2] ^= 0xFF;
    if vergleichen(&verdorben, &zurueck).is_none() {
        bail!("Kontrolle fehlgeschlagen: ein absichtlich verfaelschtes Byte fiel NICHT auf");
    }
    println!("  Kontrolle: ein verfaelschtes Byte faellt auf — die Pruefung greift");

    unsafe {
        c.pruefe((c.cuDestroyExternalMemory)(ext_mem), "cuDestroyExternalMemory")?;
        vk_seite.device.destroy_buffer(geteilt, None);
        vk_seite.device.free_memory(geteilt_mem, None);
        vk_seite.device.destroy_buffer(ablage, None);
        vk_seite.device.free_memory(ablage_mem, None);
    }

    println!();
    if fehler == 0 {
        println!("URTEIL: der Weg traegt. CUDA und Vulkan teilen sich den Speicher.");
        Ok(())
    } else {
        bail!("URTEIL: der Weg traegt NICHT ({fehler} von 2 Richtungen abweichend)")
    }
}
