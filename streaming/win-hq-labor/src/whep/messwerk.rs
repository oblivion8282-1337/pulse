//! Das Messgerät: zählt, was ankommt, und leitet daraus die Kennzahlen ab.
//!
//! Getrennt von [`super`], weil dort die WebRTC-Sitzung wohnt — Angebot,
//! Handschlag, Spuren, Rückkanal. Hier wird nur gezählt und gerechnet. Die
//! Störung, mit der gemessen wird, steht wiederum daneben in
//! [`super::stoerung`]: Vorrichtung, Messgerät und Sitzung sind drei Dinge.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use anyhow::Result;
use tokio::sync::Notify;

use super::dekoder::{Ausgang, Decoder};
use super::stoerung::{Urteil, Verlustquelle};
use super::tonurteil::Bildblock;
use super::Ergebnis;
use super::entpacken::Entpacker;

/// Was vom Lese- an den Decoder-Faden geht.
///
/// **Als Struct und nicht als Tupel**: es sind vier Werte, von denen drei
/// Zeiten sind — in unterschiedlichen Uhren. `(daten, ms, ts, ms2)` an der
/// Empfangsstelle auseinanderzuhalten ist genau die Sorte Aufgabe, bei der
/// irgendwann zwei davon vertauscht werden, und ein vertauschter Zeitstempel
/// sieht wie ein A/V-Versatz aus.
pub(super) struct Abschnitt {
    pub(super) daten: Vec<u8>,
    /// Ankunft in der Uhr der Bildspur — für die Verlust-Rechnung.
    pub(super) ms: u64,
    /// RTP-Zeitstempel = die Bild-Uhr des Senders (90 kHz).
    pub(super) rtp_ts: u32,
    /// Ankunft in der **gemeinsamen** Uhr beider Spuren — nur für den
    /// Vergleich mit dem Ton.
    pub(super) ms_gemeinsam: f64,
}

#[derive(Default)]
pub(super) struct Messwerk {
    pakete: AtomicU64,
    abschnitte: AtomicU64,
    verworfen: AtomicU64,
    /// Meldet, dass der erzeugte Verlust durch ist.
    ///
    /// **Die Anforderung hängt daran und nicht an einer eigenen Uhr:** der
    /// Verlust löst bei `t0 + verlust_ab` aus, wobei `t0` die Ankunft des
    /// ersten Videopakets ist — die Anforderung liefe sonst ab dem Handschlag,
    /// und dazwischen liegen ICE und DTLS. Über eine echte Leitung ginge sie
    /// damit womöglich VOR dem Verlust hinaus, und der Lauf mäße „Lücke ohne
    /// Anforderung", während er sich `fordert_an: JA` aufschreibt.
    pub(super) verlust_durch: Notify,
    bilder: AtomicU64,
    /// Davon Vollbilder — der Nachweis für Intra-Refresh (s. `Ausgang::Vollbild`).
    vollbilder: AtomicU64,
    beschaedigt: AtomicU64,
    decoder_fehler: AtomicU64,
    pub(super) verlust_erzeugt: AtomicU64,
    /// Millisekunden seit Beginn, an dem der Verlust **aufhörte**.
    ///
    /// **Das Ende des Stoßes, nicht sein Anfang** — sonst misst die Lücke zum
    /// größten Teil den Stoß selbst. Bei 720p30 kommen rund 90 Pakete je
    /// Sekunde an; ein Stoß von 60 Paketen dauert also gut 600 ms, in denen
    /// naturgemäß kein Abschnitt fertig werden kann. Genau das ist am
    /// 2026-08-02 passiert: mit und ohne Anforderung kamen 599 bzw. 600 ms
    /// heraus, und die Zahl sah nach „kein Unterschied" aus, während sie in
    /// Wahrheit gar nichts über die Erholung sagte. Ab dem Ende des Stoßes ist
    /// die Strecke wieder heil — erst ab da ist „wie lange bis zum Bild" eine
    /// Frage an den Codec und nicht an das Messwerk.
    verlust_bei_ms: AtomicU64,
    /// Erstes Bild NACH dem Verlust, ebenfalls in ms seit Beginn.
    erholung_bei_ms: AtomicU64,
    /// Unbeschädigte Bilder, deren Abschnitt nach dem Verlust ankam.
    bilder_nach: AtomicU64,
    /// Ankunftszeit des zuletzt gelesenen Pakets — das Ende der Messstrecke.
    letzte_ms: AtomicU64,
    /// Helligkeit je dekodiertem Bild, für die Ton-Bild-Messung
    /// (`super::tonurteil`). Nur der Auswerte-Faden schreibt, gelesen wird am
    /// Ende — deshalb eine Sperre und keine Atomkette.
    pub(super) bildblöcke: std::sync::Mutex<Vec<Bildblock>>,
}

