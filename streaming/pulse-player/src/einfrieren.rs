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
//! **Die eigentliche Ursache des gemeldeten Fehlalarms war aber eine dritte,
//! und sie sass im Fingerabdruck.** Belegt durch den Vorfall vom 2026-08-05
//! (`player-nackprobe.log`): drei Meldungen in rund 17 Sekunden, bei **4646
//! kbit/s**, 60 Bildern je Sekunde und 774 dekodierten Bildern; Sender
//! `av1_nvenc` im **Vollbild**-Betrieb, also ohne wandernde Auffrischung. Auf
//! dem Bildschirm lief ein Terminal mit blinkendem Cursor. Beide Bedingungen
//! waren gleichzeitig erfuellt — 870 kB je anderthalb Sekunden UND 90 Bilder
//! „gleich" — obwohl sich das Bild sehr wohl aenderte.
//!
//! Der Grund: [`bild_abdruck`] las bis zum 2026-08-05 **jedes 1021. Byte,
//! hoechstens 4096 Proben**. Bei 1080p in NV12 (3,1 MB) sind das rund 3000
//! Stichproben, also ein Tausendstel des Bildes. Ein kleines bewegtes Element
//! — Cursor, laufende Uhr, Ladepunkte in einer Ecke — kostet den Encoder
//! echte Bits, wird von dieser Stichprobe aber fast nie getroffen: ein 8x16
//! grosser Cursor belegt 128 Byte, die Trefferchance liegt bei 128/1021, also
//! rund 12 %. Und sie ist NICHT je Bild neu ausgewuerfelt — das Raster liegt
//! fest, ein danebenliegendes Element bleibt **dauerhaft** unsichtbar.
//!
//! Damit hing der Fehlalarm nicht an einer Encoder-Eigenschaft, sondern an
//! der Dichte des Abdrucks, und er traf viel mehr als Standbilder: jedes Video
//! mit stehendem Rahmen, jede Oberflaeche mit blinkendem Cursor, jeden
//! Ladebildschirm mit Animation in einer Ecke. **[`bild_abdruck`] liest
//! deshalb seit dem 2026-08-05 jedes Byte** (Kosten dort gemessen).
//!
//! **Was hier bis zum 2026-08-05 als Trennung galt, und warum es keine ist.**
//! Die Byte-Schwelle trug den Satz „ein echtes Standbild kostet den Encoder
//! fast nichts (wenige hundert Byte je Bild); 500 kB ueber anderthalb Sekunden
//! entspricht rund 2,7 Mbit/s und kommt nur zustande, wenn wirklich Bildinhalt
//! gesendet wird." **Das ist falsch**, und zwar aus einem Grund, der am
//! Bildinhalt gar nicht haengt: die Schwelle zaehlt Bytes und sieht nicht nach,
//! WAS in ihnen steht. Richtig ist: sie beantwortet nur „kommt ueberhaupt
//! noch etwas an", nicht „ist es Bildinhalt".
//!
//! **Ebenfalls falsch — und hier als erste Erklaerung des Fehlalarms
//! aufgeschrieben, bis der Vorfall nachgelesen war: „unter CBR haelt der
//! Encoder seine Datenrate, notfalls mit Fuellmaterial."** Als Aussage ueber
//! Encoder im Allgemeinen stimmt sie (`av1_amf` erzeugt mit `filler_data=1`
//! `OBU_PADDING` von 0,4 bis 8,3 kB je Bild, `win-hq-sidecar/src/encode/mod.rs`
//! — deshalb ist die Byte-Schwelle KEINE Unterscheidung). Als Erklaerung des
//! gemessenen Fehlalarms ist sie widerlegt: gesendet hat `av1_nvenc`, und der
//! fuellt nachweislich nicht — faellt der Inhalt wirklich still, faellt seine
//! Datenrate auf ein Zwanzigstel (Messreihe unten). Die 4646 kbit/s im Vorfall
//! waren echter Bildinhalt, den nur der Abdruck nicht gesehen hat. Wer die
//! Fuell-Erklaerung weiterverfolgt, sucht an der falschen Stelle.
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
//! Zwei Dinge stehen darin. Erstens: **auf FLAECHIGEM Inhalt fuellt NVENC
//! nicht** — steht das Bild, faellt die Datenrate auf ein Zwanzigstel, und die
//! Byte-Schwelle wird nie erreicht. Zweitens: **die Bild-Bedingung allein ist
//! bei Standbild erfuellt** (118 > 90). In keinem dieser sechs Laeufe kam eine
//! Meldung — nicht weil die Erkennung taugte, sondern weil keiner dieser
//! Inhalte beides zugleich war.
//!
//! **Beides zugleich ist ein STEHENDER, aber DETAILREICHER Bildschirm**, und
//! damit liess sich der Vorfall am 2026-08-05 mit unveraenderten Schwellen
//! nachstellen: ein Fenster mit 44 Zeilen Terminal-Text, unbewegt, `av1_nvenc`
//! im Vollbild-Betrieb, 1080p60 bei 6000 kbps. Gemessen **3,2–7,8 Mbit/s bei
//! bitgleichem Ausgabebild** — die Neucodierung scharfkantigen Textes kostet
//! dauerhaft Bits, ohne die Rekonstruktion zu veraendern. Der Player meldete
//! mit dem Stand vor dieser Datei **22-mal in 90 Sekunden**.
//!
//! Der Satz „NVENC fuellt nicht" gilt also nur fuer flaechigen Inhalt. Fuer
//! die Byte-Schwelle heisst das dasselbe wie bei einem fuellenden Encoder:
//! sie unterscheidet nichts.
//!
//! **Deshalb zwei Aenderungen, an zwei verschiedenen Stellen — gegen zwei
//! verschiedene Faelle**, die im Log gleich aussehen:
//!
//! * *Das Bild aendert sich, der Abdruck sieht es nur nicht* (Cursor, Uhr,
//!   Ladepunkte). Dagegen hilft nur ein vollstaendiger Abdruck, und der loest
//!   es restlos: was sich aendert, faellt auf.
//! * *Das Bild steht wirklich, und trotzdem fliessen Daten* (stehender
//!   detailreicher Bildschirm, oder ein fuellender Encoder). Da gibt es nichts
//!   zu unterscheiden — ein vollstaendig stehendes Bild sieht aus wie ein
//!   Haenger, mit jedem Abdruck. Dagegen hilft nur, den Preis des Nachsehens
//!   zu begrenzen.
//!
//! **Erstens also: die Abhilfe wird gestaffelt, statt die Erkennung
//! geschaerft.**
//! Schaerfen hiesse Schwellen hochdrehen, und das verzoegert nur die echte
//! Rettung. Gestaffelt heisst: der erste Verdacht wird sofort behandelt (wie
//! bisher, nach 90 Bildern); meldet sich derselbe Verdacht wieder, ohne dass
//! die Wiedergabe zwischendurch nachweislich lief, verdoppelt sich der
//! Pruefabstand — hoechstens [`MAX_STUFE`]-mal. Ein voellig stehendes Bild
//! kostet damit statt 40 erzwungener Vollbilder je Minute noch 7, und ein
//! haengender Decoder wird genauso schnell gerettet wie bisher.
//!
//! **Was das am 2026-08-05 in der laufenden Kette gebracht hat**, auf dem
//! stehenden Terminal-Bildschirm von oben, je 90 s, unveraenderte Schwellen:
//!
//! | Stand | Meldungen | Vollbilder |
//! |---|---|---|
//! | vorher | 22 | 29 |
//! | dichter Abdruck, Staffelung mit Rueckfall ueber EIN Fenster | 21 | 29 |
//! | Stichprobe, Staffelung mit Rueckfall ueber EIN Fenster | 23 | 28 |
//! | dichter Abdruck, Rueckfall ueber eine Fensterkette | **7 / 3** | 22 / 18 |
//!
//! (Letzte Zeile: zwei Laeufe. Die Staffel erreicht ihren Anschlag und bleibt
//! dort, die Streuung kommt daher, wie oft das in 90 s passt.)
//!
//! Die dritte Zeile ist der Grund fuer [`BEWEGUNGS_KETTE`] und die
//! unangenehmste Zahl der Reihe: die Staffelung war zuerst **wirkungslos**,
//! weil die Rettung selbst genug Bewegung erzeugte, um sie zurueckzusetzen.
//! Ohne den Lauf in der echten Kette waere das nicht aufgefallen — die
//! Unit-Tests hielten das Standbild fuer perfekt unbewegt, und genau das ist
//! es nach einer Rettung eben nicht.
//!
//! Auf einem FLAECHIGEN Standbild ist der Gewinn noch groesser (dort liegt der
//! Pruefabstand nach der ersten Meldung ueber dem Auffrischungstakt des
//! Senders, danach schlaegt die Erkennung gar nicht mehr an): 70 s, Byte-Boden
//! fuer den Pruefstand auf 20 kB gesenkt, sonst loest dort nichts aus —
//! **34 Meldungen vorher, 1 nachher**, Spitzen-Datenrate 257 → 169 kbit/s,
//! Bildrate 56–69 → 60–61. Die Datenrate ist die eigentliche Rechnung: die
//! Haelfte des Stroms bestand aus erzwungenen Vollbildern.
//!
//! Gegenprobe im Normalbetrieb, gleiche Kette, 60 s laufender Inhalt
//! (durchscrollendes Terminal): **null Meldungen**, 60–61 Bilder je Sekunde.
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
//! traegt: **ueber Sekunden anhaltende Bewegung** (s. [`BEWEGUNGS_FENSTER`]
//! und [`BEWEGUNGS_KETTE`]). Ein Standbild schafft die nicht — auch nicht mit
//! der Nachwirkung der eigenen Rettung —, ein rechnender Decoder auf laufendem
//! Inhalt immer.
//!
//! **Zweitens: der Abdruck liest jedes Byte** — Begruendung und Kosten stehen
//! bei [`bild_abdruck`].

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

