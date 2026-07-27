//! Jitter-Puffer: sortiert RTP-Pakete und gibt sie zeitgesteuert frei.
//!
//! Warum selbst gebaut statt Chromium/`SampleBuilder` zu benutzen: die
//! Latenzmessung in `docs/2026-07-21-remote-control-latenz-messung.md` hat
//! ergeben, dass **5-15 ms Puffer** auf einer gesunden Strecke reichen
//! (Sweep ueber 5/20/40 ms, alle sauber). Chromiums WebRTC-Puffer laesst sich
//! nicht dorthin zwingen — `playoutDelayHint` ist ein Hinweis, keine Vorgabe.
//! Ein eigener Puffer macht diese Messung erst nutzbar und ist damit der
//! direkteste Latenzhebel im ganzen Player.
//!
//! Verhalten:
//! * Pakete werden nach **erweiterter** Sequenznummer sortiert (16-bit-Ueberlauf
//!   wird mitgezaehlt, sonst springt der Puffer bei jedem Wrap zurueck).
//! * Ein Paket wird freigegeben, sobald es `target` lang liegt **oder** alle
//!   Vorgaenger da sind.
//! * Reisst eine Luecke laenger als `target` auf, wird sie als [`Release::Gap`]
//!   gemeldet und uebersprungen — lieber ein verworfener Frame als ein
//!   stehender Puffer.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use webrtc::rtp::packet::Packet;

/// Obergrenze fuer zwischengespeicherte Pakete. Greift nur, wenn der Strom
/// pathologisch ist (Dauerverlust); verhindert unbegrenzten Speicherzuwachs.
const MAX_BUFFERED: usize = 2048;

/// Ab wie vielen Sequenznummern Abstand ein Sprung als Neustart des Stroms
/// gilt statt als Luecke (z. B. nach Republish).
const RESYNC_DISTANCE: u64 = 3000;

/// Wie viele Pakete in Folge als "Nachzuegler von vor dem Ueberlauf" gedeutet
/// werden duerfen, bevor der Strom als neu gestartet gilt. Echte Nachzuegler
/// kommen vereinzelt; bleibt es dabei, ist es kein Nachzuegler mehr.
const MAX_LATE_STREAK: u32 = 8;

pub enum Release {
    /// Faelliges Paket samt seiner ANKUNFTSZEIT. Die Zeit reist mit, weil sie
    /// der Anfang der Latenzkette ist: erst am fertig gezeichneten Bild laesst
    /// sich sagen, wie lange es vom Eintreffen bis auf den Schirm gebraucht hat
    /// — inklusive der Wartezeit, die dieser Puffer selbst verursacht.
    Packet(Packet, Instant),
    /// Mindestens ein Paket ist endgueltig verloren; die angefangene
    /// Zugriffseinheit ist damit unbrauchbar.
    ///
    /// `missing` wird heute nur in Tests und Logs gelesen — es bleibt im Typ,
    /// weil die Anzahl in die Diagnose gehoert, sobald der Stats-Ausbau kommt.
    Gap {
        #[allow(dead_code)]
        missing: u64,
    },
}

struct Entry {
    packet: Packet,
    arrived: Instant,
}

pub struct JitterBuffer {
    entries: BTreeMap<u64, Entry>,
    /// Naechste erwartete erweiterte Sequenznummer.
    next: Option<u64>,
    /// Letzte gesehene rohe 16-bit-Sequenznummer (fuer die Ueberlauf-Erkennung).
    last_raw: Option<u16>,
    /// Wie viele Ueberlaeufe bereits gezaehlt wurden.
    cycles: u64,
    /// Wie viele Pakete in Folge als Nachzuegler gedeutet wurden.
    late_streak: u32,
    /// Beim Ueberlauf uebersprungene Pakete, die `poll` noch melden muss.
    forced_gap: Option<u64>,
    target: Duration,
    // --- Zaehler fuer die Diagnose ---
    pub received: u64,
    /// Rohe Nutzlast-Bytes aller angekommenen Pakete. Grundlage der Bitrate —
    /// die laesst sich sonst nirgends ablesen: der Zaehlerstand allein sagt
    /// nichts ueber die Datenmenge, und aus der Paketzahl geschaetzt waere sie
    /// bei gemischten Paketgroessen (Keyframe gegen Zwischenbild) falsch.
    pub bytes_received: u64,
    pub lost: u64,
    pub reordered: u64,
    pub duplicates: u64,
}

