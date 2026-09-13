//! Zusammensetzen von HEVC-Zugriffseinheiten aus RTP (RFC 7798) — und
//! Uebersetzung nach Annex-B, dem Format, das der Decoder (und der Recorder)
//! weiter unten erwartet.
//!
//! **Warum hier ein eigener Parser liegt, obwohl webrtc-rs einen
//! `H265Packet`-Depacketizer mitbringt:** dessen `depacketize` gibt die rohe
//! RTP-Nutzlast zurück, NICHT Annex-B — anders als `H264Packet`, der
//! Startcodes setzt. Die NAL-Grammatik ist überschaubar (drei Paketarten,
//! RFC 7798 §4.4), und so wie hier ist sie mit dem H.264-Zweig in
//! [`super`] Wort für Wort vergleichbar: gleiche Buchführung (`dropped`,
//! Deckel über Einheit + Fragmentreste), gleiche Marker-Regel.
//!
//! **Kein DONL.** Der Zusatz steht nur, wenn `sprop-max-don-diff > 0`
//! verhandelt wurde; MediaMTX (pion) tut das nie. Wäre es doch, würde jedes
//! FU/AP falsch gelesen — sichtbar als sofortiger Bildmuell, nicht still.
//!
//! Ein RTP-Paket hier trägt genau EINE NAL-Einheit in einer von drei Formen:
//!
//! * **Single NAL** (Typ 0-40): Kopf + Nutzlast, direkt anhängen.
//! * **AP, Aggregation (48)**: mehrere kleine NAL je Paket, je
//!   `[2-Byte-Länge][NAL]` — zusammen aufreihen.
//! * **FU, Fragmentierung (49)**: eine grosse NAL über viele Pakete. Der
//!   NAL-Kopf wird rekonstruiert (RFC 7798 §4.4.3): PayloadHdr des FU mit
//!   dem Typ aus dem FU-Header, dann die Fragmente in Reihe.
//!
//! PACI (50) trägt verschachtelte Daten — den Strom kennt MediaMTX nicht,
//! hier gilt er als Fehler und verwirft die Einheit.

use bytes::{Bytes, BytesMut};

use super::MAX_ACCESS_UNIT_BYTES;

/// Annex-B-Startcode — derselbe, den `H264Packet` setzt.
const STARTCODE: &[u8] = &[0, 0, 0, 1];
/// Aggregation Packet (RFC 7798 §4.4.2).
const AP_TYPE: u8 = 48;
/// Fragmentation Unit (RFC 7798 §4.4.3).
const FU_TYPE: u8 = 49;
/// PACI (RFC 7798 §4.4.4) — nicht unterstützt, zählt als Fehler.
const PACI_TYPE: u8 = 50;

/// Setzt HEVC-RTP zu Annex-B-Zugriffseinheiten zusammen.
///
/// Verträge wie der Av1-Assembler: [`Self::push`] gibt die Einheit beim
/// Marker heraus, [`Self::on_gap`] verwirft die angefangene, und
/// [`Self::verworfen_abholen`] meldet, ob seit dem letzten Abruf eine
/// fertige Einheit weggeworfen wurde — die Unterscheidung „unfertig" gegen
/// „ausgefallen" braucht `session.rs` für die Vollbild-Anforderung.
///
/// `fu_offen` markiert eine angefangene fragmentierte NAL. Kopf und
/// Fragmente liegen von Anfang an in `unit`, es gibt also KEINEN
/// unsichtbaren Rest-Puffer wie beim H.264-`fua_buffer` — der Deckel unten
/// misst deshalb `unit` allein und sieht trotzdem alles.
pub struct HevcAssembler {
    unit: BytesMut,
    fu_offen: bool,
    dropped: bool,
}

impl HevcAssembler {
    pub fn neu() -> Self {
        Self { unit: BytesMut::new(), fu_offen: false, dropped: false }
    }

    /// Angefangene Einheit samt FU-Zustand mitnehmen — ein halbes Bild ist
    /// kein Bild, und ein Rest im Decoder-Zustand verfälscht das nächste.
    pub fn on_gap(&mut self) {
        self.unit.clear();
        self.fu_offen = false;
        self.dropped = true;
    }

    pub fn verworfen_abholen(&mut self) -> bool {
        std::mem::take(&mut self.dropped)
    }

