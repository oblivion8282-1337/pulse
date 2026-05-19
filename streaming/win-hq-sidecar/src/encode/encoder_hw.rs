//! Hardware-Encoder mit D3D11-Pool-Input (Zero-Copy-NVENC-Pfad).
//!
//! Spiegelt `FfmpegEncoder` aus `encoder.rs`, aber:
//! - Input-Frames sind `OwnedHwFrame` (AVFrame mit D3D11-Texture in data[0]).
//! - **Ohne Downscale**: `pix_fmt = AV_PIX_FMT_D3D11`, `sw_format = AV_PIX_FMT_BGRA`
//!   (siehe `hwctx.rs`). NVENC schluckt die BGRA-D3D11-Frames direkt.
//! - **Mit Downscale**: `ScaleFilter` (`hwmap=cuda` → `scale_cuda=W:H:format=nv12`)
//!   dazwischen → NVENC bekommt CUDA-NV12-Frames in dst-res. Bleibt zero-copy
//!   weil D3D11→CUDA-Mapping auf derselben GPU keine echte Memory-Bewegung ist.
//! - `hw_frames_ctx` muss VOR `avcodec_open2` via FFI an `AVCodecContext` gehängt
//!   werden (ffmpeg-next exponiert das Feld nicht; wir gehen über `as_mut_ptr`).
//!
//! Aktiv für `vendor == "nvidia"`. AMD/Intel-Zero-Copy bräuchten zusätzlich
//! einen GPU-Color-Convert BGRA→NV12 ohne CUDA-Detour — kein Scope hier.

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Packet, Rational, codec, format, ffi::*};

use super::audio::AudioPipeline;
use super::encoder::{AudioStreamConfig, VideoCodec, url_format_hint, vendor_encoder_opts};
use super::hwctx::{HwContext, OwnedHwFrame};
use super::scale_filter::ScaleFilter;
use crate::audio::CapturedAudio;

#[derive(Debug, Clone)]
pub struct HwEncoderConfig {
    pub codec: VideoCodec,
    pub vendor: String,
    pub fps: u32,
    pub bitrate_kbps: u32,
    /// Capture-native Dimensionen — = HwContext-Pool-Größe.
    pub src_w: u32,
    pub src_h: u32,
    /// Encoder-Output. Bei `(src_w, src_h) == (dst_w, dst_h)` läuft der direkte
    /// D3D11-Pfad; sonst wird ein `scale_cuda`-Filter zwischengeschoben.
    pub dst_w: u32,
    pub dst_h: u32,
}

pub struct FfmpegHwEncoder {
    output: format::context::Output,
    encoder: codec::encoder::Video,
    /// `Some` wenn Downscale aktiv ist. Pipeline: D3D11-Frame → scale.push() →
    /// scale.pull() → CUDA-Frame → encoder.
    scale: Option<ScaleFilter>,
    video_stream_idx: usize,
    pts: i64,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    audio: Option<AudioPipeline>,
}

