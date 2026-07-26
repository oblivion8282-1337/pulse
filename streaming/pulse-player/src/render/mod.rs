//! GPU-Darstellung ueber wgpu.
//!
//! Der Punkt der ganzen Uebung: die Swapchain wird auf ein Format **ueber
//! 8 bit** gelegt, wenn der Compositor eines anbietet — die Wahl selbst und
//! ihre Messgrundlage stehen in [`setup`]. Chromium legt seinen Wayland-Puffer
//! immer als `ABGR8888` an, obwohl KWin daneben 10- und 16-bit-Formate
//! anbietet; genau diese Wahl treffen wir hier anders.
//!
//! Bewusst kein libplacebo: das waere zwar der Renderer aus mpv und LGPL-faehig,
//! braeuchte aber FFI-Bindungen. Die hier benoetigte Verarbeitung (Farbmatrix,
//! Deband, Dither, Zoom) passt in einen WGSL-Shader, und wgpu ist MIT/Apache.

mod setup;
mod uniforms;

use anyhow::{anyhow, Result};
use std::sync::Arc;

use crate::decode::{DecodedFrame, PixelLayout};
use crate::proto::PlayerOptions;
use uniforms::Uniforms;

fn texture_binding(binding: u32, view: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
}

struct Planes {
    y: wgpu::Texture,
    u: wgpu::Texture,
    v: wgpu::Texture,
    width: u32,
    height: u32,
    layout: PixelLayout,
    ten_bit: bool,
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniform_buf: wgpu::Buffer,
    planes: Option<Planes>,
    bind_group: Option<wgpu::BindGroup>,
    frames_presented: u64,
    start: std::time::Instant,
}

impl Renderer {
    pub async fn new(
        window: Arc<winit::window::Window>,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        let gpu = setup::create(window, width, height).await?;
        Ok(Self {
            device: gpu.device,
            queue: gpu.queue,
            surface: gpu.surface,
            config: gpu.config,
            pipeline: gpu.pipeline,
            bind_layout: gpu.bind_layout,
            sampler: gpu.sampler,
            uniform_buf: gpu.uniform_buf,
            planes: None,
            bind_group: None,
            frames_presented: 0,
            start: std::time::Instant::now(),
        })
    }

    /// Name des tatsaechlich verhandelten Oberflaechenformats — geht in die
    /// Statistik, damit im Zweifel belegbar ist, dass mehr als 8 bit anliegen.
    pub fn surface_format(&self) -> String {
        format!("{:?}", self.config.format)
    }

