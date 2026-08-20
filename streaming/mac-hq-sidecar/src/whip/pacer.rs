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
//! **Die erste Fassung (bis 2026-08-14) machte es SCHLECHTER und war deshalb
//! AUS.** Sie wartete je PAKET mit `tokio::time::sleep`, und Abstaende unter
//! 2 ms kann der Zeitgeber nicht halten — er rundet grob auf. Soll 7,9 ms je
//! Bild, tatsaechlich 13,1; auf der Leitung 17-20 Ankunftsluecken je Sekunde
//! statt 1,6-1,8 ohne Verteilung. Der eigene Befund von damals benannte den
//! Weg heraus, und genau der ist jetzt gebaut:
//!
//! * **Gruppen statt Einzelpakete.** Die Pakete eines Bildes werden in
//!   hoechstens so viele Gruppen geteilt, wie [`GRUPPEN_ABSTAND`]-Schritte in
//!   das Sendefenster passen. Der Abstand liegt sicher OBERHALB der
//!   Zeitgeber-Aufloesung — kleine Wartezeiten, die der Zeitgeber nicht kann,
//!   kommen gar nicht erst vor.
//! * **Absolute Zeitpunkte** (`sleep_until` gegen den Bild-Start) statt
//!   relativer Schlaefer: ein verschlafener Schritt verschiebt die folgenden
//!   nicht mehr — der Rueckstand kann sich nicht aufschaukeln.
//! * **Das Fenster waechst mit der Paketzahl** (kleine Bilder = wenige
//!   Gruppen = kurzes Fenster) statt fest den ganzen Bildabstand zu belegen —
//!   ein Zwei-Paket-Bild bekommt keine kuenstliche Latenz.
//!
//! Die Fassung hier haelt ihr Soll nachweislich ein — der Test
//! [`tests::verteilung_haelt_ihr_soll`] misst genau die Groesse, an der die
//! erste Fassung scheiterte (Ist gegen Soll), und laeuft bei jedem
//! `cargo test`. Die Gegenmessung ueber die echte Leitung (wie am 2026-07-28)
//! steht noch aus; `PULSE_WHIP_PACING=0` ist dafuer der Vergleichs-Schalter.
//!
//! **Die Windows-Schwester weicht bewusst ab** (`win-hq-sidecar/src/whip/
//! pacer.rs`, dort 2026-08-13 unabhaengig nach denselben Lehren gebaut):
//! gleiches Prinzip, anderer Zuschnitt (dort `zuschnitt` mit Fenster/Gruppen-
//! Teilung, hier fester [`GRUPPEN_ABSTAND`] — kuerzeres Fenster fuer kleine
//! Bilder). Wer einen Pacer-Fehler behebt, sieht sich BEIDE an.
//!
//! **Kopie aus `linux-hq-sidecar/src/whip/` (2026-08-20).** Nicht wortgleich —
//! die crate-eigenen Rueckgriffe unterscheiden sich. Was hier an der LOGIK
//! geaendert wird, gehoert dort nachgetragen; `tests/zwillinge.rs` deckt nur
//! `av1.rs` und `sdp.rs` ab, diese Datei nicht.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::Instant;
use webrtc::rtp::packet::Packet;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;

/// Anteil des Bildabstands, der als Sendefenster zur Verfuegung steht.
///
/// Nicht der ganze Abstand: das letzte Paket eines Bildes ginge dann erst
/// heraus, wenn das naechste Bild schon fertig ist, und jeder Ausrutscher des
/// Encoders liesse zwei Bilder ineinanderlaufen. 0,8 haelt Abstand zu dieser
/// Kante und nimmt dem Schwall trotzdem seine Spitze.
const ANTEIL: f64 = 0.8;

/// Abstand zwischen zwei Paket-Gruppen.
///
/// Bewusst deutlich ueber der Aufloesung des tokio-Zeitgebers (~1 ms):
/// die erste Fassung scheiterte daran, dass sie Abstaende UNTER dieser
/// Aufloesung anforderte und der Zeitgeber grob aufrundete. Feiner verteilen
/// als der Zeitgeber kann heisst, ein neues unregelmaessiges Muster zu bauen.
const GRUPPEN_ABSTAND: Duration = Duration::from_micros(2500);

/// Ab so wenigen Paketen lohnt das Verteilen nicht — ein oder zwei Pakete sind
/// kein Schwall, und jede Wartezeit waere reine Latenz.
const MIN_PAKETE: usize = 3;

/// Nach so vielen Bildern eine Zeile mit Soll und Ist — bei 60 fps also etwa
/// alle zwei Sekunden. Haeufiger waere das Log zu, seltener merkt man ein
/// Auseinanderlaufen zu spaet.
const MELDE_ALLE: u64 = 120;

/// In wie viele Gruppen `n` Pakete zerfallen: hoechstens so viele, wie
/// `GRUPPEN_ABSTAND`-Schritte ins Fenster passen, nie mehr als Pakete da sind,
/// nie weniger als eine.
fn gruppenzahl(n: usize, fenster: Duration) -> usize {
    let schritte = (fenster.as_secs_f64() / GRUPPEN_ABSTAND.as_secs_f64()).floor() as usize;
    (schritte + 1).min(n).max(1)
}

