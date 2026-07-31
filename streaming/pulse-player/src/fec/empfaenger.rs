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
    /// Gruppen, die endgueltig NICHT repariert wurden.
    ///
    /// **Bis zum 2026-07-31 zaehlte dieses Feld nur Rechen- und
    /// Parse-Fehler** — also Faelle, die im Betrieb praktisch nie auftreten.
    /// Der eigentliche Versagensfall von XOR, zwei Loecher in derselben
    /// Gruppe, fiel durch `versuchen() -> false` still heraus. Das Feld stand
    /// deshalb in acht Messlaeufen auf 0, auch in einem Lauf mit gesetztem
    /// Buendelverlust, in dem die Paritaet nachweislich versagte (21
    /// Vollbild-Anforderungen gegen 2 mit doppelter Paritaet). Auf dieser
    /// blinden Null beruhte die Aussage „XOR scheitert nie, Reed-Solomon
    /// loest ein Problem, das es nicht gibt".
    pub unreparierbar: u64,
    /// Gruppen, die beim ERSTEN Versuch mehr als ein Loch hatten.
    ///
    /// Getrennt von `unreparierbar`, weil beides verschiedene Fragen
    /// beantwortet: hier steht, wie oft XOR an seine Grenze kam — auch wenn
    /// ein Nachzuegler die Gruppe spaeter doch noch loesbar machte. Die
    /// Differenz zu `unreparierbar` ist genau das, was das Nachfassen
    /// gerettet hat.
    pub mehrfach_loch: u64,
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
            mehrfach_loch: 0,
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
        // Hier und nur hier steht fest, dass XOR an seine Grenze kam: die
        // Gruppe hat beim ersten Versuch mehr als ein Loch. Ein Nachzuegler
        // kann sie spaeter noch loesen — deshalb ist das nicht dasselbe wie
        // `unreparierbar`, sondern die Obergrenze dafuer.
        self.mehrfach_loch += 1;
        // Noch nicht loesbar — aufheben, vielleicht kommt das zweite Paket noch.
        if self.wartend.len() >= WARTENDE_PARITAET {
            // `keys().next()` einer HashMap ist NICHT die aelteste, sondern
            // eine beliebige — fuer die Speicherbegrenzung gleichgueltig.
            // Entscheidend ist, dass sie hier ENDGUELTIG verlorengeht: dieser
            // Zweig ist der einzige Ort, an dem eine ungeloeste Gruppe
            // verschwindet, und genau deshalb wird sie hier gezaehlt.
            if let Some(&beliebige) = self.wartend.keys().next() {
                self.wartend.remove(&beliebige);
                self.unreparierbar += 1;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fec::flexfec03::tests::{medienpaket, paritaet_bauen};

    const SSRC: u32 = 0xDEAD_BEEF;
    const BASIS: u16 = 1000;

    /// Fuenf Medienpakete und die Paritaet darueber — wie sie pion erzeugt.
    fn gruppe() -> (Vec<Medienpaket>, Vec<u8>) {
        let medien: Vec<_> = (0..5)
            .map(|i| medienpaket(BASIS + i, 9000, SSRC, &[i as u8; 40]))
            .collect();
        let paritaet = paritaet_bauen(&medien, SSRC, BASIS);
        (medien, paritaet)
    }

    /// **Der Fall, den der Zaehler bis zum 2026-07-31 nicht sehen konnte.**
    /// Zwei Loecher in einer Gruppe sind die Grenze von XOR; bis dahin fiel
    /// das durch `versuchen() -> false` still heraus, und `unreparierbar`
    /// blieb auf 0. Auf dieser Null beruhte die Aussage „XOR scheitert nie".
    #[tokio::test]
    async fn zwei_loecher_werden_als_grenzfall_gezaehlt() {
        let (medien, paritaet) = gruppe();
        let (tx, _rx) = mpsc::channel(16);
        let mut e = Empfaenger::neu(Codec::Av1, 90_000, tx);

        // Nur drei der fuenf ankommen lassen — 1003 und 1004 fehlen.
        for p in medien.iter().take(3) {
            e.medienpaket(p.sequenz, p.bytes.clone()).await;
        }
        e.paritaetspaket(&paritaet).await;

        assert_eq!(e.mehrfach_loch, 1, "zwei Loecher muessen gezaehlt werden");
        assert_eq!(e.repariert, 0, "mit zwei Loechern kann XOR nichts ausrichten");
    }

    /// Die Gegenprobe: EIN Loch ist der Normalfall und darf den Grenzfall-
    /// Zaehler nicht erhoehen — sonst waere er als Diagnose wertlos.
    #[tokio::test]
    async fn ein_loch_wird_repariert_und_nicht_als_grenzfall_gezaehlt() {
        let (medien, paritaet) = gruppe();
        let (tx, mut rx) = mpsc::channel(16);
        let mut e = Empfaenger::neu(Codec::Av1, 90_000, tx);

        for p in medien.iter().take(4) {
            e.medienpaket(p.sequenz, p.bytes.clone()).await;
        }
        e.paritaetspaket(&paritaet).await;

        assert_eq!(e.repariert, 1);
        assert_eq!(e.mehrfach_loch, 0);
        assert_eq!(e.unreparierbar, 0);
        assert!(rx.try_recv().is_ok(), "das reparierte Paket muss eingespeist werden");
    }

    /// Das Nachfassen: kommt eines der beiden fehlenden Pakete verspaetet an,
    /// wird die Gruppe doch noch loesbar. `mehrfach_loch` bleibt trotzdem bei
    /// 1 — es zaehlt, dass XOR an der Grenze WAR, nicht dass es verlor.
    #[tokio::test]
    async fn nachzuegler_loest_die_gruppe_der_grenzfall_bleibt_gezaehlt() {
        let (medien, paritaet) = gruppe();
        let (tx, mut rx) = mpsc::channel(16);
        let mut e = Empfaenger::neu(Codec::Av1, 90_000, tx);

        for p in medien.iter().take(3) {
            e.medienpaket(p.sequenz, p.bytes.clone()).await;
        }
        e.paritaetspaket(&paritaet).await;
        assert_eq!(e.mehrfach_loch, 1);
        assert_eq!(e.repariert, 0);

        // 1003 trifft verspaetet ein — jetzt fehlt nur noch 1004.
        e.medienpaket(medien[3].sequenz, medien[3].bytes.clone()).await;

        assert_eq!(e.repariert, 1, "die Gruppe ist jetzt loesbar");
        assert_eq!(e.mehrfach_loch, 1, "der Grenzfall bleibt gezaehlt");
        assert!(rx.try_recv().is_ok());
    }
}
