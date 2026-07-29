//! Audio-Encode-Pfad — libopus für FLV (Opus-in-FLV ist ab FFmpeg ≥6.1 nativ,
//! kein Patch nötig; wir linken FFmpeg 8).
//!
//! Portiert aus `mac-hq-sidecar/src/encode/audio.rs`. Der PipeWire-Sink-Monitor
//! (`capture::audio`) liefert interleaved Float32-Stereo @48kHz — genau libopus'
//! Eingabeformat (`AV_SAMPLE_FMT_FLT`). Wir akkumulieren in ein FIFO und emittieren
//! 960-Sample-Frames (20ms). Anders als der Mac läuft der Push auf einem eigenen
//! Encode-Thread und schiebt Packets über einen [`MuxSender`] (der Muxer
//! interleaved Video+Audio nach DTS).

use std::collections::VecDeque;

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{ChannelLayout, Dictionary, Packet, Rational, codec, format, frame};

use super::mux_writer::MuxSender;

/// Standard-Paketlänge des Tons in Millisekunden.
///
/// **Das ist eine BILDRATEN-Frage, nicht nur eine Ton-Frage.** FLV ist eine
/// einzige Zeitleiste: der Muxer gibt ein Bild erst frei, wenn Ton mit
/// passendem Zeitstempel vorliegt. Mit den üblichen 20 ms verließen die Bilder
/// den Sender also in 20-ms-Bündeln — bei 60 fps unauffällig (ein Bild dauert
/// 16,7 ms), ab etwa 144 fps deutlich sichtbar, bei 280 fps sind es sechs
/// Bilder je Bündel. Kürzere Tonpakete verkürzen die Wartezeit direkt und
/// wirken bei JEDER Bildrate; am Interleave-Delta zu drehen behebt dagegen nur
/// eine Bildrate und lässt bei höheren die Schreibreihenfolge kippen
/// (gemessen 2026-07-26: bei 280 fps starb der Stream mit `Invalid argument`).
///
/// 5 ms ist eine für Opus zulässige Länge (2,5/5/10/20/40/60). Kosten: mehr
/// Paket-Overhead auf einer 128-kbit/s-Spur — nichts gegen 25 Mbit/s Video.
const OPUS_FRAME_MS: usize = 5;