impl Messwerk {
    pub(super) async fn lauf(
        &self,
        track: &webrtc::track::track_remote::TrackRemote,
        an_decoder: &std::sync::mpsc::Sender<Abschnitt>,
        t0: Instant,
        gemeinsam: Instant,
        mime: &str,
        verlust_ab: Option<u64>,
        verlust_pakete: u64,
    ) -> Result<()> {
        // **Nach dem Codec, nicht pauschal.** Ein AV1-Sammler auf einem
        // H.264-Strom liefert Unsinn, der wie ein Sender-Fehler aussieht.
        let mut sammler = Entpacker::fuer(mime)?;
        // `PULSE_MESSWERK_DUMP=<datei>` schreibt den zusammengesetzten Strom
        // mit. Damit lässt sich ein Streit zwischen Entpacker und Decoder
        // offline entscheiden (`ffprobe <datei>`) statt am laufenden Netz —
        // beim ersten Anlauf war genau das die Abkürzung, die gefehlt hat.
        //
        // **Gepuffert.** Ungepuffert wären es zwei Syscalls je Zeitabschnitt,
        // mitten in der Schleife, die im selben Atemzug die Millisekunden
        // misst — die Mitschrift ginge in die Messung ein.
        let mut mitschrift = std::env::var("PULSE_MESSWERK_DUMP")
            .ok()
            .and_then(|p| std::fs::File::create(p).ok())
            .map(std::io::BufWriter::new);
        let mut letzte_seq: Option<u16> = None;
        let mut stoerung = Verlustquelle::neu(verlust_ab, verlust_pakete);

        loop {
            let Ok((paket, _)) = track.read_rtp().await else {
                eprintln!(
                    "[messwerk] Bildspur endet nach {} ms ({} Paketen)",
                    self.letzte_ms.load(Ordering::Relaxed),
                    self.pakete.load(Ordering::Relaxed)
                );
                break;
            };
            self.pakete.fetch_add(1, Ordering::Relaxed);
            let seq = paket.header.sequence_number;
            let ms = t0.elapsed().as_millis() as u64;
            self.letzte_ms.store(ms, Ordering::Relaxed);

            // Die Störung sitzt VOR der Messung: was sie verwirft, hat es für
            // alles Folgende schlicht nie gegeben — Sequenzlücke inbegriffen.
            match stoerung.pruefe(ms) {
                Urteil::Behalten => {}
                Urteil::Verwerfen => continue,
                Urteil::LetztesVerworfene => {
                    // Erst hier die Uhr stellen — Begründung an `verlust_bei_ms`.
                    self.verlust_bei_ms.store(ms, Ordering::SeqCst);
                    self.verlust_erzeugt.store(stoerung.menge(), Ordering::SeqCst);
                    self.verlust_durch.notify_waiters();
                    continue;
                }
            }

            let luecke = letzte_seq.is_some_and(|l| seq != l.wrapping_add(1));
            letzte_seq = Some(seq);

            let abschnitt = sammler.schieb(&paket.payload, paket.header.marker, luecke)?;
            // Den Zähler des Sammlers durchreichen. **Er lief bis 2026-08-02
            // ins Leere** — die Auswertung meldete immer „0 verworfen", und das
            // liest sich wie „nichts ging verloren", was bei einem Lauf mit
            // erzeugtem Verlust nachweislich falsch ist. Hier statt am Ende der
            // Schleife, weil `ernte()` gerufen wird, während sie noch läuft.
            self.verworfen.store(sammler.verworfen(), Ordering::Relaxed);
            let Some(daten) = abschnitt else { continue };
            self.abschnitte.fetch_add(1, Ordering::Relaxed);
            if let Some(f) = mitschrift.as_mut() {
                use std::io::Write;
                // **AV1 braucht den Zeittrenner**, sonst ist die Mitschrift
                // wertlos: der Paketierer entfernt ihn (er ist über RTP
                // überflüssig, der Zeitstempel trennt schon), und ohne ihn
                // findet ein Leser keine Bildgrenzen — er meldet „No sequence
                // header available" und das sieht nach einem kaputten Strom
                // aus. Genau darauf bin ich am 2026-08-02 hereingefallen.
                // H.264 kommt bereits mit Startcodes (Annex B) heraus und
                // braucht nichts davor.
                if matches!(sammler, Entpacker::Av1(_)) {
                    let _ = f.write_all(&crate::whip::av1_entpacken::ZEITTRENNER);
                }
                let _ = f.write_all(&daten);
            }

            // **Nicht hier dekodieren.** Der Decoder braucht je Zeitabschnitt
            // Millisekunden bis Zehntelsekunden; läuft er im Lesepfad, wird
            // genau so viel gelesen, wie er verdaut. Der Empfangspuffer läuft
            // über, es entstehen Lücken, der Sammler verwirft, der Decoder
            // bekommt nur noch Bruchstücke und wird langsamer — ein
            // Teufelskreis, den das Messwerk SELBST erzeugt.
            //
            // Am 2026-08-02 genau darauf hereingefallen: der Server sendete
            // 570 KB, angekommen sind 115 Pakete. Das sah nach einem Fehler auf
            // der Strecke aus und war einer im Messwerk. Deshalb: lesen und
            // zusammensetzen hier, dekodieren nebenan.
            // **Der RTP-Zeitstempel reist mit.** Er ist die Bild-Uhr des
            // Senders und die einzige Größe, gegen die sich die Ton-Uhr
            // vergleichen lässt; die Ankunftszeit daneben misst die Leitung.
            // Alle Pakete eines Bildes tragen denselben Wert, deshalb genügt
            // der des abschließenden.
            let ms_gemeinsam = gemeinsam.elapsed().as_secs_f64() * 1000.0;
            let stueck = Abschnitt { daten, ms, rtp_ts: paket.header.timestamp, ms_gemeinsam };
            if an_decoder.send(stueck).is_err() {
                break; // Decoder-Faden ist weg
            }
        }
        Ok(())
    }