/// Wie viele Bewegungsfenster HINTEREINANDER Bewegung zeigen muessen.
///
/// **Das ist der Unterschied zwischen laufendem Inhalt und der Nachwirkung der
/// eigenen Rettung**, und ohne ihn haelt sich die Staffelung selbst bei null:
/// am 2026-08-05 meldete der Player auf einem stehenden Bildschirm 23-mal in
/// 90 Sekunden, im Log jede einzelne als „Meldung 1". Die Staffel war zwischen
/// zwei Meldungen jedes Mal zurueckgesetzt worden, obwohl der Inhalt stand.
///
/// Zurueckgesetzt hat sie die Rettung selbst: sie leert den Decoder und
/// erzwingt ein Vollbild, danach codiert der Encoder den unveraenderten Inhalt
/// neu und naehert sich seinem Fixpunkt wieder an. Im selben Lauf gezaehlt, je
/// 60 Bilder nach einer Meldung:
///
/// | Block nach der Meldung | 1 | 2 | 3 | 4 | 5 |
/// |---|---|---|---|---|---|
/// | veraenderte Bilder | 60/60 | 60/60 | 0–60 | 0–60 | 0/60 |
///
/// Also **zwei bis vier Sekunden lang aendert sich JEDES Bild**, danach steht
/// es wieder bitgleich. Wer nur in ein einzelnes Fenster sieht, liest genau
/// hier „laeuft ja wieder" — die Erkennung nimmt ihre eigene Abhilfe als
/// Entwarnung. Eine feste Sperre von fuenf Sekunden nach der Meldung half nur
/// halb (23 → 11 Meldungen), weil der Nachlauf mal kuerzer und mal laenger ist.
///
/// Was ihn zuverlaessig von echtem Inhalt trennt, ist seine **Dauer**: der
/// Nachlauf endet, laufender Inhalt nicht. Acht Fenster sind acht Sekunden
/// ununterbrochener Bewegung — doppelt so lang wie der laengste gemessene
/// Nachlauf. Der Preis: nach einer WIRKSAMEN Rettung steht das volle Tempo
/// erst acht Sekunden spaeter wieder bereit, und das wirkt sich fruehestens
/// auf die uebernaechste Meldung aus.
const BEWEGUNGS_KETTE: u32 = 8;

