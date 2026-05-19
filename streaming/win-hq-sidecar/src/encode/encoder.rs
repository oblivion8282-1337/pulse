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

use super::audio::AudioPipeline;
use crate::audio::CapturedAudio;
use crate::capture::wgc::CapturedFrame;

/// Konfiguration für die optionale Audio-Spur. Wenn `None` an
/// `FfmpegEncoder::create` übergeben wird, hat der Output nur eine Video-Spur.
#[derive(Debug, Clone, Copy)]
pub struct AudioStreamConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub bitrate_kbps: u32,
}

impl AudioStreamConfig {
    /// Default für Pulse: 48 kHz Stereo, 128 kbps Opus — Streaming-Standard,
    /// transparent für Sprache und Musik bei moderater Bandbreite.
    pub const DEFAULT: Self = Self {
        sample_rate: 48_000,
        channels: 2,
        bitrate_kbps: 128,
    };
}

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
    /// `Some(sws)` wenn der Encoder NV12 will (= AMD/Intel oder explizites
    /// Downscale erzwungen). NVIDIA ohne Downscale läuft auf der schnellen
    /// BGR0-direct-Bahn ohne CPU-Konversion.
    sws: Option<scaling::Context>,
    /// Quell-Frame für swscale (nur wenn `sws = Some`).
    src_frame: Option<frame::Video>,
    /// Frame der in den Encoder geht — entweder BGR0 (NVIDIA-direct) oder NV12
    /// (sws-Output).
    encoder_frame: frame::Video,
    video_stream_idx: usize,
    pts: i64,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    /// Erwartete Dimensionen für `send()`-Validation.
    expected_src: (u32, u32),
    /// Optionale Audio-Spur (libopus). Capture-Worker pumpt
    /// `send_audio(captured)` rein; finish() flusht beide Spuren.
    audio: Option<AudioPipeline>,
}

