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

use std::collections::{HashMap, VecDeque};

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

/// Die zuletzt gesehenen Medienpakete, nach Sequenznummer nachschlagbar.
///
/// **Warum eine eigene Struktur und keine `BTreeMap<u16, _>` mehr.** Genau das
/// stand hier bis zum 2026-08-07, und die Verdraengung („waehrend zu viele
/// drin sind, das kleinste hinaus") verwechselte damit *kleinste
/// Sequenznummer* mit *aeltestem Paket*. Beides faellt auseinander, sobald die
/// 16-bit-Sequenz umlaeuft — bei 455 Videopaketen je Sekunde alle gut zwei
/// Minuten, bei hoeherer Bitrate frueher.
///
/// Die Folge war kein Randfall, sondern ein Totalausfall: nach dem Umlauf ist
/// der Vorrat vollstaendig mit hohen Nummern belegt, jedes frisch eingetroffene
/// Paket ist das kleinste und fliegt im selben Zug wieder hinaus. Der
/// Zusammensetzer der Paritaet findet danach kein einziges Paket seiner Gruppe
/// mehr, jede Gruppe sieht lueckenhaft aus, und die Vorwaertskorrektur
/// repariert bis zum naechsten Neustart des Stroms **nichts**. Sichtbar ist das
/// nirgends: `fec_repariert` faellt auf null, und das sieht aus wie eine
/// ruhige Leitung.
///
/// Die Ordnung wird gar nicht gebraucht (nur Nachschlagen und Einfuegen), also
/// haelt eine Warteschlange das Alter und eine Karte den Inhalt. Damit haengt
/// die Verdraengung an der Ankunftsreihenfolge, und die kennt keinen Umlauf.
#[derive(Default)]
struct Vorrat {
    inhalt: HashMap<u16, Vec<u8>>,
    /// Sequenznummern in der Reihenfolge ihres Eintreffens, aeltestes vorn.
    alter: VecDeque<u16>,
}

impl Vorrat {
    fn hat(&self, sequenz: u16) -> bool {
        self.inhalt.contains_key(&sequenz)
    }

    fn holen(&self, sequenz: u16) -> Option<&Vec<u8>> {
        self.inhalt.get(&sequenz)
    }

    /// Ablegen und auf [`VORRAT`] begrenzen.
    ///
    /// Ein erneut eintreffendes Paket (Nachlieferung, Duplikat) ueberschreibt
    /// nur den Inhalt und wandert NICHT ein zweites Mal in die Alterskette —
    /// sonst stuende dieselbe Nummer mehrfach darin und die Kette liefe
    /// gegenueber der Karte auseinander.
    fn ablegen(&mut self, sequenz: u16, bytes: Vec<u8>) {
        if self.inhalt.insert(sequenz, bytes).is_none() {
            self.alter.push_back(sequenz);
        }
        while self.alter.len() > VORRAT {
            if let Some(alt) = self.alter.pop_front() {
                self.inhalt.remove(&alt);
            }
        }
    }

    #[cfg(test)]
    fn anzahl(&self) -> usize {
        self.inhalt.len()
    }
}

