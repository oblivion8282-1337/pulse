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

use crate::decode::{ColorMatrix, DecodedFrame, PixelLayout};
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
    /// Ob die TEXTUREN 16 bit tragen. Bei `false` liegen die Daten trotz
    /// 10-bit-Quelle als 8 bit darin — der Shader darf dann nicht skalieren.
    wide: bool,
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
    /// Ob 16-bit-Norm-Texturen erlaubt sind (s. `setup::GpuSetup`).
    wide_textures: bool,
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
            wide_textures: gpu.wide_textures,
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
            // fp16 ist Fliesskomma: die Mantisse traegt nahe 1.0 rund 11 Bit, nicht
            // 16. Mit 65536 Stufen waere das Dither-Rauschen so schwach, dass es
            // das Banding der spaeteren Quantisierung durch den Compositor nicht
            // mehr aufbricht.
            wgpu::TextureFormat::Rgba16Float => 2048.0,
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
                || p.wide != (frame.ten_bit && self.wide_textures)
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

        let narrow = frame.ten_bit && !self.wide_textures;
        for (tex, w, h, plane_idx) in targets {
            let Some(idx) = plane_idx else { continue };
            let Some(source) = frame.planes.get(idx) else { continue };
            // Ohne 16-bit-Texturen die Quelle verkleinern statt abzustuerzen.
            let converted = narrow.then(|| narrow_plane(source, frame.format));
            let data: &[u8] = converted.as_deref().unwrap_or(source);
            let stride =
                if narrow { frame.strides[idx] / 2 } else { frame.strides[idx] };
            let bytes_per_sample: u32 = if narrow { 1 } else { bytes_per_sample };
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
        // 16-bit-Texturen nur, wenn die GPU sie erlaubt. Sonst werden die
        // Quelldaten beim Hochladen auf 8 bit heruntergerechnet.
        let wide = frame.ten_bit && self.wide_textures;
        let single = if wide {
            wgpu::TextureFormat::R16Unorm
        } else {
            wgpu::TextureFormat::R8Unorm
        };
        let chroma_format = match frame.format {
            PixelLayout::Planar420 => single,
            PixelLayout::BiPlanar420 if wide => wgpu::TextureFormat::Rg16Unorm,
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
            wide,
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
        matrix: ColorMatrix,
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
                // Modulo, damit die f32-Aufloesung nicht mit der Laufzeit zerfaellt:
                // nach ~18 h liegt der Abstand zweier darstellbarer Werte ueber
                // einem Frameintervall, das Rauschmuster wuerde einfrieren.
                (self.start.elapsed().as_secs_f64() % 3600.0) as f32,
            ],
            flags: [
                flag(planes.ten_bit),
                flag(full_range),
                flag(planes.layout == PixelLayout::BiPlanar420),
                sample_scale(planes.wide, planes.layout),
            ],
            output: [0.0, flag(matrix == ColorMatrix::Bt601), 0.0, 0.0],
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
    pub fn render(
        &mut self,
        opts: &PlayerOptions,
        full_range: bool,
        matrix: ColorMatrix,
    ) -> Result<()> {
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

        let uniforms = self.build_uniforms(opts, planes, full_range, matrix);
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
            // Ohne das fuellt das Vollbild-Dreieck immer das ganze Fenster und
            // zerrt das Bild bei jedem anderen Fensterverhaeltnis. Der Rest der
            // Flaeche bleibt in der Clear-Farbe (schwarz) stehen.
            let (vx, vy, vw, vh) = fit_viewport(
                self.config.width as f32,
                self.config.height as f32,
                planes.width as f32,
                planes.height as f32,
            );
            pass.set_viewport(vx, vy, vw, vh, 0.0, 1.0);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit(Some(encoder.finish()));
        surface_texture.present();
        self.frames_presented += 1;
        Ok(())
    }
}

