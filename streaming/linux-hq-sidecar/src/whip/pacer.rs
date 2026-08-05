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
//! **Wie.** Ein eigener Faden auf der WHIP-Laufzeit nimmt die fertigen Pakete
//! eines Bildes entgegen und schreibt sie ueber einen Teil des Bildabstands
//! verteilt heraus. Der Encode-Faden gibt sie nur ab und laeuft weiter — er
//! darf unter keinen Umstaenden warten, sonst bremst die Verteilung die
//! Aufnahme aus.
//!
//! **AUS als Vorgabe — diese Fassung macht es SCHLECHTER.** `PULSE_WHIP_PACING=1`
//! schaltet sie ein. Gemessen am 2026-07-28 ueber die echte Leitung, vier Laeufe
//! abwechselnd (Ankunftsluecken ueber 25 ms je Sekunde):
//!
//! | | Lauf 1 | Lauf 2 | Lauf 3 | Lauf 4 |
//! |---|---|---|---|---|
//! | ohne Verteilung | 1,6 | — | 1,8 | — |
//! | mit Verteilung | — | 19,6 | — | 16,9 |
//!
//! Die Ursache ist gemessen, nicht vermutet: die Verteilung verfehlt ihr
//! eigenes Ziel um zwei Drittel. Soll 7,9 ms je Bild, tatsaechlich 13,1 —
//! `tokio::time::sleep` kann Abstaende unter 2 ms nicht halten und rundet grob
//! auf. Damit entsteht statt eines gleichmaessigen Stroms ein neues,
//! unregelmaessiges Muster.
//!
//! Zwei Dinge, die dabei aufgefallen sind und die eine bessere Fassung
//! beruecksichtigen muss:
//!
//! * **Die Bilder sind sehr verschieden gross** (gemessen 1 bis 12 Pakete, je
//!   nachdem ob sich auf dem Bildschirm etwas bewegt). Ein fester Anteil des
//!   Bildabstands passt deshalb nicht auf alle.
//! * **Warten je Paket ist der falsche Weg.** Wer das noch einmal angeht,
//!   braucht absolute Zeitpunkte (`sleep_until`) oder einen eigenen Faden mit
//!   feinerem Zeitgeber, nicht `sleep` in der Schleife.

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

/// Nach so vielen Bildern eine Zeile mit Soll und Ist — bei 60 fps also etwa
/// alle zwei Sekunden. Haeufiger waere das Log zu, seltener merkt man ein
/// Auseinanderlaufen zu spaet.
const MELDE_ALLE: u64 = 120;

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
            // Was die Verteilung WIRKLICH braucht, gegen das, was sie brauchen
            // soll. `tokio::time::sleep` kann nicht beliebig fein warten; ist
            // der Sollabstand kleiner als die Aufloesung des Zeitgebers, dauert
            // ein Bild laenger als sein Abstand, der Rueckstand waechst — und
            // die Verteilung erzeugt genau das Ruckeln, das sie verhindern soll.
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
                let abstand = if eilig || n < MIN_PAKETE {
                    Duration::ZERO
                } else {
                    fenster / n as u32
                };
                let begonnen = Instant::now();
                for p in pakete {
                    if track.write_rtp(&p).await.is_err() {
                        return; // Spur ist zu, der Faden hat nichts mehr zu tun
                    }
                    if !abstand.is_zero() {
                        tokio::time::sleep(abstand).await;
                    }
                }
                n_bilder += 1;
                soll_us += (abstand.as_micros() as u64) * n as u64;
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