/// Streufaktor des Abdrucks. Ungerade, also ist jeder Mischschritt umkehrbar —
/// ein einzelnes veraendertes Byte kann sich nicht herausheben.
const MISCHER: u64 = 0x517c_c1b7_2722_0a95;

/// Ein einzelner Mischschritt: `wort` in `kette` einrechnen (s. [`MISCHER`]).
#[inline(always)]
fn mische(kette: u64, wort: u64) -> u64 {
    (kette ^ wort).wrapping_mul(MISCHER)
}

/// Fingerabdruck eines Bildes: **jedes Byte zaehlt**.
///
/// **Hier stand bis zum 2026-08-05 eine Stichprobe** — „jedes 1021. Byte
/// (Primzahl, damit die Schrittweite nicht mit der Zeilenlaenge zusammenfaellt),
/// hoechstens 4096 Proben. Fuer die Frage ‚hat sich ueberhaupt etwas geaendert'
/// genuegt das." **Der letzte Satz ist falsch, und er war die Ursache des
/// gemeldeten Fehlalarms** (voll im Modulkopf): 3000 Proben auf 3,1 MB sind ein
/// Tausendstel des Bildes, ein blinkender Cursor traf sie zu rund 12 %, und weil
/// das Raster fest liegt, blieb er dauerhaft unsichtbar. Der Encoder schickte
/// 4646 kbit/s echten Bildinhalt, der Abdruck meldete „unveraendert".
///
/// Eine dichtere Stichprobe waere nur eine kleinere Version desselben Fehlers:
/// jedes feste Raster hat blinde Flecken, und ein Element, das einmal
/// danebenliegt, liegt immer daneben. Ein je Bild wechselndes Raster wuerde die
/// blinden Flecken wandern lassen, aber dann sind zwei Abdruecke nur noch bei
/// gleichem Raster vergleichbar — das kostet Zustand und macht aus „gleich?"
/// ein „gleich wie vor N Bildern?". Vollstaendig lesen ist einfacher und die
/// einzige Variante ohne Restrisiko.
///
/// **Kosten, gemessen am 2026-08-05 in derselben Kette** (1080p60 in NV12, 3,1
/// MB je Bild, zwei Laeufe ueber je 90 s auf demselben Inhalt): Dekodierzeit
/// je Bild im Mittel **3,78 ms mit der Stichprobe, 4,11 ms mit dem
/// vollstaendigen Abdruck** — 0,33 ms oder 9 %, bei unveraenderter Bildrate.
/// Das ist der Preis dafuer, dass ein veraendertes Bild nicht mehr durchrutschen
/// kann. Vier unabhaengige Ketten, damit die Multiplikationen einander nicht
/// blockieren; gelesen wird in 8-Byte-Woertern.
///
/// Fuer groessere Bilder waechst er linear mit (1440p in 10 bit sind rund
/// 11 MB, also gut das Dreifache). Wird das eng, ist die Y-Ebene allein der
/// naechste Schritt — sie traegt zwei Drittel der Daten, und ein bewegtes
/// Element ohne jede Helligkeitsaenderung gibt es praktisch nicht.
fn bild_abdruck(planes: &[Vec<u8>]) -> u64 {
    let mut ketten = [MISCHER; 4];
    for plane in planes {
        // Die Laenge gehoert dazu: sonst gaeben zwei verschieden grosse Ebenen
        // mit gleichem Anfang denselben Abdruck.
        ketten[0] = mische(ketten[0], plane.len() as u64);

        let bloecke = plane.chunks_exact(32);
        let rest = bloecke.remainder();
        for block in bloecke {
            for (kette, bytes) in ketten.iter_mut().zip(block.chunks_exact(8)) {
                let wort = u64::from_le_bytes(bytes.try_into().unwrap());
                *kette = mische(*kette, wort);
            }
        }
        for (i, byte) in rest.iter().enumerate() {
            let kette = &mut ketten[i % 4];
            *kette = mische(*kette, u64::from(*byte));
        }
    }
    ketten.iter().fold(0u64, |abdruck, &kette| mische(abdruck, kette))
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
    /// Fenster mit Bewegung in Folge (s. [`BEWEGUNGS_KETTE`]).
    bewegte_fenster: u32,
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
        self.bewegung_fortschreiben(veraendert);
    }

    /// Laeuft die Wiedergabe wieder? Dann zurueck auf vollen Pruefabstand.
    /// Bewusst ueber ein Fenster und nicht ueber ein einzelnes veraendertes
    /// Bild: ein einzelnes liefert auch ein Standbild, sobald der Sender
    /// seine Auffrischung darueberzieht (Modulkopf). Und bewusst ueber eine
    /// KETTE von Fenstern, weil die Rettung selbst ein paar Sekunden
    /// Bewegung erzeugt (s. [`BEWEGUNGS_KETTE`]).
    fn bewegung_fortschreiben(&mut self, veraendert: bool) {
        self.fenster_bilder += 1;
        self.fenster_wechsel += u32::from(veraendert);
        if self.fenster_bilder < BEWEGUNGS_FENSTER {
            return;
        }
        if self.fenster_wechsel >= BEWEGUNGS_WECHSEL {
            self.bewegte_fenster += 1;
            if self.bewegte_fenster >= BEWEGUNGS_KETTE {
                self.stufe = 0;
            }
        } else {
            self.bewegte_fenster = 0;
        }
        self.fenster_zuruecksetzen();
    }

    /// Ein frisches Bewegungsfenster beginnen.
    fn fenster_zuruecksetzen(&mut self) {
        self.fenster_bilder = 0;
        self.fenster_wechsel = 0;
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
        // Die laufende Bewegungsrechnung faellt weg: was jetzt kommt, ist
        // zuerst die Wirkung der Rettung und nicht der Inhalt.
        self.fenster_zuruecksetzen();
        self.bewegte_fenster = 0;
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
    /// abbilden und veraenderte verschieden.
    ///
    /// **Hier stand bis zum 2026-08-05 „Er liest nur jedes 1021. Byte — die
    /// Probe MUSS also treffen"**; seither liest er jedes Byte, es gibt also
    /// keine Probenstellen mehr, die treffen muessten. Die alten Stellen
    /// bleiben trotzdem im Test: sie sind jetzt der Regressionsschutz gegen
    /// eine Rueckkehr zur Stichprobe.
    #[test]
    fn abdruck_erkennt_veraenderung() {
        let a = vec![vec![7u8; 300_000], vec![9u8; 150_000]];
        assert_eq!(bild_abdruck(&a), bild_abdruck(&a.clone()));

        // Erstes Byte.
        let mut b = a.clone();
        b[0][0] = 8;
        assert_ne!(bild_abdruck(&a), bild_abdruck(&b));

        // Eine Stelle, die auch das alte Raster getroffen haette.
        let mut c = a.clone();
        c[0][1021 * 50] = 8;
        assert_ne!(bild_abdruck(&a), bild_abdruck(&c));

        // Andere Groesse zaehlt ebenfalls als Veraenderung.
        let d = vec![vec![7u8; 299_999], vec![9u8; 150_000]];
        assert_ne!(bild_abdruck(&a), bild_abdruck(&d));

        // Ein einzelnes Byte irgendwo mittendrin — mit der alten Stichprobe
        // ging so etwas zu 99,9 % unter.
        let mut e = a.clone();
        e[0][123_457] ^= 1;
        assert_ne!(bild_abdruck(&a), bild_abdruck(&e), "ein Byte muss reichen");
    }

    /// Der Fall, der den gemeldeten Fehlalarm ausgeloest hat: ein winziges
    /// bewegtes Element vor stehendem Rest — ein blinkender Cursor. Er MUSS
    /// auffallen, sonst zaehlt die Erkennung 90 „gleiche" Bilder, waehrend der
    /// Encoder echten Bildinhalt schickt.
    ///
    /// Die Stelle ist bewusst ein blinder Fleck des alten Rasters (jedes 1021.
    /// Byte). Das ist kein Sonderfall, sondern der Regelfall: von den
    /// Cursor-Positionen in einem 1080p-Bild sind **87 %** blind.
    #[test]
    fn abdruck_bemerkt_blinkenden_cursor() {
        const STRIDE: usize = 1920; // wie im Log: „Zeilenabstand 1920"
        let ohne = vec![vec![40u8; STRIDE * 1080], vec![128u8; STRIDE * 540]];
        let mut mit = ohne.clone();

        let (x0, y0) = (960, 520);
        let mut altes_raster_traf = false;
        for y in y0..y0 + 16 {
            for x in x0..x0 + 8 {
                let i = y * STRIDE + x;
                altes_raster_traf |= i % 1021 == 0;
                mit[0][i] = 235;
            }
        }
        assert!(
            !altes_raster_traf,
            "Pruefstelle muss ein blinder Fleck des alten Rasters sein, sonst \
             prueft der Test nichts"
        );
        assert_ne!(
            bild_abdruck(&ohne),
            bild_abdruck(&mit),
            "ein 8x16 grosser Cursor muss den Abdruck aendern"
        );
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

        // Acht Fenster ununterbrochener Bewegung — s. BEWEGUNGS_KETTE.
        bewegtes_bild(&mut w, BEWEGUNGS_FENSTER * BEWEGUNGS_KETTE);
        assert_eq!(w.stufe(), 0, "laufende Wiedergabe muss zuruecksetzen");
        assert_eq!(w.schwelle(), EINFRIER_BILDER);

        // Zweiter Haenger, direkt danach: wieder nach 90 Bildern.
        assert_eq!(stehendes_bild(&mut w, 91), vec![90]);
    }

    /// **Die Rettung darf ihre eigene Staffelung nicht zuruecksetzen.** Nach
    /// dem Leeren des Decoders kommt ein Schub unterschiedlicher Bilder — das
    /// Aufholen bis zum Vollbild —, der mit dem Inhalt nichts zu tun hat.
    ///
    /// Ohne diese Sperre stand die Staffel bei jeder Meldung wieder auf 1: am
    /// 2026-08-05 live gemessen, 23 Meldungen in 90 Sekunden auf stehendem
    /// Inhalt, im Log jede einzelne als „Meldung 1". Die Staffelung war damit
    /// wirkungslos, ohne dass ein Test das gezeigt haette.
    #[test]
    fn aufholschub_nach_der_rettung_setzt_die_staffelung_nicht_zurueck() {
        let mut w = EinfrierWacht::default();
        assert_eq!(stehendes_bild(&mut w, 91).len(), 1);
        assert_eq!(w.stufe(), 1);

        // Der Schub: 240 verschiedene Bilder unmittelbar nach der Meldung —
        // vier Sekunden, so lang wie der laengste live gemessene Nachlauf.
        for i in 0..240u32 {
            w.daten(12_000);
            w.bild(&bild((i % 251) as u8 + 1));
        }

        // Danach steht der Inhalt wieder — die naechste Meldung muss die
        // Staffel WEITER hochzaehlen, nicht bei 1 anfangen.
        let alarme = stehendes_bild(&mut w, 400);
        assert!(!alarme.is_empty(), "die Erkennung muss weiter melden");
        assert!(
            w.stufe() >= 2,
            "der Aufholschub darf nicht als Bewegung gelten, Staffel ist {}",
            w.stufe()
        );
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
