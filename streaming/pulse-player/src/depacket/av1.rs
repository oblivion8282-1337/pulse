//! AV1-Depacketisierung nach dem AV1-RTP-Payload-Format.
//!
//! Muss selbst geschrieben werden: das `rtp`-Crate (0.17) liefert fuer AV1 nur
//! einen *Payloader*, keinen Depacketizer. AV1 ist aber der Standard-Codec
//! (`web/src/lib/stream/settings.svelte.ts` waehlt AV1, sobald die GPU es
//! encodieren kann), also fuehrt kein Weg daran vorbei.
//!
//! Aggregation-Header (1 Byte, immer das erste Byte der Payload):
//! ```text
//!  0 1 2 3 4 5 6 7
//! +-+-+-+-+-+-+-+-+
//! |Z|Y| W |N|-|-|-|
//! +-+-+-+-+-+-+-+-+
//! ```
//! * `Z` — das erste OBU-Element setzt ein Fragment aus dem Vorpaket fort
//! * `Y` — das letzte OBU-Element wird im Folgepaket fortgesetzt
//! * `W` — Anzahl der OBU-Elemente; 0 heisst "jedes Element hat ein
//!   LEB128-Laengenfeld", sonst tragen nur die ersten W-1 eines
//!   (das letzte reicht bis zum Payload-Ende)
//! * `N` — erstes Paket einer neuen codierten Videosequenz
//!
//! Zwei Dinge sind nicht offensichtlich und der eigentliche Grund fuer die
//! Tests unten:
//!
//! 1. **Groessenfeld wieder einsetzen.** Ueber RTP werden OBUs ohne
//!    `obu_has_size_field` uebertragen — die RTP-Laenge ersetzt es. FFmpegs
//!    AV1-Decoder erwartet aber einen Bitstrom mit Groessenfeldern. Beim
//!    Zusammenbauen muss das Bit gesetzt und ein LEB128-Feld hinter den Header
//!    (samt optionalem Extension-Byte) geschoben werden.
//! 2. **Fragmente ueber Paketgrenzen.** Ein OBU darf mitten im Byte geteilt
//!    sein; erst `Z`/`Y` sagen, ob zusammengesetzt werden muss.

use bytes::{BufMut, Bytes, BytesMut};

const OBU_HAS_EXTENSION_BIT: u8 = 0b0000_0100;
const OBU_HAS_SIZE_BIT: u8 = 0b0000_0010;
const OBU_TYPE_MASK: u8 = 0b0111_1000;
const OBU_TYPE_TEMPORAL_DELIMITER: u8 = 2;

/// Obergrenze fuer eine Zugriffseinheit. Schuetzt gegen unbegrenztes Wachsen,
/// wenn der Marker-Bit-Strom kaputt ist (z. B. bei schwerem Verlust).
const MAX_TEMPORAL_UNIT_BYTES: usize = 32 * 1024 * 1024;

/// Auch vom Mitschnitt gebraucht: [`crate::recorder`] zerlegt denselben
/// (bereits mit Groessenfeldern versehenen) Strom, um Keyframes zu finden.
pub(crate) fn read_leb128(buf: &[u8]) -> Option<(u32, usize)> {
    let mut value: u64 = 0;
    for (i, &b) in buf.iter().enumerate().take(8) {
        value |= u64::from(b & 0x7f) << (i * 7);
        if b & 0x80 == 0 {
            return u32::try_from(value).ok().map(|v| (v, i + 1));
        }
    }
    None
}

fn write_leb128(out: &mut BytesMut, mut value: u32) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.put_u8(byte);
        if value == 0 {
            return;
        }
    }
}

