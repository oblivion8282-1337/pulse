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
///
/// Gilt fuer `unit` **und** `partial` zusammen: ein Sender, der `Y=1` nie
/// zurueckzieht (oder ein mitten in einem Fragment-Lauf verlorenes Marker-Bit),
/// laesst sonst allein `partial` volllaufen, waehrend `unit` bei 0 bleibt.
/// Zweiter Grund: `append_obu_with_size` schreibt die Fragmentlaenge als `u32`
/// ins Groessenfeld — ohne Deckel waere ab 4 GiB eine stille Kuerzung moeglich.
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
///
/// Liefert `false`, wenn das Element in sich widerspruechlich ist und die
/// Einheit deshalb zu verwerfen ist.
fn append_obu_with_size(out: &mut BytesMut, obu: &[u8]) -> bool {
    let Some(&header) = obu.first() else { return true };

    // Temporal Delimiter tragen keine Nutzlast und werden ueber RTP ohnehin
    // weggelassen; ein durchgereichter waere harmlos, aber unnoetig.
    if (header & OBU_TYPE_MASK) >> 3 == OBU_TYPE_TEMPORAL_DELIMITER {
        return true;
    }

    let header_len = if header & OBU_HAS_EXTENSION_BIT != 0 { 2 } else { 1 };

    if header & OBU_HAS_SIZE_BIT != 0 {
        // Bis 2026-08-08 wurde hier bedingungslos `put_slice(obu)` gemacht:
        // "traegt schon ein Groessenfeld, also unveraendert uebernehmen". Das
        // war zu gutglaeubig — verbindlich ist die RTP-Elementlaenge, und der
        // AV1-RTP-Spezifikation nach MUSS `obu_size` genau dazu passen. Ein
        // fremder Sender bestimmte sonst frei, wo nachgelagerte Parser
        // OBU-Grenzen sehen: mit `obu_size = 1` in einem 400-Byte-Element
        // meldete `recorder::is_keyframe` einen Einstiegspunkt, den es nicht
        // gibt.
        let Some((size, n)) = obu.get(header_len..).and_then(read_leb128) else {
            return false;
        };
        if header_len + n + size as usize != obu.len() {
            return false;
        }
        out.put_slice(obu);
        return true;
    }

    if obu.len() < header_len {
        // Abgeschnitten, unbrauchbar. Bleibt wie gehabt ein stilles
        // Weglassen — der Fall gehoert zum Fragment-Zustand, nicht zum
        // mitgelieferten Groessenfeld.
        return true;
    }
    let payload = &obu[header_len..];

    out.put_u8(header | OBU_HAS_SIZE_BIT);
    if header_len == 2 {
        out.put_u8(obu[1]);
    }
    write_leb128(out, payload.len() as u32);
    out.put_slice(payload);
    true
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
    /// Seit dem letzten Abholen wurde mindestens eine FERTIGE Einheit
    /// weggeworfen.
    ///
    /// **Warum das neben `poisoned` noch noetig ist.** `poisoned` beschreibt
    /// die Einheit im Aufbau und ist mit ihr wieder weg; diese Meldung
    /// ueberlebt sie und geht nach aussen. `push` gibt naemlich fuer beides
    /// dasselbe `None` zurueck — „noch nicht fertig" und „weggeworfen" —, und
    /// der Aufrufer muss den Unterschied kennen: nur der zweite Fall ist ein
    /// Grund, beim Sender ein Vollbild anzufordern.
    verworfen: bool,
}

impl Av1Assembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Meldet einen Paketverlust. Die laufende Einheit wird verworfen, weil
    /// sie ohne das fehlende Fragment keinen gueltigen Bitstrom mehr ergibt.
    pub fn on_gap(&mut self) {
        // Eine angefangene Einheit geht hier verloren, und das ist ein Verlust
        // wie jeder andere. Gemeldet wird trotzdem erst beim Marker (in
        // `push`): sonst zaehlte ein Verlust, den der Jitter-Puffer ohnehin
        // schon gemeldet hat, ein zweites Mal — und die Meldung soll heissen
        // „eine Einheit ist ausgefallen", nicht „es gab ein Ereignis".
        self.reset();
        self.poisoned = true;
    }

    /// Wurde seit dem letzten Aufruf eine fertige Einheit weggeworfen?
    /// Holt die Meldung ab und loescht sie.
    pub fn verworfen_abholen(&mut self) -> bool {
        std::mem::take(&mut self.verworfen)
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

        if self.unit.len() + self.partial.len() > MAX_TEMPORAL_UNIT_BYTES {
            self.reset();
            self.poisoned = true;
        }

        if !marker {
            return None;
        }

        // Marker = Ende der Zugriffseinheit. Sagt dasselbe Paket ueber `Y`
        // zugleich "der letzte OBU wird fortgesetzt", widerspricht es sich
        // selbst: der Flush unten schriebe die Bruchstuecklaenge als LEB128
        // und behauptete damit, das halbe Fragment sei ein vollstaendiger OBU.
        // Ueberall sonst antwortet der Zusammensetzer auf eine Inkonsistenz
        // mit `poisoned`; dieser Widerspruch rutschte bis 2026-08-08 durch.
        if self.expect_continuation {
            self.poisoned = true;
        }
        self.flush_partial();
        self.expect_continuation = false;
        let poisoned = std::mem::take(&mut self.poisoned);
        let out = self.unit.split().freeze();
        // Eine Einheit, die es bis zum Marker geschafft hat und trotzdem nicht
        // herausgeht, ist ausgefallenes BILD — der einzige Punkt, an dem der
        // Zusammensetzer das sicher weiss. Leere Einheiten zaehlen nicht mit:
        // da war nichts, was verloren gehen konnte.
        if poisoned && !out.is_empty() {
            self.verworfen = true;
        }
        (!poisoned && !out.is_empty()).then_some(out)
    }

    fn flush_partial(&mut self) {
        if self.partial.is_empty() {
            return;
        }
        let obu = self.partial.split();
        if !append_obu_with_size(&mut self.unit, &obu) {
            self.poisoned = true;
        }
    }
}

