//! Wacht darueber, ob der Decoder noch rechnet — und bestimmt, WIE OFT
//! dagegen etwas unternommen wird.
//!
//! **Der Fall, fuer den es das gibt.** Am 2026-07-31 fror `av1_cuvid` nach dem
//! Ende einer Saettigungsphase ein: er gab weiter 60 Bilder je Sekunde aus,
//! immer dasselbe, ueber 90 Sekunden — bei **null** verlorenen Paketen. Ohne
//! Verlust meldet der Jitter-Puffer keine Luecke, also greift die Rettung ueber
//! [`crate::decode::VideoDecoder::on_gap`] nicht. Der Nachweis kommt deshalb
//! aus dem Ergebnis statt aus der Ursache: gleiches Bild, obwohl Daten
//! hineingehen.
//!
//! **Warum das allein nicht genuegt.** Ein Standbild beim Sender
//! (Ladebildschirm, pausiertes Spiel, stillstehender Desktop) sieht am Ausgang
//! des Decoders GENAU GLEICH aus. Beide Zustaende liefern dasselbe Bild,
//! waehrend Daten hereinkommen — am Bild sind sie nicht zu trennen.
//!
//! **Was hier bis zum 2026-08-05 als Trennung galt, und warum es keine ist.**
//! Die Byte-Schwelle trug den Satz „ein echtes Standbild kostet den Encoder
//! fast nichts (wenige hundert Byte je Bild); 500 kB ueber anderthalb Sekunden
//! entspricht rund 2,7 Mbit/s und kommt nur zustande, wenn wirklich Bildinhalt
//! gesendet wird." **Das ist falsch**, und zwar aus einem Grund, der am
//! Bildinhalt gar nicht haengt: die Schwelle zaehlt Bytes und sieht nicht nach,
//! WAS in ihnen steht. Ein Encoder, der seine Datenrate unter CBR mit
//! Fuellmaterial haelt, erreicht sie mit einem Standbild genauso — `av1_amf`
//! erzeugt mit `filler_data=1` nachweislich `OBU_PADDING` von 0,4 bis 8,3 kB
//! je Bild (`win-hq-sidecar/src/encode/mod.rs`). Richtig ist: die Schwelle
//! beantwortet nur „kommt ueberhaupt noch etwas an", nicht „ist es Bildinhalt".
//!
//! **Am 2026-08-05 auf dieser Maschine nachgemessen** (Windows, `av1_nvenc`
//! bzw. `h264_nvenc`, 1080p60, 6000 kbps CBR, WHEP ueber den MediaMTX-Fork,
//! Fenster-Capture auf einem unbewegten Bild):
//!
//! | Standbild | Datenrate | gleiche Bilder in Folge |
//! |---|---|---|
//! | flaechig (Ladebildschirm), AV1 | 114–345 kbit/s | **118** |
//! | flaechig, H.264 | 155–199 kbit/s | 72 |
//! | detailreich (Desktop-Abzug) | 5,6–6,3 Mbit/s | 0 (jedes Bild anders) |
//! | Farbverlauf | 2,3–6,3 Mbit/s | 0 |
//!
//! Zwei Dinge stehen darin. Erstens: **NVENC fuellt nicht** — faellt der Inhalt
//! still, faellt die Datenrate auf ein Zwanzigstel, und die Byte-Schwelle wird
//! nie erreicht. Der gemeldete Fehlalarm liess sich auf diesem Weg deshalb
//! nicht ausloesen (sechs Laeufe, kein einziger). Zweitens, und das ist der
//! Grund fuer diese Datei: **die Bild-Bedingung allein ist bei Standbild
//! erfuellt** (118 > 90). Was den Fehlalarm hier verhindert, ist keine
//! Unterscheidung, sondern eine Eigenschaft dieses einen Encoders.
//!
//! **Deshalb wird die Abhilfe gestaffelt, statt die Erkennung geschaerft.**
//! Schaerfen hiesse Schwellen hochdrehen, und das verzoegert nur die echte
//! Rettung. Gestaffelt heisst: der erste Verdacht wird sofort behandelt (wie
//! bisher, nach 90 Bildern); meldet sich derselbe Verdacht wieder, ohne dass
//! die Wiedergabe zwischendurch nachweislich lief, verdoppelt sich der
//! Pruefabstand — hoechstens [`MAX_STUFE`]-mal. Ein voellig stehendes Bild
//! kostet damit statt 40 erzwungener Vollbilder je Minute noch 7, und ein
//! haengender Decoder wird genauso schnell gerettet wie bisher.
//!
//! **Am gemessenen Standbild ist der Gewinn groesser als diese Rechnung**,
//! weil der Pruefabstand nach der ersten Meldung ueber dem Auffrischungstakt
//! des Senders liegt und die Erkennung danach gar nicht mehr anschlaegt. Beide
//! Staende am 2026-08-05 in derselben Kette gefahren, 70 s, gleicher Inhalt,
//! Byte-Boden fuer den Pruefstand auf 20 kB gesenkt (sonst loest die Erkennung
//! auf NVENC nie aus, s. o.):
//!
//! | | Meldungen | Vollbilder | Datenrate (Spitze) | Bildrate |
//! |---|---|---|---|---|
//! | vorher | 34 | 35 | 257 kbit/s | 56–69 |
//! | nachher | **1** | 2 | 169 kbit/s | 60–61 |
//!
//! Die Datenrate ist die eigentliche Rechnung: auf stehendem Inhalt bestand
//! die Haelfte des Stroms aus erzwungenen Vollbildern. Dass die Bildrate
//! mitschwankte, war der zweite, bis dahin unbemerkte Preis — jede Rettung
//! leert den Decoder und verwirft alles bis zum naechsten Einstiegspunkt.
//!
//! **Verworfen: die Wirkung der Rettung als Unterscheidung.** Naheliegend
//! waere, nach dem erzwungenen Vollbild nachzusehen, ob sich das Bild
//! veraendert hat — hat es das nicht, war es kein Decoder-Problem. Am
//! 2026-08-05 widerlegt: bei stehendem Inhalt und abgeschaltetem
//! Vollbild-Takt (`PULSE_KEYFRAME_INTERVAL=0`, die Produktivvorgabe) aenderte
//! sich der Fingerabdruck **exakt alle 118 Bilder**, im Takt der wandernden
//! Auffrischung des Senders. Neu codierter, unveraenderter Inhalt kommt also
//! nicht bitgleich wieder heraus; ein erzwungenes Vollbild ist dieselbe
//! Neucodierung, nur auf einen Schlag. Die Pruefung haette bei jedem Standbild
//! „hat geholfen!" gemeldet und die Staffelung sofort zurueckgesetzt.
//!
//! Zurueckgesetzt wird deshalb an einem Merkmal, das dieses Rauschen nicht
//! traegt: **anhaltende Bewegung** (s. [`BEWEGUNGS_FENSTER`]). Ein Standbild
//! schafft die nicht, ein rechnender Decoder auf laufendem Inhalt immer.

