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
///
/// Gilt fuer `unit` **und** die noch nicht herausgegebenen FU-A-Bruchstuecke
/// zusammen (`fua_bytes`, s. dort). Hier stand bis 2026-08-08 nur der erste
/// Halbsatz, und gemessen wurde auch nur `unit.len()` — das war falsch: der
/// AV1-Deckel prueft `unit + partial`, das H.264-Gegenstueck zu `partial` liegt
/// aber als `fua_buffer` IM `H264Packet` und wurde von dieser Grenze gar nicht
/// gesehen (20 966 198 Byte angehaeuft bei durchgehend `unit.len() == 0`).
const MAX_ACCESS_UNIT_BYTES: usize = 32 * 1024 * 1024;

/// Codec-abhaengiger Teil des Zusammensetzens.
enum Kind {
    Av1(av1::Av1Assembler),
    H264 {
        depacketizer: Box<H264Packet>,
        unit: BytesMut,
        dropped: bool,
        /// Mitzaehlung dessen, was im `fua_buffer` des Depacketizers liegt —
        /// das Feld selbst ist modulprivat im `rtp`-Crate (kein Sichtbarkeits-
        /// Attribut, hier stand bis 2026-08-09 faelschlich `pub(crate)`) und
        /// von aussen weder lesbar noch leerbar. Spiegelt dessen Regeln exakt: jedes
        /// FU-A-Paket haengt `payload.len() - 2` an, das E-Bit gibt den Puffer
        /// heraus (und damit auf 0).
        fua_bytes: usize,
    },
    /// Opus: ein RTP-Paket ist genau ein Frame, nichts zusammenzusetzen.
    Opus,
}

/// NAL-Typ 28 = FU-A (fragmentierte NAL-Einheit), RFC 6184 §5.8.
const FUA_NALU_TYPE: u8 = 28;
/// Groesse von FU-Indikator + FU-Kopf; alles danach ist Fragment-Nutzlast.
const FUA_HEADER_SIZE: usize = 2;
/// E-Bit im FU-Kopf: letztes Fragment, der Depacketizer gibt die NAL heraus.
const FU_END_BITMASK: u8 = 0x40;

/// Setzt den H.264-Depacketizer in den Anfangszustand zurueck — der einzige
/// Weg, seinen privaten `fua_buffer` zu leeren.
fn h264_reset(depacketizer: &mut H264Packet, fua_bytes: &mut usize) {
    // `fua_buffer` ist privat, ein Struct-Update-Ausdruck geht deshalb nicht;
    // die einzige oeffentliche Einstellung wird von Hand herueber gerettet.
    let is_avc = depacketizer.is_avc;
    *depacketizer = H264Packet::default();
    depacketizer.is_avc = is_avc;
    *fua_bytes = 0;
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
    /// Seit dem letzten Abholen wurde eine fertige Einheit weggeworfen.
    /// Gesammelt fuer ALLE Codecs an einer Stelle, damit `session.rs` nur den
    /// Wrapper kennen muss (s. [`Assembler::verworfen_abholen`]).
    verworfen: bool,
}

impl Assembler {
    pub fn for_codec(codec: Codec) -> Self {
        let kind = match codec {
            Codec::Av1 => Kind::Av1(av1::Av1Assembler::new()),
            Codec::H264 => Kind::H264 {
                depacketizer: Box::new(H264Packet::default()),
                unit: BytesMut::new(),
                dropped: false,
                fua_bytes: 0,
            },
            Codec::Opus => Kind::Opus,
        };
        Self { kind, last_seq: None, verworfen: false }
    }

    /// Aktuelle Groesse der im Aufbau befindlichen Einheit — fuer Tests und
    /// Diagnose.
    #[cfg(test)]
    pub fn buffered_len(&self) -> usize {
        match &self.kind {
            // Mit den FU-A-Bruchstuecken: genau das, was der Deckel misst.
            Kind::H264 { unit, fua_bytes, .. } => unit.len() + fua_bytes,
            _ => 0,
        }
    }

