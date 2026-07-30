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
use ffmpeg::{Packet, Rational, codec, format, frame, software::scaling};

use super::audio::AudioPipeline;
use super::latency::EncodeLatency;
use super::mux_writer::MuxWriter;
use super::opts::vendor_encoder_opts;
use super::output::{open_output, warn_unknown_opts};
use crate::audio::CapturedAudio;
use crate::capture::wgc::CapturedFrame;

/// Konfiguration für die optionale Audio-Spur. Wenn `None` an
/// `FfmpegEncoder::create` übergeben wird, hat der Output nur eine Video-Spur.
#[derive(Debug, Clone, Copy)]
pub struct AudioStreamConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub bitrate_kbps: u32,
    /// Konstanter A/V-Trim in ms (>0 = Audio später). Aus dem UI-Slider; 0 =
    /// neutral (dann greift ggf. der `PULSE_HQ_AV_OFFSET_MS`-Env-Fallback).
    pub av_offset_ms: i32,
}

impl AudioStreamConfig {
    /// Default für Pulse: 48 kHz Stereo, 128 kbps Opus — Streaming-Standard,
    /// transparent für Sprache und Musik bei moderater Bandbreite.
    pub const DEFAULT: Self = Self {
        sample_rate: 48_000,
        channels: 2,
        bitrate_kbps: 128,
        av_offset_ms: 0,
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

    /// Umkehrung von [`slug`](Self::slug): der Kurzname aus dem `start`-Request.
    /// Unbekanntes faellt auf H.264 zurueck, wie an allen drei Aufrufstellen
    /// zuvor einzeln ausgeschrieben.
    pub fn from_slug(s: &str) -> Self {
        match s {
            "hevc" => VideoCodec::Hevc,
            "av1" => VideoCodec::Av1,
            _ => VideoCodec::H264,
        }
    }

    /// Kurzname wie im `start`-Request (`"h264"`/`"hevc"`/`"av1"`) — die
    /// Rueckrichtung zu `parse_overrides`. Gebraucht fuer die argv-Zeile der
    /// `start`-Antwort, die sonst den Codec des PROFILS meldet statt den
    /// gewaehlten.
    pub fn slug(self) -> &'static str {
        match self {
            VideoCodec::H264 => "h264",
            VideoCodec::Hevc => "hevc",
            VideoCodec::Av1 => "av1",
        }
    }

    /// FFmpeg-Encoder-Name für den nativen D3D12VA-Pfad (AMD-GPU-Pfad). Die
    /// d3d12va-Encoder nutzen Microsofts D3D12 Video Encode API — NICHT
    /// NVENC/AMF/QSV — und umgehen so die AMF-Runtime + deren D3D11-Surface-
    /// Crash (Issue #455). Vendor-unabhängig: nur der Codec bestimmt den Namen.
    /// S. `encoder_d3d12.rs`.
    pub fn d3d12va_name(self) -> &'static str {
        match self {
            VideoCodec::H264 => "h264_d3d12va",
            VideoCodec::Hevc => "hevc_d3d12va",
            VideoCodec::Av1 => "av1_d3d12va",
        }
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
    /// Async-Muxer — der `AVFormatContext` lebt auf einem eigenen Thread, der
    /// Encoder schiebt Packets nur in dessen Queue (s. `mux_writer.rs`).
    mux: MuxWriter,
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
    encoder_time_base: Rational,
    stream_time_base: Rational,
    /// Erwartete Dimensionen für `send()`-Validation.
    expected_src: (u32, u32),
    /// Optionale Audio-Spur (libopus). Capture-Worker pumpt
    /// `send_audio(captured)` rein; finish() flusht beide Spuren.
    audio: Option<AudioPipeline>,
    /// Diagnose-Timings des letzten `send`-Calls (µs) — für den `TickMonitor`
    /// (s. `tick_monitor.rs`). `last_convert_us` = Frame-Copy + swscale
    /// BGRA→NV12; `last_send_us` = AMF/QSV-Submit (`send_frame`); `last_mux_us`
    /// = Einreihen der Packets in die `MuxWriter`-Queue (normal ~0).
    last_convert_us: u64,
    last_send_us: u64,
    last_mux_us: u64,
    /// Einschieben → Paket, s. `latency.rs`. Das ist der Posten, den
    /// `async_depth` (AMF/QSV) verändert; `last_send_us` sieht ihn NICHT.
    enc_latency: EncodeLatency,
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

        let mut output = open_output(output_path)?;

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

