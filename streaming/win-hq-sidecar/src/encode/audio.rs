//! Audio-Encoder-Pfad — libopus für FLV/MPEG-TS.
//!
//! Wird aus `encoder.rs` als optionale zweite Spur instantiiert. WASAPI liefert
//! interleaved 32-bit-Float bei 48 kHz Stereo; libopus akzeptiert genau dieses
//! Format direkt (`AV_SAMPLE_FMT_FLT` — siehe `libavcodec/libopusenc.c`).
//! Kein Resampler nötig.
//!
//! 1. Akkumulieren in einem FIFO bis ein 960-Sample-Chunk voll ist (20ms@48kHz)
//! 2. Encode + Packet emittieren in 1/48000-Time-Base
//!
//! Opus-in-FLV ist seit FFmpeg 6.1 nativ unterstützt (Enhanced RTMP) — kein
//! Patch nötig.

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{ChannelLayout, Dictionary, Packet, Rational, codec, format, frame};
use std::collections::VecDeque;

use crate::audio::CapturedAudio;

/// 20ms-Frame bei 48 kHz = 960 Samples. Standard für libopus + FFmpegs Opus-Encoder.
pub const OPUS_FRAME_SAMPLES: usize = 960;

pub struct AudioPipeline {
    encoder: codec::encoder::Audio,
    /// Interleaved-FLT-Frame der direkt in den Encoder geht (libopus-Format).
    interleaved_frame: frame::Audio,
    /// Roh-Byte-FIFO — sammelt WASAPI-Chunks bis OPUS_FRAME_SAMPLES Frames erreicht.
    /// Bytes-Layout: f32 interleaved Stereo → 8 Bytes pro Frame.
    fifo: VecDeque<u8>,
    sample_rate: u32,
    channels: u16,
    block_align_in: usize,
    /// PTS für eingehende Frames (= an `send_frame` übergeben). Wächst pro
    /// 960-Sample-Chunk um 960.
    pts_samples: i64,
    /// PTS für ausgehende Packets (= zum Mux'er). Wird beim Drain bei jedem
    /// emittierten Packet um 960 erhöht. Brauchen wir separat zu `pts_samples`
    /// weil libopus' Output-Packet-PTS nicht zuverlässig propagiert wird.
    out_pts_samples: i64,
    pub stream_idx: usize,
    pub encoder_time_base: Rational,
    pub stream_time_base: Rational,
}

impl AudioPipeline {
    /// Erstellt den Audio-Encoder + Resampler und fügt einen neuen Stream zum
    /// `output`-Context hinzu. Muss VOR `output.write_header()` aufgerufen
    /// werden (Stream-Anlage modifiziert den Container-Header).
    pub fn create(
        output: &mut format::context::Output,
        sample_rate: u32,
        channels: u16,
        bitrate_kbps: u32,
    ) -> Result<Self> {
        if channels != 2 {
            // libopus unterstützt 1/2/3/4/5/6/8 Kanäle, aber Pulse streamt
            // hauptsächlich Stereo. Mono könnte später kommen.
            return Err(anyhow!(
                "audio: only stereo (2 channels) supported, got {channels}"
            ));
        }

        let codec_descriptor = codec::encoder::find_by_name("libopus")
            .ok_or_else(|| anyhow!("libopus encoder not registered in linked FFmpeg"))?;

        let global_header = output.format().flags().contains(format::Flags::GLOBAL_HEADER);

        let mut stream = output.add_stream(codec_descriptor).context("add_stream audio")?;
        let stream_idx = stream.index();

        let mut encoder = codec::context::Context::new_with_codec(codec_descriptor)
            .encoder()
            .audio()?;
        // libopus' encoder sample-fmt-list ist hardcoded auf nur AV_SAMPLE_FMT_FLT
        // (interleaved Float). Siehe `libavcodec/libopusenc.c::sample_fmts[]`.
        encoder.set_format(format::Sample::F32(format::sample::Type::Packed));
        encoder.set_rate(sample_rate as i32);
        encoder.set_channel_layout(ChannelLayout::STEREO);
        encoder.set_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_time_base(Rational::new(1, sample_rate as i32));

        if global_header {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }

        let opts = Dictionary::new();
        let opened = encoder.open_with(opts).context("open libopus encoder")?;
        stream.set_parameters(&opened);

        let interleaved_frame = frame::Audio::new(
            format::Sample::F32(format::sample::Type::Packed),
            OPUS_FRAME_SAMPLES,
            ChannelLayout::STEREO,
        );

        let stream_time_base = output.stream(stream_idx).unwrap().time_base();
        let encoder_time_base = Rational::new(1, sample_rate as i32);
        let block_align_in = (channels as usize) * 4; // F32 = 4 Bytes/Sample

        Ok(Self {
            encoder: opened,
            interleaved_frame,
            fifo: VecDeque::with_capacity(OPUS_FRAME_SAMPLES * block_align_in * 4),
            sample_rate,
            channels,
            block_align_in,
            pts_samples: 0,
            out_pts_samples: 0,
            stream_idx,
            encoder_time_base,
            stream_time_base,
        })
    }

