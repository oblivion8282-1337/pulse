//! AMD-GPU-Encoder über den nativen D3D12VA-Encoder (`h264_d3d12va` etc.).
//!
//! Hintergrund: `h264_amf` crasht auf D3D11-Surface-Input mit Integer-Divide-
//! by-Zero in der AMF-Runtime (Issue #455). FFmpeg 8.1 hat aber native
//! D3D12VA-Encoder, die Microsofts D3D12 Video Encode API nutzen statt der
//! AMF-Library — die umgehen den Crash komplett.
//!
//! **Phase 2 — Zero-Copy:** Der NV12-Pool wird mit `ALLOW_UNORDERED_ACCESS`
//! allokiert. Die Capture-Bridge (`capture::wgc_d3d12`) liefert BGRA-D3D12-
//! Resources; der Compute-Shader (`encode::d3d12_convert`) schreibt NV12
//! direkt in einen Pool-Frame dieses Encoders. Kein PCIe-Roundtrip, kein
//! CPU-swscale, kein `av_hwframe_transfer_data` — der Pacing-Loop in
//! `pipeline_d3d12` orchestriert: `acquire_frame` → `convert` → `send_frame`.
//!
//! **extradata-Sonderfall:** Der d3d12va-Encoder liefert — anders als
//! NVENC/AMF — keine Encoder-`extradata`. Ohne avcC-Sequence-Header lehnt
//! MediaMTX den FLV-Stream ab. Darum wird `write_header` VERZÖGERT: erst beim
//! ersten Keyframe-Packet werden SPS/PPS daraus gezogen (`extradata.rs`), an
//! die AVCodecContext gehängt, dann der Header geschrieben und der MuxWriter
//! gestartet. Audio vor diesem Moment wird verworfen (≤ ~1 Tick).

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Packet, Rational, codec, ffi::*, format};
use windows::Win32::Graphics::Direct3D12::{ID3D12Device, ID3D12Resource};
use windows::core::Interface;

use super::audio::AudioPipeline;
use super::codec::VideoCodec;
use super::d3d12_device::{AVD3D12VAFrame, amd_adapter_index, create_d3d12_pool, d3d12va_opts};
use super::encoder::AudioStreamConfig;
use super::extradata::param_set_extradata;
use super::latency::EncodeLatency;
use super::mux_writer::MuxWriter;
use super::output::{open_output, warn_unknown_opts};
use crate::audio::CapturedAudio;
use crate::zeitbasis::VIDEO_HZ;

/// FFmpeg verlangt `AV_INPUT_BUFFER_PADDING_SIZE` Null-Bytes hinter extradata.
const EXTRADATA_PADDING: usize = 64;

