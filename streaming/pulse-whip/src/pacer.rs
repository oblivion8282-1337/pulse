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
//! **Kein Test haelt die beiden zusammen.** Seit `av1.rs` und `sdp.rs` am
//! 2026-08-20 gemeinsam in `pulse-whip` liegen, sind `pacer.rs` und `mod.rs`
//! die beiden LETZTEN doppelt vorliegenden Dateien des Sendewegs. Der
//! Pacer ist dabei der Sonderfall, der auch kuenftig doppelt bleibt: die
//! Windows-Fassung weicht absichtlich ab (s. oben), und welcher Zuschnitt
//! besser ist, ist nicht gemessen.

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

/// Wohin die Soll/Ist-Zeile geht.
///
/// Ein Rueckruf statt eines festen `tracing::info!`, weil die beiden Sidecars
/// verschieden protokollieren: Linux ueber `tracing`, macOS ueber `eprintln!`
/// (dort laeuft kein Subscriber). Die REchnung ist identisch — nur die Ausgabe
/// nicht, und daran soll die gemeinsame Fassung nicht scheitern.
///
/// Argumente: Soll-Millisekunden je Bild, Ist-Millisekunden je Bild, Pakete.
pub type Melder = fn(f64, f64, usize);

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
        melde: Melder,
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
                    let je_bild_ms = |us: u64| us as f64 / MELDE_ALLE as f64 / 1000.0;
                    melde(je_bild_ms(soll_us), je_bild_ms(ist_us), n);
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
    ///
    /// **Unter Windows uebersprungen, und zwar bewusst nicht mit weiterer
    /// Toleranz.** Gemessen am 2026-08-22 auf der Windows-Maschine: von drei
    /// Laeufen waren zwei rot (Ist 28,0 und 16,1 ms bei Soll 12,5), einer
    /// gruen — der Zeitgeber dort weckt vielfach grobkoerniger als unter Linux
    /// und macOS, ohne dass die Verteilung etwas falsch macht. Der Test ist
    /// dort also nicht rot, sondern FLATTRIG, was schlimmer ist: er zeigt
    /// abwechselnd beides. Eine Toleranz, die das aufnimmt,
    /// muesste bei etwa 20 ms liegen und waere damit groesser als das Soll
    /// selbst: der alte Fehler (Ist 20,8 bei Soll 12,5) laege dann INNERHALB
    /// der Toleranz. Der Test liefe also weiter, koennte aber genau das nicht
    /// mehr finden, wofuer es ihn gibt — schlechter als ein sichtbar
    /// uebersprungener Test.
    ///
    /// Das ist hier vertretbar, weil **Windows diesen Pacer gar nicht
    /// benutzt**: es faehrt seinen eigenen (`win-hq-sidecar/src/whip/pacer.rs`,
    /// anderer Zuschnitt des Sendefensters, s. Modulkopf von `lib.rs`) und
    /// bindet aus dieser Kiste nur `h264` ein. Geprueft wird die Verteilung
    /// dort, wo sie laeuft: auf Linux und macOS. Sollte Windows je auf diesen
    /// Pacer wechseln, gehoert der Test wieder scharf gestellt — dann aber mit
    /// einem Zeitgeber feiner Aufloesung, nicht mit weiterer Toleranz.
    #[test]
    #[cfg_attr(
        windows,
        ignore = "Windows weckt zu grobkoernig (16-28 ms bei 12,5 ms Soll) und faehrt \
                  ohnehin seinen eigenen Pacer"
    )]
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
