//! Audio encode path — libopus for FLV (Opus-in-FLV is native in FFmpeg ≥6.1,
//! so no patch is needed; we link FFmpeg 8).
//!
//! ScreenCaptureKit delivers interleaved Float32 stereo @48kHz (see
//! `capture::AudioFrame`), which is exactly libopus' input format
//! (`AV_SAMPLE_FMT_FLT`). Accumulate into a FIFO, emit 960-sample (20ms) frames.
//! Ported in spirit from `win-hq-sidecar/src/encode/audio.rs` (minus the QPC A/V
//! anchoring — macOS A/V sync is a follow-up; pts starts at 0 alongside video).

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
    /// Output pts in samples (1/sample_rate units).
    out_pts: i64,
    /// Whether the first frame's pts has been anchored to the stream epoch.
    anchored: bool,
}

/// Paketdauer der WHIP-Tonspur — konstant, weil der Encoder mit genau
/// [`OPUS_FRAME_SAMPLES`] geoeffnet wird (s. `new`). Waere sie es nicht,
/// verschoebe sich der Ton schleichend gegen das Bild, ohne dass irgendwo ein
/// Fehler auftaucht (Zwilling zur Begruendung an `TonSenke::Whip` im
/// Linux-Sidecar).
const OPUS_FRAME_DURATION: Duration = Duration::from_millis(20);

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
            out_pts: 0,
            anchored: false,
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
    /// `anchor_samples` anchors the FIRST frame's pts to the stream's wall-clock
    /// epoch (shared with video) — so if audio capture starts later than video,
    /// its timeline is offset to match instead of both starting at 0.
    pub fn push(&mut self, samples: &[f32], senke: &TonSenke, anchor_samples: i64) -> Result<()> {
        if !self.anchored {
            self.out_pts = anchor_samples.max(0);
            self.anchored = true;
        }
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
            self.frame.set_pts(Some(self.out_pts));
            self.out_pts += OPUS_FRAME_SAMPLES as i64;
            self.encoder.send_frame(&self.frame).context("audio send_frame")?;
            self.drain(senke)?;
        }
        Ok(())
    }

    fn drain(&mut self, senke: &TonSenke) -> Result<()> {
        loop {
            let mut packet = Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => match senke {
                    TonSenke::Mux(mux) => {
                        packet.set_stream(self.stream_idx);
                        packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
                        mux.send(packet)?;
                    }
                    // Kein Umrechnen: die Spur bekommt die Bytes und die
                    // PAKETDAUER (konstant, s. `OPUS_FRAME_DURATION`). Der
                    // Direkt-Sender macht es genauso — derselbe Opus-Rahmen,
                    // dieselbe Dauer-Konvention wie beim WHIP-Weg.
                    TonSenke::Whip(w) => {
                        if let Some(d) = packet.data() {
                            w.send_audio(d, OPUS_FRAME_DURATION)?;
                        }
                    }
                    TonSenke::Direct(sender) => {
                        if let Some(bytes) = packet.data() {
                            sender.send_audio(bytes, OPUS_FRAME_DURATION)?;
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
}
