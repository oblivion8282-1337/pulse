//! Repariert verlorene Medienpakete aus der Paritaet und speist sie ein.
//!
//! **Der Weg der Reparatur ist derselbe wie der eines echten Pakets** — sie
//! geht in den Jitter-Puffer, nicht am Zusammensetzer vorbei. Das ist keine
//! Bequemlichkeit, sondern Absicht: `jitter.rs::push` prueft die
//! Sequenznummern und meldet Luecken, und genau diese Pruefung ist am
//! 2026-07-28 eingebaut worden, weil der AV1-Zusammensetzer ein fehlendes
//! MITTLERES Fragment prinzipiell nicht erkennen kann. Ein reparierter Strom,
//! der daran vorbeigeht, waere die Rueckkehr genau dieses Fehlers.
//!
//! **Zu spaet ist gefahrlos.** Kommt die Reparatur, nachdem der Puffer die
//! Luecke bereits gemeldet hat, verwirft `push` sie mit `seq < next` als
//! umsortiert. Sie richtet dann keinen Schaden an — sie nuetzt nur nichts.
//! Gemessen (2026-07-29): die Paritaet laeuft ihrer Gruppe im Median 0,2 ms
//! nach, zu 99 % unter 18,5 ms; bei 100 ms Puffergeduld ist sie also fast
//! immer rechtzeitig.
//!
//! **Nur ein fehlendes Paket je Gruppe.** Mehr kann XOR nicht. Ein
//! Paritaetspaket, dessen Gruppe zwei Loecher hat, wird trotzdem kurz
//! aufgehoben: trifft eines der beiden verspaetet ein, wird die Gruppe
//! loesbar. Ohne dieses Nachfassen ginge jede Umsortierung als
//! unreparierbar durch.

use std::collections::{BTreeMap, HashMap};

use tokio::sync::mpsc;
use webrtc::rtp::packet::Packet;
use webrtc::util::Unmarshal;

use super::flexfec03::{kopf_lesen, zurueckrechnen, Medienpaket, Paritaetskopf};
use crate::whep::{Codec, RtpArrival};

/// Wie viele Medienpakete vorgehalten werden, um Gruppen aufzuloesen.
const VORRAT: usize = 512;

/// Wie viele noch unloesbare Paritaetspakete aufgehoben werden. Jedes deckt
/// fuenf Medienpakete ab; 64 reichen weit ueber jede Umsortierung hinaus, die
/// nicht ohnehin ein Totalausfall waere.
const WARTENDE_PARITAET: usize = 64;

pub struct Empfaenger {
    medien: BTreeMap<u16, Vec<u8>>,
    /// Noch nicht aufloesbare Paritaetspakete, nach ihrer Basis-Sequenznummer.
    wartend: HashMap<u16, (Paritaetskopf, Vec<u8>)>,
    codec: Codec,
    clock_rate: u32,
    tx: mpsc::Sender<RtpArrival>,
    pub repariert: u64,
    pub unreparierbar: u64,
    pub zu_spaet: u64,
}

impl Empfaenger {
    pub fn neu(codec: Codec, clock_rate: u32, tx: mpsc::Sender<RtpArrival>) -> Self {
        Self {
            medien: BTreeMap::new(),
            wartend: HashMap::new(),
            codec,
            clock_rate,
            tx,
            repariert: 0,
            unreparierbar: 0,
            zu_spaet: 0,
        }
    }

    /// Ein echt empfangenes Medienpaket ablegen und wartende Paritaet erneut
    /// versuchen — ein spaet eingetroffenes Paket kann eine Gruppe loesbar
    /// machen, die vorher zwei Loecher hatte.
    pub async fn medienpaket(&mut self, sequenz: u16, bytes: Vec<u8>) {
        self.medien.insert(sequenz, bytes);
        while self.medien.len() > VORRAT {
            let Some(&aeltester) = self.medien.keys().next() else { break };
            self.medien.remove(&aeltester);
        }
        self.wartende_pruefen().await;
    }

    /// Ein Paritaetspaket verarbeiten.
    pub async fn paritaetspaket(&mut self, nutzlast: &[u8]) {
        let Ok(kopf) = kopf_lesen(nutzlast) else {
            return;
        };
        if self.versuchen(&kopf, nutzlast).await {
            return;
        }
        // Noch nicht loesbar — aufheben, vielleicht kommt das zweite Paket noch.
        if self.wartend.len() >= WARTENDE_PARITAET {
            if let Some(&aelteste) = self.wartend.keys().next() {
                self.wartend.remove(&aelteste);
            }
        }
        self.wartend.insert(kopf.basis_sequenz, (kopf, nutzlast.to_vec()));
    }

    async fn wartende_pruefen(&mut self) {
        let offen: Vec<u16> = self.wartend.keys().copied().collect();
        for basis in offen {
            let Some((kopf, nutzlast)) = self.wartend.remove(&basis) else {
                continue;
            };
            if !self.versuchen(&kopf, &nutzlast).await {
                self.wartend.insert(basis, (kopf, nutzlast));
            }
        }
    }

    /// Versucht die Gruppe zu schliessen. `true`, wenn sie erledigt ist —
    /// entweder repariert oder gar nicht erst luecken­haft.
    async fn versuchen(&mut self, kopf: &Paritaetskopf, nutzlast: &[u8]) -> bool {
        let fehlend: Vec<u16> = kopf
            .geschuetzte_sequenzen
            .iter()
            .copied()
            .filter(|s| !self.medien.contains_key(s))
            .collect();

        match fehlend.len() {
            0 => true,
            1 => {
                let vorhanden: Vec<Medienpaket> = kopf
                    .geschuetzte_sequenzen
                    .iter()
                    .filter(|s| **s != fehlend[0])
                    .filter_map(|s| {
                        self.medien
                            .get(s)
                            .map(|b| Medienpaket { sequenz: *s, bytes: b.clone() })
                    })
                    .collect();

                let Ok(bytes) = zurueckrechnen(kopf, nutzlast, &vorhanden, fehlend[0]) else {
                    self.unreparierbar += 1;
                    return true;
                };
                let mut roh = bytes.as_slice();
                let Ok(packet) = Packet::unmarshal(&mut roh) else {
                    self.unreparierbar += 1;
                    return true;
                };

                // In den eigenen Vorrat, damit weitere Paritaetspakete dieses
                // Paket als vorhanden sehen — sonst gilt es fuer die
                // ueberlappende Gruppe weiter als Loch.
                self.medien.insert(fehlend[0], bytes);

                let arrival = RtpArrival {
                    codec: self.codec,
                    clock_rate: self.clock_rate,
                    packet,
                    arrived: std::time::Instant::now(),
                };
                if self.tx.send(arrival).await.is_err() {
                    self.zu_spaet += 1;
                } else {
                    self.repariert += 1;
                }
                true
            }
            _ => false,
        }
    }
}
