//! Die D3D11-Ansichten des HDR-Farbwegs — **einmal angelegt, danach
//! wiederverwendet.**
//!
//! Herausgezogen aus [`super::hdr_zeichner`], weil es ein eigener Gegenstand
//! ist: dort steht, was gerechnet wird, hier, wie die Grafikkarte die beteiligten
//! Texturen zu sehen bekommt. Beides in einer Datei hätte sie über die harte
//! Größen-Grenze getragen (`PLAN.md` §12.1).
//!
//! **Warum ein Textur-Zeiger als Schlüssel tragfähig ist:** `CreateShaderResourceView`
//! und `CreateRenderTargetView` halten je eine eigene Referenz auf die
//! Ressource. Solange eine Ansicht im Zwischenspeicher liegt, kann ihre Textur
//! also nicht freigegeben werden — und damit kann keine andere Textur dieselbe
//! Adresse bekommen. Ohne diese Referenz wäre der Schlüssel eine Falle: eine
//! frische Textur an alter Adresse lieferte wortlos das alte Bild.
//!
//! Die Menge bleibt klein: Pool wie WGC-Bildpuffer sind wenige Texturen, die
//! reihum benutzt werden. Nach dem ersten Durchlauf entsteht im laufenden
//! Betrieb keine Ansicht mehr.

use anyhow::{Context, Result, anyhow};
use std::collections::HashMap;
use windows::Win32::Graphics::Direct3D::D3D_SRV_DIMENSION_TEXTURE2DARRAY;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_R16_UNORM, DXGI_FORMAT_R16G16_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT,
};
use windows::core::Interface;

/// Beide Zwischenspeicher, gekeyt auf (Textur-Zeiger, Array-Scheibe).
#[derive(Default)]
pub struct Ansichten {
    quellen: HashMap<(usize, u32), ID3D11ShaderResourceView>,
    ziele: HashMap<(usize, u32), (ID3D11RenderTargetView, ID3D11RenderTargetView)>,
}

impl Ansichten {
    /// Lese-Ansicht auf eine scRGB-Textur (Aufnahme-Pool **oder** WGC-Bild).
    pub fn quelle(
        &mut self,
        device: &ID3D11Device,
        tex: *mut std::ffi::c_void,
        scheibe: u32,
    ) -> Result<ID3D11ShaderResourceView> {
        let key = (tex as usize, scheibe);
        if let Some(v) = self.quellen.get(&key) {
            return Ok(v.clone());
        }
        let res = unsafe { ID3D11Resource::from_raw_borrowed(&tex) }
            .ok_or_else(|| anyhow!("Quelltextur NULL"))?;
        // **Das Format aus der Textur lesen, nicht annehmen.** Eine Ansicht,
        // deren Format nicht zur Ressource passt, wird mit `E_INVALIDARG`
        // abgelehnt — einer Fehlermeldung, die nicht sagt, welcher der acht
        // Werte im Deskriptor gemeint ist. Am 2026-08-06 hat genau das eine
        // Stunde gekostet, und der Fehler lag am Ende gar nicht hier, sondern
        // an den Bind-Flags des Pools (s. `capture::aufnahmeziel`).
        let tex2d = res
            .cast::<ID3D11Texture2D>()
            .map_err(|e| anyhow!("Quelltextur ist keine Texture2D: {e}"))?;
        let mut tex_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex2d.GetDesc(&mut tex_desc) };
        if tex_desc.Format != DXGI_FORMAT_R16G16B16A16_FLOAT {
            return Err(anyhow!(
                "Aufnahme-Textur ist {:?}, erwartet R16G16B16A16_FLOAT — die Aufnahme läuft nicht \
                 in scRGB, und ohne die wäre HDR nur ein Etikett (s. capture::bildformat)",
                tex_desc.Format
            ));
        }
        let desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
            Format: tex_desc.Format,
            ViewDimension: D3D_SRV_DIMENSION_TEXTURE2DARRAY,
            Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
                Texture2DArray: D3D11_TEX2D_ARRAY_SRV {
                    MostDetailedMip: 0,
                    MipLevels: 1,
                    FirstArraySlice: scheibe,
                    ArraySize: 1,
                },
            },
        };
        let mut view = None;
        unsafe { device.CreateShaderResourceView(res, Some(&desc), Some(&mut view)) }.with_context(
            || {
                format!(
                    "CreateShaderResourceView (scRGB-Quelle, Bindungen 0x{:x})",
                    tex_desc.BindFlags
                )
            },
        )?;
        let view = view.ok_or_else(|| anyhow!("SRV NULL"))?;
        self.quellen.insert(key, view.clone());
        Ok(view)
    }

    /// Zwei Schreib-Ansichten auf DIESELBE P010-Textur: eine auf die Luma-,
    /// eine auf die Chroma-Ebene.
    ///
    /// **Welche Ebene gemeint ist, sagt das Format der Ansicht, nicht ein
    /// Index** — `R16_UNORM` trifft die Luma-Ebene, `R16G16_UNORM` die
    /// verschränkte Chroma-Ebene in halber Höhe und Breite. Das ist der
    /// D3D11-Weg für planare Formate; einen Ebenen-Index wie in D3D12 gibt es
    /// hier nicht.
    pub fn ziel(
        &mut self,
        device: &ID3D11Device,
        tex: *mut std::ffi::c_void,
        scheibe: u32,
    ) -> Result<(ID3D11RenderTargetView, ID3D11RenderTargetView)> {
        let key = (tex as usize, scheibe);
        if let Some(v) = self.ziele.get(&key) {
            return Ok(v.clone());
        }
        let res = unsafe { ID3D11Resource::from_raw_borrowed(&tex) }
            .ok_or_else(|| anyhow!("Zieltextur NULL"))?;
        // Die beiden Ansichten einzeln benennen statt sie über eine Sammlung zu
        // führen: welche Ebene gemeint ist, steht dann am Namen und nicht in
        // der Reihenfolge, in der sie wieder herausgeholt wird.
        let ansicht = |format| -> Result<ID3D11RenderTargetView> {
            let desc = D3D11_RENDER_TARGET_VIEW_DESC {
                Format: format,
                ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2DARRAY,
                Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
                    Texture2DArray: D3D11_TEX2D_ARRAY_RTV {
                        MipSlice: 0,
                        FirstArraySlice: scheibe,
                        ArraySize: 1,
                    },
                },
            };
            let mut view = None;
            unsafe { device.CreateRenderTargetView(res, Some(&desc), Some(&mut view)) }
                .with_context(|| format!("CreateRenderTargetView ({format:?}) auf P010"))?;
            view.ok_or_else(|| anyhow!("RTV NULL"))
        };
        let y = ansicht(DXGI_FORMAT_R16_UNORM)?;
        let uv = ansicht(DXGI_FORMAT_R16G16_UNORM)?;
        self.ziele.insert(key, (y.clone(), uv.clone()));
        Ok((y, uv))
    }
}