    /// Meldet eine Luecke im Paketstrom (der Jitter-Puffer hat aufgegeben).
    /// Angefangene Einheiten werden verworfen — ein halber Frame ergibt keinen
    /// gueltigen Bitstrom.
    ///
    /// Dazu gehoert der Zustand **im** Depacketizer: das `H264Packet` haelt in
    /// seinem `fua_buffer` die bisher eingesammelten FU-A-Bruchstuecke und
    /// leert ihn ausschliesslich beim E-Bit. Ohne den Neuaufbau hier ueberlebte
    /// ein abgebrochenes Fragment die Luecke und wurde vor die naechste FU-A-NAL
    /// geklebt — die galt dann als sauber (ein Marker-Paket dazwischen setzt
    /// `dropped` zurueck), und der Decoder stieg auf einer verfaelschten IDR ein.
    pub fn on_gap(&mut self) {
        match &mut self.kind {
            Kind::Av1(a) => a.on_gap(),
            Kind::H264 { depacketizer, unit, dropped, fua_bytes } => {
                unit.clear();
                h264_reset(depacketizer, fua_bytes);
                *dropped = true;
            }
            Kind::Opus => {}
        }
    }

    /// Wurde seit dem letzten Aufruf eine fertige Einheit weggeworfen?
    ///
    /// **Wofuer die Frage da ist.** [`Assembler::push`] antwortet mit `None`
    /// auf zwei voellig verschiedene Lagen: „die Einheit ist noch nicht
    /// fertig" und „die Einheit ist ausgefallen". Der Aufrufer braucht den
    /// Unterschied, denn nur die zweite ist ein Grund, beim Sender ein
    /// Vollbild anzufordern.
    ///
    /// **Warum nicht der Luecken-Pfad reicht.** `session.rs` fordert bisher
    /// nur an, wenn der Jitter-Puffer eine Luecke meldet. MediaMTX vergibt die
    /// Sequenznummern beim Weiterreichen aber NEU (Kopf von
    /// `0003-flexfec-on-whep.patch`): verwirft es selbst ein Bild, kommt der
    /// Rest lueckenlos gezaehlt an, der Jitter-Puffer sieht nichts, und die
    /// Sequenzpruefung im Wrapper ebenso wenig. Der Zusammensetzer ist dann
    /// der EINZIGE, der den Schaden bemerkt — und bis 2026-08-21 hat er ihn
    /// fuer sich behalten.
    ///
    /// Der zweite Weg zur Erholung ist der Decoder: lehnt er die Daten ab,
    /// meldet er „warte auf Einstieg", und die Sitzung fordert nach. Das
    /// traegt aber nur, solange der Decoder ueberhaupt ablehnt. `av1_cuvid`
    /// tut das nicht — es schluckt den Schaden und gibt weiter Bilder aus,
    /// immer dasselbe (s. `decode::VideoDecoder::on_gap`). Damit fiel bei
    /// NVIDIA-Hardware jeder Ausloeser weg, und die Erholung hing allein am
    /// Einfrier-Waechter.
    pub fn verworfen_abholen(&mut self) -> bool {
        std::mem::take(&mut self.verworfen)
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

        // Jeder Zweig meldet zusaetzlich, ob er eine fertige Einheit
        // weggeworfen hat. Als Rueckgabe und nicht per `self.verworfen = true`
        // im Zweig, weil `self.kind` hier ausgeliehen ist — und weil so kein
        // Zweig die Meldung vergessen kann, ohne dass es auffaellt.
        let (verworfen, ergebnis) = match &mut self.kind {
            Kind::Av1(a) => {
                let out = a.push(payload, marker);
                (a.verworfen_abholen(), out)
            }
            Kind::H264 { depacketizer, unit, dropped, fua_bytes } => {
                match depacketizer.depacketize(payload) {
                    // Der H264-Depacketizer liefert bereits Annex-B mit
                    // Startcodes; anhaengen reicht.
                    Ok(nal) => {
                        // Buchfuehrung ueber den fremden `fua_buffer`: nur ein
                        // angenommenes FU-A-Paket hat ihn veraendert (bei einem
                        // `Err` bleibt er unberuehrt), und `payload.len() > 2`
                        // ist dann vom Depacketizer schon geprueft.
                        if payload[0] & 0x1F == FUA_NALU_TYPE {
                            if payload[1] & FU_END_BITMASK != 0 {
                                *fua_bytes = 0;
                            } else {
                                *fua_bytes += payload.len() - FUA_HEADER_SIZE;
                            }
                        }
                        unit.extend_from_slice(&nal);
                    }
                    // Verworfenes Paket: der Depacketizer-Zustand gehoert mit
                    // weg. Hier stand bis 2026-08-08 nur `*dropped = true` —
                    // das war ein DRITTER Weg zu genau dem Bildmuell aus
                    // Befund 5, und einer, den die Gegenstelle allein waehlen
                    // kann: FU-A-Anfang ohne Ende, dann ein Paket mit einem
                    // unbehandelten NAL-Typ (0x7D = FU-B, ebenso Typ 0/30/31
                    // oder eine auf zwei Byte gekuerzte FU-A). Das gibt `Err`,
                    // setzt `dropped` — aber `on_gap` ruft niemand, denn die
                    // Sequenznummern sind lueckenlos. Ein einzelnes NAL mit
                    // Marker verzehrt danach `dropped`, und die naechste,
                    // voellig saubere FU-A-IDR kommt mit den Resten davor
                    // heraus und gilt als heil — `decode.rs` hebt darauf sein
                    // `awaiting_keyframe` auf und steigt auf einer
                    // verfaelschten IDR ein.
                    Err(_) => {
                        h264_reset(depacketizer, fua_bytes);
                        *dropped = true;
                    }
                }
                if unit.len() + *fua_bytes > MAX_ACCESS_UNIT_BYTES {
                    // Der Marker ist offenbar verlorengegangen. Verwerfen ist
                    // besser als weiterwachsen — samt der Bruchstuecke im
                    // Depacketizer, die sonst spaeter doch noch herauskaemen.
                    unit.clear();
                    h264_reset(depacketizer, fua_bytes);
                    *dropped = true;
                }
                if !marker {
                    return None;
                }
                let bad = std::mem::take(dropped);
                let out = unit.split().freeze();
                // Wie im AV1-Zweig: bis zum Marker gekommen und trotzdem nicht
                // herausgegangen heisst ausgefallenes Bild.
                let verworfen = bad && !out.is_empty();
                (verworfen, (!bad && !out.is_empty()).then_some(out))
            }
            // Ton kennt keine Einheit, die ausfallen koennte — und darf
            // deshalb nie eine Vollbild-Anforderung ausloesen. Genau daran ist
            // der Luecken-Pfad am 2026-07-28 schon einmal gescheitert.
            Kind::Opus => (false, (!payload.is_empty()).then(|| payload.clone())),
        };
        self.verworfen |= verworfen;
        ergebnis
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

    /// Der Wrapper muss die Meldung durchreichen — fuer JEDEN Codec.
    ///
    /// `session.rs` kennt nur ihn, nicht die einzelnen Zusammensetzer. Bliebe
    /// die Meldung im AV1-Zweig stecken, haette H.264 dieselbe stille
    /// Erholungsluecke weiter; der Fehler war nie ein AV1-Fehler, sondern
    /// einer der Unterscheidung „unfertig" gegen „weggeworfen".
    #[test]
    fn verworfene_einheit_kommt_durch_den_wrapper() {
        let mut a = Assembler::for_codec(Codec::H264);
        let nal = Bytes::from_static(&[0x41, 0x9A, 0x00]);
        a.push(1, &nal, false);
        assert!(!a.verworfen_abholen(), "unfertig ist kein Verlust");
        // 2 fehlt — hier faengt es die Sequenzpruefung, im echten Fall (neu
        // vergebene Nummern) der Zusammensetzer selbst. Beide Wege muessen in
        // derselben Meldung enden.
        assert!(a.push(3, &nal, true).is_none(), "Einheit ueber die Luecke bleibt drin");
        assert!(a.verworfen_abholen(), "und wird gemeldet");
        assert!(!a.verworfen_abholen(), "abgeholt ist abgeholt");

        assert!(a.push(4, &nal, true).is_some(), "danach wieder regulaer");
        assert!(!a.verworfen_abholen(), "eine heile Einheit meldet nichts");
    }

    /// Opus hat keine Einheiten, die verloren gehen koennten — und darf
    /// deshalb auch nie eine Vollbild-Anforderung ausloesen. Genau daran ist
    /// der Luecken-Pfad am 2026-07-28 schon einmal gescheitert (eine Tonluecke
    /// riss das Bild mit).
    #[test]
    fn opus_meldet_nie_einen_verlust() {
        let mut a = Assembler::for_codec(Codec::Opus);
        let leer = Bytes::new();
        assert!(a.push(1, &leer, true).is_none(), "leeres Paket faellt weg");
        assert!(!a.verworfen_abholen(), "aber das ist kein Bildverlust");
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
    ///
    /// Ein verworfenes Paket muss den Depacketizer-Zustand mitnehmen.
    ///
    /// Der dritte Weg zu dem Bildmuell aus Befund 5, gefunden von der
    /// Gegenprobe zu dessen Behebung: er kommt ohne jede Luecke aus, die
    /// Sequenznummern sind durchgehend, `on_gap` ruft also niemand. Es genuegt
    /// ein Paket mit einem NAL-Typ, den der Depacketizer nicht behandelt.
    #[test]
    fn verworfenes_paket_leert_die_fua_reste() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);

        // FU-A-Anfang mit Muell-Fuellung, kein E-Bit.
        let mut anfang = vec![0x7C, 0x85];
        anfang.extend(std::iter::repeat_n(0xAAu8, 40));
        assert!(a.push(seq(), &Bytes::from(anfang), false).is_none());

        // NAL-Typ 29 (FU-B) — der Depacketizer behandelt ihn nicht und gibt
        // `Err`. KEINE Luecke: die Sequenznummer ist die naechste.
        assert!(a.push(seq(), &Bytes::from_static(&[0x7D, 0x85, 0x00]), false).is_none());

        // Einzelnes NAL mit Marker: verzehrt `dropped`, reine Weste danach.
        assert!(a.push(seq(), &Bytes::from_static(&[0x41, 0x11, 0x22]), true).is_none());

        // Eine vollstaendige, saubere FU-A-IDR mit anderem Fuellbyte.
        let mut neu_anfang = vec![0x7C, 0x85];
        neu_anfang.extend(std::iter::repeat_n(0xBBu8, 8));
        assert!(a.push(seq(), &Bytes::from(neu_anfang), false).is_none());
        let mut neu_ende = vec![0x7C, 0x45];
        neu_ende.extend(std::iter::repeat_n(0xBBu8, 8));
        let einheit = a
            .push(seq(), &Bytes::from(neu_ende), true)
            .expect("die saubere FU-A muss herauskommen");

        assert!(
            !einheit.contains(&0xAA),
            "die Reste des verworfenen Fragments kleben vor der neuen IDR: {einheit:02x?}"
        );
    }

