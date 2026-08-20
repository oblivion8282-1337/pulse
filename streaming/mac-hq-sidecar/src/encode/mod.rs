//! Video encode + FLV mux + RTMPS push, or the own WHIP sender for http(s).
//!
//! Pipeline (zero-copy): SCK delivers an IOSurface-backed `CVPixelBuffer`
//! ([`crate::capture::Frame`]) which is wrapped — without any copy or swscale —
//! in an `AV_PIX_FMT_VIDEOTOOLBOX` frame ([`hw`]) and encoded on-GPU by
//! `h264_videotoolbox`/`av1_videotoolbox`. From there two paths diverge (see
//! [`Ausgabe`]): FLV-mux + RTMPS/SRT push (mirrors `win-hq-sidecar/src/encode/
//! encoder.rs`), or the own [`crate::whip`] sender for `http(s)://` targets —
//! ffmpeg's WHIP muxer carries neither a RTCP back-channel nor AV1, s. the
//! module head of `crate::whip`.

pub mod audio;
pub mod hw;
pub mod mux_writer;
mod timing;

use std::ffi::c_void;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Packet, Rational, codec, format};

use audio::AudioEncoder;
use hw::VtHwContext;
use mux_writer::MuxWriter;
use timing::{
    keyframe_abstand_bilder, url_format_hint, videotoolbox_encoder,
    warne_bei_langem_abstand_ohne_rueckkanal,
};

/// Der Abstand, fuer den die Schutzmechanismen ausgelegt WURDEN — und auf
/// macOS zugleich die Vorgabe.
///
/// **Zwilling zu `KEYFRAME_SEKUNDEN_UNBEDENKLICH` im Linux-Sidecar** (2 s,
/// dort ausfuehrlich begruendet). Definiert hier statt in `timing.rs`, weil
/// `keyframe.rs` (Test `deckel_haengt_am_unbedenklichen_abstand`) darauf
/// zugreift — die kleinstmoegliche Oeffnung ist `pub(crate)` an genau dieser
/// Stelle, nicht ein zusaetzlicher Re-Export.
pub(crate) const KEYFRAME_SEKUNDEN_UNBEDENKLICH: f32 = 2.0;

/// Opus audio bitrate (kbps) — fixed for now.
const OPUS_BITRATE_KBPS: u32 = 128;

/// Wohin die encodierten Pakete gehen.
///
/// Zwei Wege, die sich grundlegend unterscheiden: der Muxer schreibt in einen
/// Container (FLV/MPEG-TS) und braucht dafuer Zeitbasen und Stream-Indizes; der
/// eigene WebRTC-Weg kennt beides nicht — dort ist ein Bild ein Sample, und die
/// Paketierung macht webrtc-rs. Zwilling zu `Ausgabe` im Linux-Sidecar.
enum Ausgabe {
    Mux(MuxWriter),
    /// Eigener WHIP-Sendeweg (s. [`crate::whip`]). Der einzige Weg, auf dem
    /// eine Vollbild-Anforderung des Zuschauers den Encoder erreicht.
    Whip(Arc<crate::whip::WhipSender>),
}

/// Bildgroesse + Takt + Bitrate — gebuendelt, damit `open_video_encoder` nicht
/// sieben Einzelparameter braucht (Clippy `too_many_arguments`). Beide
/// Aufrufer (`start`/`start_whip`) haben ohnehin dieselben vier Werte.
struct VideoParams {
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: u32,
}

pub struct VideoEncoder {
    encoder: codec::encoder::Video,
    /// VideoToolbox hw-frames context — kept alive for the stream; each frame's
    /// `hw_frames_ctx` references it.
    hw: VtHwContext,
    audio: Option<AudioEncoder>,
    mux: Ausgabe,
    width: u32,
    height: u32,
    stream_idx: usize,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    /// Monotonic frame counter, in the CALLER's pts unit (fps-ticks — s.
    /// `push_pixel_buffer`), regardless of which output is active.
    frame_index: i64,
    /// Bildrate — nur fuer die WHIP-Zeitumrechnung in `push_pixel_buffer`
    /// gebraucht.
    fps: u32,
}

impl VideoEncoder {
    /// Build the encoder + FLV/RTMPS/MPEG-TS output (or the own WHIP sender for
    /// `http(s)://`) and start the mux-writer thread (mux path only).
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