impl JitterBuffer {
    pub fn new(target: Duration) -> Self {
        Self {
            entries: BTreeMap::new(),
            next: None,
            last_raw: None,
            cycles: 0,
            late_streak: 0,
            forced_gap: None,
            target,
            received: 0,
            bytes_received: 0,
            lost: 0,
            reordered: 0,
            duplicates: 0,
        }
    }

    pub fn set_target(&mut self, target: Duration) {
        self.target = target;
    }

    /// Nur von den Tests gebraucht; gehoert trotzdem zur Oberflaeche des Puffers.
    #[allow(dead_code)]
    pub fn target(&self) -> Duration {
        self.target
    }

    /// Aktueller Fuellstand — geht als `buffered` in die Statistik.
    pub fn buffered(&self) -> usize {
        self.entries.len()
    }

    /// Rechnet die rohe 16-bit-Sequenznummer in eine monoton wachsende um.
    fn extend(&mut self, raw: u16) -> u64 {
        if let Some(last) = self.last_raw {
            // Rueckwaertssprung um mehr als ein halbes Fenster = Ueberlauf.
            if last > 0xC000 && raw < 0x4000 {
                self.cycles += 1;
            } else if last < 0x4000 && raw > 0xC000 && self.cycles > 0 {
                // Sieht aus wie ein spaet eintreffendes Paket von VOR dem
                // Ueberlauf — aber nur ein paar Mal hintereinander.
                //
                // Der fruehe `return` schreibt `last_raw` bewusst NICHT fort:
                // ein Nachzuegler darf den Bezugspunkt nicht verschieben,
                // sonst wuerde das naechste regulaere Paket faelschlich als
                // weiterer Ueberlauf gezaehlt. Genau dadurch rastete die
                // Bedingung aber dauerhaft ein, wenn ein Sender nach einem
                // Ueberlauf mit hoher zufaelliger Sequenz neu startete
                // (RFC 3550 gibt sie zufaellig vor, rund ein Viertel liegt
                // ueber 0xC000): jedes Paket landete unter `next` und wurde
                // als "zu spaet" verworfen — bei 1000 Paketen/s rund zwoelf
                // Sekunden ohne Bild und Ton. Der Resynchronisierungs-Ausweg
                // in `push` steht hinter der Verwerfung und wurde nie erreicht.
                //
                // Echte Nachzuegler kommen vereinzelt, ein neuer Strom
                // dauerhaft. Nach ein paar Treffern in Folge behandeln wir es
                // deshalb als Neustart und lassen `push` resynchronisieren.
                self.late_streak += 1;
                if self.late_streak <= MAX_LATE_STREAK {
                    return (self.cycles - 1) << 16 | u64::from(raw);
                }
                self.late_streak = 0;
            } else {
                self.late_streak = 0;
            }
        }
        self.last_raw = Some(raw);
        self.cycles << 16 | u64::from(raw)
    }

    pub fn push(&mut self, packet: Packet, arrived: Instant) {
        self.received += 1;
        self.bytes_received += packet.payload.len() as u64;
        let seq = self.extend(packet.header.sequence_number);

        match self.next {
            None => self.next = Some(seq),
            Some(next) => {
                if seq < next {
                    // Zu spaet — die Einheit ist bereits raus.
                    self.reordered += 1;
                    return;
                }
                // Grosser Vorwaertssprung: der Sender hat neu begonnen.
                //
                // Die wartenden Pakete sind damit wertlos — ihr Wegwerfen MUSS
                // aber als Luecke gemeldet werden, aus demselben Grund wie beim
                // Ueberlauf unten: sonst sieht `poll` danach `first == next`,
                // liefert ein regulaeres Paket, der Assembler bekommt kein
                // `on_gap()` und klebt eine angefangene Einheit an den neuen
                // Strom. Die Z/Y-Pruefung im AV1-Zusammensetzer faengt davon nur
                // die Faelle, in denen gerade ein Fragment offen war; standen
                // bereits fertige OBUs in der Einheit, wandern die
                // stillschweigend in das erste Bild nach dem Sprung.
                //
                // Die Zahl darf hier NICHT `seq - next` sein: bei einem
                // Neustart des Senders ist das eine Fantasiezahl (deshalb ja
                // der Resync). Gemeldet wird, was tatsaechlich weggeworfen
                // wurde — auch 0, denn der Zweck ist die Meldung selbst.
                if seq > next + RESYNC_DISTANCE {
                    let verworfen = self.entries.len() as u64;
                    self.entries.clear();
                    self.lost += verworfen;
                    *self.forced_gap.get_or_insert(0) += verworfen;
                    self.next = Some(seq);
                }
            }
        }

        if self.entries.insert(seq, Entry { packet, arrived }).is_some() {
            self.duplicates += 1;
        }

        if self.entries.len() > MAX_BUFFERED {
            // Aeltestes hart freigeben, damit der Puffer nicht davonlaeuft.
            // Die dabei uebersprungenen Sequenznummern MUESSEN als Luecke
            // gemeldet werden: sonst sieht `poll` danach `first == next` und
            // liefert ein regulaeres Paket, der Assembler bekommt kein
            // `on_gap()` und klebt Fragmente ueber die Luecke zu einer
            // korrupten Zugriffseinheit zusammen.
            if let Some(&oldest) = self.entries.keys().next() {
                if let Some(next) = self.next {
                    if oldest > next {
                        let missing = oldest - next;
                        self.lost += missing;
                        self.forced_gap = Some(missing);
                    }
                }
                self.next = Some(oldest);
            }
        }
    }

