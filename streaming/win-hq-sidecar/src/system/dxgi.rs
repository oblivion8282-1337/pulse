//! DXGI-Adapter-Enumeration.
//!
//! Liefert die GPU-Liste in HIGH_PERFORMANCE-Reihenfolge (IDXGIFactory6, Win10
//! 1803+); fällt sonst auf `IDXGIFactory1::EnumAdapters1` zurück. Vendor-IDs:
//! NVIDIA `0x10DE`, AMD `0x1002`, Intel `0x8086` — Rest „other".
//!
//! Wird von `health` + `gpu_info` gelesen (Stage 2). In Stage 5 (capture)
//! brauchen wir denselben Adapter-Pointer als D3D11Device-Quelle, damit
//! Capture und Encode auf derselben GPU laufen (Optimus-Fix).

use anyhow::{Context, Result};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_DESC1, DXGI_ERROR_NOT_FOUND,
    DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IDXGIAdapter1, IDXGIFactory1, IDXGIFactory6,
};
use windows::core::Interface;

/// Vendor-Slug einer GPU-Vendor-ID. Die EINE Tabelle im Crate — sie stand
/// zwischenzeitlich an vier Stellen (hier, `pipeline_hw`, `encode/hwctx`,
/// `encode/encoder_d3d12`), und eine Vendor-Zuordnung, die auseinanderlaufen
/// kann, ist genau die Art Fehler, die man erst am kaputten Bild bemerkt.
/// `None` = unbekannter Hersteller.
pub fn vendor_slug(vendor_id: u32) -> Option<&'static str> {
    match vendor_id {
        0x10DE => Some("nvidia"),
        0x1002 => Some("amd"),
        0x8086 => Some("intel"),
        _ => None,
    }
}

/// Vendor-Slug der GPU hinter einem **D3D11-Device** — via
/// `IDXGIDevice::GetAdapter`.
///
/// Maßgeblich ist die GPU, auf der WGC sein Device gebaut hat (= die des
/// primären Displays), nicht die aus `list_adapters()`/`select_adapter()`: auf
/// Multi-GPU bevorzugt Letzteres die dGPU, während Capture und Encoder auf der
/// Display-GPU laufen. `None` wenn die Abfrage fehlschlägt oder der Vendor
/// unbekannt ist.
pub fn device_vendor(
    device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
) -> Option<&'static str> {
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    let dxgi: IDXGIDevice = device.cast().ok()?;
    let adapter = unsafe { dxgi.GetAdapter() }.ok()?;
    let desc = unsafe { adapter.GetDesc() }.ok()?;
    vendor_slug(desc.VendorId)
}

/// Knappes Adapter-Profil, JSON-serialisierbar.
#[derive(Debug, Clone)]
pub struct Adapter {
    pub description: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub vram_mb: u64,
}

impl Adapter {
    /// Vendor-Slug für die JSON-Response (`"nvidia"`/`"amd"`/`"intel"`/`"other"`).
    pub fn vendor(&self) -> &'static str {
        vendor_slug(self.vendor_id).unwrap_or("other")
    }

    /// Encoder-Codecs die die GPU in Hardware wirklich unterstützt (FFmpeg-Codec-
    /// Namen). Zur Laufzeit ermittelt — auf NVIDIA per Open-Probe, auf AMD/Intel
    /// per D3D12-Fähigkeitsabfrage, siehe `codec_probe`. Beide Wege sind
    /// selbst-korrigierend und vorwärtskompatibel: AV1 erscheint erst ab Ada
    /// (RTX 40+) / RDNA 3 / Intel Arc, und künftige Architekturen brauchen keine
    /// Tabellenpflege.
    ///
    /// **Hier stand bis zum 2026-08-21 „Echte Open-Probe".** Das galt nur für
    /// NVIDIA; AMD und Intel bekamen eine feste Liste, in der AV1 unbedingt
    /// stand — auf einer Radeon RX 570 also fälschlich (Hergang im Kopf von
    /// `system::encode_caps`).
    pub fn supported_video_codecs(&self) -> Vec<String> {
        super::codec_probe::supported_video_codecs(self)
    }
}

