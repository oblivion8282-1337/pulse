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
        let w = u32::from((aggr & 0b0011_0000) >> 4);

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

    // =========================================================================
    // Rundlauf gegen echte AV1-Daten.
    //
    // Die acht Tests oben decken den Depacketizer nur gegen handgebaute
    // Pakete ab. Hier laeuft ein echter AV1-Strom durch den *echten*
    // Gegenpart: `rtp::codecs::av1::Av1Payloader` (Dev-Dependency, s.
    // Cargo.toml) zerlegt einen Strom in RTP-Nutzlasten nach demselben
    // Aggregation-Header-Format, das `Av1Assembler` erwartet -- das Crate
    // liefert fuer AV1 nur den Payloader, keinen Depacketizer (daher der
    // Eigenbau oben), aber der Payloader allein reicht als Gegenstueck fuer
    // einen Rundlauf-Test.
    //
    // Laufen nur mit `PULSE_PLAYER_AV1_FIXTURE` (roher OBU-Strom, dieselbe
    // Fixture wie `recorder.rs`). Erzeugen:
    // `ffmpeg -f lavfi -i "testsrc2=s=320x180:r=30:d=2" -c:v libsvtav1 \
    //    -preset 12 -f obu fixture.obu`
    pub(in crate::depacket::av1) mod roundtrip {
        use super::*;
        use rtp::codecs::av1::Av1Payloader;
        use rtp::packetizer::Payloader;

        fn fixture() -> Option<Vec<u8>> {
            let path = std::env::var("PULSE_PLAYER_AV1_FIXTURE").ok()?;
            Some(std::fs::read(path).expect("Fixture lesbar"))
        }

        /// Zerlegt den rohen OBU-Strom in Zugriffseinheiten: Grenze ist ein
        /// Temporal-Delimiter (OBU-Typ 2), der selbst weggelassen wird --
        /// genau wie `recorder.rs`'s (privates) `split_obu` und genau die
        /// Form, die der Depacketizer liefert.
        fn split_temporal_units(data: &[u8]) -> Vec<Vec<u8>> {
            let mut units: Vec<Vec<u8>> = Vec::new();
            let mut current: Vec<u8> = Vec::new();
            let mut i = 0;
            while i < data.len() {
                let header = data[i];
                let obu_type = (header & OBU_TYPE_MASK) >> 3;
                let has_ext = header & OBU_HAS_EXTENSION_BIT != 0;
                let has_size = header & OBU_HAS_SIZE_BIT != 0;
                if !has_size {
                    break; // ohne Groessenfeld nicht zerlegbar
                }
                let mut pos = i + 1 + usize::from(has_ext);
                let Some((size, n)) = read_leb128(&data[pos..]) else { break };
                pos += n;
                let end = pos + size as usize;
                if end > data.len() {
                    break;
                }
                if obu_type == OBU_TYPE_TEMPORAL_DELIMITER {
                    if !current.is_empty() {
                        units.push(std::mem::take(&mut current));
                    }
                } else {
                    current.extend_from_slice(&data[i..end]);
                }
                i = end;
            }
            if !current.is_empty() {
                units.push(current);
            }
            units
        }

        /// Zerlegt eine Zugriffseinheit mit dem echten `rtp`-Payloader in
        /// RTP-Nutzlasten und setzt das Marker-Bit auf das letzte Paket --
        /// so wie ein echter Sender es fuer das Ende einer Einheit setzt.
        ///
        /// `rtp` 0.17.2 hat einen eigenstaendigen Bug in seinem AV1-LEB128-
        /// Encoder (siehe `fix_rtp_crate_leb128_bug` unten): jedes explizite
        /// Element-Laengenfeld >=128 wird nicht-standardkonform geschrieben.
        /// Ohne den Fix wuerde dieser Test also einen Fehler im *Generator*
        /// als Fehler im Depacketizer melden. Der Fix korrigiert nur die
        /// Laengenfeld-Bytes, laesst die eigentliche Fragmentierungs-
        /// Entscheidung (welches Byte in welches Paket, Z/Y, W) des
        /// Payloaders unveraendert -- die bleibt damit weiter der echte
        /// Pruefgegenstand.
        fn packetize(unit: &[u8], mtu: usize) -> Vec<(Bytes, bool)> {
            let mut p = Av1Payloader::default();
            let payloads =
                p.payload(mtu, &Bytes::copy_from_slice(unit)).expect("Payloader darf nicht fehlschlagen");
            let n = payloads.len();
            payloads
                .into_iter()
                .enumerate()
                .map(|(i, b)| (fix_rtp_crate_leb128_bug(&b), i + 1 == n))
                .collect()
        }

        /// 1:1-Kopie von `rtp` 0.17.2s `codecs::av1::leb128::{encode_leb128,
        /// put_leb128}` -- bewusst NICHT der Fix, sondern die exakte (kaputte)
        /// Vorlage. Wichtig: `decode_leb128` aus demselben Crate ist NICHT die
        /// Umkehrung davon (die liest korrektes Standard-LEB128, s. Fund
        /// unten) -- die einzig sichere Umkehr-Richtung ist ein Nachschlagen
        /// gegen diese Vorwaerts-Funktion selbst.
        fn crate_put_leb128_bytes(n: u32) -> Vec<u8> {
            let mut encoded = {
                let mut val = n;
                let mut b: u32 = 0;
                loop {
                    b |= val & 0x7f;
                    val >>= 7;
                    if val != 0 {
                        b |= 0x80;
                        b <<= 8;
                    } else {
                        break;
                    }
                }
                b
            };
            let mut out = Vec::new();
            while encoded >= 0x80 {
                out.push((0x80 | (encoded & 0x7f)) as u8);
                encoded >>= 7;
            }
            out.push(encoded as u8);
            out
        }

        /// Liest ein Laengenfeld, das mit `rtp` 0.17.2s kaputtem
        /// `put_leb128` geschrieben wurde: Byte-Grenzen ueber das
        /// Continuation-Bit finden (das haelt die Vorlage korrekt ein),
        /// den eigentlichen WERT aber per Nachschlagetabelle gegen
        /// `crate_put_leb128_bytes` rekonstruieren statt zu dekodieren --
        /// s. Doku dort, warum Dekodieren hier nicht funktioniert.
        fn buggy_crate_read_len(buf: &[u8]) -> (usize, usize) {
            let n = buf.iter().take_while(|&&b| b & 0x80 != 0).count() + 1;
            let wire = &buf[..n];
            for candidate in 0u32..=200_000 {
                if crate_put_leb128_bytes(candidate) == wire {
                    return (candidate as usize, n);
                }
            }
            panic!("keine Laenge <=200000 ergibt diese Bytes: {wire:02x?} -- Bug-Nachbau falsch oder Fragment zu gross");
        }

        /// FUND: `rtp` 0.17.2s `codecs::av1::leb128::encode_leb128` packt jede
        /// 7-Bit-Gruppe in ein volles 8-Bit-Byte-Slot eines `u32` (schiebt mit
        /// `<<= 8`), aber `put_leb128` liest das Ergebnis anschliessend mit
        /// `>>= 7` wieder aus -- die Fehlausrichtung zwischen 8-Bit-Packung und
        /// 7-Bit-Auslesung erzeugt fuer JEDEN Wert >=128 ein zusaetzliches
        /// Muellbyte statt eines gueltigen LEB128 (`put_leb128(474)` schreibt
        /// z. B. `[0x83, 0xb4, 0x03]` statt der korrekten 2 Byte `[0xda, 0x03]`
        /// -- reproduzierbar per Hand nachgerechnet, s. Testbericht). Betrifft
        /// jedes explizite Element-Laengenfeld (nicht-letzte Elemente bei
        /// W in {1,2,3}, ALLE Elemente bei W=0) mit Laenge >=128 -- bei echtem
        /// Videomaterial praktisch immer der Fall. `Av1Payloader` selbst wird
        /// in Pulse aktuell nirgends produktiv genutzt (nur als Dev-Dependency
        /// hier), daher kein bekannter Praxis-Impact -- aber ein fuer sich
        /// stehender, reproduzierbarer Bug in einer Abhaengigkeit.
        ///
        /// Baut die Nutzlast so um, dass ihre Laengenfelder wieder
        /// standardkonformes LEB128 tragen, damit der (korrekte) Depacketizer
        /// sie lesen kann.
        pub(in crate::depacket::av1) fn fix_rtp_crate_leb128_bug(payload: &Bytes) -> Bytes {
            let aggr = payload[0];
            let w = u32::from((aggr & 0b0011_0000) >> 4);
            let mut rest = &payload[1..];
            let mut out = BytesMut::new();
            out.put_u8(aggr);
            let mut idx = 0u32;
            while !rest.is_empty() {
                idx += 1;
                let is_last = w != 0 && idx == w;
                if is_last {
                    out.put_slice(rest);
                    break;
                }
                let (len, n) = buggy_crate_read_len(rest);
                write_leb128(&mut out, len as u32);
                out.put_slice(&rest[n..n + len]);
                rest = &rest[n + len..];
            }
            out.freeze()
        }

        /// Kernstueck: pro MTU jede Zugriffseinheit des Fixture-Stroms durch
        /// Payloader -> Assembler schicken und pruefen, dass exakt derselbe
        /// (bereits mit Groessenfeldern versehene) Bitstrom herauskommt.
        /// Kleine MTUs (bis 20 Byte) zwingen den Z/Y-Fragmentierungspfad --
        /// laut Auftrag die fehleranfaelligste Stelle.
        #[test]
        fn rundlauf_gegen_echten_av1_strom() {
            let Some(data) = fixture() else {
                eprintln!("uebersprungen: PULSE_PLAYER_AV1_FIXTURE nicht gesetzt");
                return;
            };
            let units = split_temporal_units(&data);
            assert!(units.len() > 10, "zu wenige Zugriffseinheiten: {}", units.len());

            for &mtu in &[1200usize, 300, 100, 20] {
                let mut assembler = Av1Assembler::new();
                let mut saw_w0 = false;
                let mut saw_w_gt0 = false;
                for (idx, unit) in units.iter().enumerate() {
                    let packets = packetize(unit, mtu);
                    assert!(!packets.is_empty(), "Einheit {idx} ergab keine Pakete (mtu={mtu})");
                    for (payload, _) in &packets {
                        let w = (payload[0] & 0b0011_0000) >> 4;
                        if w == 0 {
                            saw_w0 = true;
                        } else {
                            saw_w_gt0 = true;
                        }
                    }

                    let mut out = None;
                    for (payload, marker) in &packets {
                        out = assembler.push(payload, *marker);
                    }
                    let out = out
                        .unwrap_or_else(|| panic!("Einheit {idx} kam nicht vollstaendig an (mtu={mtu})"));
                    assert_eq!(out.as_ref(), unit.as_slice(), "Einheit {idx} weicht ab (mtu={mtu})");
                }
                eprintln!("mtu={mtu}: W=0 beobachtet={saw_w0}, W>0 beobachtet={saw_w_gt0}");
            }
        }

        /// Findet die erste Zugriffseinheit, die bei `mtu` in mindestens
        /// `min_packets` RTP-Pakete zerfaellt -- Voraussetzung, damit ein
        /// mittleres Paket ueberhaupt etwas kaputt machen kann.
        fn first_fragmented(
            units: &[Vec<u8>],
            mtu: usize,
            min_packets: usize,
        ) -> (usize, Vec<(Bytes, bool)>) {
            units
                .iter()
                .enumerate()
                .map(|(i, u)| (i, packetize(u, mtu)))
                .find(|(_, p)| p.len() >= min_packets)
                .expect("Fixture muss mindestens eine so fragmentierte Einheit enthalten")
        }

        /// Paketverlust wie ihn die echte Pipeline behandelt: der
        /// Jitter-Puffer (`jitter.rs`) erkennt die Sequenznummer-Luecke und
        /// ruft `on_gap()`, BEVOR das naechste Paket ankommt (s.
        /// Modul-Doc oben). Erwartung: die betroffene Einheit wird
        /// verworfen, nicht als Bildmuell ausgeliefert, und der Assembler
        /// erholt sich fuer die naechste Einheit.
        #[test]
        fn paketverlust_mit_gap_meldung_verwirft_einheit_und_erholt_sich() {
            let Some(data) = fixture() else {
                eprintln!("uebersprungen: PULSE_PLAYER_AV1_FIXTURE nicht gesetzt");
                return;
            };
            let units = split_temporal_units(&data);
            let mtu = 100;
            let (unit_idx, packets) = first_fragmented(&units, mtu, 3);

            let mut assembler = Av1Assembler::new();
            for unit in &units[..unit_idx] {
                for (payload, marker) in packetize(unit, mtu) {
                    assembler.push(&payload, marker);
                }
            }

            // Ein mittleres Fragment (Index 1) faellt weg; der Aufrufer meldet
            // das sofort per on_gap(), wie es der Jitter-Puffer tut.
            assembler.push(&packets[0].0, packets[0].1);
            assembler.on_gap();
            let mut out = None;
            for (payload, marker) in &packets[2..] {
                out = assembler.push(payload, *marker);
            }
            assert!(out.is_none(), "Einheit mit gemeldeter Luecke darf nicht ausgeliefert werden");

            let Some(next_unit) = units.get(unit_idx + 1) else {
                eprintln!("keine Folge-Einheit fuer den Erholungs-Check vorhanden");
                return;
            };
            let mut out = None;
            for (payload, marker) in packetize(next_unit, mtu) {
                out = assembler.push(&payload, marker);
            }
            assert_eq!(
                out.as_deref(),
                Some(next_unit.as_slice()),
                "Assembler muss sich nach der Luecke fuer die naechste Einheit erholen"
            );
        }

        /// Isoliert die interne Z/Y-Fortsetzungspruefung OHNE externe
        /// Luecken-Meldung -- also einen (hypothetischen) Aufrufer, der sich
        /// nicht wie `jitter.rs` auf RTP-Sequenznummern verlaesst, sondern
        /// nur Pakete durchreicht. Dokumentiert, ob Z/Y allein einen
        /// verlorenen *mittleren* Fragment-Teil erkennt: das ueberlebende
        /// Fortsetzungspaket traegt in diesem Fall selbst Z=1, weil es aus
        /// Senderperspektive tatsaechlich eine Fortsetzung ist -- nur eben
        /// nicht die, die der Assembler zuletzt gesehen hat.
        #[test]
        fn mittleres_fragment_ohne_gap_meldung_dokumentiert_verhalten() {
            let Some(data) = fixture() else {
                eprintln!("uebersprungen: PULSE_PLAYER_AV1_FIXTURE nicht gesetzt");
                return;
            };
            let units = split_temporal_units(&data);
            let mtu = 100;
            let (unit_idx, packets) = first_fragmented(&units, mtu, 3);

            let mut assembler = Av1Assembler::new();
            for unit in &units[..unit_idx] {
                for (payload, marker) in packetize(unit, mtu) {
                    assembler.push(&payload, marker);
                }
            }

            // Paket 1 (mittleres Fragment) wird stillschweigend uebersprungen --
            // KEIN on_gap()-Aufruf, anders als im Test oben.
            assembler.push(&packets[0].0, packets[0].1);
            let mut out = None;
            for (payload, marker) in &packets[2..] {
                out = assembler.push(payload, *marker);
            }

            match out {
                None => eprintln!(
                    "mittleres Fragment ohne Gap-Meldung: Assembler hat verworfen (Z/Y hat die Luecke erkannt)"
                ),
                Some(bytes) => {
                    let matches_original = bytes.as_ref() == units[unit_idx].as_slice();
                    eprintln!(
                        "mittleres Fragment ohne Gap-Meldung: Assembler hat {} Byte ausgeliefert, identisch mit Original={matches_original}",
                        bytes.len()
                    );
                }
            }
        }

        /// Ende-zu-Ende-Nachweis: rekonstruierten Strom (Temporal Delimiter
        /// wieder eingefuegt) durch `ffprobe -f obu` dekodieren lassen und
        /// die Bildanzahl mit dem Original vergleichen. Deckt genau die
        /// Sorge aus dem Modul-Doc ab: falsch wieder eingesetzte
        /// Groessenfelder wuerden den Decoder typischerweise mitten im
        /// Strom aussteigen lassen (weniger Bilder als das Original).
        #[test]
        fn rekonstruktion_decodiert_gleich_viele_bilder() {
            let Ok(fixture_path) = std::env::var("PULSE_PLAYER_AV1_FIXTURE") else {
                eprintln!("uebersprungen: PULSE_PLAYER_AV1_FIXTURE nicht gesetzt");
                return;
            };
            let data = std::fs::read(&fixture_path).expect("Fixture lesbar");
            let units = split_temporal_units(&data);
            let mtu = 300;

            let mut assembler = Av1Assembler::new();
            let mut out = Vec::new();
            let td = [(OBU_TYPE_TEMPORAL_DELIMITER << 3) | OBU_HAS_SIZE_BIT, 0x00];
            for (idx, unit) in units.iter().enumerate() {
                let mut assembled = None;
                for (payload, marker) in packetize(unit, mtu) {
                    assembled = assembler.push(&payload, marker);
                }
                let assembled =
                    assembled.unwrap_or_else(|| panic!("Einheit {idx} unvollstaendig (kein Verlust hier)"));
                out.extend_from_slice(&td);
                out.extend_from_slice(&assembled);
            }

            let recon_path = std::env::temp_dir().join("pulse-player-av1-roundtrip-recon.obu");
            std::fs::write(&recon_path, &out).expect("Rekonstruktion schreibbar");

            let count_frames = |path: &std::path::Path| -> u32 {
                let output = std::process::Command::new("ffprobe")
                    .args([
                        "-f",
                        "obu",
                        "-v",
                        "error",
                        "-count_frames",
                        "-select_streams",
                        "v:0",
                        "-show_entries",
                        "stream=nb_read_frames",
                        "-of",
                        "csv=p=0",
                    ])
                    .arg(path)
                    .output()
                    .expect("ffprobe ausfuehrbar");
                assert!(
                    output.status.success(),
                    "ffprobe fehlgeschlagen fuer {path:?}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse()
                    .unwrap_or_else(|e| panic!("Frame-Zahl von ffprobe nicht parsebar: {e}"))
            };

            let orig_count = count_frames(std::path::Path::new(&fixture_path));
            let recon_count = count_frames(&recon_path);
            assert_eq!(recon_count, orig_count, "Rekonstruktion hat andere Bildanzahl als das Original");
        }
    }
}

