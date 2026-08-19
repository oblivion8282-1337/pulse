//! Video encode + FLV mux + RTMPS push.
//!
//! Pipeline (zero-copy): SCK delivers an IOSurface-backed `CVPixelBuffer`
//! ([`crate::capture::Frame`]) which is wrapped — without any copy or swscale —
//! in an `AV_PIX_FMT_VIDEOTOOLBOX` frame ([`hw`]) and encoded on-GPU by
//! `h264_videotoolbox`, then FLV-muxed and pushed over RTMPS. The mux + push
//! setup mirrors `win-hq-sidecar/src/encode/encoder.rs` (FLV container,
//! `tls_verify=0` for the self-signed MediaMTX cert, `rw_timeout=10s`); the
//! async [`mux_writer::MuxWriter`] decouples socket writes from the cadence.

pub mod audio;
pub mod hw;
pub mod mux_writer;

use std::ffi::c_void;

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Packet, Rational, codec, format};

use audio::AudioEncoder;
use hw::VtHwContext;
use mux_writer::MuxWriter;

/// Opus audio bitrate (kbps) — fixed for now.
const OPUS_BITRATE_KBPS: u32 = 128;

/// Regulaerer Vollbild-Abstand in Bildern, Vorgabe sechzig Sekunden.
///
/// **Zwillingsrechnung** zu `keyframe::abstand_bilder` im Windows-Sidecar und
/// `encode::keyframe_abstand_bilder` im Linux-Sidecar — bis 2026-08-18 stand
/// hier `(fps * 2).max(1)` fest im Code, und damit war derselbe Schalter auf
/// den drei Plattformen verschieden wirksam. Die ausfuehrliche Begruendung der
/// Grenzen steht beim Linux-Zwilling.
fn keyframe_abstand_bilder(fps: u32) -> u32 {
    // 60 s seit 2026-08-18 (Begruendung beim Linux-Zwilling). Die dortige
    // Fallunterscheidung nach Betriebsart entfaellt hier: macOS traegt
    // keinen Intra-Refresh, die Zahl ist also immer der Vollbild-Abstand.
    const VORGABE: f32 = 60.0;
    const MIN: f32 = 0.1;
    const MAX: f32 = 120.0;
    let sekunden = match std::env::var("PULSE_KEYFRAME_SECONDS").ok().as_deref() {
        None => VORGABE,
        Some(roh) => match roh.parse::<f32>() {
            Ok(v) if (MIN..=MAX).contains(&v) => v,
            _ => {
                // Gemeldet statt still verworfen: eine Messreihe mit "60 s" im
                // Protokoll, die in Wahrheit mit 2 s lief, sieht plausibel aus.
                eprintln!(
                    "[encode] PULSE_KEYFRAME_SECONDS={roh:?} unbrauchbar \
                     (erlaubt {MIN}..={MAX}) — es gilt die Vorgabe {VORGABE}"
                );
                VORGABE
            }
        },
    };
    // Mindestens ein Bild — ein GOP von 0 lesen manche Encoder als "unbegrenzt".
    ((fps as f32 * sekunden).round() as u32).max(1)
}

/// Map a stream profile codec id to the matching VideoToolbox encoder.
///
/// Uses the real hardware-capability probe ([`crate::caps`]): the exact encoder
/// when this machine can encode the codec (so a gated AV1 profile produces real
/// `av1_videotoolbox` on M3+), else a defensive fall back to h264 (universally
/// available). `health` already reports the same probe to the renderer, which
/// filters the codec picker by it — so in practice the requested codec is
/// always supported here.
fn videotoolbox_encoder(codec: &str) -> &'static str {
    match crate::caps::vt_encoder_name(codec) {
        Some(name) if crate::caps::supports_codec(codec) => name,
        _ => "h264_videotoolbox",
    }
}

/// FLV for RTMP/RTMPS, MPEG-TS for SRT, WHIP for http(s) (WebRTC ingest —
/// media-svc mints `https://<host>/whep/<path>/whip?token=…` for guests on
/// app-hosted instances). Same hint table as the Windows/Linux sidecars.
fn url_format_hint(target: &str) -> Option<&'static str> {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("rtmp://") || lower.starts_with("rtmps://") {
        Some("flv")
    } else if lower.starts_with("srt://") {
        Some("mpegts")
    } else if lower.starts_with("http://") || lower.starts_with("https://") {
        Some("whip")
    } else {
        None
    }
}

/// The linked FFmpeg only carries the WHIP muxer when built with DTLS support
/// (FFmpeg ≥ 8.0 + OpenSSL/mbedTLS). Probe before opening so a missing muxer
/// yields a clear message instead of a cryptic open failure.
fn ensure_muxer_available(fmt: &'static str) -> Result<()> {
    let name = std::ffi::CString::new(fmt).expect("static fmt name");
    let found = unsafe {
        !ffmpeg::ffi::av_guess_format(name.as_ptr(), std::ptr::null(), std::ptr::null()).is_null()
    };
    if found {
        Ok(())
    } else {
        Err(anyhow!(
            "Muxer '{fmt}' fehlt im gelinkten FFmpeg — für WHIP wird FFmpeg ≥ 8.0 \
             mit DTLS (OpenSSL) benötigt. Bitte FFmpeg aktualisieren."
        ))
    }
}