pub struct Empfaenger {
    medien: Vorrat,
    /// Noch nicht aufloesbare Paritaetspakete, nach ihrer Basis-Sequenznummer.
    wartend: HashMap<u16, (Paritaetskopf, Vec<u8>)>,
    codec: Codec,
    clock_rate: u32,
    tx: mpsc::Sender<RtpArrival>,
    pub repariert: u64,
    /// Paritaetspakete, die sich nicht anwenden liessen — Rechenfehler beim
    /// Zurueckrechnen oder ein Ergebnis, das kein gueltiges RTP-Paket ergab.
    ///
    /// **Enge Bedeutung, und das ist Absicht.** Am 2026-07-31 wurde dieses
    /// Feld einmal auf „alles, was nicht repariert wurde" erweitert. Es meldete
    /// daraufhin 11719 bei 8158 Gruppen — waehrend dem Jitter-Puffer im selben
    /// Lauf ganze 14 Pakete endgueltig fehlten. Die Zahl war also kein Mass
    /// fuer Verlust, sondern eines fuer ueberfluessige Paritaet, und trug
    /// trotzdem einen Namen, der Verlust behauptete. Ein zweites Mal derselbe
    /// Fehler in derselben Datei.
    pub unreparierbar: u64,
    /// Paritaetspakete, die aus dem Wartepuffer verdraengt wurden, ohne je
    /// etwas repariert zu haben.
    ///
    /// **Misst ueberfluessige Paritaet, NICHT verlorene Pakete.** Ein hoher
    /// Wert heisst, dass die Nachforderung schneller war — die Luecke war
    /// schon geschlossen, als die Paritaet zum Zug kam. Was tatsaechlich
    /// verlorenblieb, steht in `packets_lost` des Jitter-Puffers, nirgends
    /// sonst.
    pub verworfen: u64,
    /// Gruppen, die beim ERSTEN Versuch mehr als ein Loch hatten — die Grenze
    /// von XOR.
    ///
    /// **Das ist die Zahl, die bis zum 2026-07-31 fehlte** und deren Fehlen
    /// die Aussage „XOR scheitert nie, Reed-Solomon loest ein Problem, das es
    /// nicht gibt" getragen hat. Sie ist eine Obergrenze: ein verspaeteter
    /// Nachzuegler kann die Gruppe hinterher doch noch loesbar machen, und
    /// dann taucht sie zusaetzlich in `repariert` auf.
    pub mehrfach_loch: u64,
    pub zu_spaet: u64,
}

impl Empfaenger {
    pub fn neu(codec: Codec, clock_rate: u32, tx: mpsc::Sender<RtpArrival>) -> Self {
        Self {
            medien: Vorrat::default(),
            wartend: HashMap::new(),
            codec,
            clock_rate,
            tx,
            repariert: 0,
            unreparierbar: 0,
            verworfen: 0,
            mehrfach_loch: 0,
            zu_spaet: 0,
        }
    }

    /// Ein echt empfangenes Medienpaket ablegen und wartende Paritaet erneut
    /// versuchen — ein spaet eingetroffenes Paket kann eine Gruppe loesbar
    /// machen, die vorher zwei Loecher hatte.
    pub async fn medienpaket(&mut self, sequenz: u16, bytes: Vec<u8>) {
        self.medien.ablegen(sequenz, bytes);
        self.wartende_pruefen(sequenz).await;
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
        // kann sie spaeter noch loesen — die Zahl ist deshalb eine Obergrenze
        // und KEIN Mass fuer Verlust.
        self.mehrfach_loch += 1;
        // Noch nicht loesbar — aufheben, vielleicht kommt das zweite Paket noch.
        if self.wartend.len() >= WARTENDE_PARITAET {
            // `keys().next()` einer HashMap ist NICHT die aelteste, sondern
            // eine beliebige — fuer die Speicherbegrenzung gleichgueltig.
            // Hier verschwindet eine ungeloeste Gruppe endgueltig; gezaehlt
            // wird das als `verworfen`, nicht als Verlust: meist war die
            // Luecke laengst per Nachforderung geschlossen.
            if let Some(&beliebige) = self.wartend.keys().next() {
                self.wartend.remove(&beliebige);
                self.verworfen += 1;
            }
        }
        self.wartend.insert(kopf.basis_sequenz, (kopf, nutzlast.to_vec()));
    }

