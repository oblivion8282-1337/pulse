//! Die Rueckproben: belegen, dass der geschriebene Inhalt wirklich in der
//! geteilten D3D11-Textur steht.
//!
//! **Ohne sie ist ein schwarzes Ergebnis der wgpu-Seite nicht deutbar.** Kommt
//! dort nichts an, kann das genauso gut heissen, dass nie etwas drin stand.
//! Erst wenn D3D11 den geschriebenen Inhalt wiederfindet, ist ein leeres
//! wgpu-Ergebnis ein wgpu-Befund.

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;

use crate::bildformat::{chroma_codes, luma_code, Bildformat, BREITE, HOEHE};
use crate::d3d11::D3d11Quelle;

/// Eine EINSCHICHTIGE Ablage-Textur anlegen und den Inhalt genau einer Schicht
/// hineinkopieren — die gemeinsame Vorarbeit beider Rueckproben.
///
/// **Warum einschichtig, obwohl die Quelle ein Stapel sein kann.** Ein
/// Video-Format-Stapel laesst sich als CPU-Ablage gar nicht anlegen
/// (`E_INVALIDARG`, 2026-08-06 gemessen): der Stapel braucht das
/// Decoder-Bindungsflag, und eine Ablage-Textur darf ueberhaupt keine
/// Bindungsflags tragen. Beides zusammen geht nicht. Deshalb einschichtig und
/// `CopySubresourceRegion` je Schicht statt `CopyResource` am Stueck — genau
/// der Weg, den auch der Sidecar fuer seine Poolen nimmt.
fn ablage_mit_inhalt(q: &D3d11Quelle, schicht: u32) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: BREITE,
        Height: HOEHE,
        MipLevels: 1,
        ArraySize: 1,
        Format: q.format.dxgi(),
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut ablage: Option<ID3D11Texture2D> = None;
    unsafe { q.device.CreateTexture2D(&desc, None, Some(&mut ablage)) }
        .map_err(|e| format!("Ablage: {e}"))?;
    let ablage = ablage.ok_or("Ablage fehlt")?;
    let mutex: Option<IDXGIKeyedMutex> =
        if q.mit_mutex { Some(q.textur.cast().map_err(|e| format!("Mutex: {e}"))?) } else { None };
    if let Some(m) = &mutex {
        unsafe { m.AcquireSync(0, u32::MAX) }.map_err(|e| format!("AcquireSync: {e}"))?;
    }
    unsafe {
        q.context
            .CopySubresourceRegion(&ablage, 0, 0, 0, 0, &q.textur, schicht, None)
    };
    if let Some(m) = &mutex {
        unsafe { m.ReleaseSync(0) }.map_err(|e| format!("ReleaseSync: {e}"))?;
    }
    Ok(ablage)
}

/// Einen Abtastwert aus einer abgebildeten Ebene lesen — ein oder zwei Byte,
/// je nach Format.
///
/// # Safety
/// `basis` muss auf die abgebildete Teilressource zeigen und der berechnete
/// Versatz innerhalb davon liegen.
unsafe fn wort(f: Bildformat, basis: *const u8, versatz: usize) -> u32 {
    match f.bytes() {
        1 => u32::from(unsafe { *basis.add(versatz) }),
        _ => {
            let b = unsafe { std::slice::from_raw_parts(basis.add(versatz), 2) };
            u16::from_le_bytes([b[0], b[1]]) as u32
        }
    }
}

/// Liest die Luma-Ebene EINER Schicht der geteilten Textur ueber D3D11 zurueck.
///
/// Zaehlt, wie viele Werte von `erwartet` (als gespeichertes Wort) abweichen.
/// Getrennt von der vollen Rueckprobe, weil Stufe 5 nur die Luma-Ebene
/// beschreibt.
pub fn luma_lesen(
    q: &D3d11Quelle,
    schicht: u32,
    erwartet: &dyn Fn(u32, u32) -> u32,
) -> Result<usize, String> {
    let ablage = ablage_mit_inhalt(q, schicht)?;
    let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { q.context.Map(&ablage, 0, D3D11_MAP_READ, 0, Some(&mut abbild)) }
        .map_err(|e| format!("Map: {e}"))?;
    let pitch = abbild.RowPitch as usize;
    let basis = abbild.pData as *const u8;
    let b = q.format.bytes();
    let mut abweichend = 0usize;
    for y in 0..HOEHE {
        for x in 0..BREITE {
            let ist = unsafe { wort(q.format, basis, y as usize * pitch + x as usize * b) };
            if ist != erwartet(x, y) {
                abweichend += 1;
            }
        }
    }
    unsafe { q.context.Unmap(&ablage, 0) };
    Ok(abweichend)
}

/// Stufe 2b: liest die geteilte Textur ueber D3D11 selbst zurueck.
///
/// Prueft **jede** Schicht, nicht nur die spaeter abgetastete: liefe schon
/// D3D11 die Schichten durcheinander, waere ein wgpu-Befund darueber wertlos.
pub fn rueckprobe(q: &D3d11Quelle) -> Result<usize, String> {
    let (u_soll, v_soll) = chroma_codes(q.format);
    let b = q.format.bytes();
    let mut abweichend = 0usize;
    for schicht in 0..q.schichten {
        let ablage = ablage_mit_inhalt(q, schicht)?;
        let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { q.context.Map(&ablage, 0, D3D11_MAP_READ, 0, Some(&mut abbild)) }
            .map_err(|e| format!("Map (Schicht {schicht}): {e}"))?;
        let pitch = abbild.RowPitch as usize;
        let basis = abbild.pData as *const u8;
        for y in 0..HOEHE as usize {
            for x in 0..BREITE as usize {
                let ist = unsafe { wort(q.format, basis, y * pitch + x * b) };
                if ist
                    != q.format.gespeichert(luma_code(q.format, x as u32, y as u32, schicht)) as u32
                {
                    abweichend += 1;
                }
            }
        }
        // Die Chroma-Ebene beginnt genau `pitch * hoehe` nach dem Anfang —
        // bei NV12 wie bei P010; nur die Wortbreite unterscheidet sich.
        let uv = pitch * HOEHE as usize;
        for i in 0..(BREITE * HOEHE / 4) as usize {
            let zeile = i / (BREITE as usize / 2);
            let spalte = i % (BREITE as usize / 2);
            let u = unsafe { wort(q.format, basis, uv + zeile * pitch + spalte * 2 * b) };
            let v = unsafe { wort(q.format, basis, uv + zeile * pitch + spalte * 2 * b + b) };
            if u != q.format.gespeichert(u_soll) as u32 || v != q.format.gespeichert(v_soll) as u32 {
                abweichend += 1;
            }
        }
        unsafe { q.context.Unmap(&ablage, schicht) };
    }
    Ok(abweichend)
}

