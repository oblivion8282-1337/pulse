//! scRGB (16-Bit-Fließkomma) → PQ/BT.2020 in P010 — **selbst gerechnet, weil
//! der Video-Prozessor es nicht kann.**
//!
//! ## Warum es dieses Modul gibt
//!
//! Der Regelweg für Skalieren und Farbwandlung ist [`super::d3d11_scale`], also
//! `ID3D11VideoProcessor`. Für HDR fällt er aus, und das ist gemessen, nicht
//! vermutet: `CheckVideoProcessorFormatConversion` verneint am 2026-08-06 auf
//! einer Radeon 780M (Treiber 32.0.31035.1003) **jede** Wandlung mit
//! 16-Bit-Fließkomma am Eingang — auch die harmlose nach BT.709/SDR — und
//! **jede** Wandlung mit PQ am Ausgang, auch aus 10-Bit-Ganzzahl. Von 32
//! geprüften Kombinationen sind zwei möglich, beide ohne PQ. Die Tabelle steht
//! in `farbraum.rs::tests::wandlungen_dieses_treibers`; sie lässt sich auf
//! jeder Maschine nachfahren.
//!
//! Ein Video-Prozessor, der weder das Eingangsformat noch die Zielkurve
//! annimmt, ist kein Werkzeug mehr. Also rechnen wir selbst — wie GSR es auf
//! Linux tut (`color_conversion.c`), aus demselben Grund.
//!
//! ## Warum P010 und nicht etwas Einfacheres
//!
//! Weil `av1_amf` auch `RGBAF16` und `X2BGR10` annähme — aber FFmpegs
//! `amfenc_av1.c` reicht die **Transferkurve** nur bei `NV12` oder `P010` an
//! AMF weiter (die Bedingung in Zeile 274 fragt genau das ab). Bei jedem
//! anderen Eingangsformat stünde im AV1-Sequenzkopf „Transferkurve
//! unbekannt" — der Zuschauer bekäme PQ-Werte ohne den Hinweis, dass es PQ
//! ist, und zeigte sie als SDR. Der Umweg über P010 ist also nicht
//! Bequemlichkeit, sondern die Bedingung für eine vollständige
//! Signalisierung.
//!
//! ## Was hier steht und was nebenan
//!
//! Hier: der **Ziel-Pool** und die Stufe, die die Taktschleife anfassen kann.
//! Der Farbweg selbst — Shader, Ansichten, Zeichendurchgang — liegt seit dem
//! 2026-08-07 in [`super::hdr_zeichner`], weil er einen zweiten Aufrufer
//! bekommen hat, der **keinen** Pool besitzt (Wandlung schon im
//! Aufnahme-Rückruf, `crate::capture::aufnahmeziel`). Begründung dort.

use anyhow::Result;

use super::hdr_zeichner::HdrZeichner;
use super::hwctx::OwnedHwFrame;
use windows::Win32::Graphics::Direct3D11::{D3D11_BIND_RENDER_TARGET, ID3D11Device, ID3D11DeviceContext};

/// Wandelt Aufnahme-Bilder (scRGB, fp16) in Encoder-Bilder (P010, PQ/BT.2020).
///
/// Besitzt einen eigenen P010-Zielpool, genau wie
/// [`super::d3d11_scale::D3D11Scaler`], und teilt sich dessen Sperre mit dem
/// Aufnahme-Pool — alle Zugriffe auf den unmittelbaren `ID3D11DeviceContext`
/// müssen auf EINER Sperre serialisieren.
pub struct HdrWandler {
    zeichner: HdrZeichner,
    dst: super::hwctx::HwContext,
}

impl HdrWandler {
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        dst_w: u32,
        dst_h: u32,
        pool_size: u32,
        shared_lock: *mut windows::Win32::System::Threading::CRITICAL_SECTION,
    ) -> Result<Self> {
        // Ziel-Pool: P010 mit RENDER_TARGET, damit die Ebenen als Ziel taugen.
        let dst = super::hwctx::HwContext::new(
            device.clone(),
            context.clone(),
            dst_w,
            dst_h,
            super::hwctx::HwPoolConfig {
                pool_size,
                extra_bind_flags: D3D11_BIND_RENDER_TARGET.0 as u32,
                shared_lock: Some(shared_lock),
                sw_format: ffmpeg_next::ffi::AVPixelFormat::AV_PIX_FMT_P010LE,
                shared: false,
            },
        )?;
        let zeichner = HdrZeichner::new(device, context, dst_w, dst_h, shared_lock)?;

        eprintln!(
            "[hdr-wandler] eigener Farbweg aktiv: scRGB (fp16) → PQ/BT.2020 → P010, \
             {dst_w}x{dst_h} (der Video-Prozessor dieses Treibers kann es nicht, \
             s. encode/hdr_wandler.rs)"
        );

        Ok(Self { zeichner, dst })
    }

    /// Frames-Referenz des Zielpools — der Encoder hängt sie an seinen Kontext.
    pub fn dst_frames_ref(&self) -> *mut ffmpeg_next::ffi::AVBufferRef {
        self.dst.frames_ref()
    }

    /// Ein Aufnahmebild wandeln. Gleiche Form wie
    /// [`D3D11Scaler::scale_mit`](super::d3d11_scale::D3D11Scaler::scale_mit),
    /// damit die Pipeline beide gleich behandeln kann.
    pub fn wandeln(&mut self, src: &OwnedHwFrame) -> Result<OwnedHwFrame> {
        let ziel = self.dst.acquire_frame()?;
        self.zeichner
            .wandeln_in(src.texture_raw(), src.subresource_index(), &ziel)?;
        Ok(ziel)
    }
}