    /// Wartende Paritaet erneut versuchen, nachdem `neu` eingetroffen ist.
    ///
    /// **Nur die Gruppen, die `neu` ueberhaupt abdecken.** Eine Gruppe, deren
    /// Maske diese Sequenznummer nicht enthaelt, kann durch ihr Eintreffen
    /// nicht loesbar werden — `versuchen` filtert ausschliesslich ueber
    /// `geschuetzte_sequenzen`, das ist keine Heuristik, sondern die
    /// vollstaendige Bedingung.
    ///
    /// **Warum das zaehlt.** Bis zum 2026-08-07 lief hier bei JEDEM
    /// ankommenden Videopaket die volle Liste durch: bis zu
    /// [`WARTENDE_PARITAET`] Gruppen, je mit einer eigenen Zuteilung fuer die
    /// Lochliste und zehn Nachschlagevorgaengen, dazu ein Entnehmen und
    /// Wiedereinfuegen aus der Karte. Der Aufwand fiel also mit dem Produkt aus
    /// Paketrate und Wartestand an — und der Wartestand fuellt sich genau
    /// dann, wenn die Leitung schlecht ist. Gemessen (drei Laeufe, Test
    /// `kosten_je_medienpaket_leer_gegen_voll`): 12,4 µs je Paket bei vollem
    /// Wartestand gegen 0,12 µs bei leerem, also Faktor 100.
    async fn wartende_pruefen(&mut self, neu: u16) {
        let betroffen: Vec<u16> = self
            .wartend
            .iter()
            .filter(|(_, (kopf, _))| kopf.geschuetzte_sequenzen.contains(&neu))
            .map(|(basis, _)| *basis)
            .collect();
        let repariert_vorher = self.repariert;
        self.versuchen_alle(betroffen).await;

        // Wurde etwas repariert, liegt jetzt ein weiteres Paket im Vorrat, und
        // das kann eine ANDERE Gruppe loesbar machen. Dann einmal vollstaendig
        // nachfassen — so wie es vorher bei jedem Paket geschah, jetzt aber nur
        // im seltenen Fall, dass wirklich etwas passiert ist.
        if self.repariert != repariert_vorher {
            let offen: Vec<u16> = self.wartend.keys().copied().collect();
            self.versuchen_alle(offen).await;
        }
    }

