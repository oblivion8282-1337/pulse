//! Die Pakete eines Bildes gleichmaessig verteilen statt als Schwall.
//!
//! **Warum.** Ein encodiertes Bild verlaesst den Encoder als ein Stueck. Ohne
//! Zutun gehen seine RTP-Pakete danach in Mikrosekunden hintereinander auf die
//! Leitung, dann passiert einen Bildabstand lang nichts. Auf der lokalen
//! Schleife ist das folgenlos; ueber eine echte Strecke laeuft jeder solche
//! Schwall in die Warteschlangen unterwegs und kommt verschieden breitgezogen
//! wieder heraus.
//!
//! Gemessen am 2026-07-28 gegen den Hetzner-Testserver, AV1 10 bit, 60 fps,
//! gezaehlt werden Ankunftsluecken ueber 25 ms (ein Bildabstand ist 16,7 ms):
//!
//! | gesendet | Luecken je Sekunde | typisch | groesste |
//! |---|---|---|---|
//! | 1000 kbps | 0,9 | 25,8 ms | 29,4 ms |
//! | 2000 kbps | 2,1 | 28,0 ms | 39,7 ms |
//! | 4000 kbps | 2,2 | 35,3 ms | 73,7 ms |
//! | lokal, 4000 kbps | **0** | — | 17,4 ms |
//!
//! Die Luecken wachsen mit der Bildgroesse — also mit der Laenge des Schwalls.
//! Lokal gibt es sie gar nicht. Beim Zuschauer wird daraus sichtbares Ruckeln,
//! weil der Player jedes Bild in dem Augenblick zeichnet, in dem es fertig ist.
//!
//! **Wie.** Ein Verteil-Task auf der WHIP-Laufzeit nimmt die fertigen Pakete
//! eines Bildes entgegen und schreibt sie ueber einen Teil des Bildabstands
//! verteilt heraus. Der Encode-Faden gibt sie nur ab und laeuft weiter — er
//! darf unter keinen Umstaenden warten, sonst bremst die Verteilung die
//! Aufnahme aus.
//!
//! **AUS als Vorgabe, `PULSE_WHIP_PACING=1` schaltet ein — Messung steht aus.**
//! Die ERSTE Fassung (relatives `tokio::time::sleep` je Paket) hat es
//! nachweislich schlechter gemacht: 19,6/16,9 statt 1,6/1,8 Luecken je Sekunde
//! (2026-07-28, vier Laeufe abwechselnd), weil sie ihr eigenes Ziel um zwei
//! Drittel verfehlte — Soll 7,9 ms je Bild, tatsaechlich 13,1. `sleep` unter
//! 2 ms rundete der Zeitgeber grob auf, und je Paket gewartet summierte sich
//! jeder Rundungsfehler.
//!
//! Diese Fassung baut genau die beiden Dinge anders, die damals als Lehren
//! notiert wurden:
//!
//! * **Absolute Zeitpunkte** (`sleep_until` gegen den Bild-Anfang) statt
//!   relativem Schlaf in der Schleife — ein Ueberschuss verschiebt nur den
//!   einen Termin und traegt sich nicht in alle folgenden.
//! * **Gruppen-Quantisierung statt Sub-Millisekunden-Traeume:** die Pakete
//!   eines Bildes werden in hoechstens so viele Gruppen geteilt, dass der
//!   Abstand nie unter [`MIN_ABSTAND`] faellt. Zwoelf Pakete werden also
//!   nicht in zwoelf 1,1-ms-Schritten verlangt (die der Zeitgeber nicht
//!   halten kann), sondern in sechs 2er-Bursts alle 2,2 ms — der Schwall
//!   schrumpft von zwoelf auf zwei, und jeder Termin ist haltbar. Der
//!   Prozess hebt die Zeitgeber-Aufloesung seit 2026-08-13 zusaetzlich auf
//!   1 ms an (`timeBeginPeriod` in `main.rs`), was der ersten Fassung noch
//!   fehlte.
//!
//! Die variable Bildgroesse (gemessen 1 bis 12 Pakete) steckt damit von
//! selbst im Zuschnitt: wenige Pakete → wenige oder gar keine Gruppen, grosse
//! Bilder → mehr Gruppen im selben Fenster.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use webrtc::rtp::packet::Packet;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;

