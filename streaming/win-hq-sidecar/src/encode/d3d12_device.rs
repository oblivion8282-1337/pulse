//! D3D12-hwdevice + NV12-hwframes-Pool für den nativen D3D12VA-Encoder (AMD,
//! `encoder_d3d12.rs`) — Adapter-Auswahl, Pool-Allokation, Encoder-Optionen.
//!
//! Herausgezogen aus `encoder_d3d12.rs`, das mit den Begründungen über die
//! harte Größen-Grenze von 500 Zeilen gewachsen war (`PLAN.md` §12.1): dies
//! ist die Geräte-/Pool-Plumbing-Schicht, `encoder_d3d12.rs` bleibt die
//! eigentliche Encoder-API (`FfmpegD3d12Encoder`), die sie konsumiert.
//!
//! Enthält auch den Hand-Spiegel der `AVD3D12VA*`-Structs
//! (libavutil/hwcontext_d3d12va.h, FFmpeg 8.1) — ffmpeg-sys-next bindet die
//! D3D12VA-Header nicht, gleiches Muster wie `encode/hwctx.rs` für D3D11VA.

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, ffi::*};
use std::ffi::c_void;
use windows::Win32::Graphics::Direct3D12::ID3D12Device;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIFactory1};
use windows::core::Interface;

use super::output::apply_encoder_opts_override;

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
/// `pub(super)`: `OwnedD3d12Frame::resource()` in `encoder_d3d12.rs` liest das
/// Feld direkt aus dem `AVFrame`-Rohpointer.
#[repr(C)]
pub(super) struct AVD3D12VAFrame {
    pub(super) texture: *mut c_void, // ID3D12Resource*
    subresource_index: i32,
    sync_ctx: AVD3D12VASyncContext,
    flags: i32,
}

/// Vendor-Optionen für die d3d12va-Encoder. CBR-Rate-Control für Streaming.
pub(super) fn d3d12va_opts() -> Dictionary<'static> {
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
pub(super) fn create_d3d12_pool(
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
pub(super) fn amd_adapter_index() -> Result<u32> {
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
