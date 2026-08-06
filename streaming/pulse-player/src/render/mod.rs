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

mod bildquelle;
mod farbe;
mod fremdbild;
mod hdr_fenster;
mod setup;
mod uniforms;

// Nur das, was der Messpfad wirklich braucht — nicht die ganzen Module.
pub use farbe::{build_uniforms, narrow_plane_into, output_levels, scales, Bildform};
pub use setup::{build_bind_group, build_graphics, geraet_oeffnen, pick_format, Graphics};
pub use uniforms::Uniforms;

use anyhow::{anyhow, Result};
use std::sync::Arc;

use bildquelle::{planes_anlegen, planes_fuellen, Bildquelle, Fremdform};
use crate::decode::{DecodedFrame, Farbangaben};
use crate::overlay::{Overlay, OverlayAction, StatsView};
use crate::proto::PlayerOptions;

pub fn texture_binding(binding: u32, view: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
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
    bild: Option<Bildquelle>,
    /// Eingehaengte Fremdtexturen samt ihrer Ebenen-Ansichten (Zero-Copy).
    fremdbilder: fremdbild::Fremdbilder,
    bind_group: Option<wgpu::BindGroup>,
    frames_presented: u64,
    /// Ob 16-bit-Norm-Texturen erlaubt sind (s. `setup::GpuSetup`).
    wide_textures: bool,
    /// Name des Oberflaechenformats fuer die Statistik (s. `surface_format`).
    surface_format_name: String,
    /// Wiederverwendete Puffer fuer `narrow_plane_into` (eine je Ebene).
    narrow_scratch: [Vec<u8>; 3],
    /// Durchgaenge, in denen die Oberflaeche kein Bild hergab (`Outdated`,
    /// `Lost`, `Occluded`, `Timeout`). Das Bild war dann schon aus `pending`
    /// entnommen und ist verloren, ohne irgendwo zu erscheinen — genau die
    /// Luecke, die `frames_never_drawn` nicht abdeckt. 0 heisst: Swapchain
    /// gesund.
    /// `Cell`, damit `acquire` weiter `&self` nimmt: `render` haelt zu diesem
    /// Zeitpunkt schon eine unveraenderliche Leihe auf `planes`.
    acquire_misses: std::cell::Cell<u64>,
    start: std::time::Instant,
    /// Alle Formate, die die Oberflaeche anbietet. Aufgehoben, weil der Wechsel
    /// auf HDR und zurueck (`farbraum_fuer_quelle`) die Liste wieder braucht —
    /// den Adapter dafuer festzuhalten waere deutlich mehr.
    angebotene_formate: Vec<wgpu::TextureFormat>,
    /// Fensterkennung (Windows). Fuer die Frage, ob der Schirm unter diesem
    /// Fenster in HDR laeuft; `0`, wo es keine gibt.
    hwnd: isize,
    /// Gibt das Fenster GERADE HDR aus? Nicht „koennte" — das hier ist das
    /// Ergebnis eines geglueckten `SetColorSpace1`, und nur darauf darf der
    /// Shader sich verlassen (s. `hdr_fenster`).
    hdr_fenster: bool,
    /// Was zuletzt gewuenscht war. Getrennt vom Ergebnis, damit ein
    /// fehlgeschlagener Versuch nicht bei jedem Bild wiederholt wird.
    hdr_gewuenscht: bool,
}

impl Renderer {
    pub async fn new(
        window: Arc<winit::window::Window>,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        let hwnd = hdr_fenster::fensterkennung(&window);
        let gpu = setup::create(window, width, height).await?;
        let surface_format_name = format!("{:?}", gpu.config.format);
        Ok(Self {
            angebotene_formate: gpu.angebotene_formate,
            hwnd,
            hdr_fenster: false,
            hdr_gewuenscht: false,
            device: gpu.device,
            queue: gpu.queue,
            surface: gpu.surface,
            config: gpu.config,
            pipeline: gpu.pipeline,
            bind_layout: gpu.bind_layout,
            sampler: gpu.sampler,
            uniform_buf: gpu.uniform_buf,
            bild: None,
            fremdbilder: fremdbild::Fremdbilder::neu(),
            bind_group: None,
            frames_presented: 0,
            wide_textures: gpu.wide_textures,
            surface_format_name,
            narrow_scratch: Default::default(),
            acquire_misses: std::cell::Cell::new(0),
            start: std::time::Instant::now(),
        })
    }

    /// Name des tatsaechlich verhandelten Oberflaechenformats — geht in die
    /// Statistik, damit im Zweifel belegbar ist, dass mehr als 8 bit anliegen.
    ///
    /// Einmal beim Anlegen gebildet, nicht je Abfrage: das Format steht nach der
    /// Verhandlung fest, und die Statistik wird pro Bild gelesen.
    pub fn surface_format(&self) -> &str {
        &self.surface_format_name
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.konfigurieren();
    }

