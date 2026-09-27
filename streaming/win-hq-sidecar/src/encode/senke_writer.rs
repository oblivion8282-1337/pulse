//! Abgabestelle für den angemeldeten Sendeweg — dasselbe, was [`super::mux_writer`]
//! für den Container ist, und aus demselben Grund: der Taktfaden darf nicht am
//! Netz hängen. **Die Herleitung steht dort**, samt der Messung von 2026-05-20,
//! die sie ausgelöst hat; sie wird hier nicht wiederholt.
//!
//! Der fremde Sendeweg hatte dieses Gegenstück nicht: Paketieren, Verschlüsseln
//! und `sendto` liefen **synchron im Taktfaden**. Bei den ersten Läufen ist das
//! nicht aufgefallen — aber ein Bild zerfällt in bis zu ein Dutzend RTP-Pakete
//! und der Ton in 200 je Sekunde, und es ist genau die Stelle, an der ein
//! Messstand für Latenz und Gleichmäßigkeit sich selbst verfälscht.
//!
//! Nebenwirkung, die dazugehört: `last_mux_us` misst damit auf **beiden** Wegen
//! wieder dasselbe, nämlich die Zeit fürs Einreihen. Vorher bedeutete derselbe
//! Messwert auf dem einen Weg „Warteschlange voll" und auf dem anderen „echte
//! Netzarbeit" — zwei Bedeutungen unter einem Namen.
//!
//! **Ohne Kopie.** Über den Kanal geht der `Packet` selbst, nicht seine Bytes:
//! er ist referenzgezählt, die Übergabe kostet nichts. Erst der Sendeweg holt
//! sich `data()`.

use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{Result, anyhow};
use ffmpeg_next::Packet;

use super::senke::PaketSenke;

/// Warteschlangen-Tiefe.
///
/// Bei 60 Bildern und 200 Tonpaketen je Sekunde sind 128 Einträge rund eine
/// halbe Sekunde. Das reicht, um einen Keyframe-Stoß zu schlucken, und ist
/// kurz genug, dass eine echte Stockung binnen einer halben Sekunde als
/// Gegendruck am Taktfaden ankommt statt als still wachsender Rückstand.
///
/// **Absichtlich kürzer als beim Muxer** (dort 256): dieser Weg ist Echtzeit
/// über WebRTC. Eine tiefe Warteschlange versteckt eine langsame Leitung nicht
/// nur, sie macht sie schlimmer — gepuffertes Video ist Verzögerung, die
/// niemand mehr aufholt.
const QUEUE_CAPACITY: usize = 128;

/// Was über den Kanal geht.
///
/// `unsafe impl Send`: `ffmpeg::Packet` ist nicht `Send` (ffmpeg-next markiert
/// konservativ). Gleiche Begründung wie bei `mux_writer::SendPacket` — erzeugt
/// auf dem Taktfaden, per *move* an genau einen Faden, dort verbraucht, kein
/// Aliasing; der `AVBufferRef`-Zähler ist atomar.
enum Sendung {
    Video(Packet),
    Ton(Packet),
}
unsafe impl Send for Sendung {}

/// Nimmt fertige Pakete entgegen und gibt sie auf einem eigenen Faden ab.
pub struct SenkenWriter {
    tx: Option<SyncSender<Sendung>>,
    worker: Option<JoinHandle<Result<()>>>,
    /// Fehlergrund des Fadens, BEVOR sein JoinHandle eingesammelt ist. Ohne das
    /// sähe der Erzeuger nur einen geschlossenen Kanal — und der Fehlerpfad der
    /// Pipeline erreicht `finish()` nie. Der Nutzer bekäme bei jedem
    /// Verbindungsabriss „Faden ist weg" statt der Ursache. Gleiche Konstruktion
    /// wie in `mux_writer`, aus demselben Grund.
    fail_msg: Arc<Mutex<Option<String>>>,
}