        let opts = vendor_encoder_opts(&cfg.vendor, cfg.codec);
        warn_unknown_opts(&mut encoder, codec_name, &opts);
        let opened = encoder
            .open_with(opts)
            .with_context(|| format!("open encoder '{codec_name}' (vendor={})", cfg.vendor))?;
        super::log_encoder_open(
            codec_name,
            &cfg.vendor,
            cfg.dst_width,
            cfg.dst_height,
            cfg.fps,
            cfg.bitrate_kbps,
        );
        stream.set_parameters(&opened);

        // Audio-Pipeline VOR write_header anlegen — sie addiert einen Stream
        // zum Output-Context, was nur erlaubt ist bevor der Header geschrieben
        // wurde.
        let mut audio = match audio_cfg {
            Some(a) => Some(AudioPipeline::create(
                &mut output,
                a.sample_rate,
                a.channels,
                a.bitrate_kbps,
                a.av_offset_ms,
            )?),
            None => None,
        };

        output.write_header().context("write_header")?;

        let stream_time_base = output.stream(stream_idx).unwrap().time_base();
        let encoder_time_base = Rational::new(1, cfg.fps as i32);
        // Audio-Stream-Timebase erst JETZT (nach write_header) lesen + setzen.
        if let Some(a) = audio.as_mut() {
            let audio_tb = output.stream(a.stream_idx).unwrap().time_base();
            a.set_stream_time_base(audio_tb);
        }

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

        // Output an den Writer-Thread übergeben — ab hier läuft jedes
        // write_interleaved asynchron, der Pacing-Loop blockiert nie am Socket.
        let mux = MuxWriter::start(output).context("start mux-writer")?;