/// Ab wie vielen unveraenderten Bildern in Folge der Decoder als eingefroren
/// gilt. 90 sind bei 60 Bildern je Sekunde anderthalb Sekunden — lang genug,
/// dass eine kurze Standbild-Szene nicht hineinlaeuft, kurz genug, dass ein
/// Zuschauer nicht minutenlang festhaengt.
const EINFRIER_BILDER: u32 = 90;

/// Wie viele Bytes in derselben Zeit hineingegangen sein muessen.
///
/// **Das ist ein Boden, keine Unterscheidung** (Begruendung im Modulkopf): er
/// beantwortet „kommt ueberhaupt noch etwas an" und haelt die Erkennung von
/// dem Fall fern, um den sich `session.rs` kuemmert (Abriss). Ob die Bytes
/// Bildinhalt oder Fuellmaterial tragen, sieht er NICHT.
const EINFRIER_BYTES: usize = 500_000;

/// Wie oft der Pruefabstand hoechstens verdoppelt wird.
///
/// 3 heisst: 90 → 180 → 360 → 720 Bilder, bei 60 fps also 1,5 → 3 → 6 → 12
/// Sekunden. Die Obergrenze ist der Preis, den ein haengender Decoder im
/// schlechtesten Fall kostet — und er faellt nur an, wenn der Haenger sich
/// MITTEN in eine nachweislich stehende Szene legt; nach jeder bewegten
/// Sekunde steht die Staffel wieder bei 0. Zwoelf Sekunden gegen die 90, die
/// der Fall vom 2026-07-31 ungerettet dauerte.
///
/// Nach oben begrenzt, aber nie abgeschaltet: eine Erkennung, die sich selbst
/// stilllegt, ist im entscheidenden Moment nicht da.
const MAX_STUFE: u32 = 3;