    /// **Zwei Entwuerfe dieses Tests waren wertlos, beide aus demselben Grund**
    /// — sie massen, was der Assembler NICHT liefert, und das tut er in beiden
    /// Fassungen nicht:
    ///
    /// 1. Der erste haeufte 17 500 Fortsetzungen an (20 MB, unter dem 32-MB-
    ///    Deckel) und forderte `geliefert <= 4800`. Unerfuellbar: eine Einheit
    ///    unter dem Deckel DARF herauskommen, auch nach der Behebung.
    /// 2. Der zweite ueberschritt den Deckel und forderte dasselbe. Er bestand
    ///    dann in BEIDEN Fassungen — nachgemessen am 2026-08-08, indem der
    ///    Deckel auf `unit.len()` zurueckgedreht wurde: ohne Behebung
    ///    materialisiert das E-Bit die ganze Riesen-NAL auf einmal in `unit`,
    ///    und dort greift der ALTE Deckel dann eben doch. Ausgeliefert wird so
    ///    oder so nichts, die Zusicherung war unfehlbar statt unterscheidend.
    ///
    /// Der Unterschied liegt nicht im Deckel-Paket selbst, sondern **danach**:
    /// mit der Behebung ist der fremde `fua_buffer` beim Ueberschreiten mit
    /// geleert, die naechste saubere FU-A kommt unverfaelscht heraus. Ohne sie
    /// klebt der ganze Rest davor, und die naechste Einheit ist entweder
    /// verseucht oder faellt selbst dem Deckel zum Opfer. Also wird hier
    /// gemessen, ob nach dem Ueberlauf wieder ein BRAUCHBARES Bild entsteht.
    #[test]
    fn repro_13_fua_puffer_waechst_am_deckel_vorbei() {
        let mut a = Assembler::for_codec(Codec::H264);
        let mut seq = folge(1);

        // FU-A-Anfang, danach nur Fortsetzungen — nie ein E-Bit. Fuellbyte
        // 0xAA, damit sich dieser Muell spaeter im Ergebnis wiedererkennen
        // laesst.
        let mut anfang = vec![0x7C, 0x85];
        anfang.extend(std::iter::repeat_n(0xAAu8, 1198));
        assert!(a.push(seq(), &Bytes::from(anfang), false).is_none());

        let mut weiter = vec![0x7C, 0x05];
        weiter.extend(std::iter::repeat_n(0xAAu8, 1198));
        let weiter = Bytes::from(weiter);

        // Anhaeufen, bis der Deckel greift — erkennbar daran, dass die
        // gemessene Menge FAELLT statt zu wachsen. Die Obergrenze ist nur ein
        // Notausstieg: greift der Deckel nie (der Fehlerfall), laeuft die
        // Schleife bis dorthin und `buffered_len` steht dann weit ueber
        // MAX_ACCESS_UNIT_BYTES.
        let mut vorher = a.buffered_len();
        let mut runden = 0usize;
        let gedeckelt = loop {
            assert!(a.push(seq(), &weiter, false).is_none());
            runden += 1;
            let jetzt = a.buffered_len();
            if jetzt < vorher {
                break true;
            }
            vorher = jetzt;
            if runden >= 40_000 {
                break false;
            }
        };
        eprintln!(
            "nach {runden} Fortsetzungen: buffered_len={}, Deckel griff: {gedeckelt}",
            a.buffered_len()
        );

        // `dropped` steht jetzt; ein Marker-Paket verbraucht es, damit der
        // naechste Durchgang mit reiner Weste beginnt.
        assert!(a.push(seq(), &Bytes::from_static(&[0x41, 0x11, 0x22]), true).is_none());

        // Eine frische, vollstaendige FU-A mit ANDEREM Fuellbyte.
        let mut neu_anfang = vec![0x7C, 0x85];
        neu_anfang.extend(std::iter::repeat_n(0xBBu8, 100));
        assert!(a.push(seq(), &Bytes::from(neu_anfang), false).is_none());
        let mut neu_ende = vec![0x7C, 0x45];
        neu_ende.extend(std::iter::repeat_n(0xBBu8, 100));
        let out = a.push(seq(), &Bytes::from(neu_ende), true);

        let einheit = out.expect(
            "nach dem Ueberlauf kommt keine saubere Einheit mehr heraus — der \
             fremde fua_buffer wurde beim Deckeln nicht mit geleert, seine \
             Reste kleben vor der naechsten NAL und reissen sie selbst ueber \
             den Deckel",
        );
        assert!(
            einheit.len() < 1024,
            "die Einheit traegt {} Byte statt der erwarteten gut 200 — da haengen \
             Reste aus dem fua_buffer davor",
            einheit.len()
        );
        assert!(
            !einheit.windows(2).any(|w| w == [0xAA, 0xAA]),
            "die saubere Einheit enthaelt Fuellbytes aus der verworfenen Anhaeufung"
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
