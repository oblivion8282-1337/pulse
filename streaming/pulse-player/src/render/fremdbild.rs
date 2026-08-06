//! Die andere Haelfte der Bruecke: eine geteilte D3D11-Textur in wgpu
//! einhaengen und als Ebenen-Ansichten binden.
//!
//! Gegenstueck zu [`crate::zerocopy`]; dort steht, warum es die Bruecke
//! ueberhaupt gibt und was sie kostet.
//!
//! **Nur ueber D3D12.** `wgpu-hal` 29.0.4 kann eine D3D11-Textur auf zwei Wegen
//! aufnehmen, und beide sind an ihr Backend gebunden:
//! `texture_from_d3d11_shared_handle` gibt es ausschliesslich im
//! Vulkan-Backend, `texture_from_raw` ausschliesslich im dx12-Backend. Der
//! Player faehrt unter Windows D3D12 (`setup::backends`, Voraussetzung fuer
//! HDR), also fuehrt der Weg hier ueber `ID3D12Device::OpenSharedHandle` und
//! `texture_from_raw`. Wer das Backend umstellt, verliert Zero-Copy — und
//! bekommt den Rueckfall, nicht einen Absturz.
//!
//! Gemessen als tragend auf einer Radeon 780M, NV12 und P010, auch beim
//! wiederholten Beschreiben derselben Textur:
//! `streaming/testbench/profiles/player-2026-08-06-zerocopy-d3d12-amd.json`.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::sync::Arc;

use crate::decode::PixelLayout;
use crate::zerocopy::GpuBild;

/// Ein eingehaengtes Bild samt seiner beiden Ebenen-Ansichten.
pub struct Import {
    /// Gehalten, weil die Bindegruppe daran haengt — sonst nirgends gebraucht.
    _textur: wgpu::Texture,
    /// Die fertige Bindegruppe dieses Ringplatzes.
    ///
    /// **Hier stand die Bindegruppe frueher NICHT, sie entstand je Bild neu**,
    /// mit der Begruendung „der Ring rotiert je Bild, die Ansichten sind also
    /// andere". Das erklaert nur, warum EINE feste Gruppe nicht reicht — nicht,
    /// warum zwoelf feste es nicht taeten. Alle fuenf Bestandteile sind je
    /// Ringplatz unveraenderlich (die beiden Ebenen-Ansichten, die Blindtextur,
    /// der Sampler und der Uniform-Puffer; letzterer wird beschrieben, nicht neu
    /// gebunden). `create_bind_group` ist in wgpu nicht billig — Layout-Pruefung,
    /// Deskriptoren in den shader-sichtbaren Haufen, fuenf Arc-Klone in die
    /// Ressourcen-Verfolgung —, und die alte Gruppe ging jedes Bild in die
    /// verzoegerte Zerstoerung. Bei 60 Bildern je Sekunde waren das 60 Gruppen
    /// statt zwoelf.
    pub bindegruppe: wgpu::BindGroup,
}

/// Zwischenspeicher der Einhaengungen, ein Eintrag je Ringplatz.
///
/// **Der Schluessel ist das NT-Handle**, und das ist genau richtig: die Bruecke
/// legt ihren Ring einmal an und behaelt die Handles, bis Masse oder Format
/// sich aendern. Ein Bild je Einhaengung waere Verschwendung (0,5 ms Import je
/// Bild statt einmalig je Ringplatz), ein Zwischenspeicher ueber die
/// Bildnummer waere falsch.
pub struct Fremdbilder {
    importe: HashMap<isize, Import>,
    /// Fuellt die dritte Bindung. Der Shader liest sie bei verschraenktem UV
    /// nicht, binden muss man sie trotzdem.
    blind: wgpu::TextureView,
    /// Masse und Bittiefe, fuer die die Eintraege gelten.
    ///
    /// **Ohne das waere der Zwischenspeicher gefaehrlich, nicht nur veraltet.**
    /// Aendert sich die Aufloesung, baut die Bruecke ihren Ring neu und
    /// SCHLIESST die alten NT-Handles — und Windows vergibt Handle-Werte
    /// wieder. Ein neuer Ringplatz kann also denselben Zahlenwert bekommen wie
    /// ein alter, und der Zwischenspeicher lieferte dann die Ansicht auf eine
    /// Textur, die es nicht mehr gibt.
    bauart: Option<(u32, u32, bool)>,
}

impl Fremdbilder {
    /// **Braucht das Geraet, statt die Blindtextur spaeter nachzuziehen.** Der
    /// Aufrufer (`Renderer::new`) hat es ohnehin in der Hand; lazy angelegt
    /// zwaenge sie in ein `Option` und damit zwei Fehlerpfade in `binden`, die
    /// nie eintreten koennen.
    pub fn neu(device: &wgpu::Device) -> Self {
        Self { importe: HashMap::new(), blind: blindtextur(device), bauart: None }
    }