#[cfg(test)]
mod tests {
    /// Faehrt einen echten RTP-Mitschnitt durch den Zusammensetzer und
    /// schreibt die entstehenden Zugriffseinheiten als rohen AV1-Strom weg.
    ///
    /// **Wofuer.** Am 2026-07-31 hat der Player nach dem Ende einer
    /// Saettigungsphase ein sauber eingefrorenes Bild gezeigt, bei voller
    /// Datenrate, null Paketverlust und laufenden Zaehlern. Der mitgeschriebene
    /// Bitstrom war ab diesem Punkt fuer libdav1d ungueltig ("Invalid repeated
    /// frame header OBU"), waehrend `av1_cuvid` ihn schluckte und stur dasselbe
    /// Bild ausgab. Offen ist, ob der Zusammensetzer aus denselben Paketen
    /// wieder denselben kaputten Strom baut — dann liegt der Fehler hier — oder
    /// einen gueltigen, dann lag es an der Reihenfolge davor.
    ///
    /// Kein regulaerer Test: laeuft nur mit gesetztem `PULSE_TEST_RTPDUMP`.
    #[test]
    fn mitschnitt_durch_den_zusammensetzer() {
        let Ok(pfad) = std::env::var("PULSE_TEST_RTPDUMP") else {
            eprintln!("PULSE_TEST_RTPDUMP nicht gesetzt — uebersprungen");
            return;
        };
        let bytes = std::fs::read(&pfad).expect("Mitschnitt lesbar");
        let pakete = crate::dump::read_dump(&bytes);
        assert!(!pakete.is_empty(), "Mitschnitt ist leer");

        let mut a = Av1Assembler::new();
        let mut strom: Vec<u8> = Vec::new();
        let mut einheiten = 0usize;
        let mut verworfen = 0usize;
        let mut marker = 0usize;
        for (payload, mk) in &pakete {
            if *mk {
                marker += 1;
            }
            match a.push(payload, *mk) {
                Some(unit) => {
                    einheiten += 1;
                    // Mit Laengen-Praefix, damit die Einheitsgrenzen beim
                    // Auswerten erhalten bleiben: der Zusammensetzer verwirft
                    // die Temporal Delimiter (so gewollt), am fertigen Strom
                    // sind die Grenzen danach nicht mehr abzulesen.
                    strom.extend_from_slice(&(unit.len() as u32).to_le_bytes());
                    strom.extend_from_slice(&unit);
                }
                None if *mk => verworfen += 1,
                None => {}
            }
        }
        let ziel = std::env::var("PULSE_TEST_OBU_OUT")
            .unwrap_or_else(|_| crate::ablage::temp_str("assembler-aus.obu"));
        std::fs::write(&ziel, &strom).expect("Ausgabe schreibbar");
        eprintln!(
            "Pakete {} | Marker {} | Einheiten {} | verworfene Einheiten {} | {} Bytes -> {}",
            pakete.len(),
            marker,
            einheiten,
            verworfen,
            strom.len(),
            ziel
        );
    }

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