    /// Nimmt fertige Zeitabschnitte entgegen und dekodiert sie.
    ///
    /// **Läuft auf einem eigenen Betriebssystem-Faden, nicht als async-Aufgabe.**
    /// Dekodieren ist rechenintensiv und blockierend; als Aufgabe belegt es
    /// einen Arbeitsfaden der Laufzeit, und mit zweien davon steht dann alles —
    /// auch die Uhr, die den Lauf beenden soll. Beim ersten Anlauf blieb das
    /// Messwerk genau daran hängen: es lief nie zu Ende und lieferte gar
    /// nichts. Rechenarbeit gehört nicht in eine async-Schleife.
    pub(super) fn dekodiere(
        &self,
        mime: &str,
        von_lesen: std::sync::mpsc::Receiver<Abschnitt>,
    ) -> Result<()> {
        let mut decoder = Decoder::neu(mime)?;
        let mut ts0: Option<u32> = None;
        while let Ok(a) = von_lesen.recv() {
            let ms = a.ms;
            let ergebnis = decoder.bild(&a.daten);
            // Die Bild-Uhr auf den ersten Zeitabschnitt beziehen; sie zählt in
            // 90 kHz. Nur echte Bilder werden abgelegt — ein Zeitabschnitt ohne
            // Bild hat keine Helligkeit, und eine erfundene 0 sähe wie ein
            // schwarzes Bild aus und damit wie das Gegenteil eines Blitzes.
            if let Ok((Ausgang::Bild | Ausgang::Vollbild, hell)) = ergebnis {
                let anfang = *ts0.get_or_insert(a.rtp_ts);
                self.bildblöcke.lock().expect("Bildblöcke vergiftet").push(Bildblock {
                    ms_uhr: a.rtp_ts.wrapping_sub(anfang) as f64 / 90.0,
                    ms_ankunft: a.ms_gemeinsam,
                    helligkeit: hell,
                });
            }
            match ergebnis {
                Ok((Ausgang::Nichts, _)) => {}
                Ok((Ausgang::Beschaedigt, _)) => {
                    self.beschaedigt.fetch_add(1, Ordering::Relaxed);
                }
                Ok((gut @ (Ausgang::Bild | Ausgang::Vollbild), _)) => {
                    self.bilder.fetch_add(1, Ordering::Relaxed);
                    if matches!(gut, Ausgang::Vollbild) {
                        self.vollbilder.fetch_add(1, Ordering::Relaxed);
                    }
                    // **Einmal laden, beide Zähler daraus.** Zwei getrennte
                    // Abfragen könnten auseinanderlaufen — und „Bilder nach dem
                    // Verlust" und „erstes Bild nach dem Verlust" müssen
                    // dieselbe Grenze meinen, sonst widersprechen sich Rate und
                    // Lücke in der Auswertung.
                    //
                    // **`ms >= verlust` ist nicht redundant**: `ms` ist die
                    // Ankunftszeit des Abschnitts, nicht die des Bildes. Der
                    // Decoder läuft nebenan und kann eine Warteschlange haben —
                    // ein Abschnitt von VOR dem Verlust darf hier ankommen, und
                    // der zählte sonst als Erholung, mit einer Lücke „in die
                    // Vergangenheit".
                    let verlust = self.verlust_bei_ms.load(Ordering::SeqCst);
                    if self.verlust_erzeugt.load(Ordering::Relaxed) > 0 && ms >= verlust {
                        self.bilder_nach.fetch_add(1, Ordering::Relaxed);
                        // Erstes unbeschädigtes Bild danach: der Zeitpunkt, an
                        // dem der Zuschauer wieder etwas Richtiges sieht.
                        let _ = self.erholung_bei_ms.compare_exchange(
                            0,
                            ms,
                            Ordering::SeqCst,
                            Ordering::Relaxed,
                        );
                    }
                }
                Err(_) => {
                    self.decoder_fehler.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        Ok(())
    }

    pub(super) fn ernte(&self) -> Ergebnis {
        let verlust = self.verlust_bei_ms.load(Ordering::SeqCst);
        let erholung = self.erholung_bei_ms.load(Ordering::SeqCst);
        let ende = self.letzte_ms.load(Ordering::Relaxed);
        let bilder = self.bilder.load(Ordering::Relaxed);
        let nach = self.bilder_nach.load(Ordering::Relaxed);
        Ergebnis {
            pakete: self.pakete.load(Ordering::Relaxed),
            abschnitte: self.abschnitte.load(Ordering::Relaxed),
            verworfen: self.verworfen.load(Ordering::Relaxed),
            bilder,
            vollbilder: self.vollbilder.load(Ordering::Relaxed),
            beschaedigt: self.beschaedigt.load(Ordering::Relaxed),
            decoder_fehler: self.decoder_fehler.load(Ordering::Relaxed),
            luecke_ms: (verlust > 0 && erholung >= verlust).then(|| erholung - verlust),
            rate_vor: rate(bilder - nach, verlust),
            rate_nach: rate(nach, ende.saturating_sub(verlust)),
            verlust_erzeugt: self.verlust_erzeugt.load(Ordering::Relaxed),
            // Der Ton wird von der Sitzung nachgereicht — er hat sein eigenes
            // Werk, und ein leeres Feld hier ist ehrlicher als eine Kopie, die
            // nur zufällig zur selben Zeit entsteht.
            ton: Default::default(),
        }
    }
}

/// Bilder je Sekunde. Ohne Messstrecke keine Rate — dann 0, nicht „unendlich".
fn rate(bilder: u64, dauer_ms: u64) -> f64 {
    if dauer_ms == 0 { 0.0 } else { bilder as f64 * 1000.0 / dauer_ms as f64 }
}

