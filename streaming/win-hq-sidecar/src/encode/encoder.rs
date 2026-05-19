//! Hardware-Encoder via FFmpeg (NVENC/AMF/QSV).
//!
//! Adapter-Vendor-Branch:
//!
//! | Vendor   | H.264       | HEVC       | AV1        |
//! |----------|-------------|------------|------------|
//! | nvidia   | h264_nvenc  | hevc_nvenc | av1_nvenc  |
//! | amd      | h264_amf    | hevc_amf   | av1_amf    |
//! | intel    | h264_qsv    | hevc_qsv   | av1_qsv    |
//!
//! Im Pulse-Pfad ist der Adapter durch den DXGI-HIGH_PERFORMANCE-Slot bereits
//! gewählt (Stage 2). Diese Crate ruft `EncoderConfig::vendor` aus dem
//! Adapter-Vendor-String — Capture und Encode landen so auf derselben GPU
//! (Optimus-Fix).
//!
//! Frame-Flow: `send()` nimmt einen `CapturedFrame` (BGRA-CPU-Buffer aus WGC),
//! kopiert ihn in einen FFmpeg-`Video`-Frame, swscale'd nach NV12, schickt
//! das in den Encoder, drained empfangene Packets ins Output-Format.
//! `finish()` flusht EOF + write_trailer.

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Packet, Rational, codec, format, frame, software::scaling};

use crate::capture::wgc::CapturedFrame;

#[derive(Debug, Clone, Copy)]
pub enum VideoCodec {
    H264,
    Hevc,
    Av1,
}

impl VideoCodec {
    /// FFmpeg-Encoder-Name für (Vendor, Codec). `vendor` ist der Slug aus
    /// `system::dxgi::Adapter::vendor()` (`"nvidia"`/`"amd"`/`"intel"`).
    pub fn ffmpeg_name(self, vendor: &str) -> Result<&'static str> {
        Ok(match (vendor, self) {
            ("nvidia", VideoCodec::H264) => "h264_nvenc",
            ("nvidia", VideoCodec::Hevc) => "hevc_nvenc",
            ("nvidia", VideoCodec::Av1) => "av1_nvenc",
            ("amd", VideoCodec::H264) => "h264_amf",
            ("amd", VideoCodec::Hevc) => "hevc_amf",
            ("amd", VideoCodec::Av1) => "av1_amf",
            ("intel", VideoCodec::H264) => "h264_qsv",
            ("intel", VideoCodec::Hevc) => "hevc_qsv",
            ("intel", VideoCodec::Av1) => "av1_qsv",
            _ => return Err(anyhow!("no HW encoder for vendor={vendor} codec={self:?}")),
        })
    }
}

#[derive(Debug, Clone)]
pub struct EncoderConfig {
    pub codec: VideoCodec,
    pub vendor: String,
    /// Dimensionen die der Capture liefert (= Quellbild für swscale).
    pub src_width: u32,
    pub src_height: u32,
    /// Dimensionen die NVENC/AMF/QSV bekommen (≤ src für Downscale, oder gleich).
    pub dst_width: u32,
    pub dst_height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

pub struct FfmpegEncoder {
    output: format::context::Output,
    encoder: codec::encoder::Video,
    sws: scaling::Context,
    bgra_frame: frame::Video,
    nv12_frame: frame::Video,
    video_stream_idx: usize,
    pts: i64,
    encoder_time_base: Rational,
    stream_time_base: Rational,
}

impl FfmpegEncoder {
    /// Erstellt einen neuen Encoder + Output-Context. `output_path` kann eine
    /// Datei (`.mp4`/`.flv`) oder eine URL (`rtmps://...`) sein — FFmpeg
    /// erkennt das Format an der Extension/Scheme automatisch.
    pub fn create(cfg: &EncoderConfig, output_path: &str) -> Result<Self> {
        ffmpeg::init().context("ffmpeg::init")?;

        let mut output = format::output(&output_path)
            .with_context(|| format!("format::output({output_path})"))?;

        let codec_name = cfg.codec.ffmpeg_name(&cfg.vendor)?;
        let codec_descriptor = codec::encoder::find_by_name(codec_name)
            .ok_or_else(|| anyhow!("encoder '{codec_name}' not registered in linked FFmpeg"))?;

        let global_header = output.format().flags().contains(format::Flags::GLOBAL_HEADER);

        let mut stream = output.add_stream(codec_descriptor).context("add_stream")?;
        let stream_idx = stream.index();

        let mut encoder = codec::context::Context::new_with_codec(codec_descriptor)
            .encoder()
            .video()?;
        encoder.set_width(cfg.dst_width);
        encoder.set_height(cfg.dst_height);
        encoder.set_format(format::Pixel::NV12);
        encoder.set_time_base(Rational::new(1, cfg.fps as i32));
        encoder.set_frame_rate(Some(Rational::new(cfg.fps as i32, 1)));
        encoder.set_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_max_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        // GOP = 2 Sekunden — Kompromiss zwischen Seek-Granularität (kleiner GOP)
        // und Bandbreiten-Effizienz (großer GOP). 2s ist Streaming-Standard.
        encoder.set_gop(cfg.fps.saturating_mul(2));

        if global_header {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }

        let opts = vendor_encoder_opts(&cfg.vendor);
        let opened = encoder
            .open_with(opts)
            .with_context(|| format!("open encoder '{codec_name}' (vendor={})", cfg.vendor))?;
        stream.set_parameters(&opened);

        output.write_header().context("write_header")?;

        let stream_time_base = output.stream(stream_idx).unwrap().time_base();
        let encoder_time_base = Rational::new(1, cfg.fps as i32);

        let sws = scaling::Context::get(
            format::Pixel::BGRA,
            cfg.src_width,
            cfg.src_height,
            format::Pixel::NV12,
            cfg.dst_width,
            cfg.dst_height,
            scaling::Flags::BILINEAR,
        )
        .context("scaling::Context::get (BGRA→NV12)")?;

        let bgra_frame = frame::Video::new(format::Pixel::BGRA, cfg.src_width, cfg.src_height);
        let nv12_frame = frame::Video::new(format::Pixel::NV12, cfg.dst_width, cfg.dst_height);

        Ok(Self {
            output,
            encoder: opened,
            sws,
            bgra_frame,
            nv12_frame,
            video_stream_idx: stream_idx,
            pts: 0,
            encoder_time_base,
            stream_time_base,
        })
    }