    pub fn frames_presented(&self) -> u64 {
        self.frames_presented
    }

    pub fn acquire_misses(&self) -> u64 {
        self.acquire_misses.get()
    }

    /// Laedt ein dekodiertes Bild in die GPU-Texturen.
    ///
    /// **Traegt das Bild eine Fremdtextur, wird hier gar nichts geladen** — es
    /// liegt schon im Grafikspeicher, und der ganze Zweck dieses Weges ist,
    /// dass es dort bleibt (s. [`crate::zerocopy`]).
    pub fn upload(&mut self, frame: &DecodedFrame) {
        if let Some(gpu) = frame.gpu.as_ref() {
            if self.fremdbild_binden(frame, gpu) {
                return;
            }
            // Der Import ist nicht moeglich (falsches Backend, fehlendes
            // Merkmal). Der Decoder haette dann eigentlich gar nicht erst
            // umgestellt — aber ein leeres Bild zu zeichnen waere schlimmer als
            // eines auszulassen.
            return;
        }
        if !self.bild.as_ref().is_some_and(|b| b.passt_zu(frame, self.wide_textures)) {
            self.bild =
                Some(Bildquelle::Eigen(planes_anlegen(&self.device, frame, self.wide_textures)));
            self.bind_group = None;
        }
        let Some(Bildquelle::Eigen(planes)) = self.bild.as_ref() else { return };
        planes_fuellen(
            &self.queue,
            planes,
            frame,
            self.wide_textures,
            &mut self.narrow_scratch,
        );
    }

    /// Ein Fremdbild einhaengen und binden. `false` heisst: geht nicht, der
    /// Aufrufer laesst das Bild aus.
    ///
    /// **Die Bindegruppe entsteht bei JEDEM Bild neu**, und das ist kein
    /// Versehen: der Ring rotiert je Bild, die Ansichten sind also andere. Der
    /// Import selbst laeuft nur einmal je Ringplatz (Zwischenspeicher in
    /// `fremdbild`); was hier je Bild anfaellt, ist das Schreiben von drei
    /// Deskriptoren.
    fn fremdbild_binden(
        &mut self,
        frame: &DecodedFrame,
        gpu: &std::sync::Arc<crate::zerocopy::GpuBild>,
    ) -> bool {
        let (tw, th) = gpu.textur_masse();
        if tw == 0 || th == 0 || frame.width == 0 || frame.height == 0 {
            return false;
        }
        let Some(ansichten) = self.fremdbilder.binden(&self.device, gpu) else {
            return false;
        };
        self.bind_group = Some(setup::bind_group_aus_teilen(
            &self.device,
            &self.bind_layout,
            &self.sampler,
            &self.uniform_buf,
            ansichten,
        ));
        self.bild = Some(Bildquelle::Fremd(Fremdform {
            width: frame.width,
            height: frame.height,
            ten_bit: frame.ten_bit,
            nutzanteil: [frame.width as f32 / tw as f32, frame.height as f32 / th as f32],
        }));
        true
    }

    fn build_uniforms(
        &self,
        opts: &PlayerOptions,
        form: Bildform,
        full_range: bool,
        farbe: Farbangaben,
    ) -> Uniforms {
        build_uniforms(
            self.config.format,
            form,
            opts,
            full_range,
            farbe,
            self.hdr_fenster,
            // Modulo, damit die f32-Aufloesung nicht mit der Laufzeit zerfaellt:
            // nach ~18 h liegt der Abstand zweier darstellbarer Werte ueber
            // einem Frameintervall, das Rauschmuster wuerde einfrieren.
            (self.start.elapsed().as_secs_f64() % 3600.0) as f32,
        )
    }

    /// Holt das naechste Bild der Swapchain. `None` heisst "diesen Frame
    /// auslassen" — kein Fehler, das passiert bei jedem Resize.
    fn acquire(&self) -> Result<Option<wgpu::SurfaceTexture>> {
        use wgpu::CurrentSurfaceTexture as Cst;
        match self.surface.get_current_texture() {
            Cst::Success(t) | Cst::Suboptimal(t) => Ok(Some(t)),
            // Groesse/Zustand veraltet: neu konfigurieren, dann weiter.
            Cst::Outdated | Cst::Lost => {
                self.acquire_misses.set(self.acquire_misses.get() + 1);
                // Direkt statt ueber `konfigurieren`: `acquire` haelt nur `&self`
                // (s. `acquire_misses`). Der Farbraum wird deshalb hier NICHT
                // neu angemeldet — er kommt beim naechsten `resize` oder
                // `farbraum_fuer_quelle` zurueck. Ein Bild in SDR-Deutung
                // waehrend eines Fensterwechsels ist hinnehmbar; die Alternative
                // waere, `render` und `acquire` auf `&mut self` umzustellen.
                self.surface.configure(&self.device, &self.config);
                Ok(None)
            }
            // Verdeckt oder Zeitueberschreitung: nichts zu zeichnen.
            Cst::Occluded | Cst::Timeout => {
                self.acquire_misses.set(self.acquire_misses.get() + 1);
                Ok(None)
            }
            Cst::Validation => Err(anyhow!("Oberflaeche abgelehnt (Validation)")),
        }
    }