/// Setzt einen vollstaendigen, aus RTP stammenden OBU in die Form um, die ein
/// Decoder erwartet: Header, optionales Extension-Byte, LEB128-Groesse, Nutzlast.
/// Traegt der OBU bereits ein Groessenfeld, wird er unveraendert uebernommen.
fn append_obu_with_size(out: &mut BytesMut, obu: &[u8]) {
    let Some(&header) = obu.first() else { return };

    // Temporal Delimiter tragen keine Nutzlast und werden ueber RTP ohnehin
    // weggelassen; ein durchgereichter waere harmlos, aber unnoetig.
    if (header & OBU_TYPE_MASK) >> 3 == OBU_TYPE_TEMPORAL_DELIMITER {
        return;
    }

    if header & OBU_HAS_SIZE_BIT != 0 {
        out.put_slice(obu);
        return;
    }

    let header_len = if header & OBU_HAS_EXTENSION_BIT != 0 { 2 } else { 1 };
    if obu.len() < header_len {
        return; // abgeschnitten, unbrauchbar
    }
    let payload = &obu[header_len..];

    out.put_u8(header | OBU_HAS_SIZE_BIT);
    if header_len == 2 {
        out.put_u8(obu[1]);
    }
    write_leb128(out, payload.len() as u32);
    out.put_slice(payload);
}

/// Setzt AV1-Zugriffseinheiten aus RTP-Paketen zusammen.
///
/// Erwartet Pakete **in Reihenfolge** — das Umsortieren macht der Jitter-Puffer
/// davor. Ein erkannter Lueckenschluss (`expect_continuation` passt nicht)
/// verwirft die angefangene Einheit, statt einen kaputten Bitstrom auszuliefern.
#[derive(Default)]
pub struct Av1Assembler {
    /// Zugriffseinheit im Aufbau (bereits mit Groessenfeldern).
    unit: BytesMut,
    /// Angefangener OBU, dessen Rest im naechsten Paket kommt.
    partial: BytesMut,
    /// Ob das naechste Paket mit `Z=1` beginnen MUSS.
    expect_continuation: bool,
    /// Einheit ist unbrauchbar (Verlust erkannt) und wird verworfen.
    poisoned: bool,
}

