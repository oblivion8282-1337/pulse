//! Hardware-Encoder mit D3D11-Pool-Input (Zero-Copy-NVENC-Pfad).
//!
//! Spiegelt `FfmpegEncoder` aus `encoder.rs`, aber:
//! - Input-Frames sind `OwnedHwFrame` (AVFrame mit D3D11-Texture in data[0]).
//! - `pix_fmt = AV_PIX_FMT_D3D11`, `sw_format = AV_PIX_FMT_BGRA` (siehe
//!   `hwctx.rs`). NVENC schluckt die BGRA-D3D11-Frames direkt.
//! - `hw_frames_ctx` muss VOR `avcodec_open2` via FFI an `AVCodecContext`
//!   gehängt werden (ffmpeg-next exponiert das Feld nicht; wir gehen über
//!   `as_mut_ptr`).
//!
//! **Downscale** läuft NICHT mehr hier: der `D3D11Scaler` (siehe
//! `d3d11_scale.rs`) skaliert vor dem Encoder per `VideoProcessorBlt` auf der
//! GPU. Der Encoder bekommt immer fertig dimensionierte D3D11-BGRA-Frames —
//! native aus dem Capture-Pool, downscaled aus dem Scaler-Ziel-Pool. Der
//! Caller übergibt die passende `hw_frames_ctx`-AVBufferRef.
//!
//! Aktiv für `vendor == "nvidia"`. AMD/Intel-Zero-Copy bräuchten zusätzlich
//! einen GPU-Color-Convert BGRA→NV12 — kein Scope hier.

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Packet, Rational, codec, format, ffi::*};

use super::audio::AudioPipeline;
use super::encoder::{AudioStreamConfig, VideoCodec, url_format_hint, vendor_encoder_opts};
use super::hwctx::OwnedHwFrame;
use super::mux_writer::MuxWriter;
use crate::audio::CapturedAudio;

#[derive(Debug, Clone)]
pub struct HwEncoderConfig {
    pub codec: VideoCodec,
    pub vendor: String,
    pub fps: u32,
    pub bitrate_kbps: u32,
    /// Encoder-Output-Dimensionen. Bei Downscale = dst-Auflösung (der
    /// `D3D11Scaler` hat dann schon skaliert); bei Native = capture-res.
    pub dst_w: u32,
    pub dst_h: u32,
}

pub struct FfmpegHwEncoder {
    /// Async-Muxer — der `AVFormatContext` lebt auf einem eigenen Thread, der
    /// Encoder schiebt Packets nur in dessen Queue (s. `mux_writer.rs`).
    mux: MuxWriter,
    encoder: codec::encoder::Video,
    video_stream_idx: usize,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    audio: Option<AudioPipeline>,
    /// Diagnose-Timings des letzten `send_hw`-Calls (µs) — gespeist in den
    /// `TickMonitor` (s. `tick_monitor.rs`) zur Mikro-Stutter-Analyse.
    /// `last_send_us` = `avcodec_send_frame` (NVENC-Submit), `last_mux_us` =
    /// Zeit fürs Einreihen der Packets in die `MuxWriter`-Queue (normal ~0;
    /// ein Spike = Queue voll = Writer-Thread hängt am Socket).
    last_send_us: u64,
    last_mux_us: u64,
}