    /// Der Schaden, den die SEQUENZNUMMERN NICHT verraten.
    ///
    /// MediaMTX vergibt beim Weiterreichen neue Sequenznummern (belegt im
    /// Kopf von `0003-flexfec-on-whep.patch`). Verwirft es selbst ein Bild,
    /// weil ihm Pakete fehlten, kommt der Rest hier LUECKENLOS gezaehlt an —
    /// weder der Jitter-Puffer noch die Sequenzpruefung im Wrapper sehen
    /// etwas. Der einzige Zeuge ist `Z` gegen `expect_continuation`.
    ///
    /// **Und genau dieser Zeuge schwieg bis 2026-08-21.** Die Einheit wurde
    /// richtig verworfen, aber `push` gibt fuer „verworfen" dasselbe `None`
    /// zurueck wie fuer „noch nicht fertig"; `session.rs` konnte beides nicht
    /// unterscheiden und forderte kein Vollbild an. Mit `av1_cuvid` — das
    /// kaputte Daten schluckt statt sie abzulehnen — blieb danach niemand
    /// uebrig, der die Erholung angestossen haette.
    #[test]
    fn verworfene_einheit_wird_gemeldet() {
        let mut a = Av1Assembler::new();
        let header = 6u8 << 3;

        let mut p1 = vec![0b0101_0000]; // Z=0 Y=1 W=1 — wird fortgesetzt
        p1.extend_from_slice(&[header, 0xAA]);
        assert!(a.push(&p1, false).is_none(), "ohne Marker noch keine Einheit");
        assert!(!a.verworfen_abholen(), "eine UNFERTIGE Einheit ist kein Verlust");

        // Die Fortsetzung fehlt: dieses Paket faengt neu an (Z=0), obwohl eine
        // Fortsetzung erwartet war. Sequenznummern spielen hier keine Rolle.
        let mut p2 = vec![0b0001_0000];
        p2.extend_from_slice(&[header, 0xBB]);
        assert!(a.push(&p2, true).is_none(), "vergiftete Einheit darf nicht heraus");
        assert!(a.verworfen_abholen(), "der Verlust muss nach aussen gemeldet werden");
        assert!(!a.verworfen_abholen(), "abgeholt ist abgeholt — kein Dauerzustand");
    }