impl SenkenWriter {
    /// Übernimmt die Senke und startet den Faden. `ton_dauer` ist die
    /// Rahmenlänge eines Opus-Pakets — sie gilt fuer das ERSTE Paket und als
    /// Rueckfall ohne pts; alle folgenden Pakete bekommen ihre Dauer aus dem
    /// PTS-SPRUNG (s. [`ton_dauer_aus_pts`]). `ton_rate` ist die Abtastrate
    /// als Skala der Audio-pts.
    pub fn start(
        mut senke: Box<dyn PaketSenke>,
        ton_dauer: Duration,
        ton_rate: u32,
    ) -> Result<Self> {
        let (tx, rx) = sync_channel::<Sendung>(QUEUE_CAPACITY);
        let fail_msg: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let fail_slot = Arc::clone(&fail_msg);
        let worker = thread::Builder::new()
            .name("senken-writer".into())
            .spawn(move || -> Result<()> {
                let ergebnis =
                    sende_schleife(rx, senke.as_mut(), ton_dauer, ton_rate, &fail_slot);
                // Abbauen, auch wenn die Schleife an einem Sendefehler endet —
                // sonst bliebe die Sitzung beim Server stehen, bis ein
                // Zeitablauf sie aufräumt.
                //
                // **Was das NICHT deckt:** bricht der Taktfaden ab (Encoder-
                // oder Capture-Fehler), läuft er an `finish()` vorbei — der
                // Encoder ist `ManuallyDrop`, der Sender wird also nie
                // fallengelassen und dieser Faden wartet für immer auf den
                // Kanal. Das ist heute folgenlos, weil der Sidecar direkt
                // danach den Prozess beendet; wer das ändert, braucht hier
                // einen Abbruchweg.
                senke.schliesse();
                ergebnis
            })
            .map_err(|e| anyhow!("senken-writer-Faden starten: {e}"))?;
        Ok(Self { tx: Some(tx), worker: Some(worker), fail_msg })
    }

    /// Ein Videopaket einreihen. Blockiert nur, wenn die Warteschlange voll ist
    /// (= der Sendeweg kommt nicht nach).
    pub fn video(&self, packet: Packet) -> Result<()> {
        self.reihe_ein(Sendung::Video(packet))
    }

    /// Ein Tonpaket einreihen.
    pub fn audio(&self, packet: Packet) -> Result<()> {
        self.reihe_ein(Sendung::Ton(packet))
    }

    fn reihe_ein(&self, s: Sendung) -> Result<()> {
        match &self.tx {
            Some(tx) => tx.send(s).map_err(|_| {
                let grund =
                    super::fail_slot::lies(&self.fail_msg, "Faden beendet ohne hinterlegten Grund");
                anyhow!("senken-writer gescheitert: {grund}")
            }),
            None => Err(anyhow!("senken-writer bereits beendet")),
        }
    }

    /// Warteschlange schließen, auf den Faden warten, sein Ergebnis
    /// weiterreichen. Der Faden baut dabei die Sitzung ab.
    pub fn finish(&mut self) -> Result<()> {
        self.tx = None; // Sender fallen lassen -> Schleife endet auf EOF
        match self.worker.take() {
            Some(w) => match w.join() {
                Ok(result) => result,
                Err(_) => Err(anyhow!("senken-writer-Faden ist gepanict")),
            },
            None => Ok(()),
        }
    }
}

fn sende_schleife(
    rx: Receiver<Sendung>,
    senke: &mut dyn PaketSenke,
    ton_dauer: Duration,
    ton_rate: u32,
    fail_slot: &Mutex<Option<String>>,
) -> Result<()> {
    // pts des letzten abgegebenen Tonpakets — Bezug fuer den Dauer-Sprung.
    let mut letzte_ton_pts: Option<i64> = None;
    for s in rx {
        let ergebnis = match &s {
            // Der `pts` wird MIT durchgereicht, nicht neu erfunden: er steht
            // hier noch in der Encoder-Zeitbasis (der Extern-Weg rescaled
            // nicht, s. `encoder_hw::drain_video`), und genau die erwartet der
            // AV1-Paketierer.
            Sendung::Video(p) => p.data().map(|d| senke.video(d, p.pts())),
            Sendung::Ton(p) => p.data().map(|d| {
                let dauer =
                    ton_dauer_aus_pts(p.pts(), &mut letzte_ton_pts, ton_dauer, ton_rate);
                senke.audio(d, dauer)
            }),
        };
        // Ein Paket ohne Nutzlast ist nichts zu senden, aber auch kein Fehler.
        let Some(Err(e)) = ergebnis else { continue };
        eprintln!("[senken-writer] Senden fehlgeschlagen: {e:#}");
        // Grund ablegen, BEVOR der Kanal fällt: sonst sieht der Erzeuger nur
        // einen geschlossenen Kanal und meldet „Faden ist weg" statt der
        // Ursache. Dieselbe Reihenfolge wie in `mux_writer::write_loop`.
        super::fail_slot::hinterlege(fail_slot, &e);
        return Err(e);
    }
    Ok(())
}