/// Groesstes Rechteck mit dem Seitenverhaeltnis der Quelle, das ins Fenster
/// passt, mittig gesetzt. Ergebnis: `(x, y, breite, hoehe)` in Pixeln.
///
/// Der Zoom-Ausschnitt (`crop`) aendert daran nichts: er ist quadratisch in
/// normalisierten Koordinaten und behaelt damit das Verhaeltnis der Quelle.
fn fit_viewport(win_w: f32, win_h: f32, src_w: f32, src_h: f32) -> (f32, f32, f32, f32) {
    if win_w <= 0.0 || win_h <= 0.0 || src_w <= 0.0 || src_h <= 0.0 {
        return (0.0, 0.0, win_w.max(1.0), win_h.max(1.0));
    }
    let src_ratio = src_w / src_h;
    if win_w / win_h > src_ratio {
        // Fenster breiter als das Bild: links und rechts bleibt Rand.
        let w = win_h * src_ratio;
        ((win_w - w) * 0.5, 0.0, w, win_h)
    } else {
        let h = win_w / src_ratio;
        (0.0, (win_h - h) * 0.5, win_w, h)
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
fn narrow_plane(source: &[u8], layout: PixelLayout) -> Vec<u8> {
    // Planar (YUV420P10LE) legt die 10 Bit in die UNTEREN Bits, Wertebereich
    // 0..1023 -> zwei Bit abschneiden. P010 legt sie in die OBEREN, dort ist
    // das hohe Byte schon der richtige 8-bit-Wert.
    let planar = layout == PixelLayout::Planar420;
    source
        .chunks_exact(2)
        .map(|w| {
            let v = u16::from_le_bytes([w[0], w[1]]);
            if planar { (v >> 2) as u8 } else { (v >> 8) as u8 }
        })
        .collect()
}

/// Faktor fuer die Abtastwerte, abhaengig davon, wie die Daten in der TEXTUR
/// liegen — NICHT davon, was die Quelle war.
///
/// `wide_texture` heisst: die Textur traegt 16 bit. Wurde eine 10-bit-Quelle
/// beim Hochladen auf 8 bit heruntergerechnet (GPU ohne
/// `TEXTURE_FORMAT_16BIT_NORM`), darf nicht skaliert werden — sonst waere das
/// Bild um Faktor 64 zu hell.
fn sample_scale(wide_texture: bool, layout: PixelLayout) -> f32 {
    if wide_texture && layout == PixelLayout::Planar420 {
        f32::from(u16::MAX) / 1023.0
    } else {
        1.0
    }
}

#[cfg(test)]
mod viewport_tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.01
    }

    /// Passt das Verhaeltnis, fuellt das Bild das ganze Fenster.
    #[test]
    fn gleiches_verhaeltnis_fuellt_aus() {
        let (x, y, w, h) = fit_viewport(1920.0, 1080.0, 2560.0, 1440.0);
        assert!(close(x, 0.0) && close(y, 0.0), "kein Rand erwartet: {x},{y}");
        assert!(close(w, 1920.0) && close(h, 1080.0), "{w}x{h}");
    }

    /// Breiteres Fenster: Rand links und rechts, Hoehe voll ausgenutzt.
    #[test]
    fn breiteres_fenster_bekommt_seitliche_raender() {
        let (x, y, w, h) = fit_viewport(2000.0, 1000.0, 1920.0, 1080.0);
        assert!(close(h, 1000.0), "Hoehe voll ausnutzen: {h}");
        assert!(close(w, 1000.0 * 16.0 / 9.0), "Breite aus dem Verhaeltnis: {w}");
        assert!(close(x, (2000.0 - w) * 0.5), "mittig: {x}");
        assert!(close(y, 0.0), "oben/unten kein Rand: {y}");
        assert!(w <= 2000.0, "darf nicht ueberstehen");
    }

    /// Hoeheres Fenster: Rand oben und unten.
    #[test]
    fn hoeheres_fenster_bekommt_raender_oben_und_unten() {
        let (x, y, w, h) = fit_viewport(1000.0, 2000.0, 1920.0, 1080.0);
        assert!(close(w, 1000.0), "Breite voll ausnutzen: {w}");
        assert!(close(h, 1000.0 / (16.0 / 9.0)), "Hoehe aus dem Verhaeltnis: {h}");
        assert!(close(x, 0.0) && close(y, (2000.0 - h) * 0.5), "mittig: {x},{y}");
    }

    /// Das Verhaeltnis muss erhalten bleiben — das ist der ganze Zweck.
    #[test]
    fn verhaeltnis_bleibt_in_jedem_fenster_erhalten() {
        for (win_w, win_h) in [(640.0, 480.0), (3440.0, 1440.0), (800.0, 1200.0), (100.0, 99.0)] {
            let (_, _, w, h) = fit_viewport(win_w, win_h, 2560.0, 1440.0);
            assert!(close(w / h, 2560.0 / 1440.0), "{win_w}x{win_h} -> {w}x{h}");
            assert!(w <= win_w + 0.01 && h <= win_h + 0.01, "passt nicht: {w}x{h}");
        }
    }

    /// Ein Frame ohne Groesse darf keinen Nullviewport ergeben — wgpu lehnt
    /// den ab und der Zeichenaufruf wuerde scheitern.
    #[test]
    fn entartete_eingaben_liefern_gueltigen_viewport() {
        let (_, _, w, h) = fit_viewport(800.0, 600.0, 0.0, 0.0);
        assert!(w > 0.0 && h > 0.0, "{w}x{h}");
    }
}

#[cfg(test)]
mod scale_tests {
    use super::*;

    #[test]
    fn heruntergerechnete_planes_werden_nicht_skaliert() {
        // Ohne 16-bit-Texturen liegen die Daten als 8 bit in der Textur —
        // dann waere jede Skalierung falsch.
        assert!((sample_scale(false, PixelLayout::Planar420) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn narrow_plane_rechnet_je_layout_richtig_herunter() {
        // Planar: Werte in den unteren Bits, 0..1023 -> zwei Bit abschneiden.
        let planar = narrow_plane(&[0x00, 0x01, 0xFF, 0x03], PixelLayout::Planar420);
        assert_eq!(planar, vec![(0x0100u16 >> 2) as u8, (0x03FFu16 >> 2) as u8]);
        // P010: Werte in den oberen Bits -> hohes Byte ist der 8-bit-Wert.
        let p010 = narrow_plane(&[0x00, 0x40, 0x00, 0xFF], PixelLayout::BiPlanar420);
        assert_eq!(p010, vec![0x40, 0xFF]);
    }

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
