//! Async muxer-writer — decouples `write_interleaved` from the pacing loop.
//!
//! Verbatim aus `streaming/{win,mac}-hq-sidecar/src/encode/mux_writer.rs`
//! (platform-agnostic). Der Muxer (`AVFormatContext`) lebt auf einem eigenen
//! Thread; der Pacing-Loop encodiert nur und schiebt fertige Packets in eine
//! bounded Queue. Ein Keyframe-Socket-Stall staut sich dann in der Queue statt
//! die Capture/Encode-Kadenz einzufrieren.

use std::collections::VecDeque;
use std::sync::mpsc::{SyncSender, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Packet, format};

/// Queue depth — must absorb a keyframe burst without blocking the encoder.
///
/// Bewusst KLEIN gehalten: 256 Pakete waren bei 60 fps rund vier Sekunden
/// Video. Stockt der RTMPS-Socket, laeuft die Queue voll, und diese vier
/// Sekunden bekommt der Zuschauer nie zurueck — ein Live-Stream holt nicht auf.
/// 32 Pakete (~0,5 s) fangen eine Keyframe-Spitze weiterhin ab, machen aber aus
/// einem langen Verzug einen kurzen. Das Blockieren selbst ist harmlos: die pts
/// kommen aus der Wanduhr (`stream_controller`), die Zeitlinie springt also
/// korrekt weiter statt zu driften.
/// Ueber `PULSE_MUX_QUEUE` veraenderbar — die Frage "steht die Warteschlange
/// dauerhaft voll und kostet damit feste Latenz" ist nur durch Vergleich zu
/// beantworten, nicht durch Nachdenken.
fn queue_capacity() -> usize {
    std::env::var("PULSE_MUX_QUEUE")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(QUEUE_CAPACITY)
}

const QUEUE_CAPACITY: usize = 32;

/// `ffmpeg::Packet` isn't `Send` (ffmpeg-next marks it conservatively). The
/// hand-off is sound: the packet is created on ONE producer thread (video
/// pacing loop or audio encode thread), *moved* over the channel to exactly
/// one writer thread and consumed there — no aliasing.
struct SendPacket(Packet);
// SAFETY: see above.
unsafe impl Send for SendPacket {}

/// Same for the `Output` context: moved once to the writer thread, never
/// touched by the producer afterwards.
struct SendOutput(format::context::Output);
// SAFETY: see above.
unsafe impl Send for SendOutput {}

/// Queue-Nachricht: Packet oder das Shutdown-Sentinel aus `finish()`. Ohne
/// Sentinel endete der Writer-Loop erst, wenn ALLE Sender (inkl. jedes
/// `MuxSender`-Clones des Audio-Threads) gedroppt sind — ein Ordering-Fehler
/// im Caller machte `finish()` dann zum ewigen Hänger. (Abweichung von
/// win/mac-hq-sidecar; dort besteht dasselbe Risiko noch.)
enum MuxMsg {
    Packet(SendPacket),
    Shutdown,
}

/// Cloneable handle for pushing packets to the muxer from multiple producer
/// threads (video pacing loop + audio encode thread). All packets land in the
/// same bounded queue and are interleaved by the writer thread via
/// `write_interleaved` (DTS order).
#[derive(Clone)]
pub struct MuxSender(SyncSender<MuxMsg>);

impl MuxSender {
    /// Push a finished packet (stream index set, timestamps rescaled to the
    /// stream timebase). Blocks only when the queue is full (= writer stuck).
    pub fn send(&self, packet: Packet) -> Result<()> {
        self.0
            .send(MuxMsg::Packet(SendPacket(packet)))
            .map_err(|_| anyhow!("mux-writer thread is gone"))
    }
}

/// Bildet nach, wie lange `write_interleaved` ein Videopaket festhält.
///
/// Der Interleaver gibt ein Videopaket erst heraus, wenn aus JEDEM anderen
/// Strom ein Paket mit mindestens so großem Zeitstempel vorliegt (oder
/// `max_interleave_delta` reißt). Hinkt die Tonaufnahme in Echtzeit hinter der
/// Bildaufnahme her, wartet also jedes Bild genau um diesen Rückstand — eine
/// FESTE ZEIT, unabhängig von der Datenmenge. Genau das Muster hatte die
/// Latenzmessung am 2026-07-27 übrig gelassen, nachdem MediaMTX (unter 1 ms)
/// und der Empfangsweg im Player (0,04 ms) direkt ausgeschlossen waren.
///
/// Die Sonde misst den RÜCKSTAND DES TONS, nicht die tatsächliche Haltezeit:
/// sie hält Videopakete offen, bis Ton mit passendem Zeitstempel durchkommt.
/// `max_interleave_delta` sieht sie NICHT — sobald der Deckel greift (seit
/// 2026-07-27 bei 10 ms, s. `DEFAULT_INTERLEAVE_US`), meldet sie weiter den
/// vollen Rückstand, während der Muxer längst früher freigibt. Wer den Deckel
/// bewerten will, misst Ende zu Ende (`real-harness.py --e2e`); wer die
/// Ursache sucht, liest diese Zahl. Nur über `PULSE_MUX_LATENCY_LOG=1`, weil
/// sie je Paket Buch führt.
struct InterleaveProbe {
    an: bool,
    /// (Zeitstempel in ms, Wanduhr beim Eintreffen)
    offen: VecDeque<(f64, Instant)>,
    wartezeiten: Vec<f64>,
    /// Je Bild: Wanduhr beim Schreiben minus eigener Zeitstempel. Davon den
    /// Nullpunkt der Aufnahme abgezogen (den `stream_controller` einmal
    /// meldet) ergibt den Sendeweg ab Aufnahme.
    sendeversatz: Vec<f64>,
    letzte_meldung: Instant,
}