    pub fn push(&mut self, payload: &Bytes, marker: bool) -> Option<Bytes> {
        let (verworfen, ergebnis) = self.friss(payload, marker);
        self.dropped |= verworfen;
        ergebnis
    }

    /// Aktuelle Groesse der im Aufbau befindlichen Einheit — fuer Tests.
    #[cfg(test)]
    pub fn buffered_len(&self) -> usize {
        self.unit.len()
    }

    fn friss(&mut self, payload: &Bytes, marker: bool) -> (bool, Option<Bytes>) {
        // Zu kurz für NAL-Kopf + ein Nutzlast-Byte, oder F-Bit gesetzt
        // (RFC 7798: „MUST be discarded") — beides zieht die Einheit mit weg.
        if payload.len() < 3 || payload[0] & 0x80 != 0 {
            self.on_gap();
            return (true, None);
        }
        // NAL-Typ: obere Hälfte des ersten Byte, `(b0 >> 1) & 0x3F`.
        match (payload[0] >> 1) & 0x3F {
            FU_TYPE => self.friss_fu(payload),
            AP_TYPE => self.friss_ap(payload),
            PACI_TYPE => {
                self.on_gap();
                return (true, None);
            }
            _ => {
                self.unit.extend_from_slice(STARTCODE);
                self.unit.extend_from_slice(payload);
            }
        }
        // Derselbe Deckel wie im H.264-Zweig. Hier misst er `unit` allein —
        // Fragmente landen sofort darin, ein unsichtbarer Rest-Puffer
        // existiert nicht (s. Struct-Doku).
        if self.unit.len() > MAX_ACCESS_UNIT_BYTES {
            self.unit.clear();
            self.fu_offen = false;
            self.dropped = true;
        }
        if !marker {
            return (false, None);
        }
        let bad = std::mem::take(&mut self.dropped);
        let out = self.unit.split().freeze();
        // Bis zum Marker gekommen und trotzdem nicht herausgegangen heisst
        // ausgefallenes Bild — dieselbe Meldungs-Regel wie in allen Zweigen.
        let verworfen = bad && !out.is_empty();
        (verworfen, (!bad && !out.is_empty()).then_some(out))
    }

    /// Ein FU-Paket: `[PayloadHdr (Typ 49)][FU-Header][Fragment...]`.
    ///
    /// Der NAL-Kopf wird beim S-Bit rekonstruiert und in `unit` geschrieben,
    /// die Fragmente hängen direkt dahinter — in Empfangsreihenfolge, genau
    /// wie beim H.264-Pendant. Der FU-Header selbst (S|E|Typ) gehört NICHT
    /// zum rekonstruierten NAL.
    fn friss_fu(&mut self, payload: &Bytes) {
        if payload.len() < 3 {
            self.on_gap();
            return;
        }
        let fu_header = payload[2];
        let start = fu_header & 0x80 != 0;
        let ende = fu_header & 0x40 != 0;
        let fragment = &payload[3..];
        if start {
            // Rekonstruiertes PayloadHdr: F und LayerId/TID bleiben stehen,
            // der Typ kommt aus dem FU-Header — `(b0 & 0x81) | (typ << 1)`.
            let kopf0 = (payload[0] & 0x81) | ((fu_header & 0x3F) << 1);
            self.unit.extend_from_slice(STARTCODE);
            self.unit.extend_from_slice(&[kopf0, payload[1]]);
            self.unit.extend_from_slice(fragment);
            self.fu_offen = true;
        } else if self.fu_offen {
            self.unit.extend_from_slice(fragment);
        } else {
            // Fortsetzung ohne Anfang: der Zustand ist weg (Lücke), das
            // Fragment allein ist Muell. Derselbe Fall wie der leere
            // `fua_buffer` beim H.264-Pendant — verwerfen statt kleben.
            self.dropped = true;
        }
        if ende {
            self.fu_offen = false;
        }
    }