impl FfmpegHwEncoder {
    /// `hw_frames_ref` ist die D3D11VA-frames-AVBufferRef, aus der die
    /// Input-Frames stammen — Capture-`HwContext` (native) oder Scaler-
    /// Ziel-`HwContext` (downscale). Der Encoder nimmt eine eigene Referenz.
    pub fn create(
        cfg: &HwEncoderConfig,
        hw_frames_ref: *mut AVBufferRef,
        audio_cfg: Option<AudioStreamConfig>,
        output_path: &str,
    ) -> Result<Self> {
        ffmpeg::init().context("ffmpeg::init")?;

        let mut output = match url_format_hint(output_path) {
            Some(fmt) => {
                let mut opts = Dictionary::new();
                // Netzwerk-Timeout (µs) — s. encoder.rs::create. Ohne das hängt
                // ein toter Connect/Write den Worker unbegrenzt → Sidecar-Freeze.
                opts.set("rw_timeout", "10000000");
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
        encoder.set_format(format::Pixel::D3D11);
        encoder.set_time_base(Rational::new(1, cfg.fps as i32));
        encoder.set_frame_rate(Some(Rational::new(cfg.fps as i32, 1)));
        encoder.set_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_max_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_gop(cfg.fps.saturating_mul(2));
        if global_header {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }

        // hw_frames_ctx an die AVCodecContext hängen — MUSS vor open passieren.
        // Native = Capture-D3D11-Pool (src-res), Downscale = Scaler-Ziel-Pool
        // (dst-res); beide D3D11/BGRA, also derselbe Encoder-Pfad.
        unsafe {
            let ctx_ptr = encoder.as_mut_ptr();
            let new_ref = av_buffer_ref(hw_frames_ref);
            if new_ref.is_null() {
                return Err(anyhow!("av_buffer_ref(hw_frames_ref) returned NULL"));
            }
            (*ctx_ptr).hw_frames_ctx = new_ref;
        }

        let opts = vendor_encoder_opts(&cfg.vendor);
        let opened = encoder
            .open_with(opts)
            .with_context(|| format!("open hw encoder '{codec_name}' (vendor={})", cfg.vendor))?;
        stream.set_parameters(&opened);

        let mut audio = match audio_cfg {
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
        // Audio-Stream-Timebase erst JETZT (nach write_header) lesen + setzen.
        if let Some(a) = audio.as_mut() {
            let audio_tb = output.stream(a.stream_idx).unwrap().time_base();
            a.set_stream_time_base(audio_tb);
        }

        // Output an den Writer-Thread übergeben — ab hier läuft jedes
        // write_interleaved asynchron, der Pacing-Loop blockiert nie am Socket.
        let mux = MuxWriter::start(output).context("start mux-writer")?;

        Ok(Self {
            mux,
            encoder: opened,
            video_stream_idx: stream_idx,
            encoder_time_base,
            stream_time_base,
            audio,
            last_send_us: 0,
            last_mux_us: 0,
        })
    }

    /// NVENC-Submit-Dauer (`avcodec_send_frame`) des letzten `send_hw` in µs.
    pub fn last_send_us(&self) -> u64 {
        self.last_send_us
    }

    /// Queue-Einreih-Dauer (`MuxWriter::send`) des letzten `send_hw` in µs —
    /// summiert über alle gedrainten Pakete. Normal ~0; ein Spike heißt die
    /// Queue ist voll = der Writer-Thread hängt am Socket.
    pub fn last_mux_us(&self) -> u64 {
        self.last_mux_us
    }

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
    pub fn set_audio_origin(&mut self, origin: std::time::Instant) {
        if let Some(audio) = self.audio.as_mut() {
            audio.set_stream_origin(origin);
        }
    }

    /// Schickt einen Pool-Frame in den Encoder. `pts` ist die wall-clock-
    /// abgeleitete Präsentations-Zeit in Encoder-Timebase-Einheiten (1/fps) —
    /// vom Pacing-Loop in `pipeline_hw.rs` vergeben, muss streng monoton sein.
    /// Bei statischem Bild wird derselbe Frame mehrfach mit fortlaufender PTS
    /// gesendet (Duplizierung) — daher PTS als Parameter, kein interner Zähler.
    ///
    /// Der Frame ist immer ein fertig dimensionierter D3D11-BGRA-Frame
    /// (Downscale erledigt der `D3D11Scaler` vorgelagert).
    pub fn send_hw(&mut self, frame: &mut OwnedHwFrame, pts: i64) -> Result<()> {
        frame.set_pts(pts);
        self.send_avframe(frame.as_mut_ptr())
    }

    fn send_avframe(&mut self, frame_ptr: *mut AVFrame) -> Result<()> {
        let t_send = std::time::Instant::now();
        unsafe {
            let ret = avcodec_send_frame(self.encoder.as_mut_ptr(), frame_ptr);
            if ret < 0 {
                return Err(anyhow!("avcodec_send_frame failed: {ret}"));
            }
        }
        self.last_send_us = t_send.elapsed().as_micros() as u64;
        self.drain_video()
    }

    /// Encodete Video-Packets aus dem Encoder ziehen und in die MuxWriter-Queue
    /// schieben. `receive_packet` schlägt mit EAGAIN/EOF fehl, wenn nichts
    /// (mehr) da ist — dann ist der Drain fertig.
    fn drain_video(&mut self) -> Result<()> {
        let mut mux_us: u64 = 0;
        loop {
            let mut packet = Packet::empty();
            if self.encoder.receive_packet(&mut packet).is_err() {
                break;
            }
            packet.set_stream(self.video_stream_idx);
            packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
            // Einreihen in die Queue messen — normal ~0; blockiert nur, wenn
            // die Queue voll ist (Writer-Thread hängt am Socket).
            let t_mux = std::time::Instant::now();
            self.mux.send(packet)?;
            mux_us += t_mux.elapsed().as_micros() as u64;
        }
        self.last_mux_us = mux_us;
        Ok(())
    }

    /// Finalisiert den Stream: EOF an Video (+Audio), restliche Pakete in die
    /// Queue, dann `MuxWriter::finish` — das wartet auf den Writer-Thread, der
    /// den FLV-Trailer schreibt und die RTMP-Verbindung sauber schließt.
    ///
    /// Nimmt `&mut self`, gibt den Encoder also bewusst NICHT frei: der
    /// Encoder-Drop schließt NVENC + entlädt `nvEncodeAPI64.dll`, und genau
    /// dieser Teardown lässt einen treiber-internen Threadpool-Timer dangling
    /// zurück (→ Use-after-free, `0xC0000005` auf einem `TpWaitForTimer`-Thread).
    /// Der Caller `mem::forget`et den Encoder; der Per-Stream-Sidecar endet
    /// direkt nach `stop`, `ExitProcess` gibt alles sauber frei. (Der Muxer-
    /// Teardown im Writer-Thread ist davon unberührt — rein Netzwerk/Userspace.)
    pub fn finish(&mut self) -> Result<()> {
        self.encoder.send_eof().context("video send_eof")?;
        self.drain_video()?;
        if let Some(audio) = self.audio.as_mut() {
            let packets = audio.flush()?;
            for packet in packets {
                self.mux.send(packet)?;
            }
        }
        self.mux.finish()
    }
}