    /// Gegenprobe: eine heile Einheit darf keinen Verlust melden. Ohne sie
    /// pruefte der Test darueber nur, dass die Meldung ueberhaupt kommt — und
    /// ein `verworfen`, das immer true ist, waere gruen.
    #[test]
    fn heile_einheit_meldet_keinen_verlust() {
        let mut a = Av1Assembler::new();
        let header = 6u8 << 3;
        let mut pkt = vec![0b0001_0000];
        pkt.extend_from_slice(&[header, 0xAA, 0xBB]);
        assert!(a.push(&pkt, true).is_some(), "Einheit ist fertig");
        assert!(!a.verworfen_abholen(), "nichts verworfen, nichts zu melden");
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

    /// Derselbe Zweig, aber fragmentiert — bisher nur im Ein-Paket-Fall
    /// geprueft. Gegen echte Daten laesst er sich nicht testen, weil der
    /// `Av1Payloader` des `rtp`-Crates das Size-Bit ausnahmslos strippt
    /// (`obu.header & !OBU_HAS_SIZE_BIT`); das RTP-Format erlaubt aber auch
    /// Elemente MIT Groessenfeld, ein anderer Sender darf sie also schicken.
    /// Kritisch ist, dass das Groessenfeld beim Zusammensetzen ueber die
    /// Paketgrenze weder verdoppelt noch neu berechnet wird.
    #[test]
    fn vorhandenes_groessenfeld_ueberlebt_fragmentierung() {
        let mut a = Av1Assembler::new();
        let header = (6u8 << 3) | OBU_HAS_SIZE_BIT;
        // Ein OBU mit eigenem Groessenfeld (200 Byte Nutzlast), getrennt
        // mitten im Groessenfeld-Nachbarn: erstes Paket traegt nur Header
        // plus Laengenbyte.
        let nutzlast = vec![0x5Cu8; 200];
        let mut vollstaendig = vec![header];
        vollstaendig.extend_from_slice(&leb(200));
        vollstaendig.extend_from_slice(&nutzlast);

        let mut p1 = vec![0b0101_0000]; // Z=0 Y=1 W=1
        p1.extend_from_slice(&vollstaendig[..3]);
        assert!(a.push(&p1, false).is_none());

        let mut p2 = vec![0b1101_0000]; // Z=1 Y=1 W=1
        p2.extend_from_slice(&vollstaendig[3..100]);
        assert!(a.push(&p2, false).is_none());

        let mut p3 = vec![0b1001_0000]; // Z=1 Y=0 W=1
        p3.extend_from_slice(&vollstaendig[100..]);
        let out = a.push(&p3, true).expect("Einheit fertig");
        assert_eq!(out.as_ref(), vollstaendig.as_slice(), "Groessenfeld unveraendert durchreichen");
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

    /// Reproduktion Befund 14: Marker und `Y` werden unabhaengig behandelt.
    /// Ein Paket, das gleichzeitig "wird fortgesetzt" (Y=1) und "Einheit
    /// endet hier" (Marker) sagt, ist ein Widerspruch — heute flusht der
    /// Marker-Zweig bedingungslos, `append_obu_with_size` schreibt die
    /// Bruchstuecklaenge als LEB128 und behauptet damit, das halbe Fragment
    /// sei ein vollstaendiger OBU. `poisoned` bleibt ungesetzt.
    #[test]
    fn repro_14_marker_mit_y_liefert_bruchstueck_aus() {
        let mut a = Av1Assembler::new();
        let header = 6u8 << 3; // OBU_FRAME, kein Groessenfeld

        // Paket A: Z=0 Y=1 W=1 — erste Haelfte eines OBU.
        let mut p1 = vec![0b0101_0000u8];
        p1.extend_from_slice(&[header, 0xAA, 0xAA]);
        assert!(a.push(&p1, false).is_none(), "ohne Marker noch nichts");

        // Paket B: Z=1 Y=1 (geht weiter!) UND Marker.
        let mut p2 = vec![0b1101_0000u8];
        p2.extend_from_slice(&[0xBB, 0xBB]);
        let out = a.push(&p2, true);
        assert!(
            out.is_none(),
            "Y=1 und Marker widersprechen sich — ausgeliefert wurde {:02X?}",
            out.as_deref()
        );
    }

    /// Reproduktion Befund 28: traegt ein RTP-Element bereits ein
    /// `obu_has_size_field`, uebernimmt `append_obu_with_size` es
    /// byte-gleich, ohne das Feld gegen die verbindliche Elementlaenge zu
    /// halten. Ein fremder Sender bestimmt damit frei, wo nachgelagerte
    /// Parser OBU-Grenzen sehen.
    #[test]
    fn repro_28_gelogenes_obu_size_wird_durchgereicht() {
        let mut a = Av1Assembler::new();
        let header = (6u8 << 3) | OBU_HAS_SIZE_BIT; // OBU_FRAME mit Groessenfeld

        // 400-Byte-Element, dessen Kopf `obu_size = 1` behauptet.
        let mut element = vec![header];
        element.extend_from_slice(&leb(1));
        // Nutzlast, die hinter dem gelogenen Groessenfeld wie ein
        // Keyframe-Einstiegspunkt aussieht: erst ein Frame-Kopf-Byte mit
        // show_existing_frame=0/frame_type=KEY, dann ein Sequence-Header-OBU.
        element.push(0x00);
        element.push((1u8 << 3) | OBU_HAS_SIZE_BIT);
        element.push(0x00);
        element.extend(std::iter::repeat_n(0x5Cu8, 400 - element.len()));
        assert_eq!(element.len(), 400);

        let mut pkt = vec![0b0001_0000u8]; // Z=0 Y=0 W=1
        pkt.extend_from_slice(&element);

        let out = a.push(&pkt, true);
        if let Some(unit) = &out {
            eprintln!(
                "durchgereicht: {} Byte, is_keyframe={}",
                unit.len(),
                crate::recorder::is_keyframe(crate::whep::Codec::Av1, unit)
            );
        }
        assert!(
            out.is_none(),
            "Kopflaenge + LEB128 + obu_size ({}) passt nicht zur Elementlaenge ({})",
            1 + 1 + 1,
            element.len()
        );
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

    /// Regression: die Obergrenze verglich nur `unit`, ein Fragment-Lauf
    /// sammelt aber in `partial` — bei dauerhaft gesetztem `Y` (Sender kaputt
    /// oder Marker mitten im Lauf verloren) blieb `unit` bei 0, waehrend
    /// `partial` unbegrenzt wuchs. Gemessen: 82 MB bei einer Grenze von 32 MB.
    #[test]
    fn fragment_lauf_ohne_marker_waechst_nicht_unbegrenzt() {
        let mut a = Av1Assembler::new();
        let mut erstes = vec![0b0101_0000u8]; // Z=0 Y=1 W=1: Fragment beginnt
        erstes.push(6u8 << 3);
        erstes.extend(std::iter::repeat_n(0xAAu8, 4095));
        assert!(a.push(&erstes, false).is_none());

        // Fortsetzung um Fortsetzung, nie ein Marker.
        let mut weiter = vec![0b1101_0000u8]; // Z=1 Y=1 W=1
        weiter.extend(std::iter::repeat_n(0xAAu8, 4095));
        for _ in 0..20_000 {
            assert!(a.push(&weiter, false).is_none());
        }

        assert!(
            a.unit.len() + a.partial.len() <= MAX_TEMPORAL_UNIT_BYTES,
            "waechst unbegrenzt: unit={} partial={}",
            a.unit.len(),
            a.partial.len()
        );
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
    // Die Fixture ist ein roher OBU-Strom (dieselbe Sorte wie in `recorder.rs`)
    // und erzeugt sich selbst nach `target/av1-fixture.obu`, sofern ffmpeg mit
    // libsvtav1 vorhanden ist. Fehlt ffmpeg, ueberspringen sich die Tests mit
    // Meldung. `PULSE_PLAYER_AV1_FIXTURE=<pfad>` setzt eigenes Material ein.
    mod roundtrip {
        use super::*;
        use rtp::codecs::av1::Av1Payloader;
        use rtp::packetizer::Payloader;

        /// Pfad zur Fixture — vorgegeben oder selbst erzeugt.
        ///
        /// **Warum sie erzeugt wird.** Bis zum 2026-07-28 lief dieser ganze
        /// Block nur, wenn jemand `PULSE_PLAYER_AV1_FIXTURE` gesetzt hatte;
        /// ohne die Variable meldete `cargo test` neun gruene Tests, die in
        /// Wahrheit sofort zurueckkehrten. Ein Test, der sich stillschweigend
        /// ueberspringt, ist keiner — gerade hier nicht, wo es um den
        /// riskantesten Teil des Players geht. Jetzt baut er sich sein Material
        /// selbst und ueberspringt nur noch, wenn ffmpeg fehlt.
        ///
        /// `OnceLock`, weil `cargo test` die Tests nebenlaeufig faehrt: ohne das
        /// erzeugten mehrere gleichzeitig dieselbe Datei.
        fn fixture_path() -> Option<std::path::PathBuf> {
            static CACHE: std::sync::OnceLock<Option<std::path::PathBuf>> =
                std::sync::OnceLock::new();
            let p = CACHE.get_or_init(erzeuge_fixture).clone();
            if p.is_none() {
                eprintln!("uebersprungen: keine AV1-Fixture (ffmpeg mit libsvtav1 noetig)");
            }
            p
        }

        fn erzeuge_fixture() -> Option<std::path::PathBuf> {
            if let Ok(p) = std::env::var("PULSE_PLAYER_AV1_FIXTURE") {
                return Some(std::path::PathBuf::from(p));
            }
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
            let ziel = dir.join("av1-fixture.obu");
            if std::fs::metadata(&ziel).is_ok_and(|m| m.len() > 0) {
                return Some(ziel);
            }
            let _ = std::fs::create_dir_all(&dir);
            // Erst nebenan schreiben, dann umbenennen: sonst hinterliesse ein
            // abgebrochener ffmpeg-Lauf eine halbe Datei, die beim naechsten Mal
            // als gueltige Fixture gilt.
            let temp = dir.join("av1-fixture.obu.teil");
            let status = std::process::Command::new("ffmpeg")
                .args([
                    "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2",
                    "-c:v", "libsvtav1", "-preset", "12", "-f", "obu",
                ])
                .arg(&temp)
                .status()
                .ok()?;
            if !status.success() {
                eprintln!("ffmpeg konnte keine AV1-Fixture erzeugen (libsvtav1 vorhanden?)");
                return None;
            }
            std::fs::rename(&temp, &ziel).ok()?;
            Some(ziel)
        }

        fn fixture() -> Option<Vec<u8>> {
            let p = fixture_path()?;
            Some(std::fs::read(&p).unwrap_or_else(|e| panic!("Fixture {}: {e}", p.display())))
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
        /// Vorlage. Nur als Pruefgegenstand fuer
        /// [`len_from_buggy_crate_wire`]; im Rundlauf selbst wird sie nicht
        /// gebraucht.
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

        /// Liest ein Laengenfeld, das mit `rtp` 0.17.2s kaputtem `put_leb128`
        /// geschrieben wurde, und liefert `(Wert, Feldlaenge in Bytes)`.
        ///
        /// Der Bug besteht aus zwei gegeneinander verschobenen Stufen, also
        /// kehrt das Lesen genau diese zwei Stufen um:
        /// 1. `put_leb128` serialisiert den u32 aus `encode_leb128` in
        ///    7-Bit-Schritten (`>>= 7`) -- zurueck: die 7-Bit-Nutzlasten der
        ///    Draht-Bytes little-endian wieder zu diesem u32 zusammensetzen.
        /// 2. `encode_leb128` hatte die LEB128-Gruppen aber in ganze
        ///    8-Bit-Byte-Slots gepackt (`<<= 8`) -- zurueck: die
        ///    Big-Endian-Bytes dieses u32 sind wieder standardkonformes
        ///    LEB128 und damit fuer [`read_leb128`] lesbar.
        ///
        /// Die Feldlaenge selbst steht am Continuation-Bit: das setzt die
        /// Vorlage korrekt auf allen Bytes ausser dem letzten.
        fn len_from_buggy_crate_wire(buf: &[u8]) -> (usize, usize) {
            let n = buf.iter().take_while(|&&b| b & 0x80 != 0).count() + 1;
            let mut packed: u64 = 0;
            for (i, &b) in buf[..n].iter().enumerate() {
                packed |= u64::from(b & 0x7f) << (7 * i);
            }
            let be = packed.to_be_bytes();
            let first = be.iter().position(|&b| b != 0).unwrap_or(be.len() - 1);
            let (value, _) = read_leb128(&be[first..]).expect("Vorlage schreibt hoechstens 5 Byte");
            (value as usize, n)
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
        fn fix_rtp_crate_leb128_bug(payload: &Bytes) -> Bytes {
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
                let (len, n) = len_from_buggy_crate_wire(rest);
                write_leb128(&mut out, len as u32);
                out.put_slice(&rest[n..n + len]);
                rest = &rest[n + len..];
            }
            out.freeze()
        }

        /// Haelt den Bug-Nachbau ehrlich: [`len_from_buggy_crate_wire`] muss die
        /// exakte Umkehrung von [`crate_put_leb128_bytes`] sein. Ginge das
        /// auseinander, wuerde der Rundlauf mit falsch reparierten Laengen
        /// laufen und trotzdem gruen aussehen, solange sich Schreiben und Lesen
        /// nur gegenseitig konsistent irren.
        #[test]
        fn bug_nachbau_ist_exakt_umkehrbar() {
            for v in [0u32, 1, 127, 128, 129, 474, 1000, 16383, 16384, 100_000, 2_097_151] {
                let wire = crate_put_leb128_bytes(v);
                assert_eq!(
                    len_from_buggy_crate_wire(&wire),
                    (v as usize, wire.len()),
                    "Wert {v}, Draht {wire:02x?}"
                );
            }
            // Der Bug selbst, festgenagelt: ab 128 weicht die Vorlage von
            // Standard-LEB128 ab (und braucht ein Byte mehr als ihr eigenes
            // `leb128_size` reserviert -- daher reisst der Payloader auch die MTU).
            assert_eq!(crate_put_leb128_bytes(127), leb(127), "unter 128 noch korrekt");
            assert_eq!(crate_put_leb128_bytes(474), vec![0x83, 0xb4, 0x03]);
            assert_eq!(leb(474), vec![0xda, 0x03], "so waere es richtig");
        }

        /// Baut einen OBU-Strom mit Groessenfeldern aus
        /// `(Typ, Extension-Byte, Nutzlast)` — dieselbe Form, die
        /// [`split_temporal_units`] aus dem Fixture holt und die der
        /// Assembler zurueckliefern muss.
        fn synth_unit(obus: &[(u8, Option<u8>, Vec<u8>)]) -> Vec<u8> {
            let mut out = Vec::new();
            for (typ, ext, nutzlast) in obus {
                let mut header = (typ << 3) | OBU_HAS_SIZE_BIT;
                if ext.is_some() {
                    header |= OBU_HAS_EXTENSION_BIT;
                }
                out.push(header);
                out.extend(ext.iter().copied());
                out.extend_from_slice(&leb(nutzlast.len() as u32));
                out.extend_from_slice(nutzlast);
            }
            out
        }

        fn assert_rundlauf(unit: &[u8], mtu: usize, label: &str) -> Vec<u8> {
            let packets = packetize(unit, mtu);
            let mut assembler = Av1Assembler::new();
            let mut out = None;
            for (payload, marker) in &packets {
                out = assembler.push(payload, *marker);
            }
            let out = out.unwrap_or_else(|| panic!("{label}: Einheit unvollstaendig (mtu={mtu})"));
            assert_eq!(out.as_ref(), unit, "{label}: weicht ab (mtu={mtu})");
            packets.iter().map(|(p, _)| p[0]).collect()
        }

        /// Deckungsluecke des Fixture-Rundlaufs: `libsvtav1` legt hier nie mehr
        /// als drei OBUs in eine Zugriffseinheit, also setzt der Payloader nie
        /// `W=0` (gemessen: `W=0 beobachtet=false` bei jeder MTU). Genau dann
        /// traegt aber **jedes** Element ein Laengenfeld, auch das letzte —
        /// ein eigener Zweig in `push`, den bisher nur handgebaute Pakete
        /// getroffen haben.
        #[test]
        fn w_null_aus_echtem_payloader() {
            let unit = synth_unit(&[
                (1, None, vec![0x11; 10]),  // SEQUENCE_HEADER
                (3, None, vec![0x22; 10]),  // FRAME_HEADER
                (4, None, vec![0x33; 200]), // TILE_GROUP
                (4, None, vec![0x44; 200]),
                (4, None, vec![0x55; 200]),
            ]);

            let aggr = assert_rundlauf(&unit, 1200, "W0");
            assert_eq!(aggr.len(), 1, "alles in ein Paket, sonst kommt W=0 nicht zustande");
            assert_eq!((aggr[0] & 0b0011_0000) >> 4, 0, "Payloader muss hier W=0 setzen");

            // Und derselbe Strom fragmentiert, damit W=0 auf den Z/Y-Pfad trifft.
            for mtu in [300usize, 100, 30, 12] {
                assert_rundlauf(&unit, mtu, "W0-fragmentiert");
            }
        }

        /// Zweite Deckungsluecke: das Testmaterial hat keine Extension-Header
        /// (`testsrc2` hat keine Temporal-/Spatial-Layer), also blieb der
        /// 2-Byte-Header-Pfad in `append_obu_with_size` gegen echte Pakete
        /// ungetestet. Kritisch ist der Fragment-Fall: der Payloader schreibt
        /// das Extension-Byte bei `obu_offset <= 1` erneut, ein Fragment kann
        /// also genau zwischen Header und Extension-Byte getrennt werden.
        #[test]
        fn extension_header_ueber_paketgrenzen() {
            let unit = synth_unit(&[
                (1, Some(0x10), vec![0x11; 5]),
                (6, Some(0x50), vec![0xAB; 400]),
                (4, Some(0x30), vec![0xCD; 400]),
            ]);
            // 4 Byte MTU laesst pro Paket kaum mehr als Header plus Extension
            // uebrig und trifft damit die Trennung mitten im OBU-Kopf.
            for mtu in [1200usize, 300, 100, 20, 8, 5, 4] {
                assert_rundlauf(&unit, mtu, "Extension");
            }
        }

        /// Kernstueck: pro MTU jede Zugriffseinheit des Fixture-Stroms durch
        /// Payloader -> Assembler schicken und pruefen, dass exakt derselbe
        /// (bereits mit Groessenfeldern versehene) Bitstrom herauskommt.
        /// Kleine MTUs (bis 20 Byte) zwingen den Z/Y-Fragmentierungspfad --
        /// laut Auftrag die fehleranfaelligste Stelle.
        #[test]
        fn rundlauf_gegen_echten_av1_strom() {
            let Some(data) = fixture() else { return };
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

        /// Zerlegt eine Zugriffseinheit in ihre einzelnen OBUs. Moeglich, weil
        /// die Einheiten aus `split_temporal_units` ihre Groessenfelder noch
        /// tragen (sie stammen aus dem `-f obu`-Strom, nicht aus RTP).
        fn split_obus(unit: &[u8]) -> Vec<&[u8]> {
            let mut out = Vec::new();
            let mut i = 0;
            while i < unit.len() {
                let header = unit[i];
                if header & OBU_HAS_SIZE_BIT == 0 {
                    break;
                }
                let mut pos = i + 1 + usize::from(header & OBU_HAS_EXTENSION_BIT != 0);
                let Some((size, n)) = read_leb128(&unit[pos..]) else { break };
                pos += n;
                let end = pos + size as usize;
                if end > unit.len() {
                    break;
                }
                out.push(&unit[i..end]);
                i = end;
            }
            out
        }

        /// Schliesst die letzte Deckungsluecke von `append_obu_with_size`: den
        /// Zweig "Groessenfeld schon vorhanden".
        ///
        /// Der `Av1Payloader` des `rtp`-Crates erreicht ihn prinzipiell nie, weil
        /// er das Bit ausnahmslos strippt (`obu.header & !OBU_HAS_SIZE_BIT`) —
        /// gegen echte Daten war er deshalb ungetestet, obwohl das RTP-Format
        /// Elemente MIT Groessenfeld ausdruecklich zulaesst und ein anderer
        /// Sender sie schicken darf. Bisher deckten ihn nur zwei handgebaute
        /// Pakete mit erfundenen Nutzlasten ab.
        ///
        /// Material sind hier echte OBUs aus der Fixture: echte Header, echte
        /// Groessen (auch mehrbyte-LEB128), echter Aufbau einer Zugriffseinheit.
        /// Nur die Paketierung ist eigen — es gibt keinen fremden Payloader, der
        /// das Groessenfeld stehen laesst. Geprueft wird auf Byte-Gleichheit:
        /// ein doppelt gesetztes oder neu berechnetes Groessenfeld faellt sofort
        /// auf.
        #[test]
        fn echte_obus_mit_groessenfeld_bleiben_byte_gleich() {
            let Some(data) = fixture() else { return };
            let units = split_temporal_units(&data);
            assert!(!units.is_empty(), "Fixture muss Zugriffseinheiten enthalten");

            let mut mehrbyte_gesehen = false;
            let mut obus_gesamt = 0usize;

            for (i, unit) in units.iter().enumerate() {
                let obus = split_obus(unit);
                assert!(!obus.is_empty(), "Einheit {i} liess sich nicht in OBUs zerlegen");
                obus_gesamt += obus.len();
                mehrbyte_gesehen |= obus.iter().any(|o| o.len() >= 128 + 2);

                // (a) Ein OBU je Paket, W=1, keine Fortsetzung.
                let mut a = Av1Assembler::new();
                let mut out = None;
                for (k, obu) in obus.iter().enumerate() {
                    let mut pkt = vec![0b0001_0000u8]; // Z=0 Y=0 W=1
                    pkt.extend_from_slice(obu);
                    out = a.push(&pkt, k + 1 == obus.len());
                }
                assert_eq!(
                    out.as_deref(),
                    Some(unit.as_slice()),
                    "Einheit {i}: W=1 je OBU muss byte-gleich rauskommen"
                );

                // (b) Alle OBUs in EINEM Paket mit W=0 — dann traegt jedes
                // Element ein eigenes Laengenfeld, das der Assembler lesen muss,
                // waehrend die OBUs ihr eigenes Groessenfeld behalten. Zwei
                // Laengenangaben uebereinander, genau der verwechslungsanfaellige
                // Fall.
                let mut a = Av1Assembler::new();
                let mut pkt = vec![0b0000_0000u8]; // Z=0 Y=0 W=0
                for obu in &obus {
                    let mut leb = BytesMut::new();
                    write_leb128(&mut leb, obu.len() as u32);
                    pkt.extend_from_slice(&leb);
                    pkt.extend_from_slice(obu);
                }
                assert_eq!(
                    a.push(&pkt, true).as_deref(),
                    Some(unit.as_slice()),
                    "Einheit {i}: W=0 mit erhaltenen Groessenfeldern muss byte-gleich rauskommen"
                );
            }

            assert!(obus_gesamt >= units.len(), "je Einheit mindestens ein OBU");
            assert!(
                mehrbyte_gesehen,
                "Fixture enthaelt keinen OBU ueber 128 Byte — dann bliebe der \
                 Mehrbyte-LEB128-Pfad ungetestet und der Test waere wertlos"
            );
        }

        /// Paketverlust wie ihn die echte Pipeline behandelt: der
        /// Jitter-Puffer (`jitter.rs`) erkennt die Sequenznummer-Luecke und
        /// ruft `on_gap()`, BEVOR das naechste Paket ankommt (s.
        /// Modul-Doc oben). Erwartung: die betroffene Einheit wird
        /// verworfen, nicht als Bildmuell ausgeliefert, und der Assembler
        /// erholt sich fuer die naechste Einheit.
        #[test]
        fn paketverlust_mit_gap_meldung_verwirft_einheit_und_erholt_sich() {
            let Some(data) = fixture() else { return };
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

        /// Haelt fest, was `Av1Assembler` ALLEIN nicht kann — und begruendet
        /// damit, warum die Sequenzpruefung eine Stufe hoeher noetig ist.
        ///
        /// Faellt ein MITTLERES Fragment weg, traegt das ueberlebende
        /// Fortsetzungspaket selbst `Z=1`: aus Senderperspektive ist es
        /// tatsaechlich eine Fortsetzung, nur nicht die, die der Assembler
        /// zuletzt gesehen hat. Die Z/Y-Pruefung kann das prinzipiell nicht
        /// erkennen — das RTP-Format fuer AV1 fuehrt keinen Fragmentzaehler.
        ///
        /// Der Test ist bewusst als **Festnagelung** geschrieben, nicht als
        /// Wunsch: schlaegt er fehl, weil der Assembler die Luecke ploetzlich
        /// doch erkennt, ist das eine gute Nachricht — dann gehoert diese
        /// Begruendung und die Doku in `depacket/mod.rs` angepasst.
        #[test]
        fn mittleres_fragment_allein_nicht_erkennbar_daher_sequenzpruefung() {
            let Some(data) = fixture() else { return };
            let units = split_temporal_units(&data);
            let mtu = 100;
            let (unit_idx, packets) = first_fragmented(&units, mtu, 3);

            let mut assembler = Av1Assembler::new();
            for unit in &units[..unit_idx] {
                for (payload, marker) in packetize(unit, mtu) {
                    assembler.push(&payload, marker);
                }
            }

            // Paket 1 (mittleres Fragment) faellt weg -- KEIN on_gap().
            assembler.push(&packets[0].0, packets[0].1);
            let mut out = None;
            for (payload, marker) in &packets[2..] {
                out = assembler.push(payload, *marker);
            }

            let bytes = out.expect(
                "Erwartet: der Assembler ALLEIN merkt nichts und liefert aus. \
                 Liefert er nichts, hat sich das Verhalten verbessert -- dann \
                 Doku in depacket/mod.rs und diesen Test anpassen.",
            );
            assert_ne!(
                bytes.as_ref(),
                units[unit_idx].as_slice(),
                "Ohne die fehlenden Bytes kann die Einheit nicht dem Original entsprechen"
            );
        }

        /// Und der Gegenbeweis: durch den ECHTEN Zusammensetzer (der die
        /// Sequenznummern prueft) kommt bei demselben Verlust nichts heraus.
        ///
        /// Das ist die Absicherung des Wegs, den `session.rs` benutzt, und sie
        /// haengt NICHT daran, dass der Jitter-Puffer die Luecke meldet: hier
        /// wird bewusst kein `on_gap()` gerufen, nur die Sequenznummer
        /// uebersprungen.
        #[test]
        fn mittleres_fragment_faengt_die_sequenzpruefung() {
            let Some(data) = fixture() else { return };
            let units = split_temporal_units(&data);
            let mtu = 100;
            let (unit_idx, packets) = first_fragmented(&units, mtu, 3);

            let mut a = crate::depacket::Assembler::for_codec(crate::whep::Codec::Av1);
            let mut seq: u16 = 1;
            for unit in &units[..unit_idx] {
                for (payload, marker) in packetize(unit, mtu) {
                    a.push(seq, &payload, marker);
                    seq = seq.wrapping_add(1);
                }
            }

            a.push(seq, &packets[0].0, packets[0].1);
            seq = seq.wrapping_add(2); // das mittlere Fragment fehlt
            let mut out = None;
            for (payload, marker) in &packets[2..] {
                out = a.push(seq, payload, *marker);
                seq = seq.wrapping_add(1);
            }
            assert!(out.is_none(), "Einheit mit Luecke darf nicht ausgeliefert werden");

            // Und die naechste Einheit muss wieder sauber durchgehen.
            let Some(next_unit) = units.get(unit_idx + 1) else { return };
            let mut out = None;
            for (payload, marker) in packetize(next_unit, mtu) {
                out = a.push(seq, &payload, marker);
                seq = seq.wrapping_add(1);
            }
            assert_eq!(
                out.as_deref(),
                Some(next_unit.as_slice()),
                "nach der Luecke muss sich der Zusammensetzer erholen"
            );
        }

        /// Ende-zu-Ende-Nachweis: rekonstruierten Strom (Temporal Delimiter
        /// wieder eingefuegt) durch `ffprobe -f obu` dekodieren lassen und
        /// die Bildanzahl mit dem Original vergleichen. Deckt genau die
        /// Sorge aus dem Modul-Doc ab: falsch wieder eingesetzte
        /// Groessenfelder wuerden den Decoder typischerweise mitten im
        /// Strom aussteigen lassen (weniger Bilder als das Original).
        #[test]
        fn rekonstruktion_decodiert_gleich_viele_bilder() {
            let Some(fixture_path) = fixture_path() else { return };
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