/// Ueber wie viele Bilder „laeuft die Wiedergabe wieder" beurteilt wird, und
/// wie viele davon sich geaendert haben muessen.
///
/// Der Abstand zu beiden Seiten ist gemessen, nicht geraten: ein Standbild
/// erzeugt **1 Wechsel je 118 Bilder** (Auffrischungstakt des Senders, s.
/// Modulkopf), also hoechstens einen je Fenster. Verlangt werden vier — das
/// traegt noch Inhalte, die nur mit 4 Bildern je Sekunde wirklich neu sind
/// (Diashow, stark gedrosseltes Spiel), und liegt weit ueber dem, was
/// Neucodierungs-Rauschen liefert.
const BEWEGUNGS_FENSTER: u32 = 60;
const BEWEGUNGS_WECHSEL: u32 = 4;

/// Fingerabdruck eines Bildes — billige Stichprobe statt vollem Vergleich.
///
/// Ein 1440p-Bild in 10 bit sind rund 11 MB; die bei jedem Bild vollstaendig
/// zu hashen waere teurer als das Dekodieren. Gelesen wird deshalb jedes
/// 1021. Byte (Primzahl, damit die Schrittweite nicht mit der Zeilenlaenge
/// zusammenfaellt und immer dieselbe Bildspalte trifft), hoechstens 4096
/// Proben. Fuer die Frage „hat sich ueberhaupt etwas geaendert" genuegt das:
/// zwei verschiedene Bilder stimmen an allen Proben nur zufaellig ueberein.
fn bild_abdruck(planes: &[Vec<u8>]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for plane in planes {
        plane.len().hash(&mut h);
        for b in plane.iter().step_by(1021).take(4096) {
            b.hash(&mut h);
        }
    }
    h.finish()
}

/// Zustand der Einfrier-Erkennung. Bewusst ohne jeden FFmpeg-Bezug, damit die
/// Entscheidung ohne Decoder pruefbar ist.
#[derive(Default)]
pub struct EinfrierWacht {
    /// Fingerabdruck des zuletzt ausgegebenen Bildes und wie oft er sich in
    /// Folge NICHT geaendert hat.
    letzter_abdruck: Option<u64>,
    gleiche_bilder: u32,
    /// Bytes, die seit dem letzten VERAENDERTEN Bild hineingegangen sind.
    bytes_seit_bild: usize,
    /// Laufendes Bewegungsfenster: Bilder darin und wieviele davon neu waren.
    fenster_bilder: u32,
    fenster_wechsel: u32,
    /// Meldungen seit der letzten nachweislich bewegten Wiedergabe.
    stufe: u32,
}

impl EinfrierWacht {
    /// Eine hineingehende Zugriffseinheit mitzaehlen.
    pub fn daten(&mut self, bytes: usize) {
        self.bytes_seit_bild = self.bytes_seit_bild.saturating_add(bytes);
    }

    /// Ein ausgegebenes Bild mitzaehlen.
    pub fn bild(&mut self, planes: &[Vec<u8>]) {
        let abdruck = bild_abdruck(planes);
        let veraendert = self.letzter_abdruck != Some(abdruck);
        if veraendert {
            self.letzter_abdruck = Some(abdruck);
            self.gleiche_bilder = 0;
            self.bytes_seit_bild = 0;
        } else {
            self.gleiche_bilder = self.gleiche_bilder.saturating_add(1);
        }

        // Laeuft die Wiedergabe wieder? Dann zurueck auf vollen Pruefabstand.
        // Bewusst ueber ein Fenster und nicht ueber ein einzelnes veraendertes
        // Bild: ein einzelnes liefert auch ein Standbild, sobald der Sender
        // seine Auffrischung darueberzieht (Modulkopf).
        self.fenster_bilder += 1;
        self.fenster_wechsel += u32::from(veraendert);
        if self.fenster_bilder >= BEWEGUNGS_FENSTER {
            if self.fenster_wechsel >= BEWEGUNGS_WECHSEL {
                self.stufe = 0;
            }
            self.fenster_bilder = 0;
            self.fenster_wechsel = 0;
        }
    }

    /// Liefert der Decoder trotz ankommender Daten immer dasselbe Bild?
    ///
    /// `true` heisst „jetzt behandeln" — der Aufrufer leert den Decoder und
    /// fordert ein Vollbild an. Die Zaehler werden dabei zurueckgesetzt, sonst
    /// meldete jeder folgende Durchgang erneut und der Aufrufer schickte im
    /// Millisekundentakt Anforderungen.
    ///
    /// **Der Fingerabdruck bleibt dabei absichtlich stehen.** Ihn hier zu
    /// loeschen (so war es bis 2026-08-05) laesst das naechste Bild als
    /// „veraendert" durchgehen, egal was es zeigt: das Bewegungsfenster
    /// bekaeme bei jedem Standbild einen geschenkten Wechsel.
    pub fn eingefroren(&mut self) -> bool {
        if self.gleiche_bilder < self.schwelle() || self.bytes_seit_bild < EINFRIER_BYTES {
            return false;
        }
        self.stufe = (self.stufe + 1).min(MAX_STUFE);
        self.gleiche_bilder = 0;
        self.bytes_seit_bild = 0;
        true
    }