/// Dauer eines Tonpakets fuer den Sendeweg: der PTS-SPRUNG seit dem letzten
/// Paket, nicht die feste Opus-Rahmenlaenge.
///
/// WebRTC (WHIP wie Direct) leitet den Ton-RTP-Zeitstempel aus der SUMME der
/// Paketdauern ab. Mit fester Rahmenlaenge lief die Ton-Zeitlinie als reiner
/// Paketzaehler: jeder Sprung der pts-Zeitlinie — der QPC-Nachzug auf den
/// ersten Geraete-Stempel (s. `audio::sync`), Stille-Einfuellungen des
/// WASAPI-Budgets — fehlte ihr DAUERHAFT, waehrend das Bild wanduhr-echte
/// Stempel traegt. Ton und Bild drifteten unbegrenzt auseinander
/// (47-Minuten-Stream 2026-09-23, Nutzermeldungen zu Bild/Ton-Versatz).
/// Zwilling im Linux-Sidecar: `whip_dauer` in `encode/audio.rs` — dort steht
/// die Diagnose ausfuehrlich.
///
/// Ohne pts (oder beim ersten Paket) gilt die Rahmenlaenge — der Sprung
/// waere sonst willkuerlich.
fn ton_dauer_aus_pts(
    pts: Option<i64>,
    letzte: &mut Option<i64>,
    rahmen: Duration,
    rate: u32,
) -> Duration {
    // ponytail: Deckel bei 1 s — ein groesserer Sprung ist kein Zeitstempel
    // mehr, sondern ein kaputter Anker; Untergrenze 1 ms haelt Stolperer
    // (Null/Sprung rueckwaerts) davon ab, die Zeitlinie einfrieren zu lassen.
    let ms = match pts {
        Some(p) => match letzte.replace(p) {
            Some(alte) => ((p - alte).max(0) * 1000 + i64::from(rate) - 1) / i64::from(rate),
            None => rahmen.as_millis() as i64,
        },
        None => rahmen.as_millis() as i64,
    };
    Duration::from_millis(ms.clamp(1, 1000) as u64)
}

#[cfg(test)]
mod dauer_tests {
    use std::time::Duration;

    use super::ton_dauer_aus_pts;

    const RAHMEN: Duration = Duration::from_millis(10);

    /// Der Rueckgrat-Fall: im ruhigen Lauf ist der PTS-Sprung die
    /// Rahmenlaenge — genau sie muss herauskommen, sonst driftet der Lauf
    /// schon von selbst. Das erste Paket hat keinen Bezug und faellt auf die
    /// Rahmenlaenge zurueck.
    #[test]
    fn ruhiger_lauf_trifft_die_rahmenlaenge() {
        let mut letzte = None;
        assert_eq!(ton_dauer_aus_pts(Some(0), &mut letzte, RAHMEN, 48_000), RAHMEN);
        assert_eq!(ton_dauer_aus_pts(Some(480), &mut letzte, RAHMEN, 48_000), RAHMEN);
        assert_eq!(
            ton_dauer_aus_pts(None, &mut letzte, RAHMEN, 48_000),
            RAHMEN,
            "ohne pts gilt die Rahmenlaenge"
        );
    }

    /// Ein Sprung der pts-Zeitlinie (QPC-Nachzug, Stille-Budget) traegt die
    /// Luecke IM GANZEN in den Zeitstempel — die feste Dauer liesse sie fuer
    /// immer fehlen, und der Ton liefe dem Bild davon.
    #[test]
    fn pts_spruenge_traegt_die_luecke_ganz() {
        let mut letzte = None;
        ton_dauer_aus_pts(Some(0), &mut letzte, RAHMEN, 48_000);
        assert_eq!(
            ton_dauer_aus_pts(Some(480 + 24_000), &mut letzte, RAHMEN, 48_000),
            Duration::from_millis(510)
        );
    }

