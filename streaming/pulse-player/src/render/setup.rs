//! Einmaliger GPU-Aufbau: Geraet, Oberflaeche, Pipeline.
//!
//! Hier faellt die Entscheidung, um die es beim ganzen Player geht — das
//! **Oberflaechenformat**. Gemessen auf der Dev-Maschine (2026-07-26) legt
//! Chromium seinen Wayland-Puffer immer als `ABGR8888` an, auch mit aktivem
//! HDR und auch mit `--force-color-profile=scrgb-linear`. KWin bietet daneben
//! 10-bit- und 16-bit-Formate an; die 8 bit sind also Chromiums Wahl, nicht
//! die Grenze des Systems. [`pick_format`] waehlt anders herum.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use wgpu::util::DeviceExt;

use super::uniforms::UNIFORM_BYTES;

/// Bevorzugte Oberflaechenformate, absteigend nach Praezision.
/// Rgb10a2Unorm entspricht dem `AB30` der Scanout-Ebene, Rgba16Float dem `AB4H`.
///
/// **Rgb10a2Unorm steht bewusst vor Rgba16Float**, obwohl fp16 mehr Bits hat.
/// Gemessen am 2026-07-26 (KWin 6.7.3, derselbe Strom in zwei Fenstern, einzig
/// das Format unterschiedlich): der fp16-Puffer wird als **lineares Licht**
/// gedeutet, der Unorm-Puffer als sRGB-kodiert. Da der Shader gamma-kodierte
/// Werte liefert, wirkte fp16 sichtbar flau, waehrend 8-bit-Unorm richtig
/// aussah. Beides ist inzwischen bedienbar (s. `Renderer::surface_is_linear`),
/// aber der Unorm-Weg ist der unempfindlichere: er kommt ohne Umrechnung aus
/// und traegt mit 10 bit trotzdem mehr als Chromiums 8.
///
/// Fuer 8-bit-Quellen — und GSR liefert NV12, also 8 bit — bringt fp16
/// ohnehin keine zusaetzliche Bildinformation, nur Kopfstand beim Farbraum.
const FORMAT_PREFERENCE: [wgpu::TextureFormat; 4] = [
    wgpu::TextureFormat::Rgb10a2Unorm,
    wgpu::TextureFormat::Rgba16Float,
    wgpu::TextureFormat::Bgra8Unorm,
    wgpu::TextureFormat::Rgba8Unorm,
];

/// Alles, was beim Oeffnen eines Fensters genau einmal entsteht.
pub struct GpuSetup {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
    pub pipeline: wgpu::RenderPipeline,
    pub bind_layout: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
    pub uniform_buf: wgpu::Buffer,
    /// Ob 16-bit-Norm-Texturen benutzt werden duerfen.
    ///
    /// `R16Unorm`/`Rg16Unorm` sind in wgpu **kein** Kernformat, sondern hinter
    /// `TEXTURE_FORMAT_16BIT_NORM` gegated. Ohne angefordertes Feature liefert
    /// `create_texture` einen Geraetefehler, und der fuehrt in wgpus
    /// Standardbehandlung zum Absturz — ausgeloest vom ersten 10-bit-Frame,
    /// also genau im Anwendungsfall, fuer den dieser Player gebaut wurde.
    /// Fehlt das Feature, muss der Aufrufer 10-bit-Quellen auf 8 bit
    /// herunterrechnen statt abzustuerzen.
    pub wide_textures: bool,
}

/// Erlaubt, die Formatwahl von aussen festzunageln: `PULSE_PLAYER_SURFACE`
/// = `rgba16f` | `rgb10a2` | `bgra8` | `bgra8srgb`.
///
/// Diagnosehilfe, kein Feature. Wie ein Compositor ein Oberflaechenformat
/// deutet — ob er die Werte als sRGB-kodiert oder als lineares Licht nimmt —
/// steht nirgends verlaesslich und ist von aussen nur durch Vergleich zu
/// klaeren. Am 2026-07-26 wurde das zweimal falsch geraten (erst zu flau,
/// dann zu dunkel); mit dieser Variable laesst sich derselbe Strom in zwei
/// Fenstern nebeneinander stellen, statt ein drittes Mal zu vermuten.
fn format_override() -> Option<wgpu::TextureFormat> {
    let raw = std::env::var("PULSE_PLAYER_SURFACE").ok()?;
    let format = match raw.trim().to_ascii_lowercase().as_str() {
        "rgba16f" => wgpu::TextureFormat::Rgba16Float,
        "rgb10a2" => wgpu::TextureFormat::Rgb10a2Unorm,
        "bgra8" => wgpu::TextureFormat::Bgra8Unorm,
        "bgra8srgb" => wgpu::TextureFormat::Bgra8UnormSrgb,
        other => {
            eprintln!("pulse-player: PULSE_PLAYER_SURFACE={other} unbekannt — ignoriert");
            return None;
        }
    };
    Some(format)
}

