//! Audio encode path — libopus for FLV (Opus-in-FLV is native in FFmpeg ≥6.1,
//! so no patch is needed; we link FFmpeg 8).
//!
//! ScreenCaptureKit delivers interleaved Float32 stereo @48kHz (see
//! `capture::AudioFrame`), which is exactly libopus' input format
//! (`AV_SAMPLE_FMT_FLT`). Accumulate into a FIFO, emit 960-sample (20ms) frames.
//! Ported in spirit from `win-hq-sidecar/src/encode/audio.rs`; die pts-Zeitlinie
//! ist wanduhr-verankert wie der Linux-Zwilling (`PtsTimeline` dort).

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{ChannelLayout, Dictionary, Packet, Rational, codec, format, frame};

use super::mux_writer::MuxWriter;
use crate::whip::WhipSender;

/// 20ms @48kHz = 960 samples per channel — the standard libopus frame.
pub const OPUS_FRAME_SAMPLES: usize = 960;

/// Wohin die Ton-Pakete gehen.
///
/// Drei Wege mit grundverschiedener Natur: der Muxer will ein `Packet` mit
/// Stream-Index und umgerechneter Zeitbasis; die WebRTC-Spuren wollen rohe
/// Bytes und die Dauer des Pakets (WHIP an MediaMTX, `Direct` direkt zum
/// Player). Zwilling zu `TonSenke` im Linux-Sidecar — dort als `Arc`-Clones,
/// weil Audio dort auf einem eigenen Encode-Faden laeuft; hier als
/// Referenzen, weil `push_audio` (`encode/mod.rs`) synchron im selben Faden
/// wie das Bild aufgerufen wird und keinen eigenen Ton-Faden hat.
pub enum TonSenke<'a> {
    Mux(&'a MuxWriter),
    Whip(&'a Arc<WhipSender>),
    Direct(&'a Arc<pulse_whip::direct::DirectSender>),
}

pub struct AudioEncoder {
    encoder: codec::encoder::Audio,
    frame: frame::Audio,
    /// Interleaved stereo Float32 FIFO.
    fifo: VecDeque<f32>,
    channels: usize,
    stream_idx: usize,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    /// Output-pts-Zeitlinie (Samples, 1/sample_rate-Einheiten) — wanduhr-
    /// verankert pro Batch (s. [`PtsTimeline`]).
    timeline: PtsTimeline,
    /// Sample-Rate fuer die WHIP-Dauer-Rechnung (s. [`AudioEncoder::whip_dauer`]).
    sample_rate: u32,
    /// pts des letzten auf den WHIP-/Direktweg gesandten Pakets (Samples) —
    /// Bezug fuer den Dauer-Sprung (s. [`AudioEncoder::whip_dauer`]).
    letzte_ton_pts: Option<i64>,
}

/// Paketdauer der WHIP-Tonspur — die Laenge EINES Opus-Pakets. Sie gilt fuer
/// das ERSTE Paket und als Rueckfall ohne pts; alle folgenden Pakete bekommen
/// ihre Dauer aus dem PTS-SPRUNG (s. [`AudioEncoder::whip_dauer`]).
const OPUS_FRAME_DURATION: Duration = Duration::from_millis(20);

/// Ab dieser Abweichung zwischen Wanduhr-Anker und interner pts-Zeitlinie wird
/// re-verankert (100 ms @48 kHz). Wortgleich zum Linux-Zwilling
/// (`encode/audio.rs` dort, mit der Messgeschichte) — ScreenCaptureKit kann
/// die Ton-Auslieferung ebenso aussetzen (Geraetewechsel, Stau), und zaehlte man
/// danach stur weiter (`+960` pro Frame), liefe der Ton dem Video dauerhaft um
/// exakt die Lueckenlaenge voraus.
const RESYNC_THRESHOLD_SAMPLES: i64 = 4800;

/// Ab dieser Abweichung gilt die Zeitlinie als ANHALTEND zurueckgefallen —
/// aber erst, wenn sie es [`DRIFT_SUSTAINED_BATCHES`] Batches am Stueck ist
/// (15 ms @48 kHz). Zwilling zum Linux-Sidecar (dort die Messgeschichte).
const DRIFT_THRESHOLD_SAMPLES: i64 = 720;

/// Wie viele Batches am Stueck der Rueckstand anliegen muss, bevor korrigiert
/// wird. Wortgleich zum Linux-Zwilling.
const DRIFT_SUSTAINED_BATCHES: u32 = 150;

/// Audio-pts-Zeitlinie: verankert den ersten Frame an der Stream-Wanduhr und
/// RE-ankert nach Capture-Luecken — der Zwilling von `PtsTimeline` im
/// Linux-Sidecar (`encode/audio.rs` dort). Ohne sie waere `out_pts` ein reiner
/// Paketzaehler, und der Ton-RTP-Stempel (der die Paketdauren SUMMIERT, s.
/// [`AudioEncoder::whip_dauer`]) liese jede Luecke und jeden Geraetetaktschlupf
/// dauerhaft gegen das wanduhr-echt gestempelte Bild weglaufen.
struct PtsTimeline {
    out_pts: i64,
    anchored: bool,
    /// Batches am Stueck, in denen die Zeitlinie zurueckliegt (s.
    /// [`DRIFT_SUSTAINED_BATCHES`]).
    drift_batches: u32,
}

impl PtsTimeline {
    fn new() -> Self {
        Self { out_pts: 0, anchored: false, drift_batches: 0 }
    }

    /// `anchor_samples` = Wanduhr-Position des aktuellen Batches (Samples seit
    /// Stream-Epoche, mit dem Bild geteilt — SCK-CMTime). Liefert den pts fuer
    /// den naechsten Opus-Frame; springt bei einer Luecke nach VORN, nie
    /// zurueck (pts bleiben monoton).
    fn align(&mut self, anchor_samples: i64) -> i64 {
        let anchor = anchor_samples.max(0);
        if !self.anchored {
            self.out_pts = anchor;
            self.anchored = true;
        } else {
            let behind = anchor - self.out_pts;
            if behind > RESYNC_THRESHOLD_SAMPLES {
                eprintln!(
                    "[mac-hq-sidecar] Capture-Luecke — Audio-pts re-verankert ({behind} Samples)"
                );
                self.out_pts = anchor;
                self.drift_batches = 0;
            } else if behind > DRIFT_THRESHOLD_SAMPLES {
                // Anhaltender Rueckstand statt einmaliger Aussetzer: aufholen,
                // sonst bleibt er bis zum Streamende stehen (Geraetetakt vs.
                // Wanduhr).
                self.drift_batches += 1;
                if self.drift_batches >= DRIFT_SUSTAINED_BATCHES {
                    eprintln!(
                        "[mac-hq-sidecar] Ton-Zeitlinie lag anhaltend zurueck — aufgeholt ({} ms)",
                        behind * 1000 / 48_000
                    );
                    self.out_pts = anchor;
                    self.drift_batches = 0;
                }
            } else {
                self.drift_batches = 0;
            }
        }
        self.out_pts
    }

    /// Nach einem emittierten Frame weiterzaehlen.
    fn advance(&mut self, samples: i64) {
        self.out_pts += samples;
    }
}

impl AudioEncoder {
    /// Gemeinsamer Aufbau um einen bereits geoeffneten Encoder herum.
    fn new(encoder: codec::encoder::Audio, stream_idx: usize, sample_rate: u32) -> Self {
        let tb = Rational::new(1, sample_rate as i32);
        Self {
            encoder,
            frame: frame::Audio::new(
                format::Sample::F32(format::sample::Type::Packed),
                OPUS_FRAME_SAMPLES,
                ChannelLayout::STEREO,
            ),
            fifo: VecDeque::new(),
            channels: 2,
            stream_idx,
            encoder_time_base: tb,
            // Der Muxer-Weg ueberschreibt das nach `write_header`
            // (`set_stream_time_base`); auf dem WHIP-Weg wird nie umgerechnet.
            stream_time_base: tb,
            timeline: PtsTimeline::new(),
            sample_rate,
            letzte_ton_pts: None,
        }
    }

    /// libopus-Encoder mit den fuer beide Wege gleichen Einstellungen oeffnen.
    fn open_opus(sample_rate: u32, bitrate_kbps: u32, global_header: bool) -> Result<codec::encoder::Audio> {
        let codec = codec::encoder::find_by_name("libopus")
            .ok_or_else(|| anyhow!("libopus encoder not in linked FFmpeg"))?;
        let mut enc = codec::context::Context::new_with_codec(codec).encoder().audio()?;
        // libopus' encoder only accepts interleaved Float32.
        enc.set_format(format::Sample::F32(format::sample::Type::Packed));
        enc.set_rate(sample_rate as i32);
        enc.set_channel_layout(ChannelLayout::STEREO);
        enc.set_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        enc.set_time_base(Rational::new(1, sample_rate as i32));
        if global_header {
            enc.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        // In-Band-Fehlerkorrektur — die einzige Absicherung, die die Tonspur
        // ueberhaupt haben kann (MediaMTX erzeugt FlexFEC nur fuer die
        // Videospur, s. `infra/mediamtx-fork/patches/0003-flexfec-on-whep`).
        //
        // **Bis hierher war sie auf macOS als einzigem Sidecar aus.** Das SDP
        // sagt sie auf allen drei zu — `useinbandfec=1` steht in der
        // gemeinsamen `pulse-whip::sdp::opus_capability` —, eingeschaltet
        // haben sie nur Linux (`encode/audio.rs`) und Windows
        // (`encode/audio/mod.rs`). Eine Zusage ohne Einloesung: der Empfaenger
        // richtet sich darauf ein, dass ein verlorenes Paket aus dem naechsten
        // teilweise wiederherstellbar ist, und bekam auf macOS nichts.
        //
        // `packet_loss` ist Pflicht, nicht Zierde: libopus legt die Redundanz
        // nach der ERWARTETEN Verlustrate aus, bei 0 entsteht keine und `fec=1`
        // bleibt folgenlos. Werte wortgleich von den beiden Zwillingen
        // uebernommen — nicht gemessen, wer sie dreht, misst nach.
        //
        // Keine Abfrage der Paketlaenge wie auf Linux: LBRR ist ein
        // SILK-Merkmal und gibt es unter 10 ms nicht, dieser Sidecar sendet
        // aber fest 20 ms (s. [`OPUS_FRAME_SAMPLES`]) und hat keinen Schalter
        // dafuer. Eine Bedingung haette hier nur einen Fall, der nicht
        // eintreten kann.
        let mut aopts = Dictionary::new();
        aopts.set("fec", "1");
        aopts.set("packet_loss", "5");
        enc.open_with(aopts).context("open libopus encoder")
    }

    /// Create the libopus encoder + add an audio stream to `output`. Must run
    /// BEFORE `output.write_header()`.
    pub fn create(
        output: &mut format::context::Output,
        sample_rate: u32,
        bitrate_kbps: u32,
    ) -> Result<Self> {
        // VOR `add_stream` lesen — das leiht `output` mutable aus.
        let global_header = output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER);
        let codec = codec::encoder::find_by_name("libopus")
            .ok_or_else(|| anyhow!("libopus encoder not in linked FFmpeg"))?;
        let mut stream = output.add_stream(codec).context("add_stream audio")?;
        let stream_idx = stream.index();

        let encoder = Self::open_opus(sample_rate, bitrate_kbps, global_header)?;
        stream.set_parameters(&encoder);

        Ok(Self::new(encoder, stream_idx, sample_rate))
    }

    /// libopus-Encoder OHNE Container — fuer den eigenen WHIP-Sendeweg.
    ///
    /// Dort gibt es weder Stream noch Kopf: die Spur nimmt rohe Opus-Pakete.
    /// `global_header` ist deshalb aus, und `stream_idx` bleibt 0 (auf diesem
    /// Weg nie benutzt, s. `drain`).
    pub fn create_standalone(sample_rate: u32, bitrate_kbps: u32) -> Result<Self> {
        let encoder = Self::open_opus(sample_rate, bitrate_kbps, false)?;
        Ok(Self::new(encoder, 0, sample_rate))
    }

    /// Set the muxer-assigned stream timebase (read after `write_header`).
    pub fn set_stream_time_base(&mut self, tb: Rational) {
        self.stream_time_base = tb;
    }

    /// Accumulate interleaved stereo samples and emit full 20ms Opus frames.
    /// `anchor_samples` is the wall-clock position of THIS batch (in 48kHz
    /// samples since the shared stream epoch) — it anchors the FIRST frame's
    /// pts AND re-anchors after capture gaps / catches up sustained lag (s.
    /// [`PtsTimeline`]), so audio stays on the video timeline.
    pub fn push(&mut self, samples: &[f32], senke: &TonSenke, anchor_samples: i64) -> Result<()> {
        let mut pts = self.timeline.align(anchor_samples);
        self.fifo.extend(samples.iter().copied());
        let chunk = OPUS_FRAME_SAMPLES * self.channels;
        while self.fifo.len() >= chunk {
            {
                let plane = self.frame.data_mut(0);
                let n = chunk.min(plane.len() / 4);
                for i in 0..n {
                    let v = self.fifo.pop_front().unwrap_or(0.0);
                    plane[i * 4..i * 4 + 4].copy_from_slice(&v.to_ne_bytes());
                }
            }
            self.frame.set_pts(Some(pts));
            self.timeline.advance(OPUS_FRAME_SAMPLES as i64);
            pts = self.timeline.out_pts;
            self.encoder.send_frame(&self.frame).context("audio send_frame")?;
            self.drain(senke)?;
        }
        Ok(())
    }

    fn drain(&mut self, senke: &TonSenke) -> Result<()> {
        loop {
            let mut packet = Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {
                    // ShadowPlay-Tee (s. encode/mod.rs beim Bild): die fertigen
                    // Opus-Bytes in den Clip-Ring. Millisekunden aus der
                    // Sample-Uhr (48 kHz) — der Encoder uebernimmt den
                    // Rahmen-pts meist ins Paket, der Fallback zaehlt Rahmen.
                    if let Some(d) = packet.data() {
                        let pts = packet
                            .pts()
                            .unwrap_or(self.timeline.out_pts.saturating_sub(OPUS_FRAME_SAMPLES as i64));
                        if pts >= 0 {
                            crate::clip::push_audio(bytes::Bytes::copy_from_slice(d), pts / 48);
                        }
                    }
                    match senke {
                    TonSenke::Mux(mux) => {
                        packet.set_stream(self.stream_idx);
                        packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
                        mux.send(packet)?;
                    }
                    // Kein Umrechnen: die Spur bekommt die Bytes und die Dauer.
                    // Das ist der PTS-SPRUNG seit dem letzten Paket, nicht die
                    // feste Opus-Paketlaenge: WebRTC (WHIP wie Direct) summiert
                    // die Dauern zum Ton-RTP-Zeitstempel, und nur der Sprung
                    // traegt Luecken und Re-Anker der Zeitlinie nach — die
                    // gemeinsame Uhr mit dem Bild (Begruendung:
                    // [`AudioEncoder::whip_dauer`]).
                    TonSenke::Whip(w) => {
                        if let Some(d) = packet.data() {
                            let dauer = self.whip_dauer(packet.pts());
                            w.send_audio(d, dauer)?;
                        }
                    }
                        TonSenke::Direct(sender) => {
                            if let Some(bytes) = packet.data() {
                                let dauer = self.whip_dauer(packet.pts());
                                sender.send_audio(bytes, dauer)?;
                            }
                        }
                    }
                },
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(ffmpeg::Error::Eof) => break,
                Err(e) => return Err(e).context("audio receive_packet"),
            }
        }
        Ok(())
    }

    pub fn flush(&mut self, senke: &TonSenke) -> Result<()> {
        self.encoder.send_eof().context("audio send_eof")?;
        self.drain(senke)
    }


    pub fn stream_idx(&self) -> usize {
        self.stream_idx
    }

    /// Dauer eines Opus-Pakets fuer die Tonspur des eigenen Sendewegs (WHIP
    /// wie Direct): der PTS-SPRUNG seit dem letzten Paket, nicht die feste
    /// Opus-Paketlaenge.
    ///
    /// WebRTC leitet den Ton-RTP-Zeitstempel aus der SUMME der Paketdauern
    /// ab. Mit fester Paketlaenge lief die Ton-Zeitlinie als reiner
    /// Paketzaehler: jede Capture-Luecke und jedes Nachfuehren der pts-Zeitlinie
    /// (Re-Anker, Aufholen eines Rueckstands, s. [`PtsTimeline`]) fehlte ihr
    /// DAUERHAFT, waehrend das Bild wanduhr-echte Zeitstempel traegt — Ton und
    /// Bild drifteten unbegrenzt auseinander (47-Minuten-Stream 2026-09-23,
    /// Nutzermeldungen zu Bild/Ton-Versatz). Der Sprung traegt beides: im
    /// ruhigen Lauf ist er die Paketlaenge, bei einer Luecke springt er um die
    /// Luecke — genau die gemeinsame Uhr mit dem Bild. Zwilling im Linux-
    /// Sidecar (`whip_dauer` in `encode/audio.rs`, dort die ausfuehrliche
    /// Diagnose) und im Windows-Sidecar (`ton_dauer_aus_pts`).
    fn whip_dauer(&mut self, pts: Option<i64>) -> Duration {
        let ms = match pts {
            Some(p) => match self.letzte_ton_pts.replace(p) {
                Some(letzte) => whip_dauer_ms(p - letzte, self.sample_rate),
                None => OPUS_FRAME_DURATION.as_millis() as i64,
            },
            None => OPUS_FRAME_DURATION.as_millis() as i64,
        };
        Duration::from_millis(ms as u64)
    }
}

/// Millisekunden-Anteil eines Sample-Sprungs, aufgerundet und beidseitig
/// gedeckelt (s. [`AudioEncoder::whip_dauer`]). Frei gestellt fuer den Test.
/// Zwilling zu `whip_dauer_ms` im Linux-Sidecar.
fn whip_dauer_ms(sprung: i64, sample_rate: u32) -> i64 {
    // ponytail: Deckel bei 1 s — ein groesserer Sprung ist kein Zeitstempel
    // mehr, sondern ein kaputter Anker; dann 1 s senden und beim naechsten
    // Paket weiterzaehlen. Untergrenze 1 ms haelt Stolperer (Null/Sprung
    // rueckwaerts) davon ab, die Zeitlinie einfrieren zu lassen.
    ((sprung.max(0) * 1000 + i64::from(sample_rate) - 1) / i64::from(sample_rate)).clamp(1, 1000)
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

    /// Haelt der Rueckstand an, wird er aufgeholt — sonst bliebe er bis zum
    /// Streamende stehen und liefe gegen das wanduhr-echt gestempelte Bild.
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

    /// Capture-Luecke (keine Ton-Puffer): der Anker laeuft der Zeitlinie weit
    /// voraus → re-ankern, sonst ist der Ton dauerhaft um die Luecke versetzt.
    #[test]
    fn reanchors_after_capture_gap() {
        let mut t = PtsTimeline::new();
        t.align(0);
        t.advance(FRAME);
        let gap_anchor = FRAME + RESYNC_THRESHOLD_SAMPLES + 48_000; // ~1s Luecke
        assert_eq!(t.align(gap_anchor), gap_anchor);
    }

    /// pts bleiben monoton: ein rueckwaerts laufender Anker (Capture eilt der
    /// Wanduhr voraus) darf die Zeitlinie nie zurueckdrehen.
    #[test]
    fn never_jumps_backwards() {
        let mut t = PtsTimeline::new();
        t.align(48_000);
        t.advance(FRAME);
        assert_eq!(t.align(0), 48_000 + FRAME);
    }
}

#[cfg(test)]
mod whip_dauer_tests {
    use super::whip_dauer_ms;

    /// Der Rueckgrat-Fall: 20-ms-Pakete sind 960 Samples — daraus muss
    /// exakt 20 ms werden, sonst driftet der ruhige Lauf schon von selbst.
    #[test]
    fn ruhiger_lauf_trifft_die_paketlaenge() {
        assert_eq!(whip_dauer_ms(960, 48_000), 20);
        assert_eq!(whip_dauer_ms(480, 48_000), 10);
    }

    /// Eine Luecke muss IM GANZEN im Zeitstempel ankommen — der Sprung ist
    /// die einzige Stelle, an der der Ton-Zeitstempel Luecken erfaehrt.
    #[test]
    fn luecke_traegt_die_ganze_luecke() {
        assert_eq!(whip_dauer_ms(960 + 24_000, 48_000), 520);
        assert_eq!(whip_dauer_ms(48_000, 48_000), 1000);
    }

    /// Stolperer duerfen die Zeitlinie nicht rueckwaerts drehen und nicht
    /// auf Null einfrieren; ein kaputter Riese wird auf den Deckel gekappt.
    #[test]
    fn stolperer_bleiben_minimal_riesen_gedeckelt() {
        assert_eq!(whip_dauer_ms(0, 48_000), 1);
        assert_eq!(whip_dauer_ms(-960, 48_000), 1);
        assert_eq!(whip_dauer_ms(72, 48_000), 2, "1,5 ms muessen aufrunden");
        assert_eq!(whip_dauer_ms(480_000, 48_000), 1000);
    }
}
