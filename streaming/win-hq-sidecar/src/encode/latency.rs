//! Encode-Latenz: vom Einschieben eines Bildes bis zu seinem Paket.
//!
//! **Was hier gemessen wird und was nicht.** Der `TickMonitor` hatte bisher
//! `send` — die Dauer des `avcodec_send_frame`-Aufrufs. Das ist die
//! SUBMIT-Zeit, und bei einem asynchron arbeitenden Encoder ist sie nahe null,
//! auch wenn das Paket erst zwei Bilder später herausfällt. Genau dieser
//! Vorlauf ist aber der Posten, den `zerolatency`/`delay` (NVENC) und
//! `async_depth` (VAAPI/D3D12VA/AMF) verändern — er war damit unsichtbar.
//!
//! Gemessen wird deshalb vom `send_frame` bis zu dem Paket, das denselben pts
//! trägt: die Verzögerung der Encoder-Kette EINSCHLIESSLICH ihrer
//! Warteschlange. Das ist der Anteil, den ein Zuschauer als Latenz spürt.
//!
//! Vorlage: `streaming/linux-hq-sidecar/src/encode/mod.rs`, wo dieselbe Messung
//! die Grundlage der Messreihe vom Juli 2026 war.

use std::collections::VecDeque;
use std::time::Instant;

/// Obergrenze der Zuordnungs-Schlange. Im Normalbetrieb stehen dort ein bis
/// zwei Einträge (der Vorlauf des Encoders). Wächst sie darüber hinaus, kommen
/// gar keine Pakete mehr zurück — dann ist der Stream ohnehin tot, und die
/// Schlange soll nicht zusätzlich Speicher fressen.
const MAX_PENDING: usize = 256;

/// Zuordnung eingeschobener Bilder zu ihren Paketen + Fenster-Statistik.
#[derive(Default)]
pub struct EncodeLatency {
    /// Wann welcher pts in den Encoder ging. Die Reihenfolge bleibt monoton
    /// (keine B-Bilder in den Streaming-Profilen), deshalb reicht eine Schlange.
    pending: VecDeque<(i64, Instant)>,
    sum_us: u64,
    count: u64,
    max_us: u64,
}

impl EncodeLatency {
    /// Ein angenommenes Bild vermerken. `at` muss VOR `avcodec_send_frame`
    /// gestempelt sein: mit abgeschaltetem Vorlauf liefert der Encoder das Paket
    /// im selben Aufruf zurück, die Rechenzeit steckt also im Aufruf selbst. Ein
    /// Stempel danach meldet 0,0 ms — eine Zahl, die nach vollkommener
    /// Latenzfreiheit aussieht und schlicht am Messpunkt vorbeigeht.
    pub fn submitted(&mut self, pts: i64, at: Instant) {
        if self.pending.len() >= MAX_PENDING {
            self.pending.pop_front();
        }
        self.pending.push_back((pts, at));
    }

    /// Ein herausgefallenes Paket zuordnen. **Vor `rescale_ts` aufrufen** —
    /// danach steht der pts in der Muxer-Zeitbasis und passt nicht mehr zum
    /// vermerkten.
    pub fn packet(&mut self, pts: Option<i64>) {
        let Some(pts) = pts else { return };
        while let Some(&(front, at)) = self.pending.front() {
            if front > pts {
                break; // Paket ohne Eintrag — sollte nicht vorkommen
            }
            self.pending.pop_front();
            if front == pts {
                let us = at.elapsed().as_micros() as u64;
                self.sum_us += us;
                self.count += 1;
                self.max_us = self.max_us.max(us);
                break;
            }
        }
    }

    /// Holt und LEERT die Zähler: (Summe, Maximum, Anzahl) in Mikrosekunden.
    /// Der Aufrufer bildet den Mittelwert über sein eigenes Fenster — mit einer
    /// hier schon gemittelten Zahl wäre das Fenster-Mittel je nach Paketzahl je
    /// Tick verzerrt.
    pub fn take(&mut self) -> (u64, u64, u64) {
        let out = (self.sum_us, self.max_us, self.count);
        self.sum_us = 0;
        self.max_us = 0;
        self.count = 0;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::EncodeLatency;
    use std::time::{Duration, Instant};

    /// Der Normalfall: Paket zu Bild N kommt, wenn N+2 eingeschoben wird.
    /// Gemessen werden muss die Zeit seit dem Einschieben von N, nicht von N+2.
    #[test]
    fn ordnet_ueber_den_vorlauf_hinweg_zu() {
        let mut l = EncodeLatency::default();
        let t0 = Instant::now() - Duration::from_millis(30);
        l.submitted(0, t0);
        l.submitted(1, Instant::now());
        l.packet(Some(0));
        let (sum, max, n) = l.take();
        assert_eq!(n, 1);
        assert!(sum >= 30_000, "Latenz zu klein: {sum} µs");
        assert_eq!(sum, max);
    }

    /// Ein Bild ohne Paket (verworfen) darf die Zuordnung nicht dauerhaft
    /// verschieben — sonst zeigt jede folgende Messung die Latenz des jeweils
    /// vorherigen Bildes.
    #[test]
    fn uebersprungener_pts_verschiebt_nicht() {
        let mut l = EncodeLatency::default();
        l.submitted(0, Instant::now() - Duration::from_millis(50));
        l.submitted(1, Instant::now() - Duration::from_millis(10));
        l.packet(Some(1));
        let (sum, _, n) = l.take();
        assert_eq!(n, 1);
        assert!(sum < 30_000, "es wurde der falsche Eintrag zugeordnet: {sum} µs");
    }

    /// Kommen gar keine Pakete zurück, darf die Schlange nicht unbegrenzt
    /// wachsen.
    #[test]
    fn schlange_bleibt_begrenzt() {
        let mut l = EncodeLatency::default();
        for pts in 0..1000 {
            l.submitted(pts, Instant::now());
        }
        assert!(l.pending.len() <= super::MAX_PENDING);
    }

    /// `take` leert — zwei Fenster hintereinander dürfen sich nicht summieren.
    #[test]
    fn take_leert_das_fenster() {
        let mut l = EncodeLatency::default();
        l.submitted(0, Instant::now());
        l.packet(Some(0));
        l.take();
        assert_eq!(l.take(), (0, 0, 0));
    }
}
