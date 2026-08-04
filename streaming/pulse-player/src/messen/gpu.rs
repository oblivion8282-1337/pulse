//! Headless-Durchgang durch die ECHTE Render-Pipeline, mit Rueckgabe der
//! gezeichneten Bildpunkte.
//!
//! Kein Fenster, keine Swapchain — sonst nichts anders. Geteilt mit dem
//! Fenster sind Geraeteanforderung ([`geraet_oeffnen`]), Pipeline
//! ([`build_graphics`]), Bindungen ([`build_bind_group`]), der Uniform-Block
//! ([`build_uniforms`]) und das Herunterrechnen ([`narrow_plane_into`]). Das
//! ist der ganze Zweck der Uebung: ein Nachbau haette den Nachbau gemessen,
//! und genau daran ist die numpy-Nachrechnung vom 2026-08-04 gescheitert (sie
//! liess Deband und Dither weg, also zwei von vier Shader-Stufen).

use std::collections::HashMap;

use anyhow::{Context, Result};

use super::pixel::{bytes_pro_punkt, rot_kanal};
use crate::decode::{ColorMatrix, PixelLayout};
use crate::proto::PlayerOptions;
use crate::render::{
    build_bind_group, build_graphics, build_uniforms, geraet_oeffnen, narrow_plane_into, scales,
    Bildform, Graphics,
};

/// Ein dekodiertes Einzelbild in planarer Form, so wie es der Software-Decoder
/// abliefert (`YUV420P10LE`).
pub struct Quelle {
    pub breite: u32,
    pub hoehe: u32,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
    /// Voller Wertebereich (`pc`) statt begrenztem (`tv`).
    pub voller_bereich: bool,
}

/// Was an einem Lauf verstellt wird — der Rest kommt aus den Vorgaben.
pub struct Lauf {
    pub format: wgpu::TextureFormat,
    pub deband: f32,
    pub dither: bool,
}

/// Rote Komponente je Bildpunkt, auf 0..1 normiert.
///
/// Rot genuegt: das Testbild ist farblos (Chroma auf der Mitte), R, G und B
/// tragen dort denselben Wert. Normiert statt roh, damit sich 8-, 10- und
/// 16-bit-Ausgaben ueberhaupt vergleichen lassen — die Stufenzahl zaehlt der
/// Aufrufer auf dem jeweiligen Raster.
pub struct Ausgabe {
    pub werte: Vec<f32>,
    pub breite: usize,
    pub hoehe: usize,
}

/// GPU, hochgeladenes Bild und die Pipelines — alles, was ueber mehrere Laeufe
/// gleich bleibt.
///
/// Dass die Texturen hier liegen und nicht in [`Messstand::zeichnen`], ist
/// kein Feinschliff: der Bildinhalt haengt nicht am Zielformat, und bei
/// 2560x1440 in 10 bit sind es 11 MB je Lauf. Sechs Laeufe hiessen 55 MB
/// umsonst geschoben und fuenf Shader-Uebersetzungen zuviel.
pub struct Messstand {
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Ob `R16Unorm`/`Rg16Unorm` erlaubt sind — dieselbe Bedingung, unter der
    /// der Player 10-bit-Quellen NICHT auf 8 bit herunterrechnet.
    pub breite_texturen: bool,
    pub adaptername: String,
    breite: u32,
    hoehe: u32,
    voller_bereich: bool,
    form: Bildform,
    ebenen: [wgpu::Texture; 3],
    /// Je Zielformat einmal uebersetzt.
    pipelines: HashMap<wgpu::TextureFormat, Graphics>,
}

impl Messstand {
    pub async fn aufbauen(q: &Quelle) -> Result<Self> {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .context("keine GPU gefunden")?;
        let info = adapter.get_info();
        let adaptername = format!("{} ({:?}, {})", info.name, info.backend, info.driver);
        let (device, queue, breite_texturen) =
            geraet_oeffnen(&adapter, "pulse-player-messung").await?;

        // Die Quelle ist immer planares 10 bit (s. Modul-Doku von `super`).
        let form = Bildform {
            layout: PixelLayout::Planar420,
            ten_bit: true,
            wide: breite_texturen,
        };
        let ebenen = hochladen(&device, &queue, form, q);
        Ok(Self {
            device,
            queue,
            breite_texturen,
            adaptername,
            breite: q.breite,
            hoehe: q.hoehe,
            voller_bereich: q.voller_bereich,
            form,
            ebenen,
            pipelines: HashMap::new(),
        })
    }