/// Anteil des Bildabstands, ueber den die Pakete eines Bildes verteilt werden.
///
/// Nicht der ganze Abstand: das letzte Paket eines Bildes ginge dann erst
/// heraus, wenn das naechste Bild schon fertig ist, und jeder Ausrutscher des
/// Encoders liesse zwei Bilder ineinanderlaufen. 0,8 haelt Abstand zu dieser
/// Kante und nimmt dem Schwall trotzdem seine Spitze.
const ANTEIL: f64 = 0.8;

/// Ab so wenigen Paketen lohnt das Verteilen nicht — ein oder zwei Pakete sind
/// kein Schwall, und jede Wartezeit waere reine Latenz.
const MIN_PAKETE: usize = 3;

/// Kleinster Gruppen-Abstand, den der Verteil-Task je anstrebt. Die Zahl kommt
/// aus der gescheiterten ersten Fassung: unter 2 ms hielt der Zeitgeber die
/// Termine nicht, und ein Termin, der nicht haltbar ist, macht die Verteilung
/// schlechter als den Schwall.
const MIN_ABSTAND: Duration = Duration::from_millis(2);

/// Nach so vielen Bildern eine Zeile mit Soll und Ist — bei 60 fps also etwa
/// alle zwei Sekunden. Haeufiger waere das Log zu, seltener merkt man ein
/// Auseinanderlaufen zu spaet.
const MELDE_ALLE: u64 = 120;

/// Zuschnitt eines Bildes: wieviele Gruppen, wie gross, in welchem Abstand.
/// Reine Rechnung — getrennt, damit die Grenzen pruefbar sind.
fn zuschnitt(n_pakete: usize, fenster: Duration) -> (usize, usize, Duration) {
    let max_gruppen = ((fenster.as_micros() / MIN_ABSTAND.as_micros()).max(1)) as usize;
    let gruppen = n_pakete.min(max_gruppen).max(1);
    let je_gruppe = n_pakete.div_ceil(gruppen);
    let abstand = fenster / gruppen as u32;
    (gruppen, je_gruppe, abstand)
}

/// Einen Block Pakete herausschreiben. `false` heisst „die Spur ist zu" — dann
/// hat der Verteil-Task nichts mehr zu tun und endet. Beide Wege (Schwall und
/// Gruppen) gehen hier durch, damit das Ende der Spur an EINER Stelle steht.
async fn schreibe(track: &TrackLocalStaticRTP, block: &[Packet]) -> bool {
    for p in block {
        if track.write_rtp(p).await.is_err() {
            return false;
        }
    }
    true
}

pub struct Pacer {
    tx: mpsc::UnboundedSender<Vec<Packet>>,
}