        // Der eigene WHIP-Sender traegt H.264 UND AV1 (anders als ffmpegs
        // WHIP-Muxer, der nur H.264 kennt) — nur HEVC faellt weiterhin auf
        // H.264 zurueck, weil `whip::sdp::codec_capability` es nicht anbietet.
        let codec_id = if format_hint == Some("whip") && codec_id != "h264" && codec_id != "av1" {
            eprintln!("[encode] Codec '{codec_id}' über WHIP nicht verfügbar → Fallback auf h264");
            "h264"
        } else {
            codec_id
        };

        let params = VideoParams { width, height, fps, bitrate_kbps };

        // Eigener WebRTC-Sendeweg: kein Container, kein Stream, kein Header.
        // Deshalb VOR dem Oeffnen eines ffmpeg-Ausgangs abzweigen — alles
        // Folgende (Muxer-Optionen, `write_header`, `MuxWriter`) haengt daran
        // und gilt fuer diesen Weg nicht.
        if format_hint == Some("whip") {
            return Self::start_whip(push_url, &params, codec_id, enable_audio);
        }

        // ── Output context (FLV/RTMPS oder MPEG-TS/SRT) ──────────────────────
        let mut output = match format_hint {
            Some(fmt) => {
                let mut opts = Dictionary::new();
                opts.set("rw_timeout", "10000000"); // 10s — don't hang on a dead socket
                if push_url.to_ascii_lowercase().starts_with("rtmps://") {
                    // Pulse-MediaMTX uses a self-signed cert by design.
                    opts.set("tls_verify", "0");
                }
                format::output_as_with(&push_url, fmt, opts)
                    .with_context(|| format!("open output {fmt} → {}", crate::redact::redact_url(push_url)))?
            }
            None => format::output(&push_url)
                .with_context(|| format!("open output → {}", crate::redact::redact_url(push_url)))?,
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

        let hw = VtHwContext::new(width, height)?;
        let encoder_time_base = Rational::new(1, fps as i32);
        warne_bei_langem_abstand_ohne_rueckkanal(false);
        let encoder = Self::open_video_encoder(codec, &params, encoder_time_base, &hw, global_header)?;
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
            mux: Ausgabe::Mux(mux),
            width,
            height,
            stream_idx,
            encoder_time_base,
            stream_time_base,
            frame_index: 0,
            fps,
        })
    }

    /// Encoder + eigener WHIP-Sendeweg, ohne jeden ffmpeg-Ausgang.
    ///
    /// **`global_header` ist hier bewusst `false`.** Ein Container wie FLV
    /// erwartet die Parametersaetze (SPS/PPS) EINMAL im Kopf; ueber RTP muessen
    /// sie dagegen im Strom mitlaufen, weil jeder Zuschauer zu einem beliebigen
    /// Zeitpunkt einsteigt und es keinen Kopf gibt, den er nachlesen koennte.
    /// Mit globalem Kopf bekaeme er nie Parametersaetze und saehe dauerhaft
    /// nichts (Falle 2 im Umsetzungsplan; Zwilling `create_whip` im
    /// Linux-Sidecar).
    ///
    /// **Zeitbasis 1/90000, nicht 1/fps.** Der WHIP-Weg rechnet den `pts` eines
    /// Encoder-Pakets NICHT um (Falle 1: kein `rescale_ts`, s. `drain`) — er
    /// geht als Identitaet direkt in den RTP-Zeitstempel
    /// (`whip::av1::SpurZustand::zeitstempel`). Das ist nur richtig, wenn die
    /// Encoder-Zeitbasis selbst schon die 90-kHz-RTP-Uhr ist
    /// ([`crate::zeitbasis`]) — deshalb hier anders als im Muxer-Pfad.
    fn start_whip(push_url: &str, params: &VideoParams, codec_id: &str, enable_audio: bool) -> Result<Self> {
        let enc_name = videotoolbox_encoder(codec_id);
        let codec = codec::encoder::find_by_name(enc_name)
            .ok_or_else(|| anyhow!("encoder {enc_name} not in linked FFmpeg"))?;
        let hw = VtHwContext::new(params.width, params.height)?;
        let encoder_time_base = Rational::new(1, crate::zeitbasis::VIDEO_HZ as i32);
        warne_bei_langem_abstand_ohne_rueckkanal(true);
        let encoder = Self::open_video_encoder(codec, params, encoder_time_base, &hw, false)?;

        // Ton-Encoder MUSS vor dem Verbinden stehen: WHIP kennt keine
        // Nachverhandlung, die Tonspur muss also schon im Angebot liegen.
        let audio = if enable_audio {
            Some(AudioEncoder::create_standalone(48_000, OPUS_BITRATE_KBPS)?)
        } else {
            None
        };

        // Erst NACH dem Oeffnen der Encoder verbinden: schlaegt einer von ihnen
        // fehl, waere eine offene WHIP-Sitzung ein Karteileichen-Pfad, den erst
        // ein Zeitablauf aufraeumt.
        let sender = crate::whip::WhipSender::connect(
            push_url,
            codec_id,
            params.fps,
            params.width,
            params.height,
        )
        .with_context(|| format!("WHIP-Aufbau zu {}", crate::redact::redact_url(push_url)))?;

        Ok(Self {
            encoder,
            hw,
            audio,
            mux: Ausgabe::Whip(Arc::new(sender)),
            width: params.width,
            height: params.height,
            stream_idx: 0,
            encoder_time_base,
            // Gleich der Encoder-Zeitbasis: auf diesem Weg wird nicht
            // umgerechnet (s. `drain`), das Feld bleibt nur belegt, damit die
            // Struktur eine bleibt.
            stream_time_base: encoder_time_base,
            frame_index: 0,
            fps: params.fps,
        })
    }

    /// Den VideoToolbox-Encoder aufsetzen und oeffnen — gemeinsam fuer Muxer-
    /// und WHIP-Weg, damit die gemessenen Einstellungen nicht in zwei Kopien
    /// auseinanderlaufen koennen (Zwilling `open_encoder` im Linux-Sidecar).
    fn open_video_encoder(
        codec_descriptor: ffmpeg::Codec,
        params: &VideoParams,
        time_base: Rational,
        hw: &VtHwContext,
        global_header: bool,
    ) -> Result<codec::encoder::Video> {
        let mut venc = codec::context::Context::new_with_codec(codec_descriptor)
            .encoder()
            .video()?;
        venc.set_width(params.width);
        venc.set_height(params.height);
        venc.set_time_base(time_base);
        venc.set_frame_rate(Some(Rational::new(params.fps as i32, 1)));
        venc.set_bit_rate((params.bitrate_kbps as usize).saturating_mul(1000));
        venc.set_max_bit_rate((params.bitrate_kbps as usize).saturating_mul(1000));
        venc.set_gop(keyframe_abstand_bilder(params.fps));
        venc.set_max_b_frames(0); // low-latency, container/RTP-friendly
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
        venc.open_with(eopts).context(format!("open {} encoder", codec_descriptor.name()))
    }

    /// Encode interleaved-stereo-F32 audio samples (no-op if audio disabled).
    /// `anchor_samples` is the wall-clock position (in 48kHz samples since the
    /// shared stream epoch) used to anchor the FIRST audio frame's pts, so audio
    /// lines up with video instead of both independently starting at 0.
    pub fn push_audio(&mut self, samples: &[f32], anchor_samples: i64) -> Result<()> {
        if let Some(a) = self.audio.as_mut() {
            let senke = match &self.mux {
                Ausgabe::Mux(m) => audio::TonSenke::Mux(m),
                Ausgabe::Whip(w) => audio::TonSenke::Whip(w),
            };
            a.push(samples, &senke, anchor_samples)?;
        }
        Ok(())
    }

    /// Encode one captured frame, **zero-copy**. `pb` is a `CVPixelBufferRef`
    /// carrying ONE retain that this call takes over; the IOSurface stays on the
    /// GPU all the way into VideoToolbox (no swscale, no RAM copy). The retain is
    /// released once both this thread and the async encoder are done with it.
    ///
    /// `pts` is the frame's presentation time in fps-ticks (`stream_controller.rs`
    /// derives it from a wall-clock epoch shared with the audio path, so A/V stay
    /// in sync), clamped monotonic here — the caller's contract is unchanged by
    /// which output is active (`stream_controller.rs` stays untouched, s.
    /// `Ausgabe`).
    ///
    /// # Safety
    /// `pb` must be a valid `CVPixelBufferRef` with one retain to hand over.
    // `pb` is opaque here (owned by `crate::capture`, documented above) and
    // only ever reaches an actual dereference inside `hw::wrap` (an `unsafe
    // fn` with its own `# Safety` contract) — this crate never compiled
    // clean under clippy before (E0433 in `whip/mod.rs` until this change),
    // so this pre-existing lint surfaces here for the first time.
    #[allow(clippy::not_unsafe_ptr_arg_deref)]
    pub fn push_pixel_buffer(&mut self, pb: *mut c_void, pts: i64) -> Result<()> {
        let pts = pts.max(self.frame_index);
        self.frame_index = pts + 1;
        // Der Muxer-Weg encodiert in fps-Takten (`encoder_time_base == 1/fps`),
        // der eingehende `pts` passt dort unveraendert. Der WHIP-Weg encodiert
        // dagegen in der 90-kHz-RTP-Uhr (`start_whip`) — hier umgerechnet, statt
        // in `drain()` (Falle 1: dort geht das Encoder-Paket ohne zweite
        // Umrechnung direkt an `WhipSender::send`). Gerundet, nicht
        // abgeschnitten, damit sich der Fehler nicht einseitig aufsummiert.
        let encoder_pts = match &self.mux {
            Ausgabe::Mux(_) => pts,
            Ausgabe::Whip(_) => fps_takt_zu_rtp_takt(pts, self.fps),
        };
        unsafe {
            let frame = hw::wrap(&self.hw, pb, self.width, self.height, encoder_pts)?;
            // Vollbild auf Anforderung: `pict_type = I` bringt `h264_videotoolbox`
            // (`videotoolboxenc.c`) dazu, `kVTEncodeFrameOptionKey_ForceKeyFrame`
            // zu setzen — unabhaengig vom HW-Frames-Kontext, der Zero-Copy-Pfad
            // bleibt intakt (Nachweis: `nm -u .../libavcodec.dylib | grep
            // ForceKeyFrame`). `take_keyframe_request()` MUSS hier stehen, auch
            // wenn nichts angefordert wurde — sonst bliebe ein einmal gesetztes
            // `pict_type=I` ohne Wirkung auf die Drossel unbeobachtet stehen.
            //
            // Anders als auf Linux/Windows braucht es KEIN explizites
            // Zuruecksetzen auf `pict_type = AV_PICTURE_TYPE_NONE` fuer das
            // naechste Bild: `frame` wird hier bei jedem Aufruf frisch von
            // `hw::wrap` alloziert (kein Pool) und direkt danach wieder
            // freigegeben — der naechste Aufruf startet mit einem frischen,
            // genullten `AVFrame`, dessen `pict_type` bereits
            // `AV_PICTURE_TYPE_NONE` ist.
            if crate::keyframe::take_keyframe_request() {
                (*frame).pict_type = ffmpeg::ffi::AVPictureType::AV_PICTURE_TYPE_I;
            }
            let rc = ffmpeg::ffi::avcodec_send_frame(self.encoder.as_mut_ptr(), frame);
            let mut f = frame;
            ffmpeg::ffi::av_frame_free(&mut f); // drop our ref; encoder keeps its own
            if rc < 0 {
                return Err(anyhow!("avcodec_send_frame(hw): {rc}"));
            }
        }
        self.drain()
    }

    /// Drain encoder output packets into the muxer, or onto the WHIP sender.
    fn drain(&mut self) -> Result<()> {
        loop {
            let mut packet = Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => match &self.mux {
                    Ausgabe::Mux(m) => {
                        packet.set_stream(self.stream_idx);
                        packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
                        m.send(packet)?;
                    }
                    // Kein Umrechnen und kein Stream-Index: der Sende-Track
                    // nimmt die rohen Bytes. Der `pts` geht MIT — bereits in
                    // der 90-kHz-RTP-Uhr (`start_whip`/`push_pixel_buffer`),
                    // `WhipSender::send` reicht ihn als Identitaet weiter
                    // (Falle 1, s. Modulkopf).
                    Ausgabe::Whip(w) => {
                        if let Some(daten) = packet.data() {
                            w.send(daten, packet.pts())?;
                        }
                    }
                },
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(ffmpeg::Error::Eof) => break,
                Err(e) => return Err(e).context("receive_packet"),
            }
        }
        Ok(())
    }

    /// Flush the encoder and close the mux (writes the FLV trailer / RTMP close,
    /// or tears down the WHIP session).
    pub fn finish(&mut self) -> Result<()> {
        self.encoder.send_eof().context("send_eof")?;
        self.drain()?;
        if let Some(a) = self.audio.as_mut() {
            let senke = match &self.mux {
                Ausgabe::Mux(m) => audio::TonSenke::Mux(m),
                Ausgabe::Whip(w) => audio::TonSenke::Whip(w),
            };
            a.flush(&senke)?;
        }
        match &mut self.mux {
            Ausgabe::Mux(m) => m.finish(),
            Ausgabe::Whip(w) => {
                w.close();
                Ok(())
            }
        }
    }
}