    /// Stufenzahl des Ausgabeformats (2^Bits pro Kanal) fuer das Dither.
    fn output_levels(&self) -> f32 {
        match self.config.format {
            wgpu::TextureFormat::Rgba16Float => 65536.0,
            wgpu::TextureFormat::Rgb10a2Unorm => 1024.0,
            _ => 256.0,
        }
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    pub fn frames_presented(&self) -> u64 {
        self.frames_presented
    }

    /// Laedt ein dekodiertes Bild in die GPU-Texturen.
    pub fn upload(&mut self, frame: &DecodedFrame) {
        let needs_new = self.planes.as_ref().is_none_or(|p| {
            p.width != frame.width
                || p.height != frame.height
                || p.layout != frame.format
                || p.ten_bit != frame.ten_bit
        });
        if needs_new {
            self.planes = Some(self.create_planes(frame));
            self.bind_group = None;
        }
        let Some(planes) = self.planes.as_ref() else { return };

        let bytes_per_sample: u32 = if frame.ten_bit { 2 } else { 1 };
        let chroma_w = frame.width.div_ceil(2);
        let chroma_h = frame.height.div_ceil(2);

        // Die dritte Ebene bleibt bei verschraenktem UV ungenutzt — der Shader
        // liest sie dann nicht.
        let targets = match frame.format {
            PixelLayout::Planar420 => [
                (&planes.y, frame.width, frame.height, Some(0usize)),
                (&planes.u, chroma_w, chroma_h, Some(1)),
                (&planes.v, chroma_w, chroma_h, Some(2)),
            ],
            PixelLayout::BiPlanar420 => [
                (&planes.y, frame.width, frame.height, Some(0usize)),
                (&planes.u, chroma_w, chroma_h, Some(1)),
                (&planes.v, 1, 1, None),
            ],
        };

        for (tex, w, h, plane_idx) in targets {
            let Some(idx) = plane_idx else { continue };
            let Some(data) = frame.planes.get(idx) else { continue };
            let stride = frame.strides[idx];
            // verschraenktes UV traegt zwei Komponenten je Bildpunkt
            let components: u32 =
                if frame.format == PixelLayout::BiPlanar420 && idx == 1 { 2 } else { 1 };
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride as u32),
                    rows_per_image: Some(h),
                },
                wgpu::Extent3d {
                    width: w.min(stride as u32 / (bytes_per_sample * components)),
                    height: h,
                    depth_or_array_layers: 1,
                },
            );
        }
    }

    fn create_planes(&self, frame: &DecodedFrame) -> Planes {
        let single = if frame.ten_bit {
            wgpu::TextureFormat::R16Unorm
        } else {
            wgpu::TextureFormat::R8Unorm
        };
        let chroma_format = match frame.format {
            PixelLayout::Planar420 => single,
            PixelLayout::BiPlanar420 if frame.ten_bit => wgpu::TextureFormat::Rg16Unorm,
            PixelLayout::BiPlanar420 => wgpu::TextureFormat::Rg8Unorm,
        };
        let chroma_w = frame.width.div_ceil(2);
        let chroma_h = frame.height.div_ceil(2);
        Planes {
            y: self.make_texture(frame.width, frame.height, single, "y"),
            u: self.make_texture(chroma_w, chroma_h, chroma_format, "u"),
            v: self.make_texture(chroma_w, chroma_h, single, "v"),
            width: frame.width,
            height: frame.height,
            layout: frame.format,
            ten_bit: frame.ten_bit,
        }
    }

    fn make_texture(
        &self,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        label: &str,
    ) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    }

    fn build_uniforms(
        &self,
        opts: &PlayerOptions,
        planes: &Planes,
        full_range: bool,
    ) -> Uniforms {
        let zoom = opts.zoom.unwrap_or(1.0).max(1.0);
        let size = 1.0 / zoom;
        // Ausschnitt so verschieben, dass er im Bild bleibt.
        let origin_x = (opts.pan_x.unwrap_or(0.5) - size / 2.0).clamp(0.0, 1.0 - size);
        let origin_y = (opts.pan_y.unwrap_or(0.5) - size / 2.0).clamp(0.0, 1.0 - size);
        let flag = |on: bool| if on { 1.0 } else { 0.0 };

        Uniforms {
            crop: [origin_x, origin_y, size, size],
            params: [
                opts.deband.unwrap_or(0.0),
                flag(opts.dither.unwrap_or(true)),
                self.output_levels(),
                self.start.elapsed().as_secs_f32(),
            ],
            flags: [
                flag(planes.ten_bit),
                flag(full_range),
                flag(planes.layout == PixelLayout::BiPlanar420),
                sample_scale(planes.ten_bit, planes.layout),
            ],
        }
    }

    /// Holt das naechste Bild der Swapchain. `None` heisst "diesen Frame
    /// auslassen" — kein Fehler, das passiert bei jedem Resize.
    fn acquire(&self) -> Result<Option<wgpu::SurfaceTexture>> {
        use wgpu::CurrentSurfaceTexture as Cst;
        match self.surface.get_current_texture() {
            Cst::Success(t) | Cst::Suboptimal(t) => Ok(Some(t)),
            // Groesse/Zustand veraltet: neu konfigurieren, dann weiter.
            Cst::Outdated | Cst::Lost => {
                self.surface.configure(&self.device, &self.config);
                Ok(None)
            }
            // Verdeckt oder Zeitueberschreitung: nichts zu zeichnen.
            Cst::Occluded | Cst::Timeout => Ok(None),
            Cst::Validation => Err(anyhow!("Oberflaeche abgelehnt (Validation)")),
        }
    }

    /// Zeichnet den zuletzt hochgeladenen Frame mit den aktuellen Einstellungen.
    pub fn render(&mut self, opts: &PlayerOptions, full_range: bool) -> Result<()> {
        let Some(planes) = self.planes.as_ref() else { return Ok(()) };

        if self.bind_group.is_none() {
            let view = |t: &wgpu::Texture| t.create_view(&wgpu::TextureViewDescriptor::default());
            let (vy, vu, vv) = (view(&planes.y), view(&planes.u), view(&planes.v));
            self.bind_group = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pulse-player-bg"),
                layout: &self.bind_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.uniform_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    texture_binding(2, &vy),
                    texture_binding(3, &vu),
                    texture_binding(4, &vv),
                ],
            }));
        }

        let uniforms = self.build_uniforms(opts, planes, full_range);
        self.queue.write_buffer(&self.uniform_buf, 0, &uniforms.as_bytes());

        let Some(surface_texture) = self.acquire()? else { return Ok(()) };
        let view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pulse-player") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pulse-player-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
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
            pass.set_pipeline(&self.pipeline);
            if let Some(bg) = self.bind_group.as_ref() {
                pass.set_bind_group(0, bg, &[]);
            }
            pass.draw(0..3, 0..1);
        }
        self.queue.submit(Some(encoder.finish()));
        surface_texture.present();
        self.frames_presented += 1;
        Ok(())
    }
}

/// Faktor, mit dem ein als `*16Unorm` gelesener Abtastwert multipliziert
/// werden muss, um wieder in [0,1] zu liegen.
///
/// Der Unterschied ist leicht zu uebersehen und entscheidet ueber richtiges
/// gegen fast schwarzes Bild:
/// * `P010LE` (biplanar, kommt von NVDEC) legt die 10 Bit in die **oberen**
///   Bits eines 16-bit-Wortes. Als Unorm gelesen stimmt der Wert bereits.
/// * `YUV420P10LE` (planar, kommt von libdav1d/Software-Decode) legt sie in
///   die **unteren** Bits, Wertebereich 0..1023. Als Unorm gelesen waere das
///   um Faktor ~64 zu dunkel.
fn sample_scale(ten_bit: bool, layout: PixelLayout) -> f32 {
    if ten_bit && layout == PixelLayout::Planar420 {
        f32::from(u16::MAX) / 1023.0
    } else {
        1.0
    }
}

#[cfg(test)]
mod scale_tests {
    use super::*;

    #[test]
    fn zehn_bit_planar_wird_hochskaliert_biplanar_nicht() {
        // YUV420P10LE: Werte 0..1023 in den unteren Bits -> muss skaliert werden.
        let planar = sample_scale(true, PixelLayout::Planar420);
        assert!((planar - 65535.0 / 1023.0).abs() < 0.01, "planar: {planar}");
        // P010LE: Werte liegen bereits in den oberen Bits -> unveraendert.
        assert!((sample_scale(true, PixelLayout::BiPlanar420) - 1.0).abs() < f32::EPSILON);
        // 8 bit: nie skalieren.
        assert!((sample_scale(false, PixelLayout::Planar420) - 1.0).abs() < f32::EPSILON);
    }
}
