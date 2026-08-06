//! Was FFmpeg an einem D3D11-Bild mitgibt — und wie man es liest.
//!
//! Herausgeloest aus [`super::bruecke`], weil es eine eigene Sorte Code ist:
//! hier steht die Spiegelung fremder C-Strukturen, dort die eigene Mechanik.
//! Ein Fehler an dieser Stelle sieht anders aus als einer dort (falscher
//! Versatz statt falscher Ablauf) und ist deshalb leichter zu finden, wenn er
//! nicht dazwischen liegt.

use std::ffi::c_void;

use anyhow::{anyhow, bail, Result};
use ffmpeg_next as ffmpeg;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_FORMAT_P010};

/// `AVD3D11VADeviceContext` aus FFmpeg 8.1 (`libavutil/hwcontext_d3d11va.h`).
///
/// **Die Reihenfolge ist verbindlich und darf nicht gekuerzt werden.** Im
/// Sidecar hat genau hier ein weggelassenes erstes Feld dazu gefuehrt, dass ein
/// Schreibzugriff auf dem falschen Versatz landete. Gebraucht werden hier nur
/// `device`, `device_context` und die drei Sperr-Felder — die davorliegenden
/// muessen trotzdem stehen.
#[repr(C)]
pub(super) struct AVD3D11VADeviceContext {
    pub device: *mut c_void,         // ID3D11Device*
    pub device_context: *mut c_void, // ID3D11DeviceContext*
    video_device: *mut c_void,
    video_context: *mut c_void,
    pub lock: Option<unsafe extern "C" fn(*mut c_void)>,
    pub unlock: Option<unsafe extern "C" fn(*mut c_void)>,
    pub lock_ctx: *mut c_void,
    bind_flags: u32,
    misc_flags: u32,
}



/// Der D3D11-Geraetekontext, an dem das Bild haengt.
pub(super) fn geraetekontext(
    frame: &ffmpeg::util::frame::video::Video,
) -> Result<*mut AVD3D11VADeviceContext> {
    // SAFETY: das Bild lebt und traegt bei `AV_PIX_FMT_D3D11` einen
    // `hw_frames_ctx`; jede Stufe wird vor dem naechsten Zugriff geprueft.
    unsafe {
        let f = frame.as_ptr();
        let frames_ref = (*f).hw_frames_ctx;
        if frames_ref.is_null() {
            bail!("Bild ohne hw_frames_ctx");
        }
        let frames = (*frames_ref).data as *mut ffmpeg::ffi::AVHWFramesContext;
        if frames.is_null() || (*frames).device_ctx.is_null() {
            bail!("hw_frames_ctx ohne Geraet");
        }
        let hwctx = (*(*frames).device_ctx).hwctx as *mut AVD3D11VADeviceContext;
        if hwctx.is_null() {
            bail!("Geraet ohne D3D11-Kontext");
        }
        Ok(hwctx)
    }
}

/// Masse und DXGI-Format der Decoder-Textur.
///
/// **Nicht die Bildmasse.** Der Decoder rundet auf (bei AV1 auf Vielfache von
/// 128), und die Kopie laeuft ueber die volle Teilressource — Ziel und Quelle
/// muessen deshalb genau gleich gross sein.
pub(super) fn quellmasse(frame: &ffmpeg::util::frame::video::Video) -> Result<(u32, u32, i32)> {
    // SAFETY: wie in `kopieren`.
    let desc = unsafe {
        let f = frame.as_ptr();
        let roh = (*f).data[0] as *mut c_void;
        if roh.is_null() {
            bail!("Bild ohne D3D11-Textur");
        }
        let tex = ID3D11Texture2D::from_raw_borrowed(&roh)
            .ok_or_else(|| anyhow!("D3D11-Textur nicht lesbar"))?;
        let mut d = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut d);
        d
    };
    if desc.Format != DXGI_FORMAT_NV12 && desc.Format != DXGI_FORMAT_P010 {
        bail!("Format {:?} ist weder NV12 noch P010", desc.Format);
    }
    Ok((desc.Width, desc.Height, desc.Format.0))
}