#[cfg(test)]
mod explore {
    use super::*;
    use rtp::codecs::av1::Av1Payloader;
    use rtp::packetizer::Payloader;

    fn leb(v: u32) -> Vec<u8> {
        let mut b = BytesMut::new();
        write_leb128(&mut b, v);
        b.to_vec()
    }

    /// (typ, ext_byte: Option<u8>, payload)
    fn synth_unit(obus: &[(u8, Option<u8>, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (t, ext, pl) in obus {
            let mut header = t << 3 | OBU_HAS_SIZE_BIT;
            if ext.is_some() {
                header |= OBU_HAS_EXTENSION_BIT;
            }
            out.push(header);
            if let Some(e) = ext {
                out.push(*e);
            }
            out.extend_from_slice(&leb(pl.len() as u32));
            out.extend_from_slice(pl);
        }
        out
    }

    fn packetize(unit: &[u8], mtu: usize) -> Vec<(Bytes, bool)> {
        let mut p = Av1Payloader::default();
        let payloads = p.payload(mtu, &Bytes::copy_from_slice(unit)).expect("payload");
        let n = payloads.len();
        payloads
            .into_iter()
            .enumerate()
            .map(|(i, b)| (super::tests::roundtrip::fix_rtp_crate_leb128_bug(&b), i + 1 == n))
            .collect()
    }

    fn run(label: &str, unit: &[u8], mtu: usize) {
        let pkts = packetize(unit, mtu);
        let ws: Vec<u8> = pkts.iter().map(|(p, _)| (p[0] & 0b0011_0000) >> 4).collect();
        let zs: Vec<u8> = pkts.iter().map(|(p, _)| (p[0] & 0b1000_0000) >> 7).collect();
        let ys: Vec<u8> = pkts.iter().map(|(p, _)| (p[0] & 0b0100_0000) >> 6).collect();
        let mut a = Av1Assembler::new();
        let mut out = None;
        for (p, m) in &pkts {
            out = a.push(p, *m);
        }
        let ok = out.as_deref() == Some(unit);
        eprintln!(
            "{label} mtu={mtu} pakete={} W={ws:?} Z={zs:?} Y={ys:?} -> ok={ok} (got {:?} bytes, want {})",
            pkts.len(),
            out.as_ref().map(|o| o.len()),
            unit.len()
        );
    }

    #[test]
    fn probe() {
        // 5 kleine OBUs in ein Paket -> W=0 erzwungen
        let five = synth_unit(&[
            (1, None, vec![0x11; 10]),
            (3, None, vec![0x22; 10]),
            (4, None, vec![0x33; 10]),
            (4, None, vec![0x44; 10]),
            (4, None, vec![0x55; 10]),
        ]);
        run("W0-5obus", &five, 1200);
        run("W0-5obus-frag", &five, 30);
        run("W0-5obus-frag2", &five, 12);

        // Extension-Header
        let ext = synth_unit(&[(1, None, vec![0x11; 5]), (6, Some(0x50), vec![0xAB; 400])]);
        for mtu in [1200usize, 300, 100, 20, 8, 5, 4] {
            run("ext", &ext, mtu);
        }

        // Extension-Header, viele -> W=0 mit ext
        let extmany = synth_unit(&[
            (1, Some(0x10), vec![0x11; 200]),
            (3, Some(0x20), vec![0x22; 200]),
            (4, Some(0x30), vec![0x33; 200]),
            (4, Some(0x40), vec![0x44; 200]),
        ]);
        for mtu in [1200usize, 700, 300, 100, 20] {
            run("extmany", &extmany, mtu);
        }

        // Nur ein OBU, sehr gross -> viele Mittelfragmente
        let big = synth_unit(&[(6, None, vec![0x7A; 5000])]);
        for mtu in [1200usize, 100, 20, 4] {
            run("big", &big, mtu);
        }
    }
}
