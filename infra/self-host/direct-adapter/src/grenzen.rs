//! Speichergrenzen des HTTP-Kanals der Brücke.
//!
//! Die Brücke puffert einen Anfragekörper vollständig, bevor sie ihn ans
//! Backend schickt (Body-Frames kommen in ≤48-KiB-Stücken, erst `fin` löst den
//! Versand aus). Ohne Grenze konnte jede Gegenstelle — und den DataChannel
//! öffnen darf jedes Cloud-Konto — beliebig viele IDs offen halten und in
//! jede beliebig viele Stücke schieben, bis der Prozess am Speicher stirbt.
//!
//! Drei Grenzen, alle fail-closed (Anfrage verwerfen, `err` an den Kanal):
//! - **je Anfrage** `max_anfrage_bytes()`: Vorgabe 64 MiB. Das ist die größte
//!   Dateigrenze, die der chat-gateway selbst setzt
//!   (`pulse_laufwerk_max_datei_bytes`, `ablage_zwischenlager_max_datei_bytes`);
//!   die Anhang-Vorgabe liegt mit 25 MiB darunter
//!   (`guild_limits.DEFAULT_ATTACHMENT_MAX_SIZE_BYTES`). Eine Community, die
//!   ihr Anhang-Limit darüber anhebt, scheitert auf dem Direktweg an dieser
//!   Grenze — dafür gibt es `PULSE_DIRECT_MAX_BODY_BYTES`.
//! - **je Kanal** `MAX_OFFENE_IDS` gleichzeitig offene Anfragen (gepuffert
//!   ODER schon unterwegs zum Backend).
//! - **je Prozess** `max_puffer_gesamt()`: Summe aller gepufferten Körper über
//!   alle Kanäle und Verbindungen — eine Gegenstelle kann beliebig viele
//!   DataChannels öffnen, eine Grenze nur je Kanal hielte das nicht auf.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const MAX_OFFENE_IDS: usize = 64;
const VORGABE_ANFRAGE_BYTES: usize = 64 * 1024 * 1024;
const VORGABE_GESAMT_BYTES: usize = 256 * 1024 * 1024;

static BELEGT: AtomicUsize = AtomicUsize::new(0);

pub fn max_anfrage_bytes() -> usize {
    std::env::var("PULSE_DIRECT_MAX_BODY_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(VORGABE_ANFRAGE_BYTES)
}

/// Mindestens eine volle Anfrage muss hineinpassen, sonst wäre eine
/// angehobene Einzelgrenze wirkungslos.
fn max_puffer_gesamt() -> usize {
    VORGABE_GESAMT_BYTES.max(max_anfrage_bytes())
}

/// Anteil am prozessweiten Puffer-Budget; gibt seinen Anteil beim Drop frei.
#[derive(Default)]
pub struct Reservierung(usize);

impl Reservierung {
    /// Vergrößert die Reservierung um `n` Bytes. `false` = Grenze je Anfrage
    /// oder prozessweit überschritten; die Reservierung bleibt dann unverändert.
    pub fn wachsen(&mut self, n: usize) -> bool {
        let neu = self.0.saturating_add(n);
        if neu > max_anfrage_bytes() {
            return false;
        }
        let ok = BELEGT
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |belegt| {
                let summe = belegt.checked_add(n)?;
                (summe <= max_puffer_gesamt()).then_some(summe)
            })
            .is_ok();
        if ok {
            self.0 = neu;
        }
        ok
    }
}

impl Drop for Reservierung {
    fn drop(&mut self) {
        BELEGT.fetch_sub(self.0, Ordering::AcqRel);
    }
}

/// Zählt die offenen Anfragen eines Kanals; ein `Platz` hält einen davon
/// und gibt ihn beim Drop zurück (auch wenn der Versand-Task abbricht).
#[derive(Clone, Default)]
pub struct OffeneIds(Arc<AtomicUsize>);

pub struct Platz(Arc<AtomicUsize>);

impl OffeneIds {
    pub fn belegen(&self) -> Option<Platz> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_OFFENE_IDS).then_some(n + 1)
            })
            .ok()
            .map(|_| Platz(self.0.clone()))
    }
}

impl Drop for Platz {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offene_ids_sind_gedeckelt_und_werden_frei() {
        let ids = OffeneIds::default();
        let mut plaetze: Vec<Platz> = (0..MAX_OFFENE_IDS).map(|_| ids.belegen().unwrap()).collect();
        assert!(ids.belegen().is_none(), "65. offene ID angenommen");
        plaetze.pop();
        assert!(ids.belegen().is_some(), "frei gewordener Platz nicht wiederverwendbar");
    }

    // Ein einziger Test für das prozessweite Budget: `BELEGT` ist global, und
    // parallel laufende Tests würden sich die Zahl gegenseitig verschieben.
    #[test]
    fn anfrage_und_gesamtbudget_greifen() {
        let max = max_anfrage_bytes();
        let mut r = Reservierung::default();
        assert!(r.wachsen(max));
        assert!(!r.wachsen(1), "Einzelgrenze überschritten und trotzdem angenommen");

        // Prozessweit: so viele volle Anfragen, bis das Budget erschöpft ist.
        let mut volle = vec![r];
        loop {
            let mut n = Reservierung::default();
            if !n.wachsen(max) {
                break;
            }
            volle.push(n);
            assert!(volle.len() <= max_puffer_gesamt() / max, "Gesamtbudget greift nicht");
        }
        volle.clear();
        let mut wieder = Reservierung::default();
        assert!(wieder.wachsen(max), "Drop hat das Budget nicht freigegeben");
    }
}