        Ok(Self {
            mux,
            encoder: opened,
            sws,
            src_frame,
            encoder_frame,
            video_stream_idx: stream_idx,
            encoder_time_base,
            stream_time_base,
            expected_src: (cfg.src_width, cfg.src_height),
            audio,
            last_convert_us: 0,
            last_send_us: 0,
            last_mux_us: 0,
            enc_latency: EncodeLatency::default(),
        })
    }

    /// Encode-Latenz seit dem letzten Aufruf: (Summe, Maximum, Anzahl) in µs.
    /// Holt und LEERT die Zähler — der Pacing-Loop reicht sie je Tick an den
    /// `TickMonitor` weiter.
    pub fn take_encode_latency(&mut self) -> (u64, u64, u64) {
        self.enc_latency.take()
    }

    /// Frame-Copy + swscale BGRA→NV12 des letzten `send` in µs.
    pub fn last_convert_us(&self) -> u64 {
        self.last_convert_us
    }

    /// Encoder-Submit (`send_frame`, AMF/QSV) des letzten `send` in µs.
    pub fn last_send_us(&self) -> u64 {
        self.last_send_us
    }

    /// Queue-Einreih-Dauer (`MuxWriter::send`) des letzten `send` in µs.
    /// Normal ~0; ein Spike = Queue voll = Writer-Thread hängt am Socket.
    pub fn last_mux_us(&self) -> u64 {
        self.last_mux_us
    }

    /// Schickt einen WASAPI-Audio-Chunk in den Opus-Encoder. No-op wenn der
    /// Encoder ohne Audio-Spur erstellt wurde.
    pub fn send_audio(&mut self, captured: &CapturedAudio) -> Result<()> {
        if let Some(audio) = self.audio.as_mut() {
            let packets = audio.send(captured)?;
            for packet in packets {
                self.mux.send(packet)?;
            }
        }
        Ok(())
    }

    /// Verankert den Audio-PTS am Video-PTS-Ursprung (A/V-Sync). Vor dem
    /// ersten `send_audio` aufrufen — sonst startet der Audio-PTS bei 0 und
    /// die Spuren driften (Audio-Backlog vor `started`).
    pub fn set_audio_origin(&mut self, origin: std::time::Instant, origin_qpc: Option<i64>) {
        if let Some(audio) = self.audio.as_mut() {
            audio.set_stream_origin(origin, origin_qpc);
        }
    }

    /// Schickt einen Capture-Frame in den Encoder. `pts` ist die wall-clock-
    /// abgeleitete Präsentations-Zeit in Encoder-Timebase-Einheiten (1/fps),
    /// vergeben vom Pacing-Loop — muss streng monoton sein. Bei statischem
    /// Bild wird derselbe Frame mehrfach mit fortlaufender PTS gesendet.
    /// Drained interne Packets auf den Output.
    pub fn send(&mut self, captured: &CapturedFrame, pts: i64) -> Result<()> {
        if (captured.width, captured.height) != self.expected_src {
            return Err(anyhow!(
                "frame dimensions {}x{} don't match encoder src {}x{}",
                captured.width,
                captured.height,
                self.expected_src.0,
                self.expected_src.1
            ));
        }

        let t_convert = std::time::Instant::now();
        // Der Encoder (QSV/AMF async submit-queue) kann das zuletzt gesendete
        // Frame noch referenziert halten. Bevor wir denselben `encoder_frame`-
        // Buffer wiederbeschreiben (copy_bgra / sws.run schreiben roh hinein),
        // sicherstellen dass er nicht mehr geteilt ist — sonst überschreiben wir
        // ein noch in-flight Frame (Tearing/Korruption). No-op solange der
        // Refcount 1 ist; sonst alloziert FFmpeg einen frischen Buffer (#4).
        unsafe {
            let ret = ffmpeg::ffi::av_frame_make_writable(self.encoder_frame.as_mut_ptr());
            if ret < 0 {
                return Err(anyhow!("av_frame_make_writable: {ret}"));
            }
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
        self.last_convert_us = t_convert.elapsed().as_micros() as u64;

        frame.set_pts(Some(pts));

        // VOR dem Einschieben stempeln: mit abgeschaltetem Vorlauf liefert der
        // Encoder das Paket im selben Aufruf zurück (s. `latency.rs`).
        let t_send = std::time::Instant::now();
        self.encoder
            .send_frame(frame)
            .context("encoder.send_frame")?;
        self.last_send_us = t_send.elapsed().as_micros() as u64;
        self.enc_latency.submitted(pts, t_send);
        self.drain_packets()?;
        Ok(())
    }

    /// Encodete Video-Packets aus dem Encoder ziehen und in die MuxWriter-Queue
    /// schieben. EAGAIN/EOF = nichts (mehr) da → Drain fertig; ein ECHTER
    /// Encoder-Fehler wird propagiert statt verschluckt (#8).
    fn drain_packets(&mut self) -> Result<()> {
        let mut mux_us: u64 = 0;
        loop {
            let mut packet = Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(e.into()),
            }
            // Zuordnen VOR `rescale_ts` — danach steht der pts in der
            // Muxer-Zeitbasis und passt nicht mehr zum vermerkten.
            self.enc_latency.packet(packet.pts());
            packet.set_stream(self.video_stream_idx);
            packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
            let t_mux = std::time::Instant::now();
            self.mux.send(packet)?;
            mux_us += t_mux.elapsed().as_micros() as u64;
        }
        self.last_mux_us = mux_us;
        Ok(())
    }

    /// Finalisiert den Stream: EOF an Video (+Audio), restliche Packets flushen,
    /// Trailer schreiben (RTMP wird sauber geschlossen).
    ///
    /// Nimmt `&mut self` — gibt den Encoder NICHT frei. Der Caller
    /// `mem::forget`et ihn: der Drop-Teardown rennt sonst gegen einen
    /// treiber-internen Threadpool-Timer (Use-after-free-Crash). Per-Stream-
    /// Sidecar — der Prozess endet gleich, das OS räumt auf. S. `encoder_hw.rs`.
    pub fn finish(&mut self) -> Result<()> {
        self.encoder.send_eof().context("video send_eof")?;
        self.drain_packets()?;
        if let Some(audio) = self.audio.as_mut() {
            let packets = audio.flush()?;
            for packet in packets {
                self.mux.send(packet)?;
            }
        }
        self.mux.finish()
    }
}

/// BGRA-Bytes in einen FFmpeg-`Video`-Frame kopieren. Beachtet den Frame-Stride
/// (FFmpeg padded die Zeilen für SIMD-Alignment, deshalb funktioniert kein
/// pauschales `data.copy_from_slice(src)`). `width`/`height` müssen mit der
/// Frame-Allokation übereinstimmen (Caller-Verantwortung).
pub(crate) fn copy_bgra(frame: &mut frame::Video, bgra: &[u8], width: u32, height: u32) {
    let stride = frame.stride(0);
    let row_bytes = width as usize * 4;
    let data = frame.data_mut(0);
    for y in 0..height as usize {
        let src = y * row_bytes;
        let dst = y * stride;
        data[dst..dst + row_bytes].copy_from_slice(&bgra[src..src + row_bytes]);
    }
}
