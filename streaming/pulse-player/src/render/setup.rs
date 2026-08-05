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

/// Alles, was nur vom **Zielformat** abhaengt: Shader, Bindungen, Pipeline,
/// Sampler, Uniform-Puffer.
///
/// Getrennt von [`create`], weil der Messpfad ([`crate::messen`]) genau diese
/// Pipeline braucht — ohne Fenster und ohne Swapchain. Ein dort nachgebauter
/// Zwilling waere als Messgeraet wertlos: gemessen wuerde der Nachbau, und
/// jede Shader-Aenderung liefe an der Messung vorbei.
pub struct Graphics {
    pub pipeline: wgpu::RenderPipeline,
    pub bind_layout: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
    pub uniform_buf: wgpu::Buffer,
}

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
    let (device, queue, wide_textures) = geraet_oeffnen(&adapter, "pulse-player").await?;

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
        // Drei Swapchain-Bilder, nicht zwei: wgpu macht daraus
        // `min_image_count(latency + 1)`
        // (`wgpu-hal-29.0.4/src/vulkan/swapchain/native.rs:192`, nachgelesen).
        //
        // Mit zwei Bildern kann der Fenster-Thread Bild N+1 nicht vorbereiten,
        // solange der Compositor Bild N haelt — `get_current_texture` wartet.
        // Die Schleifendauer war dadurch Rechenzeit PLUS Wartezeit bis zur
        // naechsten Bildwiederholung, also 7-11 ms statt der gemessenen ~4 ms
        // Rechenzeit; bei 144 gesendeten Bildern kamen so nur 90-140 auf den
        // Schirm, mit unregelmaessigen Abstaenden. Gemessen am 2026-07-26 an
        // einem 144-fps-Stream: `Bilder/s 144`, `Paketverlust 0`, aber viele
        // Bilder wurden ueberschrieben, bevor sie gezeichnet werden konnten.
        //
        // Nebenwirkung, die man kennen muss: `Mailbox` BRAUCHT ein drittes Bild,
        // um ueberhaupt Mailbox zu sein (mit zwei entartet es zu Fifo). Der
        // Preis ist bis zu eine Bildwiederholung mehr Verzug — bei 144 Hz rund
        // 7 ms, bei 60 Hz rund 16 ms. Wer Latenz ueber Bildrate stellt, setzt
        // hier wieder 1.
        desired_maximum_frame_latency: 2,
    };
    // Ausgabe-Takt mitloggen, nicht raten: `Mailbox` gibt sofort aus und
    // verwirft ueberzaehlige Bilder, `Fifo` wartet auf den Bildschirmtakt. Bei
    // hohen Bildraten entscheidet das mit darueber, ob 144 gesendete Bilder
    // auch 144-mal auf dem Schirm landen — und es steht sonst nirgends.
    eprintln!(
        "pulse-player: Ausgabe-Takt {:?} (angeboten: {:?}), max. Bildverzug {}",
        config.present_mode, caps.present_modes, config.desired_maximum_frame_latency
    );
    surface.configure(&device, &config);

    let gfx = build_graphics(&device, format);

    Ok(GpuSetup {
        device,
        queue,
        surface,
        config,
        pipeline: gfx.pipeline,
        bind_layout: gfx.bind_layout,
        sampler: gfx.sampler,
        uniform_buf: gfx.uniform_buf,
        wide_textures,
    })
}

/// GPU-Geraet mit den Merkmalen anfordern, die der Player braucht.
///
/// Gemeinsam fuer Fenster und Messpfad, weil ein Auseinanderlaufen hier
/// besonders teuer waere: `R16Unorm`/`Rg16Unorm` sind in wgpu hinter
/// `TEXTURE_FORMAT_16BIT_NORM` gegated, und eine Textur ohne angefordertes
/// Feature ist ein Geraetefehler — also ein Absturz beim ersten 10-bit-Bild.
/// Miesse man auf einem anders angeforderten Geraet, sagte die Messung nichts
/// ueber das ausgelieferte.
///
/// Drittes Rueckgabefeld: ob 16-bit-Norm-Texturen benutzt werden duerfen.
pub async fn geraet_oeffnen(
    adapter: &wgpu::Adapter,
    label: &str,
) -> Result<(wgpu::Device, wgpu::Queue, bool)> {
    // Nur anfordern, wenn die GPU es kann — ein unerfuellbares
    // `required_features` laesst `request_device` scheitern.
    let wide_textures = adapter.features().contains(wgpu::Features::TEXTURE_FORMAT_16BIT_NORM);
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
            label: Some(label),
            required_features,
            ..Default::default()
        })
        .await
        .context("GPU-Geraet liess sich nicht oeffnen")?;
    Ok((device, queue, wide_textures))
}

pub fn build_graphics(device: &wgpu::Device, format: wgpu::TextureFormat) -> Graphics {
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

    Graphics { pipeline, bind_layout, sampler, uniform_buf }
}

/// Die Bindungen fuer ein Bild: Uniform-Puffer, Sampler, drei Ebenen.
///
/// An EINER Stelle, weil die Nummern sonst dreifach von Hand gefuehrt wuerden
/// (Layout hier, Fenster, Messpfad) und eine sechste Bindung im Shader erst
/// zur Laufzeit auffiele.
pub fn build_bind_group(
    device: &wgpu::Device,
    gfx: &Graphics,
    ebenen: [&wgpu::TextureView; 3],
) -> wgpu::BindGroup {
    use super::texture_binding as textur;
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pulse-player-bg"),
        layout: &gfx.bind_layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: gfx.uniform_buf.as_entire_binding() },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&gfx.sampler),
            },
            textur(2, ebenen[0]),
            textur(3, ebenen[1]),
            textur(4, ebenen[2]),
        ],
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