/// Mittelwert + Maximum aus `vals` ziehen und leeren; `None` bei leerer
/// Sammlung (dann bleibt `vals` unveraendert, wie beim vorherigen
/// `if !vals.is_empty() { … vals.clear(); }`).
fn drain_avg_max(vals: &mut Vec<f64>) -> Option<(f64, f64, usize)> {
    if vals.is_empty() {
        return None;
    }
    let n = vals.len();
    let summe: f64 = vals.iter().sum();
    let max = vals.iter().copied().fold(0.0_f64, f64::max);
    vals.clear();
    Some((summe / n as f64, max, n))
}

impl InterleaveProbe {
    fn new() -> Self {
        Self {
            an: std::env::var("PULSE_MUX_LATENCY_LOG").as_deref() == Ok("1"),
            offen: VecDeque::new(),
            wartezeiten: Vec::new(),
            sendeversatz: Vec::new(),
            letzte_meldung: Instant::now(),
        }
    }

    fn beobachte(&mut self, pkt: &Packet, output: &format::context::Output) {
        if !self.an {
            return;
        }
        let (Some(dts), Some(stream)) = (pkt.dts(), output.stream(pkt.stream())) else {
            return;
        };
        // dts steht in der Zeitbasis DES STROMS — Bild und Ton haben
        // verschiedene. Ohne Umrechnung vergliche man Äpfel mit Birnen.
        let tb = stream.time_base();
        let ms = dts as f64 * f64::from(tb.numerator()) / f64::from(tb.denominator()) * 1000.0;
        let jetzt = Instant::now();

        if stream.parameters().medium() == ffmpeg::media::Type::Audio {
            while self.offen.front().is_some_and(|(v, _)| *v <= ms) {
                let (_, seit) = self.offen.pop_front().expect("front geprüft");
                self.wartezeiten.push(seit.elapsed().as_secs_f64() * 1000.0);
            }
        } else {
            self.offen.push_back((ms, jetzt));
            // Zweite, unabhaengige Groesse: wie spaet dieses Bild — gemessen an
            // seinem eigenen Zeitstempel — auf die Leitung geht. Zusammen mit
            // dem Nullpunkt aus `stream_controller` ergibt das den GANZEN
            // Sendeweg ab Aufnahme, ohne Umweg ueber eine Subtraktion.
            let wall = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            self.sendeversatz.push(wall - ms);
        }

        if self.letzte_meldung.elapsed() >= Duration::from_secs(1) {
            self.letzte_meldung = jetzt;
            if let Some((avg_ms, max_ms, n)) = drain_avg_max(&mut self.wartezeiten) {
                tracing::info!(
                    target: "mux",
                    avg_ms = format!("{avg_ms:.1}"),
                    max_ms = format!("{max_ms:.1}"),
                    packets = n,
                    offen = self.offen.len(),
                    "Interleave-Halt: wie lange ein Bild auf passenden Ton wartet"
                );
            }
            if let Some((avg_ms, max_ms, _)) = drain_avg_max(&mut self.sendeversatz) {
                tracing::info!(
                    target: "mux",
                    avg_ms = format!("{avg_ms:.1}"),
                    max_ms = format!("{max_ms:.1}"),
                    "Sendeversatz roh (minus Nullpunkt der Aufnahme = Sendeweg)"
                );
            }
        }
    }
}

pub struct MuxWriter {
    tx: Option<SyncSender<MuxMsg>>,
    worker: Option<JoinHandle<Result<()>>>,
}