pub struct VideoEncoder {
    encoder: codec::encoder::Video,
    /// VideoToolbox hw-frames context — kept alive for the stream; each frame's
    /// `hw_frames_ctx` references it.
    hw: VtHwContext,
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

        let format_hint = url_format_hint(push_url);

        // WHIP target (app-hosted instance): FFmpeg's WHIP muxer carries only
        // H.264 video — fall back instead of failing at write_header. Mirrors
        // the Linux sidecar (ops/start.rs).
        let codec_id = if format_hint == Some("whip") && codec_id != "h264" {
            eprintln!("[encode] Codec '{codec_id}' über WHIP nicht verfügbar → Fallback auf h264");
            "h264"
        } else {
            codec_id
        };

        // ── Output context (FLV/RTMPS, MPEG-TS/SRT oder WHIP/WebRTC) ─────────
        let mut output = match format_hint {
            Some(fmt) => {
                let mut opts = Dictionary::new();
                if fmt == "whip" {
                    // WHIP does its own I/O (ICE/DTLS/SRTP) — the AVIO options
                    // below don't apply; bound the handshake instead.
                    ensure_muxer_available(fmt)?;
                    opts.set("handshake_timeout", "10000");
                } else {
                    opts.set("rw_timeout", "10000000"); // 10s — don't hang on a dead socket
                    if push_url.to_ascii_lowercase().starts_with("rtmps://") {
                        // Pulse-MediaMTX uses a self-signed cert by design.
                        opts.set("tls_verify", "0");
                    }
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

        // VideoToolbox hw-frames context: the encoder ingests IOSurface-backed
        // CVPixelBuffers directly (zero-copy, no swscale), so it must be told its
        // input is VT frames.
        let hw = VtHwContext::new(width, height)?;

        let encoder_time_base = Rational::new(1, fps as i32);
        let mut venc = codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()?;
        venc.set_width(width);
        venc.set_height(height);
        venc.set_time_base(encoder_time_base);
        venc.set_frame_rate(Some(Rational::new(fps as i32, 1)));
        venc.set_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        venc.set_max_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        venc.set_gop(keyframe_abstand_bilder(fps));
        venc.set_max_b_frames(0); // low-latency, FLV-friendly
        if global_header {
            venc.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        // Hardware input: pix_fmt = VIDEOTOOLBOX + the hw-frames ctx, set on the
        // raw AVCodecContext (ffmpeg-next has no safe setter) before open.
        unsafe {
            let ctx = venc.as_mut_ptr();
            (*ctx).pix_fmt = ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX;
            (*ctx).hw_frames_ctx = ffmpeg::ffi::av_buffer_ref(hw.frames_ref());
        }

        // realtime hint for h264_videotoolbox.
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

        let mux = MuxWriter::start(output).context("start mux-writer")?;

        Ok(Self {
            encoder,
            hw,
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
    /// `anchor_samples` is the wall-clock position (in 48kHz samples since the
    /// shared stream epoch) used to anchor the FIRST audio frame's pts, so audio
    /// lines up with video instead of both independently starting at 0.
    pub fn push_audio(&mut self, samples: &[f32], anchor_samples: i64) -> Result<()> {
        if let Some(a) = self.audio.as_mut() {
            a.push(samples, &self.mux, anchor_samples)?;
        }
        Ok(())
    }

    /// Encode one captured frame, **zero-copy**. `pb` is a `CVPixelBufferRef`
    /// carrying ONE retain that this call takes over; the IOSurface stays on the
    /// GPU all the way into VideoToolbox (no swscale, no RAM copy). The retain is
    /// released once both this thread and the async encoder are done with it.
    ///
    /// `pts` is the frame's presentation time in the encoder time-base (1/fps),
    /// derived by the caller from a wall-clock epoch shared with the audio path
    /// (so A/V stay in sync); clamped monotonic here.
    ///
    /// # Safety
    /// `pb` must be a valid `CVPixelBufferRef` with one retain to hand over.
    pub fn push_pixel_buffer(&mut self, pb: *mut c_void, pts: i64) -> Result<()> {
        let pts = pts.max(self.frame_index);
        self.frame_index = pts + 1;
        unsafe {
            let frame = hw::wrap(&self.hw, pb, self.width, self.height, pts)?;
            let rc = ffmpeg::ffi::avcodec_send_frame(self.encoder.as_mut_ptr(), frame);
            let mut f = frame;
            ffmpeg::ffi::av_frame_free(&mut f); // drop our ref; encoder keeps its own
            if rc < 0 {
                return Err(anyhow!("avcodec_send_frame(hw): {rc}"));
            }
        }
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
