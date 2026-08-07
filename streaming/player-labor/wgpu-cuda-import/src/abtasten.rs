//! Die wgpu-Seite: das fremde `VkImage` uebernehmen und **jeden** Bildpunkt
//! abtasten.
//!
//! Abgetastet wird mit `textureLoad`, nicht ueber einen Sampler. Das ist
//! Absicht: ein Sampler brauchte Filterregeln und Koordinatenrechnung, und
//! beides koennte einen Fehler erzeugen oder verdecken, der mit der Frage
//! nichts zu tun hat. `textureLoad` liefert genau den Texel an der ganzzahligen
//! Stelle.
//!
//! Zurueckgerechnet wird in **Codewerte**, nicht in Gleitkomma verglichen: die
//! Norm-Formate liefern `code / hoechster_code`, und ein Vergleich in
//! Codewerten ist fuer 8 wie 16 Bit derselbe und exakt. `f32` traegt 24 Bit
//! Mantisse, 16-Bit-Codes gehen dabei verlustfrei hin und zurueck.

use anyhow::{Context, Result};

use crate::ebene::Ebene;

/// Ein Abtaster je Ebene: Pipeline, Ausgabepuffer und Lesepuffer stehen
/// einmal und werden ueber alle Runden wiederverwendet.
pub struct Abtaster {
    pipeline: wgpu::ComputePipeline,
    ausgabe: wgpu::Buffer,
    lesen: wgpu::Buffer,
    /// Groesse beider Puffer. Einmal gerechnet und behalten, damit der
    /// Rueckkopier-Aufruf nicht dieselbe Rechnung ein zweites Mal anstellt —
    /// zwei Rechnungen, die auseinandergehen koennen, waeren hier ein
    /// stiller Teilvergleich.
    bytes: u64,
    breite: u32,
    hoehe: u32,
}

impl Abtaster {
    pub fn neu(device: &wgpu::Device, e: &Ebene) -> Self {
        // Der hoechste Codewert wird in den Shader eingebacken statt als
        // Uniform gebunden — eine Bindung weniger, die falsch sein koennte,
        // und die Pipeline entsteht ohnehin je Ebene neu.
        let quelltext = format!(
            r#"
@group(0) @binding(0) var bild: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> ausgabe: array<u32>;

@compute @workgroup_size(8, 8)
fn haupt(@builtin(global_invocation_id) gid: vec3<u32>) {{
    let masse = textureDimensions(bild);
    if (gid.x >= masse.x || gid.y >= masse.y) {{ return; }}
    let t = textureLoad(bild, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
    let hoechst = {hoechst}.0;
    let r = u32(round(t.r * hoechst));
    let g = u32(round(t.g * hoechst));
    // Beide Kanaele in ein Wort: halbiert den Rueckweg, und weil der zweite
    // Kanal bei einkanaligen Formaten fest 0 liefert, bleibt die Auswertung
    // fuer beide Faelle dieselbe.
    ausgabe[gid.y * masse.x + gid.x] = r | (g << 16u);
}}
"#,
            hoechst = e.hoechster_code
        );
        let modul = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("abtasten"),
            source: wgpu::ShaderSource::Wgsl(quelltext.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("abtasten"),
            layout: None,
            module: &modul,
            entry_point: Some("haupt"),
            compilation_options: Default::default(),
            cache: None,
        });

        let bytes = (e.texel() * 4) as u64;
        let ausgabe = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("codewerte"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let lesen = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("codewerte-lesen"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Self { pipeline, ausgabe, lesen, bytes, breite: e.breite, hoehe: e.hoehe }
    }

    /// Eine Ansicht abtasten und die Codewerte zurueckholen.
    pub fn lauf(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        ansicht: &wgpu::TextureView,
    ) -> Result<Vec<u32>> {
        let gruppe = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("abtasten"),
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(ansicht),
                },
                wgpu::BindGroupEntry { binding: 1, resource: self.ausgabe.as_entire_binding() },
            ],
        });
        let mut kodierer =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut durchgang =
                kodierer.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
            durchgang.set_pipeline(&self.pipeline);
            durchgang.set_bind_group(0, &gruppe, &[]);
            durchgang.dispatch_workgroups(self.breite.div_ceil(8), self.hoehe.div_ceil(8), 1);
        }
        kodierer.copy_buffer_to_buffer(&self.ausgabe, 0, &self.lesen, 0, self.bytes);
        queue.submit([kodierer.finish()]);

        let scheibe = self.lesen.slice(..);
        let (sender, empfaenger) = std::sync::mpsc::channel();
        scheibe.map_async(wgpu::MapMode::Read, move |r| {
            let _ = sender.send(r);
        });
        device.poll(wgpu::PollType::wait_indefinitely()).ok();
        empfaenger.recv().context("Abbildung des Lesepuffers kam nie zurueck")??;
        let daten = scheibe.get_mapped_range();
        let werte: Vec<u32> = daten
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        drop(daten);
        self.lesen.unmap();
        Ok(werte)
    }
}

/// Eine wgpu-eigene Textur mit demselben Inhalt fuellen — die Kontrolle, ob der
/// Abtastweg ueberhaupt etwas misst.
///
/// Ohne sie waere ein schwarzes Ergebnis nicht von „der Shader liest immer
/// Null" zu unterscheiden. Sie laeuft ueber `write_texture`, also ohne jede
/// fremde Speicherquelle, und muss deshalb IMMER stimmen.
pub fn eigene_textur(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    e: &Ebene,
    inhalt: &[u8],
) -> wgpu::Texture {
    let masse =
        wgpu::Extent3d { width: e.breite, height: e.hoehe, depth_or_array_layers: 1 };
    let textur = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("kontrolle-eigene-textur"),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: e.wgpu_format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &textur,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        inhalt,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(e.zeilenbytes() as u32),
            rows_per_image: Some(e.hoehe),
        },
        masse,
    );
    queue.submit([]);
    textur
}