impl FfmpegEncoder {
    /// Erstellt einen neuen Encoder + Output-Context. `output_path` kann eine
    /// Datei (`.mp4`/`.flv`) oder eine URL (`rtmp://...`/`rtmps://...`) sein.
    /// Bei Dateien errät FFmpeg das Format aus der Extension; bei URLs ohne
    /// Extension forcieren wir es manuell (FLV für RTMP/RTMPS, MPEG-TS für SRT).
    ///
    /// `audio_cfg = Some(...)` fügt eine libopus-Audio-Spur hinzu; `None` =
    /// video-only.
    pub fn create(
        cfg: &EncoderConfig,
        audio_cfg: Option<AudioStreamConfig>,
        output_path: &str,
    ) -> Result<Self> {
        ffmpeg::init().context("ffmpeg::init")?;

        let mut output = match url_format_hint(output_path) {
            Some(fmt) => {
                // Für RTMPS: `tls_verify=0` setzen — Pulse-MediaMTX nutzt by-design
                // ein self-signed Cert (siehe `streaming/server/mediamtx.yml.template`).
                // Die echte Auth läuft per Stream-Token in der URL
                // (`?user=pulse&pass=<token>`) → MediaMTX authHTTP-Hook → media-svc.
                // TLS ist hier nur Token-Verschleierung, nicht Server-Verifikation.
                // FFmpegs Schannel-Backend auf Windows ist strict-verify by default,
                // was den Stream sonst nach dem TLS-Handshake mit „Writing encrypted
                // data to socket failed" killt. Verifiziert mit `ffmpeg.exe
                // -tls_verify 0` als Referenz (= identisches Verhalten).
                let mut opts = Dictionary::new();
                if output_path.to_ascii_lowercase().starts_with("rtmps://") {
                    opts.set("tls_verify", "0");
                }
                format::output_as_with(&output_path, fmt, opts)
                    .with_context(|| format!("format::output_as_with({output_path}, {fmt})"))?
            }
            None => format::output(&output_path)
                .with_context(|| format!("format::output({output_path})"))?,
        };

        let codec_name = cfg.codec.ffmpeg_name(&cfg.vendor)?;
        let codec_descriptor = codec::encoder::find_by_name(codec_name)
            .ok_or_else(|| anyhow!("encoder '{codec_name}' not registered in linked FFmpeg"))?;

        let global_header = output.format().flags().contains(format::Flags::GLOBAL_HEADER);

        let mut stream = output.add_stream(codec_descriptor).context("add_stream")?;
        let stream_idx = stream.index();

        // BGR-direct-Fast-Path: BGRA-Bytes 1:1 in den Encoder-Frame, GPU
        // swizzelt + NV12-Convert intern. Aktiv NUR auf NVIDIA UND ohne
        // Downscale. AMF (AMD) und QSV (Intel) listen nur NV12/P010LE als
        // Input — wir müssen für die durch CPU-swscale, auch ohne Downscale.
        let needs_scale = (cfg.src_width, cfg.src_height) != (cfg.dst_width, cfg.dst_height);
        let use_bgr_direct = !needs_scale && cfg.vendor == "nvidia";
        let pix_fmt = if use_bgr_direct {
            format::Pixel::BGRA
        } else {
            format::Pixel::NV12
        };

        let mut encoder = codec::context::Context::new_with_codec(codec_descriptor)
            .encoder()
            .video()?;
        encoder.set_width(cfg.dst_width);
        encoder.set_height(cfg.dst_height);
        encoder.set_format(pix_fmt);
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

        // Audio-Pipeline VOR write_header anlegen — sie addiert einen Stream
        // zum Output-Context, was nur erlaubt ist bevor der Header geschrieben
        // wurde.
        let audio = match audio_cfg {
            Some(a) => Some(AudioPipeline::create(
                &mut output,
                a.sample_rate,
                a.channels,
                a.bitrate_kbps,
            )?),
            None => None,
        };

        output.write_header().context("write_header")?;

        let stream_time_base = output.stream(stream_idx).unwrap().time_base();
        let encoder_time_base = Rational::new(1, cfg.fps as i32);

        let (sws, src_frame, encoder_frame) = if use_bgr_direct {
            // Fast-Path: BGR0 direkt in den NVENC-Frame, GPU macht den Rest.
            (
                None,
                None,
                frame::Video::new(format::Pixel::BGRA, cfg.dst_width, cfg.dst_height),
            )
        } else {
            // CPU-swscale-Pfad: für AMD/Intel immer, plus Downscale auf jedem
            // Vendor. Quellbild ist BGRA aus WGC; Ziel ist NV12. Bei
            // dst==src degeneriert das Re-Sampling zu reinem Format-Convert.
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
            (
                Some(sws),
                Some(frame::Video::new(
                    format::Pixel::BGRA,
                    cfg.src_width,
                    cfg.src_height,
                )),
                frame::Video::new(format::Pixel::NV12, cfg.dst_width, cfg.dst_height),
            )
        };

        Ok(Self {
            output,
            encoder: opened,
            sws,
            src_frame,
            encoder_frame,
            video_stream_idx: stream_idx,
            pts: 0,
            encoder_time_base,
            stream_time_base,
            expected_src: (cfg.src_width, cfg.src_height),
            audio,
        })
    }

    /// Schickt einen WASAPI-Audio-Chunk in den Opus-Encoder. No-op wenn der
    /// Encoder ohne Audio-Spur erstellt wurde.
    pub fn send_audio(&mut self, captured: &CapturedAudio) -> Result<()> {
        if let Some(audio) = self.audio.as_mut() {
            audio.send(captured, &mut self.output)?;
        }
        Ok(())
    }

