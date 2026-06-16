//! Audio encode path — libopus for FLV (Opus-in-FLV is native in FFmpeg ≥6.1,
//! so no patch is needed; we link FFmpeg 8).
//!
//! ScreenCaptureKit delivers interleaved Float32 stereo @48kHz (see
//! `capture::AudioFrame`), which is exactly libopus' input format
//! (`AV_SAMPLE_FMT_FLT`). Accumulate into a FIFO, emit 960-sample (20ms) frames.
//! Ported in spirit from `win-hq-sidecar/src/encode/audio.rs` (minus the QPC A/V
//! anchoring — macOS A/V sync is a follow-up; pts starts at 0 alongside video).

use std::collections::VecDeque;

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{ChannelLayout, Dictionary, Packet, Rational, codec, format, frame};

use super::mux_writer::MuxWriter;

/// 20ms @48kHz = 960 samples per channel — the standard libopus frame.
pub const OPUS_FRAME_SAMPLES: usize = 960;

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

impl AudioEncoder {
    /// Create the libopus encoder + add an audio stream to `output`. Must run
    /// BEFORE `output.write_header()`.
    pub fn create(
        output: &mut format::context::Output,
        sample_rate: u32,
        bitrate_kbps: u32,
    ) -> Result<Self> {
        let codec = codec::encoder::find_by_name("libopus")
            .ok_or_else(|| anyhow!("libopus encoder not in linked FFmpeg"))?;
        let global_header = output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER);

        let mut stream = output.add_stream(codec).context("add_stream audio")?;
        let stream_idx = stream.index();

        let mut enc = codec::context::Context::new_with_codec(codec)
            .encoder()
            .audio()?;
        // libopus' encoder only accepts interleaved Float32.
        enc.set_format(format::Sample::F32(format::sample::Type::Packed));
        enc.set_rate(sample_rate as i32);
        enc.set_channel_layout(ChannelLayout::STEREO);
        enc.set_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        enc.set_time_base(Rational::new(1, sample_rate as i32));
        if global_header {
            enc.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        let encoder = enc.open_with(Dictionary::new()).context("open libopus encoder")?;
        stream.set_parameters(&encoder);

        let frame = frame::Audio::new(
            format::Sample::F32(format::sample::Type::Packed),
            OPUS_FRAME_SAMPLES,
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
            out_pts: 0,
            anchored: false,
        })
    }

    /// Set the muxer-assigned stream timebase (read after `write_header`).
    pub fn set_stream_time_base(&mut self, tb: Rational) {
        self.stream_time_base = tb;
    }

    /// Accumulate interleaved stereo samples and emit full 20ms Opus frames.
    /// `anchor_samples` anchors the FIRST frame's pts to the stream's wall-clock
    /// epoch (shared with video) — so if audio capture starts later than video,
    /// its timeline is offset to match instead of both starting at 0.
    pub fn push(&mut self, samples: &[f32], mux: &MuxWriter, anchor_samples: i64) -> Result<()> {
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
            self.drain(mux)?;
        }
        Ok(())
    }

    fn drain(&mut self, mux: &MuxWriter) -> Result<()> {
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

    pub fn flush(&mut self, mux: &MuxWriter) -> Result<()> {
        self.encoder.send_eof().context("audio send_eof")?;
        self.drain(mux)
    }

    pub fn stream_idx(&self) -> usize {
        self.stream_idx
    }
}