    /// Welche Merkmale das Geraet braucht, damit dieser Weg ueberhaupt offen
    /// ist — so weit die GPU sie anbietet.
    ///
    /// **Beide Format-Merkmale zusammen anfordern und nicht je Strom
    /// nachfordern:** ein Geraet laesst sich in wgpu nicht nachtraeglich
    /// erweitern, und ob ein Strom 8 oder 10 bit fuehrt, steht erst beim ersten
    /// Bild fest. P010 braucht ausserdem `TEXTURE_FORMAT_16BIT_NORM` fuer seine
    /// Ebenen-Ansichten — das fordert der Player ohnehin schon an.
    pub fn merkmale(vorhanden: wgpu::Features) -> wgpu::Features {
        (wgpu::Features::TEXTURE_FORMAT_NV12 | wgpu::Features::TEXTURE_FORMAT_P010) & vorhanden
    }

    /// Traegt das Geraet den Weg fuer dieses Bild?
    pub fn moeglich(device: &wgpu::Device, zehn_bit: bool) -> bool {
        let f = device.features();
        if zehn_bit {
            f.contains(wgpu::Features::TEXTURE_FORMAT_P010)
                && f.contains(wgpu::Features::TEXTURE_FORMAT_16BIT_NORM)
        } else {
            f.contains(wgpu::Features::TEXTURE_FORMAT_NV12)
        }
    }

    /// Die fertige Bindegruppe fuer dieses Bild. `None` heisst: der Import ist
    /// nicht moeglich — der Aufrufer schaltet den Weg dann ab.
    pub fn binden(
        &mut self,
        device: &wgpu::Device,
        teile: &Bindeteile<'_>,
        bild: &Arc<GpuBild>,
    ) -> Option<&wgpu::BindGroup> {
        if !Self::moeglich(device, bild.zehn_bit()) {
            return None;
        }
        let (bw, bh) = bild.textur_masse();
        let bauart = (bw, bh, bild.zehn_bit());
        if self.bauart != Some(bauart) {
            // Nach einem Formatwechsel zeigen die alten Handles auf Texturen,
            // die es nicht mehr gibt (s. [`Fremdbilder::bauart`]).
            self.importe.clear();
            self.bauart = Some(bauart);
        }
        match self.importe.entry(bild.handle()) {
            Entry::Occupied(e) => Some(&e.into_mut().bindegruppe),
            Entry::Vacant(e) => {
                let import = einhaengen(device, teile, &self.blind, bild)?;
                Some(&e.insert(import).bindegruppe)
            }
        }
    }

    /// Die bereits gebaute Bindegruppe eines Ringplatzes.
    ///
    /// Getrennt von [`Fremdbilder::binden`], weil `render` sie mit `&self`
    /// braucht — `binden` laeuft in `upload` und darf einhaengen, `render`
    /// findet nur noch vor.
    pub fn bindegruppe(&self, handle: isize) -> Option<&wgpu::BindGroup> {
        self.importe.get(&handle).map(|i| &i.bindegruppe)
    }
}

/// Was ausser den Ebenen noch in die Bindegruppe gehoert.
///
/// Als Buendel, damit `binden` nicht vier Einzelteile durchreichen muss und der
/// Aufrufer sie nicht in der falschen Reihenfolge uebergeben kann.
pub struct Bindeteile<'a> {
    pub layout: &'a wgpu::BindGroupLayout,
    pub sampler: &'a wgpu::Sampler,
    pub uniform_buf: &'a wgpu::Buffer,
}

fn blindtextur(device: &wgpu::Device) -> wgpu::TextureView {
    // Dieselbe Bauart wie die Ebenen-Texturen (s. `bildquelle::textur`); nur
    // `COPY_DST` faellt weg, denn hier wird nie etwas hineingeschrieben.
    super::bildquelle::textur(
        device,
        1,
        1,
        wgpu::TextureFormat::R8Unorm,
        wgpu::TextureUsages::TEXTURE_BINDING,
        "pulse-player-blind",
    )
    .create_view(&wgpu::TextureViewDescriptor::default())
}

/// Ausserhalb von Windows gibt es weder NT-Handles noch ein D3D12-Geraet.
/// Dass es diese Fassung gibt, haelt `render/mod.rs` frei von `#[cfg]`-Zweigen;
/// erreicht wird sie ohnehin nie, weil `DecodedFrame::gpu` dort immer `None`
/// ist (s. `zerocopy::leer`).
#[cfg(not(windows))]
fn einhaengen(
    _device: &wgpu::Device,
    _teile: &Bindeteile<'_>,
    _blind: &wgpu::TextureView,
    _bild: &Arc<GpuBild>,
) -> Option<Import> {
    None
}

