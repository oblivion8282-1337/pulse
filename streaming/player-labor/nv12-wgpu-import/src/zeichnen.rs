//! Stufe 4: einen Renderdurchgang ueber die eingehaengte Textur fahren und die
//! Abtastwerte zurueckholen.
//!
//! Geprueft wird nicht „kein Fehler", sondern **jeder Bildpunkt** gegen den
//! geschriebenen Wert — die Stufen davor koennen gelingen und das Bild trotzdem
//! falsch ankommen: vertauschte Ebenen, falscher Zeilenabstand, stillschweigende
//! Formatwandlung.

use crate::bildformat::{BREITE, HOEHE};

const SHADER: &str = r#"
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    return vec4<f32>(p[i], 0.0, 1.0);
}
@group(0) @binding(0) var y_tex: texture_2d<f32>;
@group(0) @binding(1) var uv_tex: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let c = vec2<i32>(i32(pos.x), i32(pos.y));
    let y = textureLoad(y_tex, c, 0).r;
    let uv = textureLoad(uv_tex, c / 2, 0).rg;
    // Roh weitergereicht, NICHT nach RGB gerechnet: geprueft werden soll der
    // Weg der Daten, nicht die Farbmatrix.
    return vec4<f32>(y, uv.r, uv.g, 1.0);
}
"#;

/// Einen Durchgang zeichnen und die drei Kanaele je Bildpunkt zurueckgeben —
/// als Abtastwerte in [0,1], nicht als Rohbytes.
///
/// **Das Zielformat haengt an der Bittiefe der Quelle.** Ein 8-Bit-Ziel kappte
/// bei P010 die unteren zwei Bit und liesse damit genau den Fehler durch, um
/// den es bei 10 Bit geht: einen Weg, der still auf 8 Bit wandelt. Fuer NV12
/// bleibt es beim bisherigen `Rgba8Unorm`, damit die Zahlen mit den frueheren
/// Laeufen vergleichbar bleiben.
pub fn zeichnen(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    y_view: &wgpu::TextureView,
    uv_view: &wgpu::TextureView,
    zielformat: wgpu::TextureFormat,
) -> Vec<f64> {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    let eintrag = |b: u32| wgpu::BindGroupLayoutEntry {
        binding: b,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[eintrag(0), eintrag(1)],
    });
    let gruppe = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(y_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(uv_view),
            },
        ],
    });
    let pipe_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&pipe_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            targets: &[Some(zielformat.into())],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });

    let ziel = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: zielformat,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let ziel_view = ziel.create_view(&Default::default());
    // Byte je Bildpunkt am Ziel: 4 bei Rgba8Unorm, 16 bei Rgba32Float. Bei
    // 64 Punkten Breite sind beide Zeilenlaengen (256 bzw. 1024) bereits auf
    // 256 ausgerichtet — die von wgpu geforderte Schranke ist also ohne
    // Zwischenzeile eingehalten.
    let bpp: u32 = if zielformat == wgpu::TextureFormat::Rgba32Float { 16 } else { 4 };
    let puffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (BREITE * HOEHE * bpp) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut enc = device.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &ziel_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &gruppe, &[]);
        pass.draw(0..3, 0..1);
    }
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &ziel,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &puffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(BREITE * bpp),
                rows_per_image: Some(HOEHE),
            },
        },
        wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);

    let slice = puffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let roh = slice.get_mapped_range().to_vec();
    let _ = slice;
    puffer.unmap();

    // In den Abtastraum [0,1] umrechnen, drei Kanaele je Bildpunkt. Damit
    // spielt es fuer den Vergleich keine Rolle mehr, welches Ziel gerade
    // gefahren wurde — und die Toleranz laesst sich am QUELL-Format
    // festmachen, wo sie hingehoert.
    let mut werte = Vec::with_capacity((BREITE * HOEHE * 3) as usize);
    for i in 0..(BREITE * HOEHE) as usize {
        for k in 0..3usize {
            let wert = if bpp == 16 {
                let a = i * 16 + k * 4;
                f32::from_le_bytes([roh[a], roh[a + 1], roh[a + 2], roh[a + 3]]) as f64
            } else {
                roh[i * 4 + k] as f64 / 255.0
            };
            werte.push(wert);
        }
    }
    werte
}