    /// Gibt alles frei, was faellig ist. `now` wird uebergeben statt intern
    /// geholt, damit der Ablauf testbar bleibt.
    pub fn poll(&mut self, now: Instant) -> Vec<Release> {
        let mut out = Vec::new();
        if let Some(missing) = self.forced_gap.take() {
            out.push(Release::Gap { missing });
        }
        loop {
            let Some(next) = self.next else { return out };
            let Some(entry) = self.entries.first_entry() else { return out };
            let first = *entry.key();

            if first == next {
                self.next = Some(next + 1);
                let e = entry.remove();
                out.push(Release::Packet(e.packet, e.arrived));
                continue;
            }

            // Luecke. Warten, solange das aelteste wartende Paket noch nicht
            // ueber die Zielzeit hinaus liegt — das fehlende kann noch kommen.
            if now.duration_since(entry.get().arrived) < self.target {
                return out;
            }

            let missing = first - next;
            self.lost += missing;
            self.next = Some(first);
            out.push(Release::Gap { missing });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(seq: u16) -> Packet {
        let mut p = Packet::default();
        p.header.sequence_number = seq;
        p
    }

    fn seqs(rel: &[Release]) -> Vec<u16> {
        rel.iter()
            .filter_map(|r| match r {
                Release::Packet(p, _) => Some(p.header.sequence_number),
                Release::Gap { .. } => None,
            })
            .collect()
    }

    #[test]
    fn reihenfolge_bleibt_erhalten() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        for s in [1u16, 2, 3] {
            j.push(pkt(s), t0);
        }
        assert_eq!(seqs(&j.poll(t0)), vec![1, 2, 3]);
    }

    #[test]
    fn vertauschte_pakete_werden_sortiert() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        j.push(pkt(1), t0);
        j.push(pkt(3), t0);
        // 3 darf noch nicht raus — 2 fehlt und die Zielzeit ist nicht um.
        assert_eq!(seqs(&j.poll(t0)), vec![1]);
        j.push(pkt(2), t0);
        assert_eq!(seqs(&j.poll(t0)), vec![2, 3]);
    }

    #[test]
    fn luecke_wird_nach_zielzeit_uebersprungen() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        j.push(pkt(1), t0);
        j.push(pkt(3), t0);
        assert_eq!(seqs(&j.poll(t0)), vec![1]);