    /// Schickt einen Capture-Frame in den Encoder. Drained interne Packets auf
    /// den Output. Returnt sofort wenn der Encoder noch Frames akkumuliert —
    /// das ist normal (B-Frame-Lookahead) und kein Fehler.
    pub fn send(&mut self, captured: &CapturedFrame) -> Result<()> {
        // BGRA-Bytes in den FFmpeg-`Video`-Frame kopieren. Stride beachten —
        // FFmpeg-Frames können pro Zeile gepaddet sein.
        let stride = self.bgra_frame.stride(0);
        let row_bytes = captured.width as usize * 4;
        let data = self.bgra_frame.data_mut(0);
        for y in 0..captured.height as usize {
            let src = y * row_bytes;
            let dst = y * stride;
            data[dst..dst + row_bytes].copy_from_slice(&captured.bgra[src..src + row_bytes]);
        }

        // BGRA → NV12 via swscale
        self.sws
            .run(&self.bgra_frame, &mut self.nv12_frame)
            .context("sws.run BGRA→NV12")?;

        // PTS in Encoder-Time-Base (1/fps)
        self.nv12_frame.set_pts(Some(self.pts));
        self.pts += 1;

        self.encoder
            .send_frame(&self.nv12_frame)
            .context("encoder.send_frame")?;
        self.drain_packets()?;
        Ok(())
    }

    fn drain_packets(&mut self) -> Result<()> {
        let mut packet = Packet::empty();
        while self.encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(self.video_stream_idx);
            packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
            packet
                .write_interleaved(&mut self.output)
                .context("packet.write_interleaved")?;
        }
        Ok(())
    }

    /// EOF an den Encoder, restliche Packets flushen, Trailer schreiben. Konsumiert
    /// self — danach ist der Encoder zu.
    pub fn finish(mut self) -> Result<()> {
        self.encoder.send_eof().context("send_eof")?;
        self.drain_packets()?;
        self.output.write_trailer().context("write_trailer")?;
        Ok(())
    }
}

/// Vendor-spezifische Encoder-Optionen. Defaults sind „streaming-tauglich"
/// (Low-Latency, CBR) — pro Encoder mehr durchstimmen wenn die echten
/// Quality-Tradeoffs sichtbar sind.
fn vendor_encoder_opts(vendor: &str) -> Dictionary<'static> {
    let mut opts = Dictionary::new();
    match vendor {
        "nvidia" => {
            // NVENC-Presets: p1 (fastest) … p7 (slowest+best). p4 = mid.
            opts.set("preset", "p4");
            opts.set("tune", "ll"); // low-latency
            opts.set("rc", "cbr");
            opts.set("zerolatency", "1");
        }
        "amd" => {
            opts.set("usage", "transcoding");
            opts.set("quality", "balanced");
            opts.set("rc", "cbr");
        }
        "intel" => {
            opts.set("preset", "medium");
            opts.set("look_ahead", "0"); // low-latency
        }
        _ => {}
    }
    opts
}
