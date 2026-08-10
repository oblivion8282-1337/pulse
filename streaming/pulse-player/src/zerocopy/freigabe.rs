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

#[cfg(test)]
mod tests {
    use super::*;

    /// Sie gibt genau so viele Plaetze heraus, wie sie hat — und keinen mehr.
    /// **Daran haengt auf dem VAAPI-Weg der Decoder:** ein Platz zu viel heisst
    /// eine Surface zu wenig in seinem Pool, und er liefert nichts mehr
    /// (`zerocopy::vaapi::anker`).
    #[test]
    fn sie_gibt_nicht_mehr_heraus_als_sie_hat() {
        let f = Freigabe::mit(2);
        let a = f.nehmen().expect("erster Platz");
        let b = f.nehmen().expect("zweiter Platz");
        assert_ne!(a, b, "zwei Entnahmen duerfen nicht denselben Platz liefern");
        assert!(f.nehmen().is_none(), "den dritten Platz darf es nicht geben");
        f.zurueck(a);
        assert_eq!(f.nehmen(), Some(a), "nach der Rueckgabe ist er wieder da");
    }

    /// Eine leere Freigabe gibt nichts heraus — der Zustand zwischen Abbau und
    /// Neubau des Rings (`zerocopy::linux::Bruecke`).
    #[test]
    fn die_leere_gibt_nichts_heraus() {
        assert!(Freigabe::leer().nehmen().is_none());
    }
}