#[derive(Debug, Clone)]
pub struct D3d12EncoderConfig {
    pub codec: VideoCodec,
    /// Capture-Auflösung (BGRA-Quelle für den Converter).
    pub src_width: u32,
    pub src_height: u32,
    /// NV12-Encoder-/Pool-Auflösung (≤ src für Downscale, oder gleich).
    pub dst_width: u32,
    pub dst_height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

/// Ein NV12-Pool-Frame des Encoders. Der Converter beschreibt seine
/// `ID3D12Resource`; danach geht der Frame per `send_frame` in den Encoder.
/// Drop unrefs die AVFrame (Texture zurück in den Pool).
pub struct OwnedD3d12Frame {
    frame: *mut AVFrame,
}

// AVFrame-Ptr ist nur eine Heap-Adresse; alles Texture-bezogene ist FFmpeg-
// ref-counted. Der Frame wird vom Pacing-Thread allein benutzt.
unsafe impl Send for OwnedD3d12Frame {}

impl OwnedD3d12Frame {
    /// Die D3D12-NV12-Resource des Pool-Frames — Ziel des Converters.
    pub fn resource(&self) -> Result<ID3D12Resource> {
        let d12 = unsafe { (*self.frame).data[0] as *const AVD3D12VAFrame };
        if d12.is_null() {
            return Err(anyhow!("AVFrame.data[0] (AVD3D12VAFrame) ist NULL"));
        }
        let ptr = unsafe { (*d12).texture };
        unsafe { ID3D12Resource::from_raw_borrowed(&ptr) }
            .map(|r| r.clone())
            .ok_or_else(|| anyhow!("AVD3D12VAFrame.texture ist NULL"))
    }
}

impl Drop for OwnedD3d12Frame {
    fn drop(&mut self) {
        unsafe { av_frame_free(&mut self.frame) }
    }
}

pub struct FfmpegD3d12Encoder {
    /// Async-Muxer — `None` bis zum ersten Keyframe-Packet (verzögertes
    /// `write_header`, s. Modul-Doku).
    mux: Option<MuxWriter>,
    /// Output-Context VOR `write_header`. `Some` bis zur Aktivierung.
    pending_output: Option<format::context::Output>,
    encoder: codec::encoder::Video,
    codec: VideoCodec,
    /// D3D12-hwdevice + NV12-hwframes-Pool. FFmpeg-Eigentum; bewusst geleakt.
    frames_ref: *mut AVBufferRef,
    /// FFmpegs D3D12-Device — der Pacing-Loop öffnet darüber die Capture-
    /// Shared-Handles und baut den `Nv12Converter`.
    device: ID3D12Device,
    video_stream_idx: usize,
    encoder_time_base: Rational,
    /// Erst nach der Aktivierung gültig (vorher Platzhalter 1/90000).
    stream_time_base: Rational,
    audio: Option<AudioPipeline>,
    /// Diagnose-Timings (µs) für den `TickMonitor`.
    last_send_us: u64,
    last_mux_us: u64,
    /// Einschieben -> Paket, s. `latency.rs`. Das ist der Posten, den
    /// `async_depth` veraendert (Default 2 bei den d3d12va-Encodern);
    /// `last_send_us` sieht ihn NICHT.
    enc_latency: EncodeLatency,
    /// Vollbilder auf Anforderung: abholen, zaehlen, gedrosselt melden
    /// (s. `crate::keyframe::Anforderungen`).
    ///
    /// **Fehlte hier bis zum 2026-08-27**, wie im CPU-Weg (`encoder.rs`) und
    /// aus demselben Grund: `crate::keyframe::request_keyframe()` setzt nur
    /// einen prozessweiten Merker, abgeholt hat ihn allein `encoder_hw.rs`.
    /// Ein Zuschauer, der auf diesem Weg ein Vollbild anforderte, bekam keines
    /// — und wartete bis zum regulaeren Takt, seit dem 2026-08-18 also bis zu
    /// 60 s.
    ///
    /// Weniger schwer als im CPU-Weg, weil dieser Zweig nur ueber
    /// `PULSE_HQ_AMD_D3D12=1` erreichbar ist (`codec.rs::amd_forces_d3d12`) —
    /// eine Gegenprobe, kein Auslieferweg. Genau deshalb aber mitgezogen: eine
    /// Gegenprobe, die den Rueckkanal nicht bedient, misst etwas anderes als
    /// den Regelweg und faellt als Vergleich still aus.
    ///
    /// Kein `Selbsttakt` daneben wie in `encoder_hw.rs`: den braucht nur
    /// `h264_amf` (s. `auffrischung::braucht_selbsttakt`), und der laeuft
    /// nicht ueber d3d12va.
    vollbilder_angefordert: crate::keyframe::Anforderungen,
}

impl FfmpegD3d12Encoder {
    pub fn create(
        cfg: &D3d12EncoderConfig,
        audio_cfg: Option<AudioStreamConfig>,
        output_path: &str,
    ) -> Result<Self> {
        ffmpeg::init().context("ffmpeg::init")?;

        // D3D12-hwdevice auf der AMD-GPU + UAV-fähiger NV12-hwframes-Pool.
        let adapter = amd_adapter_index()?;
        let (frames_ref, device) =
            create_d3d12_pool(adapter, cfg.dst_width, cfg.dst_height)?;

        // Output-Öffnung inkl. Protokoll-Optionen (RTMPS/SRT/WHIP) zentral in
        // output.rs::open_output.
        let mut output = open_output(output_path)?;

        let codec_name = cfg.codec.d3d12va_name();
        let codec_descriptor = codec::encoder::find_by_name(codec_name)
            .ok_or_else(|| anyhow!("encoder '{codec_name}' not registered in linked FFmpeg"))?;

        let global_header = output.format().flags().contains(format::Flags::GLOBAL_HEADER);
        let video_stream_idx = output.add_stream(codec_descriptor).context("add_stream")?.index();

        let mut encoder = codec::context::Context::new_with_codec(codec_descriptor)
            .encoder()
            .video()?;
        encoder.set_width(cfg.dst_width);
        encoder.set_height(cfg.dst_height);
        // Zeitbasis 1/90000, NICHT 1/fps — Begruendung in [`crate::zeitbasis`].
        // Die Bildrate darunter bleibt die Grundlage von Ratenregelung und
        // GOP; nur die EINHEIT der Zeitstempel wird feiner.
        encoder.set_time_base(Rational::new(1, VIDEO_HZ as i32));
        encoder.set_frame_rate(Some(Rational::new(cfg.fps as i32, 1)));
        encoder.set_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_max_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_gop(crate::keyframe::abstand_bilder(cfg.fps));
        // Farbgebung ANSAGEN, weil wir sie hier selbst herstellen.
        //
        // `d3d12_convert.rs` rechnet mit einem eigenen HLSL-Shader nach
        // **BT.709 limited** (`rgb_to_yuv709_limited`, Y auf 16..235 gestaucht)
        // — der Strom sagte das bis zum 2026-08-27 aber nicht. Ein Empfaenger
        // ohne Angabe raet, und die uebliche Annahme fuer SD-Material ist
        // BT.601: dieselbe Verwechslung, die auf Linux fuer VAAPI gemessen und
        // nachgezogen wurde (`linux-hq-sidecar/src/encode/mod.rs`, dort weiss
        // Y=255 statt 235).
        //
        // **Warum hier und nicht im AMF-/NVENC-Weg** (`encoder.rs`,
        // Zero-Copy-Zweig): dort wandelt der Encoder intern nach eigener
        // Konvention. Etwas anzusagen, das wir nicht herstellen, verstellte
        // einen funktionierenden Weg auf Verdacht. Die Trennlinie ist nicht
        // die Plattform, sondern die Frage, wer die Umrechnung macht — genau
        // so steht sie auch im Linux-Zwilling.
        encoder.set_colorspace(ffmpeg::color::Space::BT709);
        encoder.set_color_range(ffmpeg::color::Range::MPEG);
        if global_header {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        // pix_fmt + hw_frames_ctx + B-Frames via FFI — MUSS vor `open` passieren.
        unsafe {
            let ctx = encoder.as_mut_ptr();
            (*ctx).pix_fmt = AVPixelFormat::AV_PIX_FMT_D3D12;
            (*ctx).max_b_frames = 0;
            // Zur Farbgebung oben: Primaries und Uebertragungskurve kennt
            // ffmpeg-next nicht als Setter, deshalb ueber den Zeiger — wie im
            // Linux-Zwilling.
            (*ctx).color_primaries = AVColorPrimaries::AVCOL_PRI_BT709;
            (*ctx).color_trc = AVColorTransferCharacteristic::AVCOL_TRC_BT709;
            let new_ref = av_buffer_ref(frames_ref);
            if new_ref.is_null() {
                return Err(anyhow!("av_buffer_ref(frames_ref) returned NULL"));
            }
            (*ctx).hw_frames_ctx = new_ref;
        }

        let opts = d3d12va_opts();
        warn_unknown_opts(&mut encoder, codec_name, &opts);
        let opened = encoder
            .open_with(opts)
            .with_context(|| format!("open encoder '{codec_name}'"))?;
        super::log_encoder_open(
            codec_name,
            "amd/d3d12va",
            cfg.dst_width,
            cfg.dst_height,
            cfg.fps,
            cfg.bitrate_kbps,
            // Der d3d12va-Weg fuehrt keinen 10-bit-Pool.
            false,
        );

        // Audio-Pipeline VOR write_header (addiert einen Stream zum Output).
        let audio = match audio_cfg {
            Some(a) => Some(AudioPipeline::create(
                Some(&mut output),
                a.sample_rate,
                a.channels,
                a.bitrate_kbps,
                a.av_offset_ms,
            )?),
            None => None,
        };

        // KEIN write_header / set_parameters hier — passiert in `activate`,
        // sobald das erste Keyframe-Packet die SPS/PPS liefert.

        Ok(Self {
            mux: None,
            pending_output: Some(output),
            encoder: opened,
            codec: cfg.codec,
            frames_ref,
            device,
            video_stream_idx,
            encoder_time_base: Rational::new(1, VIDEO_HZ as i32),
            // Platzhalter bis `write_header` — s. `set_stream_time_base`.
            stream_time_base: Rational::new(1, VIDEO_HZ as i32),
            audio,
            last_send_us: 0,
            last_mux_us: 0,
            enc_latency: EncodeLatency::default(),
            vollbilder_angefordert: Default::default(),
        })
    }

    /// FFmpegs D3D12-Device — für `OpenSharedHandle` (Capture-Bridge) +
    /// `Nv12Converter::new`.
    pub fn device(&self) -> ID3D12Device {
        self.device.clone()
    }

    /// `avcodec_send_frame`-Dauer des letzten `send_frame` in µs.
    pub fn last_send_us(&self) -> u64 {
        self.last_send_us
    }

    /// Encode-Latenz seit dem letzten Aufruf: (Summe, Maximum, Anzahl) in us.
    /// Holt und LEERT die Zaehler — der Pacing-Loop reicht sie je Tick an den
    /// `TickMonitor` weiter.
    pub fn take_encode_latency(&mut self) -> (u64, u64, u64) {
        self.enc_latency.take()
    }

    /// Queue-Einreih-Dauer des letzten `send_frame` in µs.
    pub fn last_mux_us(&self) -> u64 {
        self.last_mux_us
    }

    /// Zieht einen frischen NV12-Pool-Frame. Der Caller (Pacing-Loop) lässt den
    /// Converter dessen `resource()` beschreiben und übergibt ihn dann an
    /// `send_frame`.
    pub fn acquire_frame(&self) -> Result<OwnedD3d12Frame> {
        let frame = unsafe { av_frame_alloc() };
        if frame.is_null() {
            return Err(anyhow!("av_frame_alloc returned NULL"));
        }
        let ret = unsafe { av_hwframe_get_buffer(self.frames_ref, frame, 0) };
        if ret < 0 {
            let mut f = frame;
            unsafe { av_frame_free(&mut f) };
            return Err(anyhow!("av_hwframe_get_buffer failed: {ret}"));
        }
        Ok(OwnedD3d12Frame { frame })
    }

    /// Schickt einen (vom Converter beschriebenen) Pool-Frame in den Encoder.
    /// `pts` ist die aus der Aufnahmezeit abgeleitete PTS in Encoder-Zeitbasis
    /// (1/90000 — s. `crate::zeitbasis`).
    pub fn send_frame(&mut self, frame: &mut OwnedD3d12Frame, pts: i64) -> Result<()> {
        unsafe { (*frame.frame).pts = pts };
        // Vollbild auf Anforderung eines Zuschauers (s. `crate::keyframe`).
        //
        // **Vor dem Stempel**, nicht danach — dieselbe Begruendung wie im
        // Zwilling `encoder_hw.rs::send_avframe`: die gedrosselte Meldung
        // schreibt auf stderr, und im Messfenster truege `last_send_us`
        // ausgerechnet auf den interessanten Bildern die Schreibzeit mit.
        let angefordert = self.vollbilder_angefordert.naechstes_bild(pts);
        unsafe {
            // **Pro Bild ZURUECKSETZEN**, deshalb `if/else` und nicht `if`:
            // die Frames kommen aus einem Pool. Bliebe `I` kleben, waere jedes
            // folgende Bild ein Vollbild und die Bildqualitaet braeche bei
            // fester Bitrate zusammen.
            (*frame.frame).pict_type = if angefordert {
                AVPictureType::AV_PICTURE_TYPE_I
            } else {
                AVPictureType::AV_PICTURE_TYPE_NONE
            };
        }
        // VOR dem Einschieben stempeln (s. `latency.rs`).
        let t_send = std::time::Instant::now();
        let ret = unsafe { avcodec_send_frame(self.encoder.as_mut_ptr(), frame.frame) };
        if ret < 0 {
            return Err(anyhow!("avcodec_send_frame failed: {ret}"));
        }
        self.last_send_us = t_send.elapsed().as_micros() as u64;
        self.enc_latency.submitted(pts, t_send);
        self.drain_and_mux()
    }

    /// Schickt einen WASAPI-Audio-Chunk in den Opus-Encoder. Vor der
    /// Mux-Aktivierung (erstes Video-Keyframe) wird Audio verworfen.
    pub fn send_audio(&mut self, captured: &CapturedAudio) -> Result<()> {
        if let (Some(mux), Some(audio)) = (self.mux.as_ref(), self.audio.as_mut()) {
            for packet in audio.send(captured)? {
                mux.send(packet)?;
            }
        }
        Ok(())
    }

    /// Verankert den Audio-PTS am Video-PTS-Ursprung (A/V-Sync). Vor dem
    /// ersten `send_audio` aufrufen — sonst startet der Audio-PTS bei 0 und
    /// die Spuren driften (Audio-Backlog vor `started` + `activate`-Delay).
    pub fn set_audio_origin(&mut self, origin: std::time::Instant, origin_qpc: Option<i64>) {
        if let Some(audio) = self.audio.as_mut() {
            audio.set_stream_origin(origin, origin_qpc);
        }
    }

    /// Encodete Video-Packets ziehen, beim ersten den Muxer aktivieren, dann
    /// alle in die MuxWriter-Queue schieben.
    fn drain_and_mux(&mut self) -> Result<()> {
        let mut mux_us: u64 = 0;
        loop {
            let mut packet = Packet::empty();
            // EAGAIN/EOF = nichts (mehr) da → Drain fertig; ECHTER Encoder-Fehler
            // wird propagiert statt verschluckt (#8).
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(e.into()),
            }
            // Zuordnen VOR `rescale_ts` — danach steht der pts in der
            // Muxer-Zeitbasis und passt nicht mehr zum vermerkten.
            self.enc_latency.packet(packet.pts());
            let t_mux = std::time::Instant::now();
            if self.mux.is_none() {
                self.activate(&packet)?;
            }
            packet.set_stream(self.video_stream_idx);
            packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
            if let Some(mux) = self.mux.as_ref() {
                mux.send(packet)?;
            }
            mux_us += t_mux.elapsed().as_micros() as u64;
        }
        self.last_mux_us = mux_us;
        Ok(())
    }