/// Enumeriert alle Hardware-Adapter (Software-Treiber wie WARP überspringen wir
/// per Flag-Check). HIGH_PERFORMANCE-Reihenfolge wenn IDXGIFactory6 verfügbar.
///
/// Dedup-Hinweis: NVIDIA-Optimus-Treiber listen die dGPU manchmal zweimal (einmal
/// als physisches Device, einmal als virtuellen Optimus-Bridge). LUID ist pro
/// Adapter eindeutig — wir filtern Dubletten darüber raus.
pub fn list_adapters() -> Result<Vec<Adapter>> {
    // CoInitialize ist hier nicht zwingend — DXGI ist nicht COM-init-pflichtig,
    // im Gegensatz zu WASAPI. Wir lassen's weg um keine Apartment-Konflikte
    // mit dem `wasapi`-Pfad zu provozieren (der initialisiert MTA selbst).

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.context("CreateDXGIFactory1")?;

    // IDXGIFactory6 ist seit Win10 1803 da. Wenn das Cast fehlschlägt fallen wir
    // auf EnumAdapters1 zurück (z.B. auf älteren Windows Server-Images).
    let factory6: Option<IDXGIFactory6> = factory.cast::<IDXGIFactory6>().ok();

    let mut out = Vec::new();
    // Dedup nach (vendor_id, device_id) — robuster als LUID, weil NVIDIAs
    // Treiber denselben physischen RTX-Adapter mit unterschiedlichen LUIDs
    // exponiert (einer pro WDDM-Engine-Pfad, gesehen 2026-05-19 auf RTX 4090).
    let mut seen: std::collections::BTreeSet<(u32, u32)> = std::collections::BTreeSet::new();
    let mut idx: u32 = 0;
    loop {
        let adapter: Result<IDXGIAdapter1, windows::core::Error> = unsafe {
            if let Some(f6) = &factory6 {
                f6.EnumAdapterByGpuPreference(idx, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)
            } else {
                factory.EnumAdapters1(idx)
            }
        };
        let adapter = match adapter {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(anyhow::anyhow!("EnumAdapter failed: {e}")),
        };

        let desc: DXGI_ADAPTER_DESC1 = unsafe { adapter.GetDesc1() }.context("GetDesc1")?;
        idx += 1;

        // Software-Renderer (z.B. Microsoft Basic Render Driver, WARP) ausblenden —
        // die kommen sonst als „Encoder verfügbar" durch und werfen erst beim
        // ersten Frame Fehler. Bit 0x2 (DXGI_ADAPTER_FLAG_SOFTWARE).
        if (desc.Flags & 0x2) != 0 {
            continue;
        }

        if !seen.insert((desc.VendorId, desc.DeviceId)) {
            // Sichtbar machen statt still verschlucken: bei zwei echten
            // physischen GPUs desselben Modells (nicht nur Optimus-Dubletten)
            // geht die zweite hier unter — im Diagnose-Log soll das auffallen.
            eprintln!(
                "[dxgi] Adapter übersprungen (Dedup nach vendor/device-id): {}",
                utf16_to_string(&desc.Description)
            );
            continue;
        }

        out.push(Adapter {
            description: utf16_to_string(&desc.Description),
            vendor_id: desc.VendorId,
            device_id: desc.DeviceId,
            vram_mb: (desc.DedicatedVideoMemory / (1024 * 1024)) as u64,
        });
    }

    Ok(out)
}

/// `DXGI_ADAPTER_DESC1::Description` ist ein 128-char UTF-16-Buffer mit Nullterm.
fn utf16_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// Sentinel — wenn `HMODULE` unbenutzt-wegoptimiert würde, hier referenzieren.
/// (Im aktuellen Code nicht nötig, aber das `Win32_Foundation`-Feature würde
/// sonst als unused warning kommen.)
#[allow(dead_code)]
const _USE_HMODULE: Option<HMODULE> = None;