    /// Das GPU-Geraet — das Overlay zeichnet in dieselbe Oberflaeche und legt
    /// darauf seine eigenen Puffer an.
    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    pub fn surface_texture_format(&self) -> wgpu::TextureFormat {
        self.config.format
    }

    /// Zeichnet den zuletzt hochgeladenen Frame mit den aktuellen Einstellungen.
    ///
    /// `overlay` wird NACH dem Bild in dieselbe Oberflaechen-Textur gezeichnet
    /// (mit `LoadOp::Load`), bevor sie praesentiert wird — die Bedienoberflaeche
    /// liegt also im selben 10-bit-Puffer und kostet keinen zweiten Durchgang
    /// durch den Compositor.
    pub fn render(
        &mut self,
        opts: &PlayerOptions,
        full_range: bool,
        farbe: Farbangaben,
        overlay: Option<&mut OverlayPass<'_>>,
    ) -> Result<()> {
        let Some(quelle) = self.bild.as_ref() else { return Ok(()) };
        let form = quelle.form();
        let (bild_w, bild_h) = quelle.masse();

        if self.bind_group.is_none() {
            let Some(Bildquelle::Eigen(planes)) = self.bild.as_ref() else { return Ok(()) };
            let view = |t: &wgpu::Texture| t.create_view(&wgpu::TextureViewDescriptor::default());
            let (vy, vu, vv) = (view(&planes.y), view(&planes.u), view(&planes.v));
            self.bind_group = Some(setup::bind_group_aus_teilen(
                &self.device,
                &self.bind_layout,
                &self.sampler,
                &self.uniform_buf,
                [&vy, &vu, &vv],
            ));
        }

        let uniforms = self.build_uniforms(opts, form, full_range, farbe);
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
                bild_w as f32,
                bild_h as f32,
            );
            pass.set_viewport(vx, vy, vw, vh, 0.0, 1.0);
            pass.draw(0..3, 0..1);
        }
        // Bedienoberflaeche darueber, in dieselbe Textur. Die ausgeloesten
        // Aktionen gibt der Aufrufer weiter — der Renderer kennt weder Sitzung
        // noch Fenster.
        if let Some(op) = overlay {
            let size = (self.config.width, self.config.height);
            op.actions = op.overlay.paint(
                op.window,
                &self.device,
                &self.queue,
                &mut encoder,
                &view,
                size,
                op.is_fullscreen,
                op.stats,
            );
        }
        self.queue.submit(Some(encoder.finish()));
        // **Den Ringplatz erst freigeben, wenn die GPU ihn nicht mehr liest.**
        // Der `DecodedFrame` ist zu diesem Zeitpunkt laengst verworfen (das
        // Fenster laesst ihn direkt nach `upload` fallen); ohne diese zweite
        // Referenz schriebe der Decoder in die Textur, aus der gerade gezeichnet
        // wird — sichtbar als flackernder Riss quer durchs Bild.
        if let Some(gehalten) = self.fremdbilder.gehalten() {
            self.queue.on_submitted_work_done(move || drop(gehalten));
        }
        surface_texture.present();
        self.frames_presented += 1;
        Ok(())
    }
}

/// Was der Renderer braucht, um das Overlay mitzuzeichnen — und der Rueckkanal
/// fuer die ausgeloesten Aktionen (`actions` ist nach dem Aufruf gefuellt).
pub struct OverlayPass<'a> {
    pub overlay: &'a mut Overlay,
    pub window: &'a winit::window::Window,
    pub is_fullscreen: bool,
    pub stats: &'a StatsView<'a>,
    pub actions: Vec<OverlayAction>,
}

impl<'a> OverlayPass<'a> {
    pub fn new(
        overlay: &'a mut Overlay,
        window: &'a winit::window::Window,
        is_fullscreen: bool,
        stats: &'a StatsView<'a>,
    ) -> Self {
        Self { overlay, window, is_fullscreen, stats, actions: Vec::new() }
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