impl Pacer {
    /// Startet den Verteil-Task auf der uebergebenen Laufzeit.
    ///
    /// `frame_duration` ist der Soll-Abstand zweier Bilder; daraus ergibt sich,
    /// wieviel Zeit fuer ein Bild zur Verfuegung steht.
    pub fn start(
        rt: &tokio::runtime::Runtime,
        track: Arc<TrackLocalStaticRTP>,
        frame_duration: Duration,
    ) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<Packet>>();
        let fenster = frame_duration.mul_f64(ANTEIL);
        rt.spawn(async move {
            let mut n_bilder = 0u64;
            let mut soll_us = 0u64;
            let mut ist_us = 0u64;
            while let Some(pakete) = rx.recv().await {
                // Faellt der Sender zurueck, weil die Leitung klemmt, liegen
                // mehrere Bilder in der Schlange. Dann NICHT verteilen — sonst
                // wuechse der Rueckstand weiter. Der Schwall ist in diesem Fall
                // das kleinere Uebel.
                //
                // Waehrend einer FERNSTEUERUNG ebenfalls nicht verteilen
                // (Bughunt 2026-08-13): die Verteilung verzoegert das letzte
                // Paket eines Bildes um bis zu ~11 ms — sie gaebe im
                // geschlossenen Kreis genau die Latenz zurueck, die das
                // Senden-bei-Ankunft (`pipeline_hw`) dort gerade einspart.
                // Glaettung ist ein Zuschauer-Tausch, kein Steuer-Tausch.
                let eilig = !rx.is_empty() || crate::remote_input::fern_aktiv();
                let n = pakete.len();
                let begonnen = Instant::now();
                if eilig || n < MIN_PAKETE {
                    if !schreibe(&track, &pakete).await {
                        return;
                    }
                } else {
                    let (_, je_gruppe, abstand) = zuschnitt(n, fenster);
                    // Tatsaechliche Blockzahl, nicht `gruppen`: bei krummen
                    // Teilern (7 Pakete, 6 Gruppen) fasst `chunks` frueher
                    // zusammen, und das Soll im Log soll messen, was wirklich
                    // geplant war.
                    let bloecke = n.div_ceil(je_gruppe);
                    for (i, block) in pakete.chunks(je_gruppe).enumerate() {
                        if i > 0 {
                            // Absoluter Termin gegen den Bild-Anfang: ein
                            // verpasster Termin (Instant liegt in der
                            // Vergangenheit) kehrt sofort zurueck und schiebt
                            // sich NICHT in die folgenden.
                            let termin = begonnen + abstand * i as u32;
                            tokio::time::sleep_until(termin.into()).await;
                        }
                        if !schreibe(&track, block).await {
                            return;
                        }
                    }
                    soll_us += (abstand.as_micros() as u64) * (bloecke as u64 - 1);
                }
                n_bilder += 1;
                ist_us += begonnen.elapsed().as_micros() as u64;
                if n_bilder % MELDE_ALLE == 0 {
                    let je_bild_ms = |us: u64| format!("{:.2}", us as f64 / MELDE_ALLE as f64 / 1000.0);
                    eprintln!(
                        "[whip] Verteilung je Bild: soll {} ms, ist {} ms ({n} Pakete)",
                        je_bild_ms(soll_us),
                        je_bild_ms(ist_us)
                    );
                    soll_us = 0;
                    ist_us = 0;
                }
            }
        });
        Self { tx }
    }

    /// Pakete eines Bildes zum Verteilen abgeben. Blockiert nie.
    pub fn send(&self, pakete: Vec<Packet>) -> anyhow::Result<()> {
        self.tx
            .send(pakete)
            .map_err(|_| anyhow::anyhow!("WHIP-Verteilfaden ist beendet"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Kernzusage des Neubaus: kein Gruppen-Abstand unter [`MIN_ABSTAND`],
    /// kein Paket verloren, und wenige Pakete werden nicht zerhackt.
    #[test]
    fn zuschnitt_haelt_die_grenzen() {
        let fenster = Duration::from_micros(13_333); // 0,8 × 16,7 ms (60 fps)

        // Der gemessene Grossfall: 12 Pakete. Frueher 12 × 1,1 ms (unhaltbar),
        // jetzt 6 Gruppen à 2 im haltbaren Abstand.
        let (gruppen, je_gruppe, abstand) = zuschnitt(12, fenster);
        assert_eq!((gruppen, je_gruppe), (6, 2));
        assert!(abstand >= MIN_ABSTAND);

        // Alle Pakete kommen unter: Gruppen × Gruppengroesse deckt n ab.
        for n in 1..=64 {
            let (g, je, a) = zuschnitt(n, fenster);
            assert!(g * je >= n, "n={n}: {g}×{je} deckt nicht");
            assert!(a >= MIN_ABSTAND || g == 1, "n={n}: Abstand {a:?} unhaltbar");
        }

        // Ein winziges Fenster (hohe Bildrate) erzwingt keine Panik und
        // faellt auf eine einzige Gruppe zurueck.
        let (g, je, _) = zuschnitt(12, Duration::from_micros(500));
        assert_eq!(g, 1);
        assert_eq!(je, 12);
    }
}