    /// Die genannten Gruppen durchprobieren; was offen bleibt, geht zurueck in
    /// die Warteliste.
    async fn versuchen_alle(&mut self, basen: Vec<u16>) {
        for basis in basen {
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
            .filter(|s| !self.medien.hat(*s))
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
                            .holen(*s)
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
                self.medien.ablegen(fehlend[0], bytes);

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
        assert_eq!(e.verworfen, 0);
        assert!(rx.try_recv().is_ok(), "das reparierte Paket muss eingespeist werden");
    }

    /// **Regression: die Paritaet muss den Sequenznummern-Umlauf ueberleben.**
    ///
    /// Der Vorrat ist nach der ROHEN 16-bit-Sequenznummer geordnet, und die
    /// laeuft bei 65535 um — bei 455 Videopaketen je Sekunde alle gut zwei
    /// Minuten, bei hoeherer Bitrate entsprechend frueher. Danach ist die
    /// kleinste Zahl in der Ordnung nicht mehr das AELTESTE Paket, sondern das
    /// NEUESTE: die Verdraengung (`while len > VORRAT`) wirft dann genau das
    /// Paket wieder hinaus, das gerade eingetroffen ist, und die alten hohen
    /// Nummern bleiben fuer immer stehen.
    ///
    /// Die Folge ist kein Leistungsproblem, sondern ein Totalausfall: jede
    /// Gruppe sieht danach lueckenhaft aus, weil ihre Pakete gar nicht mehr im
    /// Vorrat stehen — die Paritaet repariert nichts mehr, bis der Strom neu
    /// startet. Sichtbar ist das nirgends; `fec_repariert` faellt auf null,
    /// und das sieht wie eine ruhige Leitung aus.
    #[tokio::test]
    async fn paritaet_ueberlebt_den_sequenznummern_umlauf() {
        let (tx, mut rx) = mpsc::channel(64);
        let mut e = Empfaenger::neu(Codec::Av1, 90_000, tx);

        // **Der Vorlauf muss laenger sein als der Vorrat.** Mit weniger als
        // VORRAT Paketen vor dem Umlauf bleibt in der Ordnung Platz unterhalb
        // der alten hohen Nummern, und die neuen ueberleben — der Fehler
        // versteckt sich dann. Im Betrieb laeuft ein Strom minutenlang, bevor
        // die Sequenz umschlaegt; der Vorrat ist zu diesem Zeitpunkt IMMER
        // vollstaendig mit hohen Nummern belegt.
        let start: u16 = u16::MAX - 699; // 700 Pakete bis zum Umlauf
        for i in 0..1000u16 {
            let seq = start.wrapping_add(i);
            e.medienpaket(seq, medienpaket(seq, 9000, SSRC, &[i as u8; 40]).bytes).await;
        }

        // Eine frische Gruppe NACH dem Umlauf, ein Loch darin.
        let basis: u16 = 400;
        let medien: Vec<_> =
            (0..5).map(|i| medienpaket(basis + i, 9000, SSRC, &[i as u8; 40])).collect();
        let paritaet = paritaet_bauen(&medien, SSRC, basis);
        for p in medien.iter().take(4) {
            e.medienpaket(p.sequenz, p.bytes.clone()).await;
        }
        e.paritaetspaket(&paritaet).await;

        assert_eq!(
            e.repariert, 1,
            "nach dem Umlauf muss die Paritaet weiter reparieren \
             (mehrfach_loch {}, verworfen {})",
            e.mehrfach_loch, e.verworfen
        );
        assert!(rx.try_recv().is_ok(), "das reparierte Paket muss eingespeist werden");
    }

    /// **Diagnose, kein Regressionstest: was kostet ein Medienpaket?**
    ///
    /// `medienpaket()` laeuft fuer JEDES ankommende Videopaket und ruft danach
    /// [`Empfaenger::wartende_pruefen`] — und die geht ueber ALLE wartenden
    /// Paritaetspakete, unabhaengig davon, ob das neue Paket ihre Gruppe
    /// ueberhaupt beruehrt. Auf ruhiger Leitung ist `wartend` leer und das
    /// kostet nichts; unter Buendelverlust fuellt es sich bis
    /// [`WARTENDE_PARITAET`], und dann faellt der Aufwand mit dem Produkt aus
    /// Paketrate und Wartestand an — also ausgerechnet dann, wenn ohnehin
    /// nichts mehr Zeit hat.
    ///
    /// Der Test misst beide Enden gegeneinander. Er behauptet KEINE Grenze
    /// (die haenge an der Maschine), sondern schreibt die Zahlen heraus; die
    /// Aussage ist das VERHAELTNIS.
    ///
    /// Laeuft nur mit `PULSE_PLAYER_FEC_KOSTEN=1`, und ohne die Variable
    /// schlaegt er fehl statt still gruen zu melden — dieselbe Regel wie bei
    /// den anderen Diagnosetests im Baum.
    #[tokio::test]
    #[ignore = "Kostenmessung; braucht PULSE_PLAYER_FEC_KOSTEN=1"]
    async fn kosten_je_medienpaket_leer_gegen_voll() {
        assert_eq!(
            std::env::var("PULSE_PLAYER_FEC_KOSTEN").as_deref(),
            Ok("1"),
            "PULSE_PLAYER_FEC_KOSTEN=1 setzen"
        );

        /// Eine Gruppe aus `n` Medienpaketen samt ihrer Paritaet, bei `basis`.
        fn gruppe_n(basis: u16, n: u16, groesse: usize) -> (Vec<Medienpaket>, Vec<u8>) {
            let medien: Vec<_> = (0..n)
                .map(|i| medienpaket(basis + i, 9000, SSRC, &vec![i as u8; groesse]))
                .collect();
            let paritaet = paritaet_bauen(&medien, SSRC, basis);
            (medien, paritaet)
        }

        // Realistischer Zuschnitt: 10+2 (die entschiedene Paritaetsstufe) und
        // 1100 Byte Nutzlast, also etwa eine volle MTU.
        const GRUPPE: u16 = 10;
        const NUTZLAST: usize = 1100;
        const PAKETE: u32 = 20_000;

        // --- Fall A: `wartend` bleibt leer (ruhige Leitung) ---
        let (tx, _rx) = mpsc::channel(4096);
        let mut leer = Empfaenger::neu(Codec::Av1, 90_000, tx);
        let (medien, _) = gruppe_n(0, GRUPPE, NUTZLAST);
        let start = std::time::Instant::now();
        for i in 0..PAKETE {
            let p = &medien[(i % u32::from(GRUPPE)) as usize];
            leer.medienpaket((i % 60000) as u16, p.bytes.clone()).await;
        }
        let ns_leer = start.elapsed().as_nanos() as u64 / u64::from(PAKETE);

        // --- Fall B: `wartend` ist voll (Buendelverlust) ---
        //
        // Die Gruppen liegen weit weg von den eingespeisten Paketen und haben
        // keines ihrer Mitglieder im Vorrat: unloesbar, also bleiben sie ueber
        // die ganze Messung liegen. Das ist der teuerste Fall und damit die
        // Obergrenze, die hier gesucht ist.
        //
        // **Der Zustand muss dabei STILLSTEHEN, sonst misst der Lauf seinen
        // eigenen Verlauf.** Eine erste Fassung speiste 20000 verschiedene
        // Sequenznummern ein; die verdraengten waehrend der Messung nach und
        // nach den Vorrat, die Gruppen bekamen unterwegs mehr Loecher, und die
        // Zahl haette sich mit jeder Aenderung an der Verdraengung mitbewegt —
        // ohne dass sich am gemessenen Aufwand etwas geaendert haette. Jetzt
        // wiederholen sich die Nummern, ein Wiedereintreffen ueberschreibt nur
        // und verdraengt nichts.
        let (tx2, _rx2) = mpsc::channel(4096);
        let mut voll = Empfaenger::neu(Codec::Av1, 90_000, tx2);
        for g in 0..WARTENDE_PARITAET as u16 {
            let (_, par) = gruppe_n(30_000 + g * GRUPPE, GRUPPE, NUTZLAST);
            voll.paritaetspaket(&par).await;
        }
        assert_eq!(
            voll.wartend.len(),
            WARTENDE_PARITAET,
            "der Wartestand muss fuer die Messung wirklich voll sein"
        );

        const VERSCHIEDENE: u32 = 200;
        // Einlaufen lassen, damit der Vorrat vor der Zeitnahme steht.
        for i in 0..VERSCHIEDENE {
            let p = &medien[(i % u32::from(GRUPPE)) as usize];
            voll.medienpaket(i as u16, p.bytes.clone()).await;
        }
        let vorrat_vorher = voll.medien.anzahl();

        let start = std::time::Instant::now();
        for i in 0..PAKETE {
            let p = &medien[(i % u32::from(GRUPPE)) as usize];
            voll.medienpaket((i % VERSCHIEDENE) as u16, p.bytes.clone()).await;
        }
        let ns_voll = start.elapsed().as_nanos() as u64 / u64::from(PAKETE);
        assert_eq!(voll.wartend.len(), WARTENDE_PARITAET, "Wartestand blieb nicht stehen");
        assert_eq!(voll.medien.anzahl(), vorrat_vorher, "der Vorrat blieb nicht stehen");

        // Bezugsgroesse dazu, sonst ist es eine Zahl ohne Massstab: bei 4 Mbit/s
        // und 1100 Byte Nutzlast kommen rund 455 Videopakete je Sekunde.
        let pro_s = 455.0;
        eprintln!(
            "FEC-Empfaenger, Kosten je Medienpaket:\n  \
             Wartestand leer: {ns_leer} ns  ({:.3} % einer CPU bei {pro_s:.0} Paketen/s)\n  \
             Wartestand voll ({WARTENDE_PARITAET}): {ns_voll} ns  \
             ({:.3} % einer CPU)  = Faktor {:.1}",
            ns_leer as f64 * pro_s / 1e7,
            ns_voll as f64 * pro_s / 1e7,
            ns_voll as f64 / ns_leer.max(1) as f64,
        );
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