/// Nimmt das praeziseste angebotene Format; als letzter Ausweg irgendeines.
fn pick_format(offered: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    if let Some(forced) = format_override() {
        if offered.contains(&forced) {
            eprintln!("pulse-player: Oberflaechenformat erzwungen: {forced:?}");
            return Some(forced);
        }
        eprintln!("pulse-player: {forced:?} wird nicht angeboten — normale Wahl");
    }
    FORMAT_PREFERENCE
        .iter()
        .copied()
        .find(|f| offered.contains(f))
        .or_else(|| offered.first().copied())
}

pub async fn create(window: Arc<winit::window::Window>, width: u32, height: u32) -> Result<GpuSetup> {
    let instance = wgpu::Instance::new(
        wgpu::InstanceDescriptor::new_with_display_handle_from_env(Box::new(window.clone())),
    );
    let surface = instance
        .create_surface(window)
        .context("Oberflaeche liess sich nicht anlegen")?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        })
        .await
        .context("keine passende GPU gefunden")?;
    // 16-bit-Norm-Texturen nur anfordern, wenn die GPU sie kann — ein
    // unerfuellbares `required_features` laesst `request_device` scheitern.
    let wide_textures =
        adapter.features().contains(wgpu::Features::TEXTURE_FORMAT_16BIT_NORM);
    if !wide_textures {
        eprintln!(
            "pulse-player: GPU ohne TEXTURE_FORMAT_16BIT_NORM — 10-bit-Quellen \
             werden auf 8 bit heruntergerechnet"
        );
    }
    let required_features = if wide_textures {
        wgpu::Features::TEXTURE_FORMAT_16BIT_NORM
    } else {
        wgpu::Features::empty()
    };
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("pulse-player"),
            required_features,
            ..Default::default()
        })
        .await
        .context("GPU-Geraet liess sich nicht oeffnen")?;

    let caps = surface.get_capabilities(&adapter);
    let format = pick_format(&caps.formats)
        .ok_or_else(|| anyhow!("Oberflaeche bietet kein einziges Format an"))?;
    eprintln!("pulse-player: Oberflaechenformat {format:?} (angeboten: {:?})", caps.formats);

    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: width.max(1),
        height: height.max(1),
        present_mode: caps
            .present_modes
            .iter()
            .copied()
            .find(|m| *m == wgpu::PresentMode::Mailbox)
            .unwrap_or(wgpu::PresentMode::Fifo),
        alpha_mode: caps.alpha_modes[0],
        view_formats: vec![],
        desired_maximum_frame_latency: 1,
    };
    surface.configure(&device, &config);

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("pulse-player-shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
    });

    let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("pulse-player-bind"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            texture_entry(2),
            texture_entry(3),
            texture_entry(4),
        ],
    });

    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("pulse-player-layout"),
        bind_group_layouts: &[Some(&bind_layout)],
        immediate_size: 0,
    });

    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("pulse-player-pipeline"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(format.into())],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    });

    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("pulse-player-sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        ..Default::default()
    });

    let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("pulse-player-uniforms"),
        contents: &[0u8; UNIFORM_BYTES],
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });

    Ok(GpuSetup {
        device,
        queue,
        surface,
        config,
        pipeline,
        bind_layout,
        sampler,
        uniform_buf,
        wide_textures,
    })
}

fn texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bietet der Compositor alles an, faellt die Wahl auf 10-bit-Unorm —
    /// NICHT auf fp16, obwohl das mehr Bits haette.
    ///
    /// Das ist die Lehre aus dem Zwei-Fenster-Vergleich vom 2026-07-26: fp16
    /// wird als lineares Licht gedeutet und braucht eine Umrechnung, die
    /// leicht falsch herum passiert (sie ist es zweimal). Rgb10a2Unorm traegt
    /// 10 bit — mehr als Chromiums 8, worum es beim Player geht — und kommt
    /// ohne diese Falle aus. Wer die Reihenfolge wieder umdreht, holt sich das
    /// flaue Bild zurueck.
    #[test]
    fn formatpraeferenz_nimmt_zehn_bit_unorm_vor_fp16() {
        assert_eq!(pick_format(&FORMAT_PREFERENCE), Some(wgpu::TextureFormat::Rgb10a2Unorm));

        // Ohne 10-bit bleibt fp16 die praezisere Wahl vor 8 bit.
        let no10 = [wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureFormat::Rgba16Float];
        assert_eq!(pick_format(&no10), Some(wgpu::TextureFormat::Rgba16Float));

        // Bietet er nur 8-bit an, faellt die Wahl dorthin — aber erst dann.
        let only8 = [wgpu::TextureFormat::Bgra8Unorm];
        assert_eq!(pick_format(&only8), Some(wgpu::TextureFormat::Bgra8Unorm));
    }
}
