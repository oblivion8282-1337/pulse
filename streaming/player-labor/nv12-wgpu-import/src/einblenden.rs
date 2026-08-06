//! Stufe 3: die geteilte D3D11-Textur in wgpu einhaengen — auf zwei Wegen.
//!
//! **Der Weg ist die eigentliche Frage dieser Erweiterung.** Bis zum
//! 2026-08-06 wurde ausschliesslich ueber Vulkan gemessen; der Player faehrt
//! unter Windows aber seit demselben Tag **D3D12** (`render/setup.rs::backends`,
//! Voraussetzung fuer HDR — nur dort laesst sich der Farbraum des Fensters
//! anmelden). Eine Messung auf dem einen Backend sagt ueber das andere nichts:
//!
//! * Vulkan: `texture_from_d3d11_shared_handle` — gibt es in wgpu-hal 29.0.4
//!   **ausschliesslich** hier (`src/vulkan/device.rs:544`). Importiert den
//!   Speicher selbst (`VK_KHR_external_memory_win32`).
//! * D3D12: `OpenSharedHandle` auf wgpus eigenem `ID3D12Device` plus
//!   `texture_from_raw` (`src/dx12/device.rs:448`). Das Oeffnen macht also
//!   D3D12 selbst, wgpu bekommt nur die fertige `ID3D12Resource`.
//!
//! Der zweite Weg hat einen Vorteil, der in der Vulkan-Akte fehlt: **D3D12
//! kennt keinen `initial_state`-Parameter, und braucht auch keinen.** Eine
//! ueber `OpenSharedHandle` geoeffnete Ressource liegt vorschriftsmaessig im
//! Zustand `COMMON`, und genau davon geht wgpu bei einer eingehaengten Textur
//! aus. Die ganze Zustandsfrage, an der sich der Vulkan-Weg auf NVIDIA
//! aufgehalten hat, stellt sich hier nicht.

use windows::Win32::Graphics::Direct3D12::{ID3D12Device, ID3D12Resource};

use crate::bildformat::Bildformat;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Weg {
    Vulkan,
    Dx12,
}

impl Weg {
    pub fn aus_umgebung() -> Self {
        // **Vorgabe ist D3D12**, nicht Vulkan: das ist der Weg, den der Player
        // wirklich faehrt. Ein nackter Lauf soll die Lage des Produkts messen,
        // nicht die einer Nebenstrasse.
        match std::env::var("SPIKE_BACKEND").as_deref().map(str::trim) {
            Ok("vulkan") => Weg::Vulkan,
            _ => Weg::Dx12,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Weg::Vulkan => "Vulkan",
            Weg::Dx12 => "D3D12",
        }
    }

    pub fn backends(self) -> wgpu::Backends {
        match self {
            Weg::Vulkan => wgpu::Backends::VULKAN,
            Weg::Dx12 => wgpu::Backends::DX12,
        }
    }

    /// Merkmale, die dieser Weg zusaetzlich zum Bildformat braucht.
    ///
    /// `VULKAN_EXTERNAL_MEMORY_WIN32` ist nach seinem Namen ein reines
    /// Vulkan-Merkmal; auf D3D12 wird es nicht angeboten, und es anzufordern
    /// liesse `request_device` scheitern — der Lauf saehe dann aus wie „D3D12
    /// kann das nicht", obwohl nur zu viel verlangt wurde.
    pub fn zusatzmerkmale(self) -> wgpu::Features {
        match self {
            Weg::Vulkan => wgpu::Features::VULKAN_EXTERNAL_MEMORY_WIN32,
            Weg::Dx12 => wgpu::Features::empty(),
        }
    }
}