#[cfg(windows)]
fn einhaengen(
    device: &wgpu::Device,
    teile: &Bindeteile<'_>,
    blind: &wgpu::TextureView,
    bild: &Arc<GpuBild>,
) -> Option<Import> {
    let (breite, hoehe) = bild.textur_masse();
    let format =
        if bild.zehn_bit() { wgpu::TextureFormat::P010 } else { wgpu::TextureFormat::NV12 };
    // Die Ebenen-Formate kommen aus `farbe`, nicht von hier: dort steht auch
    // `scales`, das mit genau dieser Zuordnung rechnet. Zwei Tabellen koennten
    // auseinanderlaufen, ohne dass man es dem Bild ansaehe — genau die
    // Begruendung, mit der `scales` seinerzeit zusammengelegt wurde.
    //
    // `wide = zehn_bit`: auf diesem Weg wird nichts heruntergerechnet. Eine
    // P010-Textur traegt 16 bit, oder es gibt gar keinen Import
    // (`Fremdbilder::moeglich` prueft das Merkmal vorher).
    let (ebene0, ebene1) =
        super::farbe::ebenenformate(bild.zehn_bit(), PixelLayout::BiPlanar420);
    let masse = wgpu::Extent3d { width: breite, height: hoehe, depth_or_array_layers: 1 };

    let ressource = match oeffnen(device, bild.handle()) {
        Ok(r) => r,
        Err(e) => {
            // Eine Zeile, kein Absturz: der Aufrufer faellt auf den Weg ueber
            // den Hauptspeicher zurueck. Haeufigster Grund waere ein anderer
            // Adapter unter FFmpeg als unter wgpu (zwei GPUs im Rechner).
            eprintln!("pulse-player: Zero-Copy nicht moeglich ({e}) — Rueckfall auf Ruecklesen");
            return None;
        }
    };
    // SAFETY: `ressource` wurde gerade von genau diesem Geraet geoeffnet, die
    // Masse stammen aus dem Deskriptor der D3D11-Textur, und `bild` haelt sie
    // am Leben, solange der Import benutzt wird.
    let hal_tex = unsafe {
        wgpu::hal::dx12::Device::texture_from_raw(
            ressource,
            format,
            wgpu::TextureDimension::D2,
            masse,
            1,
            1,
        )
    };
    // SAFETY: die hal-Textur gehoert ab hier wgpu.
    let textur = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
            hal_tex,
            &wgpu::TextureDescriptor {
                label: Some("pulse-player-fremdbild"),
                size: masse,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[ebene0, ebene1],
            },
        )
    };
    let ansicht = |name: &'static str, f: wgpu::TextureFormat, a: wgpu::TextureAspect| {
        textur.create_view(&wgpu::TextureViewDescriptor {
            label: Some(name),
            format: Some(f),
            aspect: a,
            dimension: Some(wgpu::TextureViewDimension::D2),
            ..Default::default()
        })
    };
    let luma = ansicht("fremdbild-y", ebene0, wgpu::TextureAspect::Plane0);
    let chroma = ansicht("fremdbild-uv", ebene1, wgpu::TextureAspect::Plane1);
    // Einmal je Ringplatz, nicht je Bild — Begruendung an `Import::bindegruppe`.
    let bindegruppe = super::setup::bind_group_aus_teilen(
        device,
        teile.layout,
        teile.sampler,
        teile.uniform_buf,
        [&luma, &chroma, blind],
    );
    Some(Import { _textur: textur, bindegruppe })
}

/// Das NT-Handle auf wgpus eigenem D3D12-Geraet oeffnen.
///
/// **Das Handle wird hier NICHT geschlossen** — es gehoert der Bruecke, die es
/// ueber die Lebensdauer ihres Rings haelt und in ihrem `Drop` schliesst. D3D12
/// nimmt beim Oeffnen eine eigene Referenz auf die Ressource.
#[cfg(windows)]
fn oeffnen(
    device: &wgpu::Device,
    handle: isize,
) -> Result<windows::Win32::Graphics::Direct3D12::ID3D12Resource, String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Direct3D12::{ID3D12Device, ID3D12Resource};

    // SAFETY: das Geraet lebt waehrend des Aufrufs; `raw_device` gibt nur eine
    // Leihe auf das darunterliegende `ID3D12Device`.
    unsafe {
        let hal = device
            .as_hal::<wgpu::hal::api::Dx12>()
            .ok_or("Geraet ist kein D3D12-Geraet")?;
        let roh: &ID3D12Device = hal.raw_device();
        let mut res: Option<ID3D12Resource> = None;
        roh.OpenSharedHandle(HANDLE(handle as *mut std::ffi::c_void), &mut res)
            .map_err(|e| format!("OpenSharedHandle: {e}"))?;
        res.ok_or_else(|| "OpenSharedHandle lieferte keine Ressource".to_string())
    }
}