    /// Erst-Packet-Aktivierung: SPS/PPS aus dem Keyframe ziehen, als
    /// `extradata` an die AVCodecContext hängen, Header schreiben, MuxWriter
    /// starten. Danach ist `self.mux` `Some` und `pending_output` `None`.
    fn activate(&mut self, first_packet: &Packet) -> Result<()> {
        let data = first_packet
            .data()
            .ok_or_else(|| anyhow!("first d3d12va packet has no data"))?;
        let extradata = param_set_extradata(self.codec, data).ok_or_else(|| {
            anyhow!("no SPS/PPS in first d3d12va packet — cannot build avcC for FLV")
        })?;
        let size = extradata.len();
        // `extradata` MUSS mit FFmpegs Allocator allokiert sein —
        // `avcodec_free_context` gibt es mit `av_free` frei. Ein Rust-`Vec`-
        // Pointer hier => Heap-Corruption beim Context-Drop (fremder Allocator,
        // `0xc0000374`). `av_mallocz` nullt den Puffer → das geforderte
        // `AV_INPUT_BUFFER_PADDING_SIZE`-Padding ist gleich mit-genullt.
        unsafe {
            let ctx = self.encoder.as_mut_ptr();
            let buf = av_mallocz(size + EXTRADATA_PADDING) as *mut u8;
            if buf.is_null() {
                return Err(anyhow!("av_mallocz(extradata) returned NULL"));
            }
            std::ptr::copy_nonoverlapping(extradata.as_ptr(), buf, size);
            (*ctx).extradata = buf;
            (*ctx).extradata_size = size as i32;
        }

        let mut output = self
            .pending_output
            .take()
            .ok_or_else(|| anyhow!("activate called twice"))?;
        {
            let mut video = output
                .stream_mut(self.video_stream_idx)
                .ok_or_else(|| anyhow!("video stream missing"))?;
            video.set_parameters(&self.encoder);
        }
        output.write_header().context("write_header")?;

        self.stream_time_base = output
            .stream(self.video_stream_idx)
            .ok_or_else(|| anyhow!("video stream missing"))?
            .time_base();
        if let Some(audio) = self.audio.as_mut() {
            let audio_tb = output
                .stream(audio.stream_idx)
                .ok_or_else(|| anyhow!("audio stream missing"))?
                .time_base();
            audio.set_stream_time_base(audio_tb);
        }

        self.mux = Some(MuxWriter::start(output).context("start mux-writer")?);
        Ok(())
    }

    /// Finalisiert den Stream: EOF an Video (+Audio), Rest in die Queue, dann
    /// `MuxWriter::finish`.
    pub fn finish(&mut self) -> Result<()> {
        self.encoder.send_eof().context("video send_eof")?;
        self.drain_and_mux()?;
        match self.mux.as_mut() {
            Some(mux) => {
                if let Some(audio) = self.audio.as_mut() {
                    for packet in audio.flush()? {
                        mux.send(packet)?;
                    }
                }
                mux.finish()
            }
            None => Ok(()),
        }
    }
}
