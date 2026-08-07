//! Wer einen Ringplatz haelt und wann er frei wird.
//!
//! **Von beiden Bruecken benutzt** (Windows `bruecke.rs`, Linux `linux/`) und
//! deshalb aus `platz.rs` herausgeloest: dort stand es neben dem
//! D3D11-spezifischen `GpuBild` und waere auf Linux nicht uebersetzbar
//! gewesen. Die Sache selbst hat mit keiner der beiden Grafikschnittstellen
//! etwas zu tun — es ist ein Stapel freier Nummern.

use std::sync::{Arc, Mutex};

/// Freie Ringplaetze. Getrennt vom Ring selbst, weil die Rueckgabe von einem
/// ANDEREN Thread kommt als die Entnahme: der Renderer gibt einen Platz erst
/// frei, wenn die GPU mit ihm fertig ist.
pub struct Freigabe {
    frei: Mutex<Vec<usize>>,
}

impl Freigabe {
    pub fn mit(plaetze: usize) -> Arc<Self> {
        Arc::new(Self { frei: Mutex::new((0..plaetze).collect()) })
    }
    pub fn leer() -> Arc<Self> {
        Arc::new(Self { frei: Mutex::new(Vec::new()) })
    }
    pub fn nehmen(&self) -> Option<usize> {
        self.frei.lock().ok()?.pop()
    }
    pub fn zurueck(&self, slot: usize) {
        if let Ok(mut f) = self.frei.lock() {
            f.push(slot);
        }
    }
}