/// Rechnet einen `pts` in fps-Takten (der Aufrufer-Kontrakt von
/// `push_pixel_buffer`, unveraendert seit vor Aufgabe 3) in die 90-kHz-RTP-Uhr
/// um, die der WHIP-Encoder als Zeitbasis fuehrt (s. `start_whip`).
///
/// Herausgeloest, damit die Rechnung ohne einen echten Stream pruefbar ist —
/// `push_pixel_buffer` selbst braucht dafuer einen offenen VideoToolbox-
/// Encoder. Gerundet (nicht abgeschnitten): bei 30 fps waere `90000/30` exakt
/// 3000, aber bei krummen Raten wie 280 fps ist es das nicht, und Abschneiden
/// wuerde den Fehler einseitig aufsummieren lassen (Zwilling zur Falle, die
/// `whip::dauer_fuer_takte` fuer die Ton-Paketdauer schon einmal behoben hat).
fn fps_takt_zu_rtp_takt(pts: i64, fps: u32) -> i64 {
    let hz = i128::from(crate::zeitbasis::VIDEO_HZ);
    let fps = i128::from(fps.max(1));
    ((i128::from(pts) * hz + fps / 2) / fps) as i64
}

#[cfg(test)]
mod pts_umrechnung_tests {
    use super::fps_takt_zu_rtp_takt;
    use crate::zeitbasis::VIDEO_HZ;