impl Av1Assembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Meldet einen Paketverlust. Die laufende Einheit wird verworfen, weil
    /// sie ohne das fehlende Fragment keinen gueltigen Bitstrom mehr ergibt.
    pub fn on_gap(&mut self) {
        self.reset();
        self.poisoned = true;
    }

    fn reset(&mut self) {
        self.unit.clear();
        self.partial.clear();
        self.expect_continuation = false;
        self.poisoned = false;
    }

    /// Verarbeitet ein Paket. Gibt bei gesetztem Marker-Bit die fertige
    /// Zugriffseinheit zurueck.
    pub fn push(&mut self, payload: &[u8], marker: bool) -> Option<Bytes> {
        let (&aggr, mut rest) = payload.split_first()?;
        let z = aggr & 0b1000_0000 != 0;
        let y = aggr & 0b0100_0000 != 0;
        let w = (aggr & 0b0011_0000) >> 4;

        // Fortsetzung erwartet, aber keine geliefert (oder umgekehrt) =>
        // dazwischen fehlt etwas.
        if z != self.expect_continuation {
            self.reset();
            self.poisoned = true;
        }

        // Bewusst breiter als das 2-Bit-Feld `W`: bei W=0 traegt jedes Element
        // ein eigenes Laengenfeld, ein Paket kann also beliebig viele
        // enthalten. Mit einem u8 lief der Zaehler ab 256 Elementen ueber —
        // im Debug-Build eine Panik, im Release ein stiller Wraparound, der
        // die Fortsetzungspruefung `idx != 1` durcheinanderbringt.
        let mut idx: u32 = 0;
        let w = u32::from(w);
        while !rest.is_empty() {
            idx += 1;
            let is_last = w != 0 && idx == w;
            let (element, consumed) = if is_last {
                (rest, rest.len())
            } else {
                let Some((len, n)) = read_leb128(rest) else {
                    self.poisoned = true;
                    break;
                };
                let len = len as usize;
                if rest.len() < n + len {
                    self.poisoned = true;
                    break;
                }
                (&rest[n..n + len], n + len)
            };

            // Nur das erste Element eines `Z`-Pakets setzt fort; alles andere
            // schliesst den vorherigen OBU ab.
            if idx != 1 || !z {
                self.flush_partial();
            }
            self.partial.put_slice(element);

            rest = &rest[consumed..];
        }

        // Nur das LETZTE Element eines Pakets darf fortgesetzt werden.
        self.expect_continuation = y;
        if !y {
            self.flush_partial();
        }

        if self.unit.len() > MAX_TEMPORAL_UNIT_BYTES {
            self.reset();
            self.poisoned = true;
        }

        if !marker {
            return None;
        }

        // Marker = Ende der Zugriffseinheit.
        self.flush_partial();
        self.expect_continuation = false;
        let poisoned = std::mem::take(&mut self.poisoned);
        let out = self.unit.split().freeze();
        (!poisoned && !out.is_empty()).then_some(out)
    }

    fn flush_partial(&mut self) {
        if self.partial.is_empty() {
            return;
        }
        let obu = self.partial.split();
        append_obu_with_size(&mut self.unit, &obu);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leb(v: u32) -> Vec<u8> {
        let mut b = BytesMut::new();
        write_leb128(&mut b, v);
        b.to_vec()
    }

    #[test]
    fn leb128_hin_und_zurueck() {
        for v in [0u32, 1, 127, 128, 300, 16383, 16384, 1_000_000] {
            let enc = leb(v);
            let (dec, n) = read_leb128(&enc).expect("dekodierbar");
            assert_eq!(dec, v, "Wert {v}");
            assert_eq!(n, enc.len(), "Laenge {v}");
        }
    }

    /// Ein Paket, ein OBU (W=1), kein Fragment: muss mit gesetztem
    /// Groessen-Bit und LEB128-Laenge herauskommen.
    #[test]
    fn einzelner_obu_bekommt_groessenfeld() {
        let mut a = Av1Assembler::new();
        // Header: Typ 6 (FRAME) = 0b0011_0000, kein Extension, kein Size-Bit
        let header = 6u8 << 3;
        let payload = [header, 0xAA, 0xBB, 0xCC];
        let mut pkt = vec![0b0001_0000]; // Z=0 Y=0 W=1 N=0
        pkt.extend_from_slice(&payload);

        let out = a.push(&pkt, true).expect("Einheit fertig");
        assert_eq!(out[0], header | OBU_HAS_SIZE_BIT, "Size-Bit muss gesetzt sein");
        assert_eq!(out[1], 3, "LEB128-Laenge der Nutzlast");
        assert_eq!(&out[2..], &[0xAA, 0xBB, 0xCC]);
    }

    /// Derselbe OBU, aber ueber zwei Pakete verteilt (Y im ersten, Z im zweiten).
    #[test]
    fn fragmentierter_obu_wird_zusammengesetzt() {
        let mut a = Av1Assembler::new();
        let header = 6u8 << 3;

        let mut p1 = vec![0b0101_0000]; // Z=0 Y=1 W=1
        p1.extend_from_slice(&[header, 0xAA]);
        assert!(a.push(&p1, false).is_none(), "noch nicht fertig");

        let mut p2 = vec![0b1001_0000]; // Z=1 Y=0 W=1
        p2.extend_from_slice(&[0xBB, 0xCC]);
        let out = a.push(&p2, true).expect("Einheit fertig");

        assert_eq!(out[0], header | OBU_HAS_SIZE_BIT);
        assert_eq!(out[1], 3);
        assert_eq!(&out[2..], &[0xAA, 0xBB, 0xCC]);
    }

    /// W=0: jedes Element traegt ein eigenes Laengenfeld, auch das letzte.
    #[test]
    fn w_null_alle_elemente_mit_laenge() {
        let mut a = Av1Assembler::new();
        let h1 = 1u8 << 3; // SEQUENCE_HEADER
        let h2 = 6u8 << 3; // FRAME

        let mut pkt = vec![0b0000_0000]; // Z=0 Y=0 W=0
        pkt.extend_from_slice(&leb(2));
        pkt.extend_from_slice(&[h1, 0x11]);
        pkt.extend_from_slice(&leb(3));
        pkt.extend_from_slice(&[h2, 0x22, 0x33]);

        let out = a.push(&pkt, true).expect("Einheit fertig");
        // erster OBU
        assert_eq!(out[0], h1 | OBU_HAS_SIZE_BIT);
        assert_eq!(out[1], 1);
        assert_eq!(out[2], 0x11);
        // zweiter OBU
        assert_eq!(out[3], h2 | OBU_HAS_SIZE_BIT);
        assert_eq!(out[4], 2);
        assert_eq!(&out[5..], &[0x22, 0x33]);
    }

    #[test]
    fn temporal_delimiter_wird_verworfen() {
        let mut a = Av1Assembler::new();
        let td = OBU_TYPE_TEMPORAL_DELIMITER << 3;
        let frame = 6u8 << 3;

        let mut pkt = vec![0b0000_0000]; // W=0
        pkt.extend_from_slice(&leb(1));
        pkt.extend_from_slice(&[td]);
        pkt.extend_from_slice(&leb(2));
        pkt.extend_from_slice(&[frame, 0x42]);

        let out = a.push(&pkt, true).expect("Einheit fertig");
        assert_eq!(out[0], frame | OBU_HAS_SIZE_BIT, "TD darf nicht im Strom stehen");
        assert_eq!(out.len(), 3);
    }

    /// Bereits vorhandenes Groessenfeld darf nicht doppelt gesetzt werden.
    #[test]
    fn vorhandenes_groessenfeld_bleibt_unveraendert() {
        let mut a = Av1Assembler::new();
        let header = (6u8 << 3) | OBU_HAS_SIZE_BIT;
        let mut pkt = vec![0b0001_0000]; // W=1
        pkt.extend_from_slice(&[header, 2, 0xAA, 0xBB]);

        let out = a.push(&pkt, true).expect("Einheit fertig");
        assert_eq!(&out[..], &[header, 2, 0xAA, 0xBB]);
    }

    /// Erwartete Fortsetzung fehlt => Einheit wird verworfen statt kaputt
    /// ausgeliefert.
    #[test]
    fn fehlende_fortsetzung_verwirft_einheit() {
        let mut a = Av1Assembler::new();
        let header = 6u8 << 3;

        let mut p1 = vec![0b0101_0000]; // Y=1: Fortsetzung angekuendigt
        p1.extend_from_slice(&[header, 0xAA]);
        assert!(a.push(&p1, false).is_none());

        // Paket mit Z=0, obwohl Fortsetzung erwartet war
        let mut p2 = vec![0b0001_0000];
        p2.extend_from_slice(&[header, 0xBB]);
        assert!(a.push(&p2, true).is_none(), "kaputte Einheit darf nicht raus");

        // danach wieder sauber
        let mut p3 = vec![0b0001_0000];
        p3.extend_from_slice(&[header, 0xCC]);
        assert!(a.push(&p3, true).is_some(), "Assembler muss sich erholen");
    }

    /// Regression: `idx` zaehlt die OBU-Elemente eines Pakets. Bei W=0 traegt
    /// jedes Element ein eigenes Laengenfeld, also kann ein Paket beliebig
    /// viele enthalten — mit einem u8-Zaehler laeuft das ab 256 Elementen
    /// ueber (Debug: Panik, Release: stiller Wraparound, der die
    /// Fortsetzungslogik `idx != 1` durcheinanderbringt).
    #[test]
    fn viele_elemente_lassen_den_zaehler_nicht_ueberlaufen() {
        let mut a = Av1Assembler::new();
        let mut pkt = vec![0b0000_0000]; // Z=0 Y=0 W=0
        // 300 Elemente der Laenge 0 — LEB128(0) ist ein einzelnes Nullbyte.
        pkt.extend(std::iter::repeat_n(0u8, 300));
        // Darf weder panischen noch etwas Kaputtes ausliefern.
        let out = a.push(&pkt, true);
        assert!(out.is_none(), "leere Elemente ergeben keine Einheit");
    }

    #[test]
    fn gap_verwirft_laufende_einheit() {
        let mut a = Av1Assembler::new();
        let header = 6u8 << 3;
        let mut p1 = vec![0b0101_0000];
        p1.extend_from_slice(&[header, 0xAA]);
        a.push(&p1, false);

        a.on_gap();

        let mut p2 = vec![0b0001_0000];
        p2.extend_from_slice(&[header, 0xBB]);
        assert!(a.push(&p2, true).is_none(), "nach Luecke keine Teil-Einheit");
    }
}
