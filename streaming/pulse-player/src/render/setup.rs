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
const FORMAT_PREFERENCE: [wgpu::TextureFormat; 4] = [
    wgpu::TextureFormat::Rgba16Float,
    wgpu::TextureFormat::Rgb10a2Unorm,
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
}

/// Nimmt das praeziseste angebotene Format; als letzter Ausweg irgendeines.
fn pick_format(offered: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
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
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor { label: Some("pulse-player"), ..Default::default() })
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

    Ok(GpuSetup { device, queue, surface, config, pipeline, bind_layout, sampler, uniform_buf })
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

    #[test]
    fn formatpraeferenz_bevorzugt_hohe_praezision() {
        // Ein Compositor, der alles anbietet, muss fp16 bekommen.
        assert_eq!(pick_format(&FORMAT_PREFERENCE), Some(wgpu::TextureFormat::Rgba16Float));

        // Bietet er nur 8-bit an, faellt die Wahl dorthin — aber erst dann.
        let only8 = [wgpu::TextureFormat::Bgra8Unorm];
        assert_eq!(pick_format(&only8), Some(wgpu::TextureFormat::Bgra8Unorm));
    }
}
