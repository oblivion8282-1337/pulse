//! Video encode + FLV mux + RTMPS push.
//!
//! Pipeline: SCK BGRA [`crate::capture::Frame`] → swscale to NV12 →
//! FFmpeg `h264_videotoolbox` (hardware encode via VideoToolbox) → FLV mux →
//! RTMPS push. The mux + push setup mirrors `win-hq-sidecar/src/encode/encoder.rs`
//! (FLV container, `tls_verify=0` for the self-signed MediaMTX cert,
//! `rw_timeout=10s`); the async [`mux_writer::MuxWriter`] decouples socket writes
//! from the encode cadence.
//!
//! Audio (libopus, Opus-in-FLV) is a follow-up — this is the video-only path.

pub mod audio;
pub mod mux_writer;

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::format::Pixel;
use ffmpeg::software::scaling::{Context as Scaler, Flags as ScaleFlags};
use ffmpeg::{Dictionary, Packet, Rational, codec, format, frame};

use audio::AudioEncoder;
use mux_writer::MuxWriter;

/// Opus audio bitrate (kbps) — fixed for now.
const OPUS_BITRATE_KBPS: u32 = 128;

/// Map a stream profile codec id to the matching VideoToolbox encoder.
fn videotoolbox_encoder(codec: &str) -> &'static str {
    match codec {
        "hevc" | "h265" => "hevc_videotoolbox",
        // AV1 VideoToolbox encode is Apple-Silicon M3+ only; fall back to h264
        // until the Metal-family probe gates the AV1 profile.
        _ => "h264_videotoolbox",
    }
}

/// FLV for RTMP/RTMPS, MPEG-TS for SRT (same hint table as the Windows sidecar).
fn url_format_hint(target: &str) -> Option<&'static str> {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("rtmp://") || lower.starts_with("rtmps://") {
        Some("flv")
    } else if lower.starts_with("srt://") {
        Some("mpegts")
    } else {
        None
    }
}

pub struct VideoEncoder {
    encoder: codec::encoder::Video,
    scaler: Scaler,
    audio: Option<AudioEncoder>,
    mux: MuxWriter,
    width: u32,
    height: u32,
    stream_idx: usize,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    /// Monotonic frame counter = pts in encoder time-base (1/fps).
    frame_index: i64,
}

impl VideoEncoder {
    /// Build the encoder + FLV/RTMPS output and start the mux-writer thread.
    pub fn start(
        push_url: &str,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_kbps: u32,
        codec_id: &str,
        enable_audio: bool,
    ) -> Result<Self> {
        ffmpeg::init().context("ffmpeg::init")?;

        // ── Output context (FLV over RTMPS) ──────────────────────────────────
        let mut output = match url_format_hint(push_url) {
            Some(fmt) => {
                let mut opts = Dictionary::new();
                opts.set("rw_timeout", "10000000"); // 10s — don't hang on a dead socket
                if push_url.to_ascii_lowercase().starts_with("rtmps://") {
                    // Pulse-MediaMTX uses a self-signed cert by design.
                    opts.set("tls_verify", "0");
                }
                format::output_as_with(&push_url, fmt, opts)
                    .with_context(|| format!("open output {fmt} → {}", redact(push_url)))?
            }
            None => format::output(&push_url)
                .with_context(|| format!("open output → {}", redact(push_url)))?,
        };

        let global_header = output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER);

        // ── Video encoder (VideoToolbox) ─────────────────────────────────────
        let enc_name = videotoolbox_encoder(codec_id);
        let codec = codec::encoder::find_by_name(enc_name)
            .ok_or_else(|| anyhow!("encoder {enc_name} not in linked FFmpeg"))?;

        let mut stream = output.add_stream(codec).context("add_stream video")?;
        let stream_idx = stream.index();

        let encoder_time_base = Rational::new(1, fps as i32);
        let mut venc = codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()?;
        venc.set_width(width);
        venc.set_height(height);
        venc.set_format(Pixel::NV12);
        venc.set_time_base(encoder_time_base);
        venc.set_frame_rate(Some(Rational::new(fps as i32, 1)));
        venc.set_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        venc.set_max_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        venc.set_gop((fps * 2).max(1)); // keyframe every ~2s
        venc.set_max_b_frames(0); // low-latency, FLV-friendly
        if global_header {
            venc.set_flags(codec::Flags::GLOBAL_HEADER);
        }

