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
use ffmpeg::{Dictionary, Packet, Rational, codec, ffi::*, format};
use std::ffi::c_void;
use windows::Win32::Graphics::Direct3D12::{ID3D12Device, ID3D12Resource};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIFactory1};
use windows::core::Interface;

use super::audio::AudioPipeline;
use super::encoder::{AudioStreamConfig, VideoCodec};
use super::extradata::param_set_extradata;
use super::latency::EncodeLatency;
use super::mux_writer::MuxWriter;
use super::output::{apply_encoder_opts_override, open_output, warn_unknown_opts};
use crate::audio::CapturedAudio;

/// FFmpeg verlangt `AV_INPUT_BUFFER_PADDING_SIZE` Null-Bytes hinter extradata.
const EXTRADATA_PADDING: usize = 64;

/// `D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS` — die Pool-NV12-Resources
/// müssen UAV-fähig sein, damit der Compute-Shader sie beschreiben kann.
const D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS: i32 = 0x4;

// ── Hand-Spiegel der `AVD3D12VA*`-Structs (libavutil/hwcontext_d3d12va.h,
//    FFmpeg 8.1). ffmpeg-sys-next bindet die D3D12VA-Header nicht — gleiches
//    Muster wie `encode/hwctx.rs` für D3D11VA. ─────────────────────────────

/// `AVD3D12VADeviceContext` — `AVHWDeviceContext.hwctx`. Wir lesen `device`.
#[repr(C)]
struct AVD3D12VADeviceContext {
    device: *mut c_void,       // ID3D12Device*
    video_device: *mut c_void,
    lock: *mut c_void,
    unlock: *mut c_void,
    lock_ctx: *mut c_void,
    resource_flags: i32,
    heap_flags: i32,
}

/// `AVD3D12VAFramesContext` — `AVHWFramesContext.hwctx`. Wir setzen
/// `resource_flags`.
#[repr(C)]
struct AVD3D12VAFramesContext {
    format: i32,
    resource_flags: i32,
    heap_flags: i32,
    texture_array: *mut c_void,
    flags: i32,
}

/// `AVD3D12VASyncContext` — Teil von `AVD3D12VAFrame`.
#[repr(C)]
struct AVD3D12VASyncContext {
    fence: *mut c_void,
    event: *mut c_void,
    fence_value: u64,
}