    /// Zeichnet das Bild 1:1 in eine Textur des gewuenschten Formats und liest
    /// sie zurueck.
    ///
    /// 1:1 ist Bedingung, nicht Bequemlichkeit: bei abweichender Zielgroesse
    /// interpoliert der Sampler (`FilterMode::Linear`) zwischen Texeln und
    /// erzeugt Zwischenwerte, die es im Bild gar nicht gibt. Die Stufenzahl
    /// waere dann ein Ergebnis der Skalierung, nicht der Bittiefe.
    pub fn zeichnen(&mut self, lauf: &Lauf) -> Result<Ausgabe> {
        let (w, h) = (self.breite, self.hoehe);
        let device = &self.device;
        let gfx = self
            .pipelines
            .entry(lauf.format)
            .or_insert_with(|| build_graphics(device, lauf.format));

        // Genau der Uniform-Block des Fensters. `zeit` (das Rauschmuster des
        // Dithers) steht fest auf 0, damit zwei Laeufe vergleichbar sind.
        let opts = PlayerOptions {
            deband: Some(lauf.deband),
            dither: Some(lauf.dither),
            ..Default::default()
        };
        let uniforms = build_uniforms(
            lauf.format,
            self.form,
            &opts,
            self.voller_bereich,
            ColorMatrix::Bt709,
            0.0,
        );
        self.queue.write_buffer(&gfx.uniform_buf, 0, &uniforms.as_bytes());

        let ziel = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("messung-ziel"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: lauf.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        let ansicht = |t: &wgpu::Texture| t.create_view(&wgpu::TextureViewDescriptor::default());
        let [vy, vu, vv] = std::array::from_fn(|i| ansicht(&self.ebenen[i]));
        let bind = build_bind_group(&self.device, gfx, [&vy, &vu, &vv]);

        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("messung") });
        {
            let zielansicht = ansicht(&ziel);
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("messung-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &zielansicht,
                    resolve_target: None,
                    depth_slice: None,
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
            pass.set_pipeline(&gfx.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit(Some(enc.finish()));

        let werte = self.zurueck_lesen(&ziel, lauf.format)?;
        Ok(Ausgabe { werte, breite: w as usize, hoehe: h as usize })
    }

    /// Die gezeichnete Textur in den Hauptspeicher holen und den roten Kanal
    /// herausziehen.
    fn zurueck_lesen(
        &self,
        ziel: &wgpu::Texture,
        format: wgpu::TextureFormat,
    ) -> Result<Vec<f32>> {
        let (w, h) = (self.breite, self.hoehe);
        let bpp = bytes_pro_punkt(format);
        // `copy_texture_to_buffer` verlangt 256-Byte-Zeilen.
        let zeile = (w * bpp).div_ceil(256) * 256;
        let lese = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("messung-lesepuffer"),
            size: u64::from(zeile) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ruecklesen") });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: ziel,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &lese,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(zeile),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.queue.submit(Some(enc.finish()));

        let slice = lese.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .context("GPU-Warten fehlgeschlagen")?;
        rx.recv().context("Lesepuffer nie fertig")?.context("Lesepuffer nicht abbildbar")?;

        let roh = slice.get_mapped_range();
        let werte = rot_kanal(&roh, format, w as usize, h as usize, zeile as usize);
        drop(roh);
        lese.unmap();
        Ok(werte)
    }

    /// Der Massstab, mit dem der Shader gerade rechnet — fuer die Ausgabe des
    /// Werkzeugs, damit die Zahlen einer Messung zuordenbar bleiben.
    pub fn code_massstab(&self) -> f32 {
        scales(self.form.wide, self.form.layout).1
    }
}

/// Die drei Ebenen als Texturen — dieselben Formate und dasselbe
/// Herunterrechnen wie `Renderer::create_planes`/`upload`.
///
/// Frei statt Methode, weil sie den [`Messstand`] erst mit aufbaut.
fn hochladen(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    form: Bildform,
    q: &Quelle,
) -> [wgpu::Texture; 3] {
    let breit = form.wide;
    let format = if breit { wgpu::TextureFormat::R16Unorm } else { wgpu::TextureFormat::R8Unorm };
    let bps = if breit { 2 } else { 1 };
    let (cw, ch) = (q.breite.div_ceil(2), q.hoehe.div_ceil(2));
    let mut scratch = Vec::new();

    let mut mach = |w: u32, h: u32, quelle: &[u8], name: &str| {
        // Ohne 16-bit-Texturen rechnet der Player die Quelle beim Hochladen
        // herunter; hier derselbe Schritt, sonst waere dieser Fall gar nicht
        // messbar.
        let daten: &[u8] = if breit {
            quelle
        } else {
            narrow_plane_into(quelle, form.layout, &mut scratch);
            &scratch
        };
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(name),
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            daten,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * bps),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        tex
    };
    [mach(q.breite, q.hoehe, &q.y, "y"), mach(cw, ch, &q.u, "u"), mach(cw, ch, &q.v, "v")]
}