    /// Stolperer duerfen die Zeitlinie nicht einfrieren und Riesen nicht den
    /// Deckel sprengen — QPC-Epochen-Differenzen sind real, kein Gedanken-
    /// spiel.
    #[test]
    fn stolperer_bleiben_minimal_riesen_gedeckelt() {
        let mut letzte = None;
        ton_dauer_aus_pts(Some(1_000_000), &mut letzte, RAHMEN, 48_000);
        assert_eq!(
            ton_dauer_aus_pts(Some(1_000_000), &mut letzte, RAHMEN, 48_000),
            Duration::from_millis(1),
            "Null-Sprung"
        );
        assert_eq!(
            ton_dauer_aus_pts(Some(999_000), &mut letzte, RAHMEN, 48_000),
            Duration::from_millis(1),
            "Ruecksprung"
        );
        assert_eq!(
            ton_dauer_aus_pts(Some(1_000_000 + 480_000), &mut letzte, RAHMEN, 48_000),
            Duration::from_millis(1000),
            "Deckel"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Attrappe: zaehlt, was ankommt, und kann auf Wunsch scheitern.
    struct Attrappe {
        video: Arc<AtomicUsize>,
        ton: Arc<AtomicUsize>,
        geschlossen: Arc<AtomicUsize>,
        scheitert_ab: usize,
    }

    impl PaketSenke for Attrappe {
        fn video(&mut self, _d: &[u8], _pts: Option<i64>) -> Result<()> {
            let n = self.video.fetch_add(1, Ordering::SeqCst) + 1;
            if self.scheitert_ab > 0 && n >= self.scheitert_ab {
                return Err(anyhow!("Attrappe scheitert absichtlich"));
            }
            Ok(())
        }
        fn audio(&mut self, _d: &[u8], _dauer: Duration) -> Result<()> {
            self.ton.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn schliesse(&mut self) {
            self.geschlossen.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn paket() -> Packet {
        // Inhalt egal — die Attrappe sieht nur, DASS etwas kam.
        Packet::new(8)
    }

    #[test]
    fn reicht_beide_spuren_durch_und_schliesst_genau_einmal() {
        let (v, t, c) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let senke = Attrappe {
            video: Arc::clone(&v),
            ton: Arc::clone(&t),
            geschlossen: Arc::clone(&c),
            scheitert_ab: 0,
        };
        let mut w = SenkenWriter::start(Box::new(senke), Duration::from_millis(5), 48_000).unwrap();
        w.video(paket()).unwrap();
        w.video(paket()).unwrap();
        w.audio(paket()).unwrap();
        w.finish().unwrap();
        assert_eq!(v.load(Ordering::SeqCst), 2, "beide Videopakete");
        assert_eq!(t.load(Ordering::SeqCst), 1, "das Tonpaket");
        assert_eq!(c.load(Ordering::SeqCst), 1, "genau einmal geschlossen");
    }

    /// Der Fehler der Senke muss als GRUND beim Erzeuger ankommen, nicht als
    /// „Faden ist weg". Das ist der ganze Zweck von `fail_msg` — und ohne Test
    /// bleibt die Reihenfolge (Grund ablegen, dann Kanal fallen lassen) eine
    /// Behauptung im Kommentar.
    #[test]
    fn fehler_der_senke_kommt_als_grund_an() {
        let (v, t, c) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let senke = Attrappe {
            video: Arc::clone(&v),
            ton: Arc::clone(&t),
            geschlossen: Arc::clone(&c),
            scheitert_ab: 1,
        };
        let w = SenkenWriter::start(Box::new(senke), Duration::from_millis(5), 48_000).unwrap();
        // Der erste Aufruf kann noch gelingen (der Faden ist evtl. noch nicht
        // so weit); ab dem Moment, in dem er es nicht mehr tut, MUSS die
        // Meldung die Ursache tragen.
        let mut meldung = None;
        for _ in 0..200 {
            match w.video(paket()) {
                Ok(()) => std::thread::sleep(Duration::from_millis(2)),
                Err(e) => {
                    meldung = Some(format!("{e:#}"));
                    break;
                }
            }
        }
        let meldung = meldung.expect("der Erzeuger muss den Fehler sehen");
        assert!(
            meldung.contains("absichtlich"),
            "die Ursache muss durchkommen, nicht nur 'Faden weg' — war: {meldung}"
        );
        assert_eq!(c.load(Ordering::SeqCst), 1, "auch im Fehlerfall abgebaut");
    }
}