    /// Schickt einen Capture-Frame in den Encoder. Drained interne Packets auf
    /// den Output. Returnt sofort wenn der Encoder noch Frames akkumuliert —
    /// das ist normal (B-Frame-Lookahead) und kein Fehler.
    pub fn send(&mut self, captured: &CapturedFrame) -> Result<()> {
        if (captured.width, captured.height) != self.expected_src {
            return Err(anyhow!(
                "frame dimensions {}x{} don't match encoder src {}x{}",
                captured.width,
                captured.height,
                self.expected_src.0,
                self.expected_src.1
            ));
        }

        let frame = match (&mut self.sws, &mut self.src_frame) {
            (Some(sws), Some(src_frame)) => {
                copy_bgra(src_frame, &captured.bgra, captured.width, captured.height);
                sws.run(src_frame, &mut self.encoder_frame)
                    .context("sws.run BGRA→NV12")?;
                &mut self.encoder_frame
            }
            _ => {
                // BGR-direct (NVIDIA): BGRA-Bytes 1:1 in den Encoder-Frame.
                // NVENC swizzelt + macht den NV12-Convert auf der GPU.
                copy_bgra(
                    &mut self.encoder_frame,
                    &captured.bgra,
                    captured.width,
                    captured.height,
                );
                &mut self.encoder_frame
            }
        };

        frame.set_pts(Some(self.pts));
        self.pts += 1;

        self.encoder
            .send_frame(frame)
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

    /// EOF an Video + Audio Encoder, restliche Packets flushen, Trailer schreiben.
    /// Konsumiert self — danach ist der Encoder zu.
    pub fn finish(mut self) -> Result<()> {
        self.encoder.send_eof().context("video send_eof")?;
        self.drain_packets()?;
        if let Some(mut audio) = self.audio.take() {
            audio.flush(&mut self.output)?;
        }
        self.output.write_trailer().context("write_trailer")?;
        Ok(())
    }
}

/// Für URL-Schemes ohne Extension wählt FFmpeg's Auto-Detect kein Format —
/// wir mappen die unterstützten Streaming-Protokolle hier explizit.
///
/// - `rtmp://` / `rtmps://` → FLV (RTMP transportiert FLV-Tags)
/// - `srt://`               → MPEG-TS (SRT-Standard)
/// - Sonst                  → `None` (FFmpeg-Default, Extension-basiert)
pub(crate) fn url_format_hint(target: &str) -> Option<&'static str> {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("rtmp://") || lower.starts_with("rtmps://") {
        Some("flv")
    } else if lower.starts_with("srt://") {
        Some("mpegts")
    } else {
        None
    }
}

/// BGRA-Bytes in einen FFmpeg-`Video`-Frame kopieren. Beachtet den Frame-Stride
/// (FFmpeg padded die Zeilen für SIMD-Alignment, deshalb funktioniert kein
/// pauschales `data.copy_from_slice(src)`). `width`/`height` müssen mit der
/// Frame-Allokation übereinstimmen (Caller-Verantwortung).
fn copy_bgra(frame: &mut frame::Video, bgra: &[u8], width: u32, height: u32) {
    let stride = frame.stride(0);
    let row_bytes = width as usize * 4;
    let data = frame.data_mut(0);
    for y in 0..height as usize {
        let src = y * row_bytes;
        let dst = y * stride;
        data[dst..dst + row_bytes].copy_from_slice(&bgra[src..src + row_bytes]);
    }
}

/// Vendor-spezifische Encoder-Optionen. Defaults sind „streaming-tauglich"
/// (Low-Latency, CBR) — pro Encoder mehr durchstimmen wenn die echten
/// Quality-Tradeoffs sichtbar sind.
pub(crate) fn vendor_encoder_opts(vendor: &str) -> Dictionary<'static> {
    let mut opts = Dictionary::new();
    match vendor {
        "nvidia" => {
            // NVENC-Presets: p1 (fastest) … p7 (slowest+best). Für Live-Stream
            // ist Throughput wichtiger als Last-bit-Quality → `p2` ist der
            // sweet-spot, sehr schnell und kaum schlechter als p4 im Screen-
            // Content. `tune=ull` (ultra-low-latency) statt nur `ll` damit
            // B-Frames und VBV-Lookahead komplett aus sind.
            opts.set("preset", "p2");
            opts.set("tune", "ull");
            opts.set("rc", "cbr");
            opts.set("zerolatency", "1");
            opts.set("delay", "0");
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