    /// Ein AP-Paket: `[PayloadHdr (Typ 48)][Länge (2)][NAL][Länge (2)][NAL]…`
    ///
    /// Bewusst tolerant bei EINER NAL (RFC verlangt zwei, aber wer am Rand
    /// eines MTU-Schnitts eine einzige zustellt, hat trotzdem heile NALs);
    /// bei abgeschnittener Länge oder NAL dagegen ist der Rest unbrauchbar
    /// und die Einheit fliegt — dieselbe Haltung wie beim kaputten STAP-A
    /// im H.264-Zweig.
    fn friss_ap(&mut self, payload: &Bytes) {
        let mut i = 2;
        while i + 2 <= payload.len() {
            let lang = u16::from_be_bytes([payload[i], payload[i + 1]]) as usize;
            i += 2;
            if lang == 0 || i + lang > payload.len() {
                self.on_gap();
                return;
            }
            self.unit.extend_from_slice(STARTCODE);
            self.unit.extend_from_slice(&payload[i..i + lang]);
            i += lang;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nal(typ: u8, nutzlast: u8) -> Vec<u8> {
        // Kopf: F=0, Typ=typ, LayerId=0, TID=1 → b0 = typ << 1, b1 = 1.
        vec![typ << 1, 0x01, nutzlast]
    }

    /// Ein Single-NAL-Paket geht mit Startcode in die Einheit; der Marker
    /// schliesst sie ab.
    #[test]
    fn single_nal_bis_marker() {
        let mut a = HevcAssembler::neu();
        let p = Bytes::from(nal(1, 0xAA));
        assert!(a.push(&p, false).is_none(), "ohne Marker keine Einheit");
        let out = a.push(&Bytes::from(nal(1, 0xBB)), true).expect("Marker schliesst ab");
        assert!(out.starts_with(STARTCODE), "{out:02x?}");
        // Beide NAL drin: 2 × (4 Startcode + 3 NAL).
        assert_eq!(out.len(), 2 * 7, "{out:02x?}");
    }

    /// Eine NAL über drei FU-Pakete: der rekonstruierte Kopf trägt den Typ
    /// aus dem FU-Header (nicht 49), die Fragmente hängen in Reihenfolge.
    #[test]
    fn fu_wird_zur_einen_annex_b_nal() {
        let mut a = HevcAssembler::neu();
        // PayloadHdr des FU: Typ 49 → b0 = 49 << 1 = 98 = 0x62. FU-Header:
        // S=1, Typ 19 (IDR_W_RADL) → 0x80 | 19 = 0x93.
        let anfang = Bytes::from(vec![0x62, 0x01, 0x93, 0x11, 0x22]);
        assert!(a.push(&anfang, false).is_none());
        // Fortsetzung: E=0, Typ-Feld bedeutungslos → 0x00.
        assert!(a.push(&Bytes::from(vec![0x62, 0x01, 0x00, 0x33]), false).is_none());
        // Ende: E=1 → 0x40 | typ.
        let out = a
            .push(&Bytes::from(vec![0x62, 0x01, 0x53, 0x44]), true)
            .expect("E-Bit + Marker geben die NAL heraus");
        // Rekonstruierter Kopf: Typ 19 → 0x26, TID 1 → 0x01.
        assert_eq!(&out[..6], &[0, 0, 0, 1, 0x26, 0x01], "{out:02x?}");
        assert_eq!(&out[6..], &[0x11, 0x22, 0x33, 0x44], "{out:02x?}");
    }

    /// Eine grosse NAL in einem AP-Paket: Längenfelder werden geschluckt,
    /// die NALs mit Startcode aufgereiht.
    #[test]
    fn ap_reiht_die_nals_mit_startcode_auf() {
        let mut a = HevcAssembler::neu();
        // AP (Typ 48 → 0x60) mit zwei NALs zu je 3 Byte.
        let mut p = vec![0x60, 0x01, 0x00, 0x03];
        p.extend(nal(32, 0xAA)); // VPS
        p.push(0x00);
        p.push(0x03);
        p.extend(nal(1, 0xBB));
        let out = a.push(&Bytes::from(p), true).expect("AP + Marker");
        assert_eq!(out.len(), 2 * 7, "{out:02x?}");
        assert_eq!(&out[4..6], &[0x40, 0x01], "erste NAL ist die VPS: {out:02x?}");
        assert_eq!(&out[11..13], &[0x02, 0x01], "zweite NAL ist TRAIL_R: {out:02x?}");
    }

    /// F-Bit gesetzt (RFC 7798: MUST discard) — Einheit fällt, und die
    /// Meldung kommt über `verworfen_abholen` heraus.
    #[test]
    fn f_bit_verwirft_und_meldet() {
        let mut a = HevcAssembler::neu();
        assert!(a.push(&Bytes::from(nal(1, 0xAA)), false).is_none());
        let mut kaputt = nal(1, 0xBB);
        kaputt[0] |= 0x80;
        assert!(a.push(&Bytes::from(kaputt), true).is_none(), "F-Bit darf nicht raus");
        assert!(a.verworfen_abholen(), "der Verlust muss gemeldet werden");
        assert!(a.push(&Bytes::from(nal(1, 0xCC)), true).is_some(), "danach wieder regulaer");
        assert!(!a.verworfen_abholen(), "heile Einheit meldet nichts");
    }

    /// FU-Fortsetzung ohne Anfang: der Zustand ist weg (Lücke), das Fragment
    /// allein ist Muell — die dadurch unvollständige Einheit wird gemeldet,
    /// nicht geschluckt. Derselbe Dreisatz wie im Wrapper-Test des
    /// H.264-Zweigs: verlorene Einheit → keine Auslieferung → Meldung.
    #[test]
    fn fu_fortsetzung_ohne_anfang_verwirft() {
        let mut a = HevcAssembler::neu();
        // Fortsetzung ohne Anfang, kein Marker — `dropped` steht jetzt.
        assert!(a.push(&Bytes::from(vec![0x62, 0x01, 0x00, 0x33]), false).is_none());
        // Ein heiles NAL mit Marker: verzehrt `dropped`, liefert nichts —
        // die verlorene FU klebt nicht davor.
        assert!(a.push(&Bytes::from(nal(1, 0x01)), true).is_none());
        assert!(a.verworfen_abholen(), "der Verlust wird gemeldet");
        assert!(a.push(&Bytes::from(nal(1, 0x02)), true).is_some(), "danach wieder regulaer");
        assert!(!a.verworfen_abholen(), "heile Einheit meldet nichts");
    }

    /// Der Deckel greift an `unit` allein und räumt die offene FU mit ab —
    /// danach muss wieder eine saubere Einheit herauskommen, ohne Reste der
    /// Anhäufung (der H.264-Lehre aus Befund 13 entsprechend).
    #[test]
    fn deckel_misst_die_offene_fu_mit() {
        let mut a = HevcAssembler::neu();
        // FU-Anfang, danach nur Fortsetzungen — nie ein E-Bit.
        let mut anfang = vec![0x62, 0x01, 0x93];
        anfang.extend(std::iter::repeat_n(0xAAu8, 1198));
        assert!(a.push(&Bytes::from(anfang), false).is_none());
        let mut weiter = vec![0x62, 0x01, 0x00];
        weiter.extend(std::iter::repeat_n(0xAAu8, 1198));
        let weiter = Bytes::from(weiter);
        for _ in 0..40_000 {
            assert!(a.push(&weiter, false).is_none(), "ohne Marker darf nichts herauskommen");
            if a.buffered_len() > MAX_ACCESS_UNIT_BYTES {
                panic!("Deckel griff nicht: {} Byte liegen in der Einheit", a.buffered_len());
            }
        }
        assert!(
            a.buffered_len() <= MAX_ACCESS_UNIT_BYTES,
            "Einheit waechst unbegrenzt: {} Bytes",
            a.buffered_len()
        );
        // Danach wieder heil: ein Marker-Paket verzehrt `dropped` und meldet
        // den Ueberlauf (Meldung abholen!), eine frische FU kommt danach
        // unverfälscht heraus.
        assert!(a.push(&Bytes::from(nal(1, 0x01)), true).is_none());
        assert!(a.verworfen_abholen(), "der Ueberlauf wird gemeldet");
        let mut neu = vec![0x62, 0x01, 0x93];
        neu.extend(std::iter::repeat_n(0xBBu8, 8));
        assert!(a.push(&Bytes::from(neu), false).is_none());
        let out = a
            .push(&Bytes::from(vec![0x62, 0x01, 0x53, 0xBB]), true)
            .expect("die saubere FU muss herauskommen");
        assert!(!out.contains(&0xAA), "Reste der alten Anhäufung kleben: {out:02x?}");
    }
}