impl MuxWriter {
    /// Takes the fully-configured output context (`write_header` already run,
    /// all streams added) and starts the writer thread.
    pub fn start(output: format::context::Output) -> Result<Self> {
        let (tx, rx) = sync_channel::<MuxMsg>(queue_capacity());
        let out = SendOutput(output);
        let worker = thread::Builder::new()
            .name("mux-writer".into())
            .spawn(move || -> Result<()> {
                let mut output = out.0;
                let mut halt = InterleaveProbe::new();
                for msg in rx {
                    let pkt = match msg {
                        MuxMsg::Packet(p) => p,
                        // finish() → Trailer schreiben, egal welche Sender-
                        // Clones noch leben (deren spätere Sends schlagen fehl).
                        MuxMsg::Shutdown => break,
                    };
                    halt.beobachte(&pkt.0, &output);
                    if let Err(e) = pkt.0.write_interleaved(&mut output) {
                        tracing::error!(target: "mux", "write_interleaved fehlgeschlagen: {e:#}");
                        return Err(e).context("mux-writer: write_interleaved");
                    }
                    // Push the bytes onto the wire after every packet (live
                    // low-latency). AVFMT_FLAG_FLUSH_PACKETS is unreliable for the
                    // FLV/RTMP path, so flush the AVIO context explicitly.
                    unsafe {
                        let ctx = output.as_mut_ptr();
                        let pb = (*ctx).pb;
                        if !pb.is_null() {
                            ffmpeg::ffi::avio_flush(pb);
                        }
                    }
                }
                // Channel closed = EOF → write the FLV trailer (clean RTMP/TLS close).
                output.write_trailer().context("mux-writer: write_trailer")?;
                Ok(())
            })
            .context("spawn mux-writer thread")?;
        Ok(Self { tx: Some(tx), worker: Some(worker) })
    }

    /// Push a finished packet (stream index set, timestamps rescaled to the
    /// stream timebase). Blocks only when the queue is full (= writer stuck).
    pub fn send(&self, packet: Packet) -> Result<()> {
        match &self.tx {
            Some(tx) => tx
                .send(MuxMsg::Packet(SendPacket(packet)))
                .map_err(|_| anyhow!("mux-writer thread is gone")),
            None => Err(anyhow!("mux-writer already finished")),
        }
    }

    /// A cloneable sender for a second producer thread (audio). `finish()`
    /// beendet den Writer über ein Shutdown-Sentinel — lebende Clones blocken
    /// den Trailer NICHT mehr, ihre späteren Sends schlagen nur fehl. Sauberes
    /// Draining verlangt trotzdem: Audio zuerst stoppen, dann `finish()`.
    pub fn sender(&self) -> Result<MuxSender> {
        match &self.tx {
            Some(tx) => Ok(MuxSender(tx.clone())),
            None => Err(anyhow!("mux-writer already finished")),
        }
    }

    /// Close the queue, wait for the writer thread (which writes the trailer)
    /// and propagate its result. Beendet den Writer über das Shutdown-Sentinel
    /// — hängt damit auch dann nicht, wenn noch ein `MuxSender`-Clone lebt.
    pub fn finish(&mut self) -> Result<()> {
        if let Some(tx) = self.tx.take() {
            // Fehler = Writer bereits weg (Fehler-Exit) → join liefert dessen Result.
            let _ = tx.send(MuxMsg::Shutdown);
        }
        match self.worker.take() {
            Some(w) => match w.join() {
                Ok(result) => result,
                Err(_) => Err(anyhow!("mux-writer thread panicked")),
            },
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod finish_tests {
    use super::*;
    use std::time::Duration;

    fn null_output_with_stream() -> format::context::Output {
        let path = std::env::temp_dir().join("pulse-mux-finish-test");
        let mut output = format::output_as(&path, "null").expect("null muxer");
        unsafe {
            let st = ffmpeg::ffi::avformat_new_stream(output.as_mut_ptr(), std::ptr::null());
            assert!(!st.is_null());
            let par = (*st).codecpar;
            (*par).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
            (*par).codec_id = ffmpeg::ffi::AVCodecID::AV_CODEC_ID_RAWVIDEO;
            (*par).width = 16;
            (*par).height = 16;
        }
        output.write_header().expect("write_header (null)");
        output
    }

    /// `finish()` darf NICHT darauf warten, dass auch alle geklonten
    /// `MuxSender` (Audio-Thread) gedroppt sind — ein Ordering-Fehler im
    /// Caller (z. B. Video-Fehlerpfad ruft `finish`, während Audio noch läuft)
    /// würde sonst zum ewigen Hänger im Stop-Pfad statt zu einem Fehler.
    #[test]
    fn finish_returns_even_while_a_clone_sender_is_alive() {
        let mut w = MuxWriter::start(null_output_with_stream()).unwrap();
        let audio_sender = w.sender().unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let h = std::thread::spawn(move || {
            let _ = done_tx.send(w.finish().is_ok());
        });
        let finished = done_rx.recv_timeout(Duration::from_secs(5));
        drop(audio_sender); // erst NACH dem Timeout-Fenster droppen
        assert!(finished.is_ok(), "finish() hängt, solange ein Clone-Sender lebt");
        let _ = h.join();
    }
}
