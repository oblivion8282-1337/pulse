//! Der CUDA-Unterbau des Prozesses: geladene Bibliothek und der Kontext, den
//! sich Decoder und Bruecke TEILEN.
//!
//! **Warum prozessweit und nicht je Bruecke.** Der Kontext muss derselbe sein,
//! in dem FFmpeg dekodiert — sonst laege der Decoder-Frame in einem fremden
//! Kontext und `cuMemcpy2D` griffe ins Leere. FFmpeg uebernimmt ihn ueber
//! `AV_CUDA_USE_CURRENT_CONTEXT` beim Oeffnen des Decoders, also **bevor** es
//! ein erstes Bild und damit eine Bruecke gibt. Etwas, das vor der Bruecke da
//! sein muss, kann nicht in ihr wohnen.
//!
//! Der primaere Kontext einer Karte ist genau dafuer gedacht: er ist
//! prozessweit derselbe, egal wie oft man ihn anfordert.

use anyhow::{anyhow, bail, Result};

use super::cuda::{self, Cuda};
use super::vkbild::Vkseite;

pub(super) struct Kern {
    pub cuda: Cuda,
    pub ctx: cuda::CUcontext,
    /// Die Karte, fuer die er gilt. Ein zweites Fenster auf einer ANDEREN Karte
    /// bekaeme sonst still den falschen Kontext (s. [`kern`]).
    uuid: [u8; 16],
}

// SAFETY: `Cuda` haelt eine Bibliothek und Funktionszeiger (beide `Send`+`Sync`);
// `ctx` ist ein undurchsichtiger Zeiger, den CUDA selbst gegen gleichzeitige
// Benutzung absichert. Er wird ausserdem vor jedem Gebrauch auf dem
// benutzenden Thread aktiv gesetzt (s. `Bruecke::kopieren`).
unsafe impl Send for Kern {}
unsafe impl Sync for Kern {}

impl Kern {
    /// Den geteilten Kontext auf DIESEM Thread aktiv machen.
    ///
    /// **Vor jedem Gebrauch**, nicht nur einmal beim Aufbau: der CUDA-Kontext
    /// haengt am THREAD, und der Decoder laeuft in einer tokio-Aufgabe, die
    /// zwischen zwei Bildern den Arbeitsthread wechseln darf. Ohne diesen
    /// Aufruf fiele der Wechsel als `CUDA_ERROR_INVALID_CONTEXT` auf — aber
    /// erst irgendwann, nicht zuverlaessig.
    pub fn kontext_setzen(&self) -> Result<()> {
        // SAFETY: `ctx` stammt aus `cuDevicePrimaryCtxRetain` und lebt so lange
        // wie der Prozess.
        unsafe { self.cuda.pruefe((self.cuda.cuCtxSetCurrent)(self.ctx), "cuCtxSetCurrent") }
    }
}

static KERN: std::sync::OnceLock<Option<Kern>> = std::sync::OnceLock::new();

/// Den geteilten CUDA-Unterbau holen — beim ersten Mal anlegen.
///
/// `uuid` ist die Karte, die wgpu benutzt; der Kontext wird fuer genau diese
/// angefordert. Stimmt sie beim zweiten Aufruf nicht (zwei Fenster auf zwei
/// Karten), gibt es fuer das zweite keinen Zero-Copy-Weg — **eine Absage ist
/// hier richtiger als ein zweiter Kontext**, denn FFmpeg hat den ersten
/// laengst uebernommen.
pub(super) fn kern(uuid: [u8; 16]) -> Result<&'static Kern> {
    let k = KERN
        .get_or_init(|| match kern_bauen(uuid) {
            Ok(k) => Some(k),
            Err(e) => {
                eprintln!("pulse-player: CUDA-Unterbau nicht verfuegbar ({e:#})");
                None
            }
        })
        .as_ref()
        .ok_or_else(|| anyhow!("CUDA-Unterbau nicht verfuegbar"))?;
    if k.uuid != uuid {
        bail!("dieses Fenster laeuft auf einer anderen Karte als der geteilte CUDA-Kontext");
    }
    Ok(k)
}

fn kern_bauen(uuid: [u8; 16]) -> Result<Kern> {
    // Zuerst das Layout: stimmt es nicht, ist jeder folgende Aufruf
    // verdaechtig, und ein falscher Feld-Versatz meldet sich nicht von selbst.
    cuda::selbsttest_layout()?;
    let c = Cuda::laden()?;
    // SAFETY: alle Aufrufe folgen der Reihenfolge der Treiber-API; jeder
    // Rueckgabewert wird geprueft, bevor der naechste laeuft.
    unsafe {
        c.pruefe((c.cuInit)(0), "cuInit")?;
        let mut anzahl: std::ffi::c_int = 0;
        c.pruefe((c.cuDeviceGetCount)(&mut anzahl), "cuDeviceGetCount")?;
        for i in 0..anzahl {
            let mut dev: cuda::CUdevice = 0;
            c.pruefe((c.cuDeviceGet)(&mut dev, i), "cuDeviceGet")?;
            let mut kandidat = [0u8; 16];
            c.pruefe((c.cuDeviceGetUuid)(&mut kandidat, dev), "cuDeviceGetUuid")?;
            if kandidat != uuid {
                continue;
            }
            let mut ctx: cuda::CUcontext = std::ptr::null_mut();
            c.pruefe((c.cuDevicePrimaryCtxRetain)(&mut ctx, dev), "cuDevicePrimaryCtxRetain")?;
            c.pruefe((c.cuCtxSetCurrent)(ctx), "cuCtxSetCurrent")?;
            return Ok(Kern { cuda: c, ctx, uuid });
        }
    }
    bail!("keine CUDA-Karte mit der UUID von wgpus Geraet — laeuft wgpu auf einer anderen GPU?")
}

/// Den geteilten CUDA-Kontext auf DIESEM Thread aktiv machen und melden, ob es
/// geklappt hat.
///
/// **Der Aufruf gehoert vor `av_hwdevice_ctx_create` mit
/// `AV_CUDA_USE_CURRENT_CONTEXT`** (s. `decode.rs`). Der andere naheliegende
/// Weg, `AV_CUDA_USE_PRIMARY_CONTEXT`, scheitert **genau in dieser Lage**:
/// haben wir den primaeren Kontext schon geholt — und die Reihenfolge ist
/// zwingend so —, antwortet FFmpeg mit
/// `Primary context already active with incompatible flags` (rc=-95, 16 von 16
/// Laeufen). Beleg: `profiles/player-2026-08-07-cuvid-cuda-ausgabe.json`,
/// Abschnitt `GEMESSEN_cuda_kontext`.
///
/// Schlaegt es fehl, ist das **kein Grund, die Dekodierung aufzugeben**: der
/// Aufrufer laesst FFmpeg dann seinen eigenen Kontext anlegen und verliert nur
/// den Zero-Copy-Weg.
pub fn kontext_bereitstellen(geraet: &Option<wgpu::Device>) -> bool {
    let Some(d) = geraet else { return false };
    let versuch = Vkseite::neu(d).and_then(|v| kern(v.uuid())?.kontext_setzen());
    match versuch {
        Ok(()) => true,
        Err(e) => {
            eprintln!(
                "pulse-player: kein geteilter CUDA-Kontext ({e:#}) — der Decoder legt seinen \
                 eigenen an, Zero-Copy entfaellt"
            );
            false
        }
    }
}