        // realtime + constant bitrate hints for h264_videotoolbox.
        let mut eopts = Dictionary::new();
        eopts.set("realtime", "true");
        let encoder = venc
            .open_with(eopts)
            .context(format!("open {enc_name} encoder"))?;
        stream.set_parameters(&encoder);

        // The audio stream must be added before write_header (it modifies the
        // container header). AudioEncoder::create returns owned — the &mut output
        // borrow ends here, freeing output for write_header below.
        let mut audio = if enable_audio {
            Some(AudioEncoder::create(&mut output, 48_000, OPUS_BITRATE_KBPS)?)
        } else {
            None
        };

        output.write_header().context("write_header")?;
        let stream_time_base = output.stream(stream_idx).unwrap().time_base();
        if let Some(a) = audio.as_mut() {
            let atb = output.stream(a.stream_idx()).unwrap().time_base();
            a.set_stream_time_base(atb);
        }

        // ── BGRA → NV12 scaler ───────────────────────────────────────────────
        let scaler = Scaler::get(
            Pixel::BGRA,
            width,
            height,
            Pixel::NV12,
            width,
            height,
            ScaleFlags::FAST_BILINEAR,
        )
        .context("create BGRA→NV12 scaler")?;

        let mux = MuxWriter::start(output).context("start mux-writer")?;

        Ok(Self {
            encoder,
            scaler,
            audio,
            mux,
            width,
            height,
            stream_idx,
            encoder_time_base,
            stream_time_base,
            frame_index: 0,
        })
    }

    /// Encode interleaved-stereo-F32 audio samples (no-op if audio disabled).
    pub fn push_audio(&mut self, samples: &[f32]) -> Result<()> {
        if let Some(a) = self.audio.as_mut() {
            a.push(samples, &self.mux)?;
        }
        Ok(())
    }

    /// Encode one BGRA frame (packed, `src_stride`-strided) and push the
    /// resulting packets to the muxer.
    pub fn push_bgra(&mut self, data: &[u8], src_stride: usize) -> Result<()> {
        // Wrap the BGRA bytes in an ffmpeg frame, copying row-by-row to respect
        // both the source stride (from CVPixelBuffer) and ffmpeg's alignment.
        let mut src = frame::Video::new(Pixel::BGRA, self.width, self.height);
        {
            let dst_stride = src.stride(0);
            let h = self.height as usize;
            let copy = src_stride.min(dst_stride);
            let dst = src.data_mut(0);
            for y in 0..h {
                let s = y * src_stride;
                let d = y * dst_stride;
                if s + copy <= data.len() && d + copy <= dst.len() {
                    dst[d..d + copy].copy_from_slice(&data[s..s + copy]);
                }
            }
        }

        let mut nv12 = frame::Video::new(Pixel::NV12, self.width, self.height);
        self.scaler.run(&src, &mut nv12).context("scale BGRA→NV12")?;
        nv12.set_pts(Some(self.frame_index));
        self.frame_index += 1;

        self.encoder.send_frame(&nv12).context("send_frame")?;
        self.drain()
    }

    /// Drain encoder output packets into the muxer.
    fn drain(&mut self) -> Result<()> {
        loop {
            let mut packet = Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {
                    packet.set_stream(self.stream_idx);
                    packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
                    self.mux.send(packet)?;
                }
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(ffmpeg::Error::Eof) => break,
                Err(e) => return Err(e).context("receive_packet"),
            }
        }
        Ok(())
    }

    /// Flush the encoder and close the mux (writes the FLV trailer / RTMP close).
    pub fn finish(&mut self) -> Result<()> {
        self.encoder.send_eof().context("send_eof")?;
        self.drain()?;
        if let Some(a) = self.audio.as_mut() {
            a.flush(&self.mux)?;
        }
        self.mux.finish()
    }
}

/// Mask a token in a push URL for logging (never log the raw stream key).
fn redact(url: &str) -> String {
    let mut s = url.to_string();
    for pat in ["pass=", "token=", "streamid=publish:"] {
        if let Some(idx) = s.find(pat) {
            let start = idx + pat.len();
            let end = s[start..]
                .find(|c: char| c == '&' || c == ' ')
                .map(|i| start + i)
                .unwrap_or(s.len());
            s.replace_range(start..end, "***");
        }
    }
    s
}