/// Die Pakete eines Bildes in Gruppen ueber das Fenster verteilen. Absolute
/// Zeitpunkte gegen `start` — ein verschlafener Schritt holt sich nicht in
/// die folgenden fort. Mit `fenster == ZERO` degeneriert das zu EINER Gruppe
/// ohne Warten — der Schwall-Schnellweg geht deshalb durch dieselbe Schleife
/// statt sie zu duplizieren. `false` heisst „die Spur ist zu": der
/// Verteil-Task hat dann nichts mehr zu tun.
async fn verteile(
    track: &TrackLocalStaticRTP,
    pakete: Vec<Packet>,
    fenster: Duration,
    start: Instant,
) -> bool {
    let n = pakete.len();
    let gruppen = gruppenzahl(n, fenster);
    // Gruppengroessen so gleichmaessig wie moeglich (erst die groesseren).
    let basis = n / gruppen;
    let rest = n % gruppen;
    let mut iter = pakete.into_iter();
    for g in 0..gruppen {
        if g > 0 {
            tokio::time::sleep_until(start + GRUPPEN_ABSTAND * g as u32).await;
        }
        let groesse = basis + usize::from(g < rest);
        for p in iter.by_ref().take(groesse) {
            if track.write_rtp(&p).await.is_err() {
                return false;
            }
        }
    }
    true
}

pub struct Pacer {
    tx: mpsc::UnboundedSender<Vec<Packet>>,
}

impl Pacer {
    /// Startet den Verteil-Faden auf der uebergebenen Laufzeit.
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
            // Soll gegen Ist je Bild, gemeldet alle MELDE_ALLE Bilder — die
            // Zahl, an der die erste Fassung ihr Scheitern gezeigt hat.
            let mut n_bilder = 0u64;
            let mut soll_us = 0u64;
            let mut ist_us = 0u64;
            while let Some(pakete) = rx.recv().await {
                // Faellt der Sender zurueck, weil die Leitung klemmt, liegen
                // mehrere Bilder in der Schlange. Dann NICHT verteilen — sonst
                // wuechse der Rueckstand weiter. Der Schwall ist in diesem Fall
                // das kleinere Uebel.
                let eilig = !rx.is_empty();
                let n = pakete.len();
                let fenster_bild =
                    if eilig || n < MIN_PAKETE { Duration::ZERO } else { fenster };
                let begonnen = Instant::now();
                if !verteile(&track, pakete, fenster_bild, begonnen).await {
                    return;
                }
                n_bilder += 1;
                soll_us += (GRUPPEN_ABSTAND * (gruppenzahl(n, fenster_bild) - 1) as u32)
                    .as_micros() as u64;
                ist_us += begonnen.elapsed().as_micros() as u64;
                if n_bilder % MELDE_ALLE == 0 {
                    let je_bild_ms = |us: u64| format!("{:.2}", us as f64 / MELDE_ALLE as f64 / 1000.0);
                    tracing::info!(
                        target: "whip",
                        soll_ms = je_bild_ms(soll_us),
                        ist_ms = je_bild_ms(ist_us),
                        pakete = n,
                        "Verteilung je Bild"
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

    fn pakete(n: usize) -> Vec<Packet> {
        (0..n).map(|_| Packet::default()).collect()
    }

    /// Eine ungebundene Spur schreibt ins Leere und eignet sich damit als
    /// Zeit-Messstand ohne Netz.
    fn leere_spur() -> TrackLocalStaticRTP {
        TrackLocalStaticRTP::new(Default::default(), "t".into(), "t".into())
    }

    /// Die Gruppenzahl haelt sich an Fenster UND Paketzahl.
    #[test]
    fn gruppenzahl_ist_beschraenkt() {
        let fenster_60fps = Duration::from_secs_f64(1.0 / 60.0).mul_f64(ANTEIL); // 13,3 ms
        assert_eq!(gruppenzahl(30, fenster_60fps), 6, "13,3 ms / 2,5 ms → 5 Schritte + Start");
        assert_eq!(gruppenzahl(4, fenster_60fps), 4, "nie mehr Gruppen als Pakete");
        assert_eq!(gruppenzahl(1, fenster_60fps), 1);
        let fenster_144fps = Duration::from_secs_f64(1.0 / 144.0).mul_f64(ANTEIL); // 5,6 ms
        assert_eq!(gruppenzahl(30, fenster_144fps), 3, "kurzes Fenster, wenige Gruppen");
    }

    /// **Die Messung, an der die erste Fassung gescheitert ist**, als Test:
    /// Soll 7,9 ms je Bild, Ist 13,1 — plus zwei Drittel. Die Fassung mit
    /// absoluten Zeitpunkten muss ihr Soll bis auf den einen Aufwach-Ruckler
    /// des Zeitgebers halten. Grosszuegige 3 ms Toleranz, damit der Test auf
    /// einer belasteten CI-Maschine nicht flattert — der alte Fehler lag mit
    /// +5,2 ms VERTEILUNGSBEDINGT weit darueber, um den geht es.
    #[test]
    fn verteilung_haelt_ihr_soll() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            let track = leere_spur();
            let fenster = Duration::from_secs_f64(1.0 / 60.0).mul_f64(ANTEIL);
            // 12 Pakete = das obere Ende der 2026-07-28 gemessenen Bildgroessen.
            let start = Instant::now();
            assert!(verteile(&track, pakete(12), fenster, start).await);
            let ist = start.elapsed();
            let soll = GRUPPEN_ABSTAND * (gruppenzahl(12, fenster) - 1) as u32;
            assert!(ist >= soll, "schneller als das Soll hiesse: nicht verteilt");
            assert!(
                ist < soll + Duration::from_millis(3),
                "Soll {soll:?}, Ist {ist:?} — die Verteilung verfehlt ihr eigenes Ziel \
                 (der Fehler der ersten Fassung)"
            );
        });
    }
}