    /// WASAPI-Chunk in den FIFO werfen + so viele Opus-Frames rauspushen wie
    /// gehen. Jeder gesendete Frame schreibt Encoder-Packets in den
    /// gemeinsamen Output-Context.
    pub fn send(
        &mut self,
        captured: &CapturedAudio,
        output: &mut format::context::Output,
    ) -> Result<()> {
        if captured.format.sample_rate != self.sample_rate
            || captured.format.channels != self.channels
        {
            return Err(anyhow!(
                "audio format mismatch: capture {}Hz/{}ch vs encoder {}Hz/{}ch",
                captured.format.sample_rate,
                captured.format.channels,
                self.sample_rate,
                self.channels
            ));
        }
        self.fifo.extend(&captured.bytes);

        let chunk_bytes = OPUS_FRAME_SAMPLES * self.block_align_in;
        while self.fifo.len() >= chunk_bytes {
            self.encode_one_chunk(chunk_bytes, output)?;
        }
        Ok(())
    }

    fn encode_one_chunk(
        &mut self,
        chunk_bytes: usize,
        output: &mut format::context::Output,
    ) -> Result<()> {
        // FIFO-Front in den interleaved_frame kopieren (plane 0 hält die
        // gesamten Stereo-interleaved Bytes für F32-Packed).
        {
            let dst = self.interleaved_frame.data_mut(0);
            for (i, slot) in dst.iter_mut().take(chunk_bytes).enumerate() {
                *slot = self.fifo[i];
            }
        }
        self.fifo.drain(..chunk_bytes);

        self.interleaved_frame.set_pts(Some(self.pts_samples));
        self.pts_samples += OPUS_FRAME_SAMPLES as i64;

        self.encoder
            .send_frame(&self.interleaved_frame)
            .context("audio encoder.send_frame")?;
        self.drain_packets(output)?;
        Ok(())
    }

    pub fn drain_packets(&mut self, output: &mut format::context::Output) -> Result<()> {
        let mut packet = Packet::empty();
        while self.encoder.receive_packet(&mut packet).is_ok() {
            // libopus' FFmpeg-Encoder propagiert weder PTS/DTS noch Duration
            // sauber in den Output-Packet (n8.1 hatte das fixes/regressions;
            // wir setzen alles drei manuell). PTS+DTS in encoder_time_base
            // (1/sample_rate), Duration = 20ms-Frame = 960 Samples.
            if packet.pts().is_none() {
                packet.set_pts(Some(self.out_pts_samples));
                packet.set_dts(Some(self.out_pts_samples));
            }
            packet.set_duration(OPUS_FRAME_SAMPLES as i64);
            self.out_pts_samples += OPUS_FRAME_SAMPLES as i64;
            packet.set_stream(self.stream_idx);
            packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
            packet
                .write_interleaved(output)
                .context("audio packet.write_interleaved")?;
        }
        Ok(())
    }

    pub fn flush(&mut self, output: &mut format::context::Output) -> Result<()> {
        self.encoder.send_eof().context("audio send_eof")?;
        self.drain_packets(output)?;
        Ok(())
    }
}