    /// Wie viele unveraenderte Bilder derzeit noetig sind.
    pub fn schwelle(&self) -> u32 {
        EINFRIER_BILDER << self.stufe
    }

    /// Wievielte Meldung ohne zwischenzeitlich laufende Wiedergabe das war —
    /// nur fuer die Diagnoseausgabe.
    pub fn stufe(&self) -> u32 {
        self.stufe
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Bild, dessen Inhalt an `n` haengt.
    fn bild(n: u8) -> Vec<Vec<u8>> {
        vec![vec![n; 300_000], vec![n ^ 0x5a; 150_000]]
    }

    /// Fuettert `anzahl` gleiche Bilder samt Daten und liefert die
    /// Bildnummern, bei denen gemeldet wurde. 12 kB je Bild sind bei 60 fps
    /// rund 5,8 Mbit/s — genau die Lage, in der ein fuellender Encoder die
    /// Byte-Schwelle traegt, obwohl der Inhalt steht.
    fn stehendes_bild(wacht: &mut EinfrierWacht, anzahl: u32) -> Vec<u32> {
        let mut alarme = Vec::new();
        let stand = bild(7);
        for i in 0..anzahl {
            wacht.daten(12_000);
            wacht.bild(&stand);
            if wacht.eingefroren() {
                alarme.push(i);
            }
        }
        alarme
    }

    /// Bewegte Wiedergabe: jedes Bild ist neu.
    fn bewegtes_bild(wacht: &mut EinfrierWacht, anzahl: u32) {
        for i in 0..anzahl {
            wacht.daten(12_000);
            wacht.bild(&bild((i % 251) as u8 + 1));
            assert!(!wacht.eingefroren(), "laufendes Bild darf nie melden");
        }
    }

    /// Der Fingerabdruck muss zwei Dinge koennen: gleiche Bilder gleich
    /// abbilden und veraenderte verschieden. Er liest nur jedes 1021. Byte —
    /// die Probe MUSS also treffen, sonst meldet der Einfrier-Nachweis
    /// „unveraendert", waehrend sich das Bild sehr wohl aendert.
    #[test]
    fn abdruck_erkennt_veraenderung() {
        let a = vec![vec![7u8; 300_000], vec![9u8; 150_000]];
        assert_eq!(bild_abdruck(&a), bild_abdruck(&a.clone()));

        // Erste Probenstelle veraendern.
        let mut b = a.clone();
        b[0][0] = 8;
        assert_ne!(bild_abdruck(&a), bild_abdruck(&b));

        // Eine spaetere Probenstelle (jedes 1021. Byte).
        let mut c = a.clone();
        c[0][1021 * 50] = 8;
        assert_ne!(bild_abdruck(&a), bild_abdruck(&c));

        // Andere Groesse zaehlt ebenfalls als Veraenderung.
        let d = vec![vec![7u8; 299_999], vec![9u8; 150_000]];
        assert_ne!(bild_abdruck(&a), bild_abdruck(&d));
    }

    /// Der Fall vom 2026-07-31: gleiches Bild, volle Datenrate. Die erste
    /// Meldung MUSS nach 90 Bildern kommen — daran aendert die Staffelung
    /// nichts, sie greift erst ab der Wiederholung.
    #[test]
    fn haengender_decoder_wird_nach_90_bildern_gemeldet() {
        let mut w = EinfrierWacht::default();
        assert_eq!(stehendes_bild(&mut w, 91), vec![90]);
    }

    /// **Die Gegenrichtung**: die Rettung hat gewirkt, das Bild laeuft wieder.
    /// Danach muss die Erkennung wieder mit vollem Tempo scharf sein, auch
    /// wenn der Pruefabstand vorher am Anschlag stand — sonst waere ein
    /// Haenger nach einer langen Standbild-Szene zwoelf Sekunden lang
    /// unbemerkt.
    #[test]
    fn bewegtes_bild_stellt_das_volle_tempo_wieder_her() {
        let mut w = EinfrierWacht::default();
        stehendes_bild(&mut w, 3000);
        assert_eq!(w.stufe(), MAX_STUFE, "Vorbedingung: Staffel am Anschlag");

        bewegtes_bild(&mut w, 120);
        assert_eq!(w.stufe(), 0, "laufende Wiedergabe muss zuruecksetzen");
        assert_eq!(w.schwelle(), EINFRIER_BILDER);

        // Zweiter Haenger, direkt danach: wieder nach 90 Bildern.
        assert_eq!(stehendes_bild(&mut w, 91), vec![90]);
    }

    /// Standbild: dieselbe Meldung kommt immer wieder. Der Abstand muss sich
    /// verdoppeln und bei [`MAX_STUFE`] stehenbleiben.
    #[test]
    fn standbild_meldet_immer_seltener() {
        let mut w = EinfrierWacht::default();
        let alarme = stehendes_bild(&mut w, 3600); // eine Minute bei 60 fps
        let abstaende: Vec<u32> = alarme.windows(2).map(|p| p[1] - p[0]).collect();
        assert_eq!(
            &abstaende[..3],
            &[180, 360, 720],
            "Abstand muss sich verdoppeln, war {abstaende:?}"
        );
        assert!(
            abstaende[3..].iter().all(|&a| a == 720),
            "ab MAX_STUFE muss der Abstand stehen, war {abstaende:?}"
        );
        // Ohne Staffelung waeren es 3600/90 = 40 Meldungen je Minute — jede
        // ein erzwungenes Vollbild zum Fuenffachen eines normalen Bildes.
        assert_eq!(alarme.len(), 7, "40 Meldungen je Minute waren der Fehler");
    }

    /// Das Standbild aus der Messung: alle 118 Bilder aendert die wandernde
    /// Auffrischung des Senders etwas am Bild. Dieser eine Wechsel darf die
    /// Staffelung NICHT zuruecksetzen — sonst faellt die Erkennung genau in
    /// den Zustand zurueck, der den Fehlalarm erzeugt hat.
    ///
    /// Auf genau diesem Inhalt kostet der Fehlalarm damit **eine** Meldung
    /// statt 40 je Minute: nach der ersten steht der Pruefabstand bei 180
    /// Bildern und liegt damit ueber dem Auffrischungstakt.
    #[test]
    fn auffrischungstakt_setzt_die_staffelung_nicht_zurueck() {
        let mut w = EinfrierWacht::default();
        let mut alarme = 0;
        for i in 0..3600u32 {
            w.daten(12_000);
            // Alle 118 Bilder ein anderer Inhalt, sonst unveraendert.
            w.bild(&bild(7 + (i / 118) as u8 % 3));
            if w.eingefroren() {
                alarme += 1;
            }
        }
        assert_eq!(alarme, 1, "ohne Staffelung waeren es 40 je Minute");
        assert!(w.stufe() >= 1, "ein Wechsel je 118 Bilder ist keine Bewegung");
        assert!(
            w.schwelle() > 118,
            "Pruefabstand muss ueber den Auffrischungstakt steigen, ist {}",
            w.schwelle()
        );
    }

    /// Die Staffelung darf sich NIE ganz abschalten: auch nach einer langen
    /// Standbild-Strecke muss weiter geprueft werden.
    #[test]
    fn erkennung_bleibt_dauerhaft_scharf() {
        let mut w = EinfrierWacht::default();
        let alarme = stehendes_bild(&mut w, 36_000); // zehn Minuten
        assert!(
            alarme.len() >= 45,
            "Erkennung darf nicht einschlafen: nur {} Meldungen",
            alarme.len()
        );
        assert_eq!(w.schwelle(), EINFRIER_BILDER << MAX_STUFE);
    }

    /// Ohne ankommende Daten keine Meldung — das ist der Abriss, und um den
    /// kuemmert sich `session.rs`. Ein Decoder, den niemand fuettert, ist
    /// nicht eingefroren.
    #[test]
    fn ohne_daten_keine_meldung() {
        let mut w = EinfrierWacht::default();
        let stand = bild(3);
        for _ in 0..1000 {
            w.bild(&stand);
            assert!(!w.eingefroren(), "ohne Daten darf nichts gemeldet werden");
        }
    }

    /// Die Byte-Schwelle ist ein Boden, kein Zeitfenster: ein langsamer Strom
    /// meldet spaeter, aber er meldet.
    #[test]
    fn langsamer_strom_meldet_spaeter_trotzdem() {
        let mut w = EinfrierWacht::default();
        let stand = bild(11);
        let mut alarme = 0;
        for _ in 0..2000 {
            w.daten(1000); // 60 kB/s statt 720 kB/s
            w.bild(&stand);
            if w.eingefroren() {
                alarme += 1;
            }
        }
        assert!(alarme >= 1, "auch langsame Stroeme muessen irgendwann melden");
    }
}
