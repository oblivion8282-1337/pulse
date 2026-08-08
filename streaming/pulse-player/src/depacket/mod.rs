//! Zusammensetzen von Zugriffseinheiten aus (bereits sortierten) RTP-Paketen.
//!
//! Bewusst nicht ueber `webrtc::media::io::sample_builder::SampleBuilder`:
//! der bringt sein eigenes Umsortieren mit und versteckt damit genau die
//! Puffer-Entscheidung, die dieser Player steuerbar machen soll. Sortiert wird
//! eine Stufe frueher in [`crate::jitter`]; hier geht es nur noch um
//! Codec-Grammatik.

pub mod av1;

use bytes::{Bytes, BytesMut};
use webrtc::rtp::codecs::h264::H264Packet;
use webrtc::rtp::packetizer::Depacketizer;

use crate::whep::Codec;

/// Obergrenze fuer eine im Aufbau befindliche Zugriffseinheit.
///
/// Der AV1-Pfad hat sein eigenes Pendant (`av1::MAX_TEMPORAL_UNIT_BYTES`); hier
/// gilt dasselbe fuer H.264. Ohne die Grenze laesst ein Sender, der nie ein
/// Marker-Bit setzt, den Speicher volllaufen — die Einheit wird ja nur beim
/// Marker freigegeben.
const MAX_ACCESS_UNIT_BYTES: usize = 32 * 1024 * 1024;

/// Codec-abhaengiger Teil des Zusammensetzens.
enum Kind {
    Av1(av1::Av1Assembler),
    H264 { depacketizer: Box<H264Packet>, unit: BytesMut, dropped: bool },
    /// Opus: ein RTP-Paket ist genau ein Frame, nichts zusammenzusetzen.
    Opus,
}

/// Zusammensetzer fuer genau einen Track.
///
/// **Prueft die Sequenznummern selbst.** Der Jitter-Puffer davor meldet Luecken
/// per [`Assembler::on_gap`], und er tut das an allen drei Stellen, an denen er
/// Pakete ueberspringt. Trotzdem haengt die Korrektheit damit an der Sorgfalt
/// des Aufrufers, und die Folge eines vergessenen Aufrufs ist kein Fehler,
/// sondern *stiller Bildmuell*: bei einem verlorenen MITTLEREN Fragment traegt
/// das ueberlebende Fortsetzungspaket selbst `Z=1`, die Z/Y-Pruefung sieht also
/// nichts Verdaechtiges und klebt zwei Haelften verschiedener OBUs zusammen.
/// Gegen echte AV1-Daten gemessen (2026-07-28): 4450 ausgelieferte Byte, nicht
/// identisch mit dem Original.
///
/// Deshalb hier die zweite Linie — sie kostet einen `u16`-Vergleich je Paket
/// und macht die Zusicherung lokal statt verteilt.
pub struct Assembler {
    kind: Kind,
    /// Sequenznummer des zuletzt verarbeiteten Pakets; `None` vor dem ersten.
    last_seq: Option<u16>,
}

impl Assembler {
    pub fn for_codec(codec: Codec) -> Self {
        let kind = match codec {
            Codec::Av1 => Kind::Av1(av1::Av1Assembler::new()),
            Codec::H264 => Kind::H264 {
                depacketizer: Box::new(H264Packet::default()),
                unit: BytesMut::new(),
                dropped: false,
            },
            Codec::Opus => Kind::Opus,
        };
        Self { kind, last_seq: None }
    }

    /// Aktuelle Groesse der im Aufbau befindlichen Einheit — fuer Tests und
    /// Diagnose.
    #[cfg(test)]
    pub fn buffered_len(&self) -> usize {
        match &self.kind {
            Kind::H264 { unit, .. } => unit.len(),
            _ => 0,
        }
    }

    /// Meldet eine Luecke im Paketstrom (der Jitter-Puffer hat aufgegeben).
    /// Angefangene Einheiten werden verworfen — ein halber Frame ergibt keinen
    /// gueltigen Bitstrom.
    pub fn on_gap(&mut self) {
        match &mut self.kind {
            Kind::Av1(a) => a.on_gap(),
            Kind::H264 { unit, dropped, .. } => {
                unit.clear();
                *dropped = true;
            }
            Kind::Opus => {}
        }
    }