    /// Glatte Bildraten treffen die 90-kHz-Uhr exakt.
    #[test]
    fn glatte_bildrate_trifft_exakt() {
        assert_eq!(fps_takt_zu_rtp_takt(0, 60), 0);
        assert_eq!(fps_takt_zu_rtp_takt(1, 60), 1_500);
        assert_eq!(fps_takt_zu_rtp_takt(60, 60), 90_000);
    }

    /// Krumme Bildraten runden, statt abzuschneiden — sonst faellt der Fehler
    /// einseitig aus (die Falle, die `whip::dauer_fuer_takte` fuer den Ton
    /// schon einmal behoben hat).
    #[test]
    fn krumme_bildrate_rundet_statt_abzuschneiden() {
        // 90000/280 = 321,43 — abgeschnitten waere 321, gerundet 321. Nach 7
        // Bildern liegt der Unterschied klar: 90000*7/280 = 2250 exakt.
        assert_eq!(fps_takt_zu_rtp_takt(7, 280), 2_250);
        // 90000/3 = 30000 exakt, aber 90000*2/3 = 60000 exakt — kein guter
        // Testfall fuer Rundung. 90000/7 = 12857,14... — hier zeigt sich's:
        assert_eq!(fps_takt_zu_rtp_takt(1, 7), 12_857); // 12857,14 -> 12857
        assert_eq!(fps_takt_zu_rtp_takt(2, 7), 25_714); // 25714,29 -> 25714
    }

    /// `fps=0` darf nicht durch Null teilen — geklemmt auf 1.
    #[test]
    fn null_fps_teilt_nicht_durch_null() {
        assert_eq!(fps_takt_zu_rtp_takt(1, 0), i64::from(VIDEO_HZ));
    }

    /// Der Muxer-Weg rechnet ueberhaupt nicht um — das ist in
    /// `push_pixel_buffer` selbst geprueft (Match auf `Ausgabe::Mux`), diese
    /// Funktion hier deckt nur den WHIP-Zweig ab.
    #[test]
    fn ein_sekundentakt_ergibt_die_volle_uhr() {
        assert_eq!(fps_takt_zu_rtp_takt(30, 30), i64::from(VIDEO_HZ));
    }
}