impl FfmpegHwEncoder {
    pub fn create(
        cfg: &HwEncoderConfig,
        hw: &HwContext,
        audio_cfg: Option<AudioStreamConfig>,
        output_path: &str,
    ) -> Result<Self> {
        ffmpeg::init().context("ffmpeg::init")?;

        let needs_scale = (cfg.src_w, cfg.src_h) != (cfg.dst_w, cfg.dst_h);
        // ScaleFilter VOR dem Encoder bauen — der Filter-Graph init macht
        // hwmap+scale_cuda und stellt einen CUDA-frames-ctx bereit, den wir an
        // den Encoder hängen.
        let scale = if needs_scale {
            Some(
                ScaleFilter::new(
                    hw.frames_ref(),
                    cfg.src_w,
                    cfg.src_h,
                    cfg.dst_w,
                    cfg.dst_h,
                    cfg.fps,
                )
                .context("ScaleFilter::new")?,
            )
        } else {
            None
        };

        let mut output = match url_format_hint(output_path) {
            Some(fmt) => {
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

        let mut encoder = codec::context::Context::new_with_codec(codec_descriptor)
            .encoder()
            .video()?;
        encoder.set_width(cfg.dst_w);
        encoder.set_height(cfg.dst_h);
        encoder.set_format(if needs_scale { format::Pixel::CUDA } else { format::Pixel::D3D11 });
        encoder.set_time_base(Rational::new(1, cfg.fps as i32));
        encoder.set_frame_rate(Some(Rational::new(cfg.fps as i32, 1)));
        encoder.set_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_max_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_gop(cfg.fps.saturating_mul(2));
        if global_header {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }

        // hw_frames_ctx an die AVCodecContext hängen — MUSS vor open passieren.
        // Downscale-Pfad nimmt den CUDA-frames-ctx aus dem ScaleFilter-Sink
        // (dst-res, NV12); direkt-Pfad nimmt den D3D11-Pool (src-res, BGRA).
        unsafe {
            let ctx_ptr = encoder.as_mut_ptr();
            let source_ref = match &scale {
                Some(s) => s.cuda_frames_ref(),
                None => hw.frames_ref(),
            };
            let new_ref = av_buffer_ref(source_ref);
            if new_ref.is_null() {
                return Err(anyhow!("av_buffer_ref(frames_ref) returned NULL"));
            }
            (*ctx_ptr).hw_frames_ctx = new_ref;
        }

        let opts = vendor_encoder_opts(&cfg.vendor);
        let opened = encoder
            .open_with(opts)
            .with_context(|| format!("open hw encoder '{codec_name}' (vendor={})", cfg.vendor))?;
        stream.set_parameters(&opened);

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

        Ok(Self {
            output,
            encoder: opened,
            scale,
            video_stream_idx: stream_idx,
            pts: 0,
            encoder_time_base,
            stream_time_base,
            audio,
        })
    }

    pub fn send_audio(&mut self, captured: &CapturedAudio) -> Result<()> {
        if let Some(audio) = self.audio.as_mut() {
            audio.send(captured, &mut self.output)?;
        }
        Ok(())
    }

    /// Schickt einen Pool-Frame in den Encoder. PTS wird hier gesetzt
    /// (überschreibt eventuell vorab gesetzte) — Pipeline-Convention: pro
    /// Encoder-Instanz monoton ab 0.
    pub fn send_hw(&mut self, frame: &mut OwnedHwFrame) -> Result<()> {
        let pts = self.pts;
        self.pts += 1;
        frame.set_pts(pts);

        if self.scale.is_none() {
            return self.send_avframe(frame.as_mut_ptr());
        }

        // Downscale-Pfad: erst alle ready-CUDA-Frames aus dem Filter ziehen
        // (Vec entkoppelt den scale-Borrow vom send_avframe-Borrow), dann
        // sequentiell senden. Pro D3D11-Input erzeugt scale_cuda 1 CUDA-Output
        // (nach dem initialen Warmup); in Edge-Cases (Filter braucht mehr Input
        // bevor er output produziert) kann's auch 0 sein → nächste send_hw
        // bekommt zwei Frames raus. Pipeline bleibt korrekt.
        {
            let scale = self.scale.as_mut().unwrap();
            scale.push(frame.as_mut_ptr())?;
        }
        let mut cuda_frames = Vec::with_capacity(1);
        {
            let scale = self.scale.as_mut().unwrap();
            while let Some(cf) = scale.pull()? {
                cuda_frames.push(cf);
            }
        }
        for mut cf in cuda_frames {
            self.send_avframe(cf.as_mut_ptr())?;
        }
        Ok(())
    }

    fn send_avframe(&mut self, frame_ptr: *mut AVFrame) -> Result<()> {
        unsafe {
            let ret = avcodec_send_frame(self.encoder.as_mut_ptr(), frame_ptr);
            if ret < 0 {
                return Err(anyhow!("avcodec_send_frame failed: {ret}"));
            }
        }
        self.drain_packets()
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