/// `AVD3D12VAFrame` — `AVFrame.data[0]` zeigt hierauf. Wir lesen `texture`.
#[repr(C)]
struct AVD3D12VAFrame {
    texture: *mut c_void, // ID3D12Resource*
    subresource_index: i32,
    sync_ctx: AVD3D12VASyncContext,
    flags: i32,
}

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
    /// Erst nach der Aktivierung gültig (vorher Platzhalter 1/fps).
    stream_time_base: Rational,
    audio: Option<AudioPipeline>,
    /// Diagnose-Timings (µs) für den `TickMonitor`.
    last_send_us: u64,
    last_mux_us: u64,
    /// Einschieben -> Paket, s. `latency.rs`. Das ist der Posten, den
    /// `async_depth` veraendert (Default 2 bei den d3d12va-Encodern);
    /// `last_send_us` sieht ihn NICHT.
    enc_latency: EncodeLatency,
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
        encoder.set_time_base(Rational::new(1, cfg.fps as i32));
        encoder.set_frame_rate(Some(Rational::new(cfg.fps as i32, 1)));
        encoder.set_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_max_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_gop(cfg.fps.saturating_mul(2));
        if global_header {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        // pix_fmt + hw_frames_ctx + B-Frames via FFI — MUSS vor `open` passieren.
        unsafe {
            let ctx = encoder.as_mut_ptr();
            (*ctx).pix_fmt = AVPixelFormat::AV_PIX_FMT_D3D12;
            (*ctx).max_b_frames = 0;
            let new_ref = av_buffer_ref(frames_ref);
            if new_ref.is_null() {
                return Err(anyhow!("av_buffer_ref(frames_ref) returned NULL"));
            }
            (*ctx).hw_frames_ctx = new_ref;
        }

        let mut opts = d3d12va_opts();
        // Hier ist der Abbruch der ganze Zweck: `h264_d3d12va` NIMMT die
        // Intra-Refresh-Option an und tut nichts damit (Herleitung in
        // `auffrischung::optionen_fuer`). Ohne diese Zeile liefe genau der
        // Fall, gegen den die Betriebsart antritt — und niemand sähe es.
        super::auffrischung::anwenden(&mut opts, codec_name, cfg.fps)?;
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
            encoder_time_base: Rational::new(1, cfg.fps as i32),
            stream_time_base: Rational::new(1, cfg.fps as i32),
            audio,
            last_send_us: 0,
            last_mux_us: 0,
            enc_latency: EncodeLatency::default(),
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
    /// `pts` ist die wall-clock-abgeleitete PTS in Encoder-Timebase (1/fps).
    pub fn send_frame(&mut self, frame: &mut OwnedD3d12Frame, pts: i64) -> Result<()> {
        unsafe { (*frame.frame).pts = pts };
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

/// Vendor-Optionen für die d3d12va-Encoder. CBR-Rate-Control für Streaming.
fn d3d12va_opts() -> Dictionary<'static> {
    let mut opts = Dictionary::new();
    opts.set("rc_mode", "CBR");
    // `async_depth` ist der Vorlauf der Encoder-Warteschlange. Der Default 2
    // haelt ein Bild zurueck; auf 1 gezogen faellt es sofort heraus.
    //
    // Am 2026-07-30 auf einer Radeon 780M gemessen (1440p-Capture -> 1080p60,
    // H.264, `PULSE_ENC_LATENCY_LOG=1`) — Einschieben bis Paket:
    //
    //     async_depth=1   7,1 ms   (Maximum 11,2)
    //     async_depth=2  19,2 ms   (Maximum 25,4)   <- bisheriger Default
    //     async_depth=4  52,4 ms   (Maximum 59,2)
    //
    // Also rund ein Bildabstand je Stufe (16,7 ms bei 60 fps) — dieselbe
    // Arithmetik, die der Linux-Zweig bei VAAPI gemessen hat. Der Wert 1 kostet
    // dabei NICHTS an Bildqualitaet, und das ist nicht geschaetzt: die
    // Bitstroeme fuer 1, 2 und 4 sind byte-identisch (SHA-256 ueber 720 Bilder,
    // H.264 wie AV1). `async_depth` verschiebt nur, wann ein fertiges Paket
    // herausgegeben wird, nicht wie encodiert wird.
    opts.set("async_depth", "1");
    apply_encoder_opts_override(&mut opts);
    opts
}

/// D3D12-hwdevice (auf der AMD-GPU) + NV12-hwframes-Pool. Der Pool ist
/// UAV-fähig (`ALLOW_UNORDERED_ACCESS`), damit der Compute-Shader die
/// Pool-Frames direkt beschreiben kann. Gibt die frames-AVBufferRef + FFmpegs
/// `ID3D12Device` zurück.
fn create_d3d12_pool(
    adapter: u32,
    width: u32,
    height: u32,
) -> Result<(*mut AVBufferRef, ID3D12Device)> {
    let dev_str = std::ffi::CString::new(adapter.to_string()).unwrap();
    let mut device_ref: *mut AVBufferRef = std::ptr::null_mut();
    let ret = unsafe {
        av_hwdevice_ctx_create(
            &mut device_ref,
            AVHWDeviceType::AV_HWDEVICE_TYPE_D3D12VA,
            dev_str.as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ret < 0 {
        return Err(anyhow!(
            "av_hwdevice_ctx_create(D3D12VA, adapter={adapter}) failed: {ret}"
        ));
    }

    // FFmpegs ID3D12Device aus dem hwctx ziehen (Clone = AddRef).
    let device = unsafe {
        let dev_ctx = (*device_ref).data as *mut AVHWDeviceContext;
        let d3d12_hw = (*dev_ctx).hwctx as *mut AVD3D12VADeviceContext;
        let ptr = (*d3d12_hw).device;
        ID3D12Device::from_raw_borrowed(&ptr)
            .map(|d| d.clone())
            .ok_or_else(|| anyhow!("AVD3D12VADeviceContext.device ist NULL"))
    };
    let device = match device {
        Ok(d) => d,
        Err(e) => {
            let mut r = device_ref;
            unsafe { av_buffer_unref(&mut r) };
            return Err(e);
        }
    };

    let frames_ref = unsafe { av_hwframe_ctx_alloc(device_ref) };
    if frames_ref.is_null() {
        unsafe { av_buffer_unref(&mut device_ref) };
        return Err(anyhow!("av_hwframe_ctx_alloc returned NULL"));
    }
    unsafe {
        let hdr = (*frames_ref).data as *mut AVHWFramesContext;
        (*hdr).format = AVPixelFormat::AV_PIX_FMT_D3D12;
        (*hdr).sw_format = AVPixelFormat::AV_PIX_FMT_NV12;
        (*hdr).width = width as i32;
        (*hdr).height = height as i32;
        (*hdr).initial_pool_size = 8;
        let d3d12_frames = (*hdr).hwctx as *mut AVD3D12VAFramesContext;
        (*d3d12_frames).resource_flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
    }
    let ret = unsafe { av_hwframe_ctx_init(frames_ref) };
    if ret < 0 {
        let mut fr = frames_ref;
        let mut dr = device_ref;
        unsafe {
            av_buffer_unref(&mut fr);
            av_buffer_unref(&mut dr);
        }
        return Err(anyhow!("av_hwframe_ctx_init failed: {ret}"));
    }
    // device_ref hält der frames-Ctx jetzt intern; lokale Ref freigeben.
    unsafe { av_buffer_unref(&mut device_ref) };
    Ok((frames_ref, device))
}

/// DXGI-Index der ersten AMD-GPU (Vendor `0x1002`).
fn amd_adapter_index() -> Result<u32> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.context("CreateDXGIFactory1")?;
    let mut idx = 0u32;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(idx) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(anyhow!("EnumAdapters1: {e}")),
        };
        let desc = unsafe { adapter.GetDesc1() }.context("GetDesc1")?;
        if desc.VendorId == 0x1002 {
            return Ok(idx);
        }
        idx += 1;
    }
    Err(anyhow!(
        "keine AMD-GPU (DXGI-Vendor 0x1002) für den D3D12VA-Encoder gefunden"
    ))
}