/// Samples pro Kanal und Opus-Paket bei 48 kHz. Über `PULSE_OPUS_FRAME_MS`
/// veränderbar (zulässig 2,5 wird nicht angeboten — nur ganze ms), damit die
/// Wahl messbar bleibt statt geraten zu werden.
pub fn opus_frame_ms() -> usize {
    static MS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *MS.get_or_init(|| {
        std::env::var("PULSE_OPUS_FRAME_MS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| [5, 10, 20, 40, 60].contains(v))
            .unwrap_or(OPUS_FRAME_MS)
    })
}

pub fn opus_frame_samples() -> usize {
    48 * opus_frame_ms()
}

/// Der frühere feste Wert (20 ms) — nur noch als Rechengröße in den Tests der
/// pts-Zeitlinie, die von der tatsächlichen Paketlänge unabhängig sind.
#[cfg(test)]
pub const OPUS_FRAME_SAMPLES: usize = 960;

/// Ab dieser Abweichung zwischen Wanduhr-Anker und interner pts-Zeitlinie wird
/// re-verankert (100 ms @48 kHz). Klein genug, dass hörbarer A/V-Versatz nach
/// einer Capture-Lücke korrigiert wird; groß genug, dass FIFO-Restbestand und
/// Batch-Jitter nie einen Sprung auslösen.
const RESYNC_THRESHOLD_SAMPLES: i64 = 4800;

/// Ab dieser Abweichung gilt die Zeitlinie als ANHALTEND zurueckgefallen —
/// aber erst, wenn sie es [`DRIFT_SUSTAINED_BATCHES`] Batches am Stueck ist
/// (15 ms @48 kHz).
///
/// Warum es das zusaetzlich zu [`RESYNC_THRESHOLD_SAMPLES`] braucht: die
/// 100-ms-Schwelle faengt den AUSSETZER, nicht den RUECKSTAND. Ein einmaliger
/// Haenger von 25 ms laesst die Zeitlinie dauerhaft um 25 ms hinter der
/// Wanduhr zurueck, und weil er unter der Schwelle bleibt, wird das nie wieder
/// eingeholt. Gemessen am 2026-07-27 im Desktop-Modus (Ton ueber den Null-Sink
/// des Routers): die Zeitlinie startet bei 2 bis 4 ms, springt nach wenigen
/// Sekunden auf 27 bis 29 ms und bleibt dort bis zum Streamende. Im
/// Mikrofonweg, der diesen Sink nicht durchlaeuft, bleibt sie bei 3 bis 6 ms.
///
/// Das kostet doppelt: der FLV-Muxer haelt jedes BILD fest, bis Ton mit
/// passendem Zeitstempel vorliegt (der Rueckstand ist also 1:1 Bild-Latenz,
/// heute durch `DEFAULT_INTERLEAVE_US` auf 10 ms gedeckelt), und der Ton
/// selbst laeuft dem Bild beim Zuschauer um denselben Betrag VORAUS.
///
/// 15 ms liegt sicher ueber dem normalen Zappeln (Mikrofonweg: 6,5 ms
/// Ausschlag) und deutlich unter dem beobachteten Rueckstand.
const DRIFT_THRESHOLD_SAMPLES: i64 = 720;

/// Wie viele Batches am Stueck der Rueckstand anliegen muss, bevor korrigiert
/// wird. Bei 2,7-ms-Batches sind das gut 0,4 s — lang genug, dass ein
/// einzelner Ausreisser nichts ausloest, kurz genug, dass ein echter
/// Rueckstand nicht die ganze Sitzung stehen bleibt.
const DRIFT_SUSTAINED_BATCHES: u32 = 150;

/// Audio-pts-Zeitlinie: verankert den ersten Frame an der Stream-Wanduhr und
/// RE-ankert nach Capture-Lücken. PipeWire liefert bei suspendiertem Node
/// (Stille) nichts — zählte man danach stur weiter (`+960` pro Frame), liefe
/// der Ton dem Video dauerhaft um exakt die Lückenlänge voraus.
struct PtsTimeline {
    out_pts: i64,
    anchored: bool,
    /// Nur fuer die Messung (`PULSE_MUX_LATENCY_LOG=1`): wie weit die Zeitlinie
    /// hinter der Wanduhr herlaeuft. Jede Millisekunde davon ist Bild-Latenz,
    /// weil der FLV-Muxer das Bild bis zum passenden Ton festhaelt.
    letzte_meldung: Option<std::time::Instant>,
    /// Batches am Stueck, in denen die Zeitlinie zurueckliegt (s.
    /// [`DRIFT_SUSTAINED_BATCHES`]).
    drift_batches: u32,
}

impl PtsTimeline {
    fn new() -> Self {
        Self {
            out_pts: 0,
            anchored: false,
            letzte_meldung: (std::env::var("PULSE_MUX_LATENCY_LOG").as_deref() == Ok("1"))
                .then(std::time::Instant::now),
            drift_batches: 0,
        }
    }

    /// `anchor_samples` = Wanduhr-Position des aktuellen Batches (Samples seit
    /// Stream-Epoche). Liefert den pts für den nächsten Opus-Frame; springt
    /// bei einer Lücke nach VORN, nie zurück (pts bleiben monoton).
    fn align(&mut self, anchor_samples: i64) -> i64 {
        let anchor = anchor_samples.max(0);
        if !self.anchored {
            self.out_pts = anchor;
            self.anchored = true;
        } else {
            let behind = anchor - self.out_pts;
            if behind > RESYNC_THRESHOLD_SAMPLES {
                tracing::info!(
                    target: "audio",
                    gap_samples = behind,
                    "Capture-Lücke — Audio-pts re-verankert"
                );
                self.out_pts = anchor;
                self.drift_batches = 0;
            } else if behind > DRIFT_THRESHOLD_SAMPLES {
                // Anhaltender Rueckstand statt einmaliger Aussetzer: aufholen,
                // sonst bleibt er bis zum Streamende stehen (s. Konstante).
                self.drift_batches += 1;
                if self.drift_batches >= DRIFT_SUSTAINED_BATCHES {
                    tracing::info!(
                        target: "audio",
                        rueckstand_ms = behind * 1000 / 48_000,
                        "Ton-Zeitlinie lag anhaltend zurueck — aufgeholt"
                    );
                    self.out_pts = anchor;
                    self.drift_batches = 0;
                }
            } else {
                self.drift_batches = 0;
            }
        }
        if let Some(seit) = self.letzte_meldung {
            if seit.elapsed() >= std::time::Duration::from_secs(1) {
                self.letzte_meldung = Some(std::time::Instant::now());
                tracing::info!(
                    target: "audio",
                    ms = format!("{:.1}", (anchor - self.out_pts) as f64 * 1000.0 / 48_000.0),
                    schwelle_ms = RESYNC_THRESHOLD_SAMPLES * 1000 / 48_000,
                    "Ton-Zeitlinie hinter der Wanduhr (unter der Schwelle wird nie korrigiert)"
                );
            }
        }
        self.out_pts
    }

    /// Nach einem emittierten Frame weiterzählen.
    fn advance(&mut self, samples: i64) {
        self.out_pts += samples;
    }
}

#[cfg(test)]
mod timeline_tests {
    use super::{
        DRIFT_SUSTAINED_BATCHES, DRIFT_THRESHOLD_SAMPLES, OPUS_FRAME_SAMPLES, PtsTimeline,
        RESYNC_THRESHOLD_SAMPLES,
    };

    const FRAME: i64 = OPUS_FRAME_SAMPLES as i64;

    #[test]
    fn anchors_first_batch_and_ignores_jitter() {
        let mut t = PtsTimeline::new();
        assert_eq!(t.align(1000), 1000);
        t.advance(FRAME);
        // Kleiner Batch-Jitter (< Schwelle) darf NICHT springen.
        assert_eq!(t.align(1000 + FRAME + 100), 1000 + FRAME);
    }

    /// Ein kleiner Rueckstand darf NICHT sofort korrigieren — sonst loest
    /// normales Zappeln staendig Spruenge aus.
    #[test]
    fn kleiner_rueckstand_springt_nicht_sofort() {
        let mut t = PtsTimeline::new();
        t.align(0);
        // Anker laeuft um mehr als die Drift-Schwelle voraus, aber nur kurz.
        for i in 1..DRIFT_SUSTAINED_BATCHES {
            let anchor = DRIFT_THRESHOLD_SAMPLES + 100 + i64::from(i);
            assert_eq!(t.align(anchor), 0, "Batch {i} haette nicht springen duerfen");
        }
    }

    /// Haelt der Rueckstand an, wird er aufgeholt. Ohne das bliebe er bis zum
    /// Streamende stehen und kostete 1:1 Bild-Latenz (s. DRIFT_THRESHOLD_SAMPLES).
    #[test]
    fn anhaltender_rueckstand_wird_aufgeholt() {
        let mut t = PtsTimeline::new();
        t.align(0);
        let anchor = DRIFT_THRESHOLD_SAMPLES + 100;
        for _ in 1..DRIFT_SUSTAINED_BATCHES {
            t.align(anchor);
        }
        assert_eq!(t.align(anchor), anchor, "nach anhaltendem Rueckstand aufholen");
    }

    /// Der Zaehler muss zuruecksetzen, sobald der Rueckstand weg ist — sonst
    /// summieren sich weit auseinanderliegende Ausreisser zu einem Sprung.
    #[test]
    fn unterbrochener_rueckstand_setzt_zurueck() {
        let mut t = PtsTimeline::new();
        t.align(0);
        let anchor = DRIFT_THRESHOLD_SAMPLES + 100;
        for _ in 1..DRIFT_SUSTAINED_BATCHES {
            t.align(anchor);
        }
        t.align(0); // dazwischen wieder in Ordnung -> Zaehler zurueck
        for _ in 1..DRIFT_SUSTAINED_BATCHES {
            assert_eq!(t.align(anchor), 0, "Zaehler haette zuruecksetzen muessen");
        }
    }

    /// Capture-Lücke (Node suspendiert): der Anker läuft der Zeitlinie weit
    /// voraus → re-ankern, sonst ist der Ton dauerhaft um die Lücke versetzt.
    #[test]
    fn reanchors_after_capture_gap() {
        let mut t = PtsTimeline::new();
        t.align(0);
        t.advance(FRAME);
        let gap_anchor = FRAME + RESYNC_THRESHOLD_SAMPLES + 48_000; // ~1s Lücke
        assert_eq!(t.align(gap_anchor), gap_anchor);
    }

    /// pts bleiben monoton: ein rückwärts laufender Anker (Capture eilt der
    /// Wanduhr voraus) darf die Zeitlinie nie zurückdrehen.
    #[test]
    fn never_jumps_backwards() {
        let mut t = PtsTimeline::new();
        t.align(48_000);
        t.advance(FRAME);
        assert_eq!(t.align(0), 48_000 + FRAME);
    }
}

pub struct AudioEncoder {
    encoder: codec::encoder::Audio,
    frame: frame::Audio,
    /// Interleaved Stereo-Float32-FIFO.
    fifo: VecDeque<f32>,
    channels: usize,
    stream_idx: usize,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    /// Output-pts-Zeitlinie (Samples, 1/sample_rate-Einheiten).
    timeline: PtsTimeline,
}

impl AudioEncoder {
    /// libopus-Encoder anlegen + Audio-Stream zu `output` hinzufügen. MUSS VOR
    /// `output.write_header()` laufen.
    pub fn create(
        output: &mut format::context::Output,
        sample_rate: u32,
        bitrate_kbps: u32,
    ) -> Result<Self> {
        let codec = codec::encoder::find_by_name("libopus")
            .ok_or_else(|| anyhow!("libopus-Encoder nicht im gelinkten FFmpeg"))?;
        let global_header = output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER);

        let mut stream = output.add_stream(codec).context("add_stream audio")?;
        let stream_idx = stream.index();

        let mut enc = codec::context::Context::new_with_codec(codec)
            .encoder()
            .audio()?;
        // libopus akzeptiert nur interleaved Float32.
        enc.set_format(format::Sample::F32(format::sample::Type::Packed));
        enc.set_rate(sample_rate as i32);
        enc.set_channel_layout(ChannelLayout::STEREO);
        enc.set_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        enc.set_time_base(Rational::new(1, sample_rate as i32));
        if global_header {
            enc.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        // Ohne diese Option bleibt libopus bei 20 ms und lehnt die kürzeren
        // Frames ab („more samples than frame size") — die Paketlänge steht an
        // ZWEI Stellen und muss zusammenpassen.
        let mut aopts = Dictionary::new();
        let dur = opus_frame_ms().to_string();
        aopts.set("frame_duration", &dur);
        let encoder = enc.open_with(aopts).context("open libopus encoder")?;
        stream.set_parameters(&encoder);

        let frame = frame::Audio::new(
            format::Sample::F32(format::sample::Type::Packed),
            opus_frame_samples(),
            ChannelLayout::STEREO,
        );

        Ok(Self {
            encoder,
            frame,
            fifo: VecDeque::new(),
            channels: 2,
            stream_idx,
            encoder_time_base: Rational::new(1, sample_rate as i32),
            stream_time_base: Rational::new(1, sample_rate as i32),
            timeline: PtsTimeline::new(),
        })
    }

    /// Vom Muxer zugewiesene Stream-Timebase setzen (nach `write_header` lesen).
    pub fn set_stream_time_base(&mut self, tb: Rational) {
        self.stream_time_base = tb;
    }

    /// Interleaved Stereo-Samples akkumulieren und volle Opus-Frames
    /// emittieren. `anchor_samples` = Wanduhr-Position DIESES Batches (Samples
    /// seit Stream-Epoche, mit Video geteilt) — verankert den ersten Frame-pts
    /// und re-ankert nach Capture-Lücken (s. [`PtsTimeline`]).
    pub fn push(&mut self, samples: &[f32], mux: &MuxSender, anchor_samples: i64) -> Result<()> {
        let mut pts = self.timeline.align(anchor_samples);
        self.fifo.extend(samples.iter().copied());
        let chunk = opus_frame_samples() * self.channels;
        while self.fifo.len() >= chunk {
            {
                // `make_contiguous` + `drain` statt `pop_front` je Sample: das
                // sparte bei 20-ms-Frames 1920 Ringpuffer-Entnahmen je Frame,
                // rund 96 000 je Sekunde. Die Bytes selbst bleiben eine sichere
                // Kopie je Sample — `unsafe`-Umdeuten von `f32` auf Bytes waere
                // hier ein schlechter Tausch, der Opus-Encode kostet
                // Groessenordnungen mehr als diese Schleife.
                let plane = self.frame.data_mut(0);
                let n = chunk.min(plane.len() / 4);
                let source = &self.fifo.make_contiguous()[..n];
                for (dst, v) in plane[..n * 4].chunks_exact_mut(4).zip(source) {
                    dst.copy_from_slice(&v.to_ne_bytes());
                }
                self.fifo.drain(..n);
            }
            self.frame.set_pts(Some(pts));
            self.timeline.advance(opus_frame_samples() as i64);
            pts = self.timeline.out_pts;
            self.encoder.send_frame(&self.frame).context("audio send_frame")?;
            self.drain(mux)?;
        }
        Ok(())
    }

    fn drain(&mut self, mux: &MuxSender) -> Result<()> {
        loop {
            let mut packet = Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {
                    packet.set_stream(self.stream_idx);
                    packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
                    mux.send(packet)?;
                }
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(ffmpeg::Error::Eof) => break,
                Err(e) => return Err(e).context("audio receive_packet"),
            }
        }
        Ok(())
    }

    pub fn flush(&mut self, mux: &MuxSender) -> Result<()> {
        self.encoder.send_eof().context("audio send_eof")?;
        self.drain(mux)
    }

    pub fn stream_idx(&self) -> usize {
        self.stream_idx
    }
}