        let later = t0 + Duration::from_millis(25);
        let rel = j.poll(later);
        assert!(
            matches!(rel.first(), Some(Release::Gap { missing: 1 })),
            "fehlendes Paket muss als Luecke gemeldet werden"
        );
        assert_eq!(seqs(&rel), vec![3]);
        assert_eq!(j.lost, 1);
    }

    /// Regression: Der Resync bei einem grossen Vorwaertssprung wirft wartende
    /// Pakete weg und setzt `next` neu — beides muss als Luecke herauskommen.
    ///
    /// Fehlte die Meldung, sah `poll` danach `first == next`, lieferte ein
    /// regulaeres Paket, und der Zusammensetzer klebte eine angefangene Einheit
    /// an den neuen Strom. Die beiden anderen Ueberspring-Wege (Zielzeit,
    /// Ueberlauf) melden seit jeher; dieser dritte tat es nicht.
    #[test]
    fn resync_meldet_die_weggeworfenen_pakete_als_luecke() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        j.push(pkt(1), t0);
        assert_eq!(seqs(&j.poll(t0)), vec![1]);
        // Wartendes Paket, das der Resync gleich wegwirft.
        j.push(pkt(3), t0);

        // Sprung ueber RESYNC_DISTANCE hinaus: der Sender hat neu begonnen.
        j.push(pkt(9000), t0);
        let rel = j.poll(t0);
        assert!(
            matches!(rel.first(), Some(Release::Gap { .. })),
            "Resync muss eine Luecke melden"
        );
        assert_eq!(seqs(&rel), vec![9000], "danach laeuft der neue Strom regulaer");
        assert_eq!(j.lost, 1, "das weggeworfene wartende Paket zaehlt als verloren");
    }

    #[test]
    fn sequenznummern_ueberlauf() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        j.push(pkt(65534), t0);
        j.push(pkt(65535), t0);
        j.push(pkt(0), t0);
        j.push(pkt(1), t0);
        assert_eq!(seqs(&j.poll(t0)), vec![65534, 65535, 0, 1], "Wrap darf nicht zurueckspringen");
    }

    /// Regression: nach einem Sequenznummern-Ueberlauf darf ein Neustart des
    /// Stroms mit hoher zufaelliger Startsequenz nicht dauerhaft als
    /// "spaetes Paket von vor dem Ueberlauf" fehlgedeutet werden.
    ///
    /// RFC 3550 gibt die Startsequenz zufaellig vor; in rund einem Viertel der
    /// Faelle liegt sie ueber 0xC000. Traf das zusammen, wurde jedes Paket des
    /// neuen Stroms verworfen, bis die Sequenz sich hochgezaehlt hatte — bei
    /// 1000 Paketen/s rund zwoelf Sekunden ohne Bild und Ton. Der
    /// Resynchronisierungs-Ausweg stand hinter der Verwerfung und wurde nie
    /// erreicht.
    #[test]
    fn neustart_nach_ueberlauf_blockiert_nicht() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));

        // Luckenlos ueber den Ueberlauf laufen, damit `next` auch wirklich
        // hinter den Wrap wandert (ohne das ist die Vorbedingung nicht da).
        for raw in (0xFFF0u16..=0xFFFF).chain(0x0000..=0x0100) {
            j.push(pkt(raw), t0);
            j.poll(t0);
        }

        // Neustart des Senders mit hoher Startsequenz.
        let mut angenommen = 0;
        for i in 0..40u16 {
            j.push(pkt(0xFF00_u16.wrapping_add(i)), t0);
            angenommen += seqs(&j.poll(t0)).len();
        }
        assert!(
            angenommen > 0,
            "Neustart mit hoher Sequenz wurde vollstaendig verworfen ({} von 40)",
            angenommen
        );
    }

    #[test]
    fn duplikate_werden_gezaehlt_nicht_doppelt_geliefert() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        j.push(pkt(1), t0);
        j.push(pkt(1), t0);
        assert_eq!(seqs(&j.poll(t0)), vec![1]);
        assert_eq!(j.duplicates, 1);
    }

    #[test]
    fn zu_spaete_pakete_werden_verworfen() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        j.push(pkt(5), t0);
        j.poll(t0);
        j.push(pkt(4), t0); // kommt nach der Freigabe
        assert!(seqs(&j.poll(t0)).is_empty());
        assert_eq!(j.reordered, 1);
    }

    #[test]
    fn grosser_sprung_synchronisiert_neu() {
        let t0 = Instant::now();
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        j.push(pkt(1), t0);
        j.poll(t0);
        // Republish: Sequenz beginnt weit entfernt neu
        j.push(pkt(9000), t0);
        assert_eq!(seqs(&j.poll(t0)), vec![9000], "Neustart darf nicht blockieren");
    }

    #[test]
    fn zielzeit_ist_zur_laufzeit_aenderbar() {
        let mut j = JitterBuffer::new(Duration::from_millis(20));
        assert_eq!(j.target(), Duration::from_millis(20));
        j.set_target(Duration::from_millis(5));
        assert_eq!(j.target(), Duration::from_millis(5));
    }
}