    /// Verarbeitet ein Paket; liefert eine fertige Einheit, sobald der Marker
    /// das Ende signalisiert.
    ///
    /// `seq` ist die RTP-Sequenznummer. Ist sie nicht die unmittelbare
    /// Fortsetzung der vorigen, wird die angefangene Einheit verworfen — auch
    /// wenn niemand [`on_gap`](Self::on_gap) gerufen hat. Doppelte Meldung
    /// (Jitter-Puffer *und* diese Pruefung) ist harmlos: beide verwerfen
    /// dasselbe.
    pub fn push(&mut self, seq: u16, payload: &Bytes, marker: bool) -> Option<Bytes> {
        // `wrapping_add`, weil die Sequenznummer bei 65535 umlaeuft — das ist
        // der Normalfall alle gut 18 Minuten bei 60 fps, kein Sonderfall.
        if self.last_seq.is_some_and(|prev| seq != prev.wrapping_add(1)) {
            self.on_gap();
        }
        self.last_seq = Some(seq);

        match &mut self.kind {
            Kind::Av1(a) => a.push(payload, marker),
            Kind::H264 { depacketizer, unit, dropped } => {
                match depacketizer.depacketize(payload) {
                    // Der H264-Depacketizer liefert bereits Annex-B mit
                    // Startcodes; anhaengen reicht.
                    Ok(nal) => unit.extend_from_slice(&nal),
                    Err(_) => *dropped = true,
                }
                if unit.len() > MAX_ACCESS_UNIT_BYTES {
                    // Der Marker ist offenbar verlorengegangen. Verwerfen ist
                    // besser als weiterwachsen.
                    unit.clear();
                    *dropped = true;
                }
                if !marker {
                    return None;
                }
                let bad = std::mem::take(dropped);
                let out = unit.split().freeze();
                (!bad && !out.is_empty()).then_some(out)
            }
            Kind::Opus => (!payload.is_empty()).then(|| payload.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fortlaufende Sequenznummern ab 1 — der Normalfall.
    fn folge(n: u16) -> impl FnMut() -> u16 {
        let mut i = n;
        move || {
            let v = i;
            i = i.wrapping_add(1);
            v
        }
    }

    #[test]
    fn opus_reicht_paket_direkt_durch() {
        let mut a = Assembler::for_codec(Codec::Opus);
        let p = Bytes::from_static(&[1, 2, 3]);
        assert_eq!(a.push(1, &p, true).as_deref(), Some(&[1u8, 2, 3][..]));
    }

    #[test]
    fn opus_verwirft_leere_pakete() {
        let mut a = Assembler::for_codec(Codec::Opus);
        assert!(a.push(1, &Bytes::new(), true).is_none());
    }

    #[test]
    fn h264_sammelt_bis_marker() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);
        // Single-NAL-Unit-Paket (Typ 1), vom Depacketizer mit Startcode versehen.
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        assert!(a.push(seq(), &nal, false).is_none(), "ohne Marker keine Einheit");
        let out = a.push(seq(), &nal, true).expect("Marker schliesst die Einheit ab");
        assert!(out.len() > nal.len(), "beide Pakete muessen drin sein");
    }

    /// Kern der zweiten Verteidigungslinie: ein Aufrufer, der die Luecke NICHT
    /// meldet, darf trotzdem keine zusammengeklebte Einheit bekommen. Ohne
    /// diese Pruefung lieferte der AV1-Pfad gegen echte Daten 4450 Byte
    /// Bildmuell aus (2026-07-28).
    #[test]
    fn sprung_in_der_sequenz_verwirft_auch_ohne_gap_meldung() {
        let mut a = Assembler::for_codec(Codec::H264);
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        a.push(1, &nal, false);
        // 2 fehlt, niemand meldet es.
        assert!(a.push(3, &nal, true).is_none(), "Einheit ueber die Luecke darf nicht raus");
        // Danach wieder regulaer.
        assert!(a.push(4, &nal, true).is_some(), "Erholung nach dem Sprung");
    }

    /// Die Sequenznummer laeuft bei 65535 um — bei 60 fps alle gut 18 Minuten.
    /// Wuerde der Umlauf als Luecke gelten, riss die Wiedergabe regelmaessig ab.
    #[test]
    fn sequenz_umlauf_ist_keine_luecke() {
        let mut a = Assembler::for_codec(Codec::H264);
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        a.push(u16::MAX, &nal, false);
        assert!(a.push(0, &nal, true).is_some(), "65535 -> 0 ist die regulaere Fortsetzung");
    }

    /// Regression: ohne Marker-Bit waechst die H.264-Einheit unbegrenzt.
    /// Der AV1-Pfad hat dafuer eine Obergrenze, der H.264-Pfad hatte keine —
    /// ein Sender, der nie ein Marker-Bit setzt, haette den Speicher
    /// leerlaufen lassen.
    #[test]
    fn h264_einheit_waechst_nicht_unbegrenzt() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);
        let nal = Bytes::from_static(&[0x41; 4096]);
        // Deutlich mehr als die Obergrenze einspeisen, nie ein Marker.
        for _ in 0..20_000 {
            assert!(a.push(seq(), &nal, false).is_none());
        }
        assert!(
            a.buffered_len() <= MAX_ACCESS_UNIT_BYTES,
            "Einheit waechst unbegrenzt: {} Bytes",
            a.buffered_len()
        );
    }

    #[test]
    fn gap_verwirft_h264_einheit() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        a.push(seq(), &nal, false);
        a.on_gap();
        assert!(a.push(seq(), &nal, true).is_none(), "nach Luecke keine Teil-Einheit");
        assert!(a.push(seq(), &nal, true).is_some(), "danach wieder normal");
    }

    /// Reproduktion Befund 3: STAP-A (NAL-Typ 24) mit einem ueberzaehligen
    /// Byte am Ende. Der Depacketizer des `rtp`-Crates prueft in der
    /// Schleifenbedingung nur `curr_offset < packet.len()`, liest im Rumpf
    /// aber `packet[curr_offset]` UND `packet[curr_offset + 1]`. Bleibt genau
    /// ein Byte uebrig, greift der zweite Zugriff hinter den Puffer.
    /// `Err(_) => dropped = true` faengt nur `Result`, keine Panik.
    ///
    /// Erwartet nach der Behebung: der Aufruf kehrt zurueck und liefert `None`
    /// (Einheit verworfen), statt den Sitzungs-Task zu erschlagen.
    #[test]
    #[ignore = "Reproduktion Befund 3 — schlaegt bis zur Behebung absichtlich fehl"]
    fn repro_3_stapa_ueberzaehliges_byte() {
        let mut a = Assembler::for_codec(Codec::H264);
        // 0x18 = NAL-Typ 24 (STAP-A); Laengenfeld 0x0000, dann ein Fuellbyte.
        let out = a.push(1, &Bytes::from_static(&[0x18, 0x00, 0x00, 0xAA]), true);
        assert!(out.is_none(), "kaputtes STAP-A darf keine Einheit ergeben");

        // Gegenprobe: wohlgeformtes STAP-A (ein NAL der Laenge 1) plus ein
        // Fuellbyte — derselbe Weg, nur mit echtem Inhalt davor.
        let mut b = Assembler::for_codec(Codec::H264);
        let out = b.push(1, &Bytes::from_static(&[0x18, 0x00, 0x01, 0x41, 0xAA]), true);
        assert!(out.is_none(), "STAP-A mit Fuellbyte darf keine Einheit ergeben");
    }

    /// Reproduktion Befund 5: `on_gap` leert nur `unit` und setzt `dropped`,
    /// fasst den `fua_buffer` IM `H264Packet` aber nicht an. Ein
    /// Marker-Paket, das selbst kein FU-A-Ende ist, setzt `dropped` zurueck —
    /// die danach folgende, lueckenlose FU-A-NAL uebernimmt dann die alten
    /// Fragmentreste und gilt trotzdem als sauber.
    #[test]
    #[ignore = "Reproduktion Befund 5 — schlaegt bis zur Behebung absichtlich fehl"]
    fn repro_5_gap_laesst_fua_reste_stehen() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);

        // FU-A-Anfang (Indikator 0x7C = Typ 28, S-Bit gesetzt, NAL-Typ 5)
        // mit erkennbarem Fuellmuster — das E-Bit kommt nie.
        let angefangen = Bytes::from_static(&[0x7C, 0x85, 0xAA, 0xAA, 0xAA, 0xAA]);
        assert!(a.push(seq(), &angefangen, false).is_none());

        a.on_gap();

        // Einzelnes NAL mit Marker: schliesst eine Einheit ab und setzt
        // `dropped` zurueck, ohne den `fua_buffer` zu leeren.
        let einzeln = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        assert!(a.push(seq(), &einzeln, true).is_none(), "verworfene Einheit nach der Luecke");

        // Jetzt eine vollstaendige, lueckenlose FU-A-IDR.
        assert!(a.push(seq(), &Bytes::from_static(&[0x7C, 0x85, 0x11, 0x22]), false).is_none());
        let out = a
            .push(seq(), &Bytes::from_static(&[0x7C, 0x45, 0x33, 0x44]), true)
            .expect("die heile IDR muss ausgeliefert werden");

        assert!(
            !out.windows(2).any(|w| w == [0xAA, 0xAA]),
            "Reste der abgebrochenen FU-A stecken in der IDR: {out:02X?}"
        );
    }

    /// Reproduktion Befund 13: der H.264-Deckel misst nur `unit`. Das
    /// Gegenstueck zu AV1s `partial` liegt hier als `fua_buffer` im
    /// `H264Packet` und wird erst beim E-Bit herausgegeben — bis dahin
    /// liefert `depacketize` ein leeres `Ok` und `unit` bleibt 0.
    #[test]
    #[ignore = "Reproduktion Befund 13 — schlaegt bis zur Behebung absichtlich fehl"]
    fn repro_13_fua_puffer_waechst_am_deckel_vorbei() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);

        // FU-A-Anfang, danach nur Fortsetzungen — nie ein E-Bit.
        let mut anfang = vec![0x7C, 0x85];
        anfang.extend(std::iter::repeat_n(0xAAu8, 1198));
        assert!(a.push(seq(), &Bytes::from(anfang), false).is_none());

        let mut weiter = vec![0x7C, 0x05];
        weiter.extend(std::iter::repeat_n(0xAAu8, 1198));
        let weiter = Bytes::from(weiter);
        let mut angehaeuft = 1198usize;
        // Rund 20 MB anhaeufen — unter MAX_ACCESS_UNIT_BYTES, damit die
        // Einheit am Ende ueberhaupt herauskommt.
        for _ in 0..17_500 {
            assert!(a.push(seq(), &weiter, false).is_none());
            angehaeuft += 1198;
        }
        eprintln!("angehaeuft {angehaeuft} Bytes, Deckel sieht buffered_len={}", a.buffered_len());

        // Kleines FU-A-Ende mit Marker.
        let out = a.push(seq(), &Bytes::from_static(&[0x7C, 0x45, 0x33, 0x44]), true);
        let geliefert = out.map_or(0, |u| u.len());
        assert!(
            geliefert <= 4 * 1200,
            "der Deckel hat {angehaeuft} Bytes nicht gesehen — ausgeliefert wurden {geliefert}"
        );
    }

    /// Diagnose, kein Regressionstest: schickt einen echten RTP-Mitschnitt
    /// durch den Assembler und schreibt die entstehenden Einheiten heraus,
    /// damit `testbench/obu-schnitt.py` sie einzeln auf OBU-Syntax pruefen
    /// kann. Bewusst KEIN Nachbau der Pruefung hier — das Werkzeug drueben
    /// ist gegen echte Stroeme geprueft, ein zweiter Parser waere eine
    /// zweite Fehlerquelle.
    ///
    /// Hintergrund: Am 2026-07-29 meldete `libdav1d` 87 Mal "Error parsing
    /// OBU data" in einem Lauf OHNE jede Stoerung, alle nach dem
    /// Einstiegspunkt. Entweder liefert der Assembler kaputte Einheiten,
    /// oder die Meldung ist harmlos — aus dem Log allein nicht zu trennen.
    ///
    /// Laeuft nur mit `PULSE_PLAYER_DUMP_IN`; ohne die Variable **schlaegt er
    /// fehl** statt still gruen zu melden. Ein uebersprungener Test, der wie
    /// ein bestandener aussieht, hat hier schon einmal neun Rundlauf-Tests
    /// monatelang wirkungslos gemacht.
    #[test]
    #[ignore = "Diagnose gegen einen echten Mitschnitt; braucht PULSE_PLAYER_DUMP_IN"]
    fn echter_mitschnitt_ergibt_syntaktisch_heile_einheiten() {
        let quelle = std::env::var("PULSE_PLAYER_DUMP_IN")
            .expect("PULSE_PLAYER_DUMP_IN muss auf ein .rtpdump zeigen");
        let ziel = std::env::var("PULSE_PLAYER_UNITS_OUT")
            .unwrap_or_else(|_| crate::ablage::temp_str("einheiten.bin"));
        let roh = std::fs::read(&quelle).expect("Mitschnitt lesbar");
        let pakete = crate::dump::read_dump(&roh);
        assert!(!pakete.is_empty(), "Mitschnitt {quelle} enthaelt keine Pakete");

        let mut a = Assembler::for_codec(Codec::Av1);
        let mut seq = folge(0);
        let mut raus = Vec::new();
        let mut einheiten = 0usize;
        for (payload, marker) in &pakete {
            // Der Mitschnitt fuehrt die Sequenznummer nicht mit. Im
            // ungestoerten Lauf ist sie lueckenlos, deshalb hier fortlaufend
            // — die Sequenzpruefung des Assemblers wird damit bewusst
            // neutralisiert, geprueft wird das ZUSAMMENSETZEN.
            if let Some(unit) = a.push(seq(), &Bytes::from(payload.clone()), *marker) {
                einheiten += 1;
                raus.extend_from_slice(&(unit.len() as u32).to_le_bytes());
                raus.push(0);
                raus.extend_from_slice(&unit);
            }
        }
        std::fs::write(&ziel, &raus).expect("Einheiten schreibbar");
        eprintln!("{} Pakete -> {einheiten} Einheiten nach {ziel}", pakete.len());
        assert!(einheiten > 0, "keine einzige Einheit zusammengesetzt");
    }
}