/// Haengt das NT-Handle als wgpu-Textur ein. Gibt zusaetzlich die reine
/// Einblendzeit zurueck (ohne Ansichten, ohne Zeichnen).
pub fn einhaengen(
    weg: Weg,
    device: &wgpu::Device,
    handle: windows::Win32::Foundation::HANDLE,
    format: Bildformat,
    schichten: u32,
) -> Result<(wgpu::Texture, std::time::Duration), String> {
    let (ebene0, ebene1) = format.ebenen();
    // `depth_or_array_layers` traegt die Schichtenzahl — auf beiden Wegen. Ob
    // die Speicherlage eines D3D11-Stapels dazu passt, ist genau die Frage der
    // Stapel-Pruefung; auf Vulkan tat sie es am 2026-08-06 NICHT (Schicht 0 gut,
    // jede weitere um den Schichtabstand daneben).
    let masse = wgpu::Extent3d {
        width: crate::bildformat::BREITE,
        height: crate::bildformat::HOEHE,
        depth_or_array_layers: schichten,
    };
    let hal_desc = wgpu::hal::TextureDescriptor {
        label: Some("nv12-import"),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: format.wgpu(),
        // COPY_DST zusaetzlich, damit Stufe 5 in die Textur schreiben kann.
        usage: wgpu::TextureUses::RESOURCE | wgpu::TextureUses::COPY_DST,
        memory_flags: wgpu::hal::MemoryFlags::empty(),
        view_formats: vec![ebene0, ebene1],
    };
    let beschreibung = wgpu::TextureDescriptor {
        label: Some("nv12-import"),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: format.wgpu(),
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[ebene0, ebene1],
    };

    let start = std::time::Instant::now();
    let textur = match weg {
        Weg::Vulkan => {
            // SAFETY: das Handle stammt aus `CreateSharedHandle` auf einer
            // lebenden D3D11-Textur; die Quelle wird bis zum Programmende
            // gehalten.
            let hal_tex = unsafe {
                let hal_device = device
                    .as_hal::<wgpu::hal::api::Vulkan>()
                    .ok_or("Geraet ist kein Vulkan-Geraet")?;
                hal_device
                    .texture_from_d3d11_shared_handle(handle, &hal_desc)
                    .map_err(|e| format!("texture_from_d3d11_shared_handle: {e:?}"))?
            };
            // SAFETY: die hal-Textur stammt aus demselben Geraet und wird hier
            // an wgpu uebergeben, das sie ab jetzt besitzt.
            unsafe { device.create_texture_from_hal::<wgpu::hal::api::Vulkan>(hal_tex, &beschreibung) }
        }
        Weg::Dx12 => {
            let ressource = oeffnen(device, handle)?;
            // SAFETY: `ressource` ist eine gueltige, von diesem Geraet
            // geoeffnete Ressource; die angegebenen Masse stimmen mit der
            // D3D11-Textur ueberein.
            let hal_tex = unsafe {
                wgpu::hal::dx12::Device::texture_from_raw(
                    ressource,
                    format.wgpu(),
                    wgpu::TextureDimension::D2,
                    masse,
                    1,
                    1,
                )
            };
            // SAFETY: wie oben.
            unsafe { device.create_texture_from_hal::<wgpu::hal::api::Dx12>(hal_tex, &beschreibung) }
        }
    };
    Ok((textur, start.elapsed()))
}

/// Das NT-Handle auf wgpus eigenem D3D12-Geraet oeffnen.
///
/// **Das Handle wird hier NICHT geschlossen.** D3D12 haelt nach dem Oeffnen
/// eine eigene Referenz, und im Sidecar wird es genau deshalb sofort
/// geschlossen (`pipeline_d3d12.rs::open_shared_bgra`). Hier bleibt es offen,
/// weil die Probe es fuer die Gegenrichtung und fuer wiederholte Laeufe noch
/// braucht — bei einem einzigen Handle pro Programmlauf ist das kein Leck von
/// Belang. Im Player gilt wieder die Sidecar-Regel: je Bild ein Handle heisst
/// je Bild ein `CloseHandle`.
fn oeffnen(
    device: &wgpu::Device,
    handle: windows::Win32::Foundation::HANDLE,
) -> Result<ID3D12Resource, String> {
    // SAFETY: das Geraet lebt waehrend des ganzen Aufrufs; `raw_device` gibt
    // nur eine Leihe auf das darunterliegende `ID3D12Device`.
    unsafe {
        let hal_device = device
            .as_hal::<wgpu::hal::api::Dx12>()
            .ok_or("Geraet ist kein D3D12-Geraet")?;
        let roh: &ID3D12Device = hal_device.raw_device();
        let mut res: Option<ID3D12Resource> = None;
        roh.OpenSharedHandle(handle, &mut res)
            .map_err(|e| format!("OpenSharedHandle: {e}"))?;
        res.ok_or_else(|| "OpenSharedHandle lieferte keine Ressource".to_string())
    }
}
