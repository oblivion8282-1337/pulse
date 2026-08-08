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

mod abdruck;
mod ausgabe;
mod bildquelle;
// `pub(crate)`, weil die Linux-Zero-Copy-Bruecke ihre Ebenen-Formate GEGEN
// diese hier prueft (`zerocopy::linux::ebene`). Sie stehen in zwei
// Dateien, und eine Abweichung saehe man nicht als Fehler, sondern als falsche
// Farben — der Test dort ist die einzige Stelle, die es bemerken kann.
pub(crate) mod farbe;
mod fremdbild;
mod hdr_fenster;
mod musterprobe;
mod setup;
mod uniforms;

// Nur das, was der Messpfad wirklich braucht — nicht die ganzen Module.
pub use ausgabe::OverlayPass;
pub use farbe::{build_uniforms, narrow_plane_into, output_levels, scales, Bildform};
// Die Farbmessung muss GENAU das HDR-Format pruefen, das das Fenster nimmt —
// mit einer eigenen Eintragung meldete sie nach einem Wechsel hier „ok" fuer
// ein Format, das gar nicht mehr benutzt wird.
pub use hdr_fenster::HDR_OBERFLAECHE;
pub use setup::{bind_group_aus_teilen, build_graphics, geraet_oeffnen, pick_format, Graphics};
pub use uniforms::Uniforms;

use anyhow::{anyhow, Result};
use std::sync::Arc;

use ausgabe::fit_viewport;
use bildquelle::{planes_anlegen, planes_fuellen, Bildquelle, Fremdform};
use crate::decode::{DecodedFrame, Farbangaben};
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
    /// Rechnet den Fingerabdruck der Fremdbilder fuer den Einfrier-Waechter
    /// (s. [`abdruck`]). Nur auf dem Zero-Copy-Weg im Einsatz; auf dem Weg
    /// ueber den Hauptspeicher liest der Waechter die Ebenen selbst.
    abdruckwerk: abdruck::Abdruckwerk,
    /// Holt die vier Musterzeilen der Latenz-Sonde aus der eingehaengten
    /// Textur zurueck (s. [`musterprobe`]). **`None` ohne
    /// `PULSE_PLAYER_LATENCY_PROBE=1`** — dann wird dafuer kein einziger Befehl
    /// abgesetzt.
    musterprobe: Option<musterprobe::Musterprobe>,
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
    /// Die letzte Antwort auf „laeuft der Schirm in HDR" samt Alter. Ohne sie
    /// liefe bei jedem Bild eines PQ-Stroms eine DXGI-Aufzaehlung.
    schirmwissen: hdr_fenster::Schirmwissen,
    /// Wartet ein frisch eingehaengtes Fremdbild auf seinen Fingerabdruck?
    /// Ohne dieses Merkmal bekaeme ein Durchgang ohne neues Bild (Bedienleiste,
    /// Mausbewegung) einen zweiten Abdruck desselben Bildes, und der
    /// Einfrier-Waechter zaehlte eine Unveraenderlichkeit, die es nicht gab.
    abdruck_faellig: bool,
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
        // Vor dem Struktur-Ausdruck: dort wandert `gpu.device` in das Feld
        // `device`, und danach ist es nicht mehr auszuleihen.
        let fremdbilder = fremdbild::Fremdbilder::neu(&gpu.device);
        let abdruckwerk = abdruck::Abdruckwerk::neu(&gpu.device);
        let musterprobe = musterprobe::Musterprobe::neu_wenn_gebraucht(&gpu.device);
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
            fremdbilder,
            abdruckwerk,
            musterprobe,
            bind_group: None,
            frames_presented: 0,
            wide_textures: gpu.wide_textures,
            surface_format_name,
            narrow_scratch: Default::default(),
            acquire_misses: std::cell::Cell::new(0),
            start: std::time::Instant::now(),
            schirmwissen: Default::default(),
            abdruck_faellig: false,
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

    /// Ein Satz fertig abgeholter Musterzeilen fuer die Latenz-Sonde.
    ///
    /// **Abgeholt statt hineingereicht**: der Renderer kennt die Sonde nicht und
    /// soll sie nicht kennen — sie ist ein Messwerkzeug, kein Betriebsteil.
    pub fn musterzeilen_nehmen(&mut self) -> Option<crate::probe::Musterzeilen> {
        self.musterprobe.as_mut()?.nehmen()
    }

    /// Laedt ein dekodiertes Bild in die GPU-Texturen.
    ///
    /// **Traegt das Bild eine Fremdtextur, wird hier gar nichts geladen** — es
    /// liegt schon im Grafikspeicher, und der ganze Zweck dieses Weges ist,
    /// dass es dort bleibt (s. [`crate::zerocopy`]).
    pub fn upload(&mut self, frame: &DecodedFrame) {
        if let Some(gpu) = frame.gpu.as_ref() {
            self.fremdbild_binden(frame, gpu);
            return;
        }
        let passt = match self.bild.as_ref() {
            Some(Bildquelle::Eigen(p)) => p.passt_zu(frame, self.wide_textures),
            // Nichts da, oder zuletzt lag ein Fremdbild an: Texturen anlegen.
            _ => false,
        };
        if !passt {
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

    /// Ein Fremdbild einhaengen und binden.
    ///
    /// **Geht das nicht, wird der ganze Weg abgeschaltet, nicht nur dieses Bild
    /// ausgelassen.** Die Gruende sind allesamt bleibend (anderes Backend,
    /// fehlendes Merkmal, anderer Adapter unter FFmpeg als unter wgpu), der
    /// Decoder lieferte also weiter GPU-Bilder, die hier allesamt liegenblieben:
    /// ein schwarzes Fenster bei 0 Bildern je Sekunde. Der Rueckkanal ist
    /// [`crate::zerocopy::abschalten`].
    ///
    /// **Hier stand bis zum 2026-08-06 „und weil auf diesem Weg auch der
    /// Einfrier-Waechter nicht arbeitet, meldete es niemand". Das ist seit dem
    /// Fingerabdruck auf der GPU ([`abdruck`]) falsch** — der Waechter arbeitet
    /// jetzt auch hier, und bliebe der Abdruck aus, gaebe der Decoder den Weg
    /// von sich aus auf (`einfrieren::Zulauf`). Die Meldung an dieser Stelle
    /// bleibt trotzdem: sie nennt die Ursache, wo der Zulauf nur die Wirkung
    /// sieht.
    fn fremdbild_binden(
        &mut self,
        frame: &DecodedFrame,
        gpu: &std::sync::Arc<crate::zerocopy::GpuBild>,
    ) {
        // Feldweise leihen, und in einem eigenen Block: `fremdbilder` wird
        // veraendert und danach gelesen, waehrend `abdruckwerk` gleichzeitig
        // veraendert wird — ueber `self` waere das dem Borrow-Checker nicht zu
        // vermitteln. Der Block endet die Leihen, bevor unten wieder `self`
        // beschrieben wird.
        {
            let Self {
                device, fremdbilder, abdruckwerk, bind_layout, sampler, uniform_buf, ..
            } = self;
            let teile = fremdbild::Bindeteile { layout: bind_layout, sampler, uniform_buf };
            if fremdbilder.binden(device, &teile, gpu, abdruckwerk).is_none() {
                crate::zerocopy::abschalten("der Renderer kann die Textur nicht einhaengen");
                return;
            }
        }
        // Den Fingerabdruck **vormerken**, nicht rechnen: gerechnet wird er im
        // Kommandopuffer des Zeichendurchgangs, was die zweite Abgabe an die
        // GPU-Warteschlange spart (Kopf von [`abdruck`]).
        self.abdruck_faellig = true;
        // Die Bindegruppe liegt im Zwischenspeicher (eine je Ringplatz); hier
        // wird nur noch vermerkt, welche gerade gilt.
        self.bind_group = None;
        self.bild = Some(Bildquelle::Fremd(Fremdform {
            gpu: gpu.clone(),
            width: frame.width,
            height: frame.height,
            layout: frame.format,
        }));
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

        // Die eigenen Ebenen brauchen ihre Bindegruppe hier; ein Fremdbild
        // bringt seine aus dem Zwischenspeicher mit (eine je Ringplatz).
        if let Bildquelle::Eigen(planes) = quelle {
            if self.bind_group.is_none() {
                let view =
                    |t: &wgpu::Texture| t.create_view(&wgpu::TextureViewDescriptor::default());
                let (vy, vu, vv) = (view(&planes.y), view(&planes.u), view(&planes.v));
                self.bind_group = Some(setup::bind_group_aus_teilen(
                    &self.device,
                    &self.bind_layout,
                    &self.sampler,
                    &self.uniform_buf,
                    [&vy, &vu, &vv],
                ));
            }
        }

        // Welche Bindegruppe gilt, welcher Ringplatz noch gehalten werden muss
        // — und, beim Fremdbild, gleich alles fuer den Fingerabdruck. **In
        // EINEM Zugriff**: es ist dieselbe Fallunterscheidung und dieselbe
        // Suche ueber dasselbe Handle, zweimal gefragt liefen die Arme beim
        // naechsten `Bildquelle`-Zweig auseinander.
        // (`muster_bild` gehoert dazu: die Latenz-Sonde holt ihre Zeilen aus
        // derselben Luma-Seite, s. [`musterprobe`].)
        let (gebundene, zu_halten, abdruck_auftrag, muster_bild) = match self.bild.as_ref() {
            Some(Bildquelle::Fremd(f)) => (
                self.fremdbilder.bindegruppe(f.gpu.handle()),
                Some(f.gpu.clone()),
                (self.fremdbilder.abdruckgruppe(f.gpu.handle()))
                    .map(|b| (b, abdruck::Bildangabe::vom_fremdbild(f), f.gpu.briefkasten())),
                Some((f.gpu.handle(), f.gpu.zehn_bit())),
            ),
            _ => (self.bind_group.as_ref(), None, None, None),
        };

        let uniforms = self.build_uniforms(opts, form, full_range, farbe);
        self.queue.write_buffer(&self.uniform_buf, 0, &uniforms.as_bytes());

        let acq_uhr = std::time::Instant::now();
        let Some(surface_texture) = self.acquire()? else {
            // Kein Ziel zum Zeichnen (verdeckt, minimiert, Zeitueberschreitung,
            // Oberflaeche wird neu aufgesetzt) — also auch kein Abdruck, denn
            // der entsteht erst weiter unten im Kommandopuffer dieses
            // Durchgangs. Dem Zulauf auf der Decoder-Seite sieht das genauso
            // aus wie ein toter Rueckweg; ohne diese Meldung gaebe er nach
            // fuenf Sekunden Minimierung den Zero-Copy-Weg **prozessweit und
            // dauerhaft** auf (Befund 11 vom 2026-08-08).
            if let Some((_, _, kasten)) = &abdruck_auftrag {
                kasten.ohne_oberflaeche_melden();
            }
            return Ok(());
        };
        {
            let us = acq_uhr.elapsed().as_micros() as u64;
            use crate::app::diagnose as dg;
            dg::hoch(&dg::ACQ_SUM_US, us);
            dg::hoechstens(&dg::ACQ_MAX_US, us);
        }
        let enc_uhr = std::time::Instant::now();
        let view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("pulse-player") });
        // Das `take` raeumt die Vormerkung auch dann ab, wenn nichts
        // aufzuzeichnen ist; sonst holte der naechste Durchgang ein laengst
        // ersetztes Bild nach. **Einmal genommen, von BEIDEN Werken benutzt** —
        // sie stellen dieselbe Frage („ist das ein neues Bild?"), und zwei
        // Merkmale dafuer koennten auseinanderlaufen.
        let neues_bild = std::mem::take(&mut self.abdruck_faellig);
        // Der Fingerabdruck des Einfrier-Waechters, **vor** dem Zeichnen und im
        // SELBEN Kommandopuffer (s. [`abdruck`]) — er liest dieselbe Luma-Ebene,
        // aus der gleich gezeichnet wird, beides nur lesend. Die Musterzeilen
        // der Latenz-Sonde fahren aus demselben Grund darin mit.
        //
        // Beide Werke haengen an DERSELBEN Bedingung, und sie steht deshalb an
        // beiden Stellen gleich: `.filter(|_| neues_bild)`.
        let mut abdruck_platz = None;
        if let Some((bindung, bild, kasten)) = abdruck_auftrag.filter(|_| neues_bild) {
            let teile = abdruck::Werkteile { device: &self.device, queue: &self.queue, bindung };
            abdruck_platz = self.abdruckwerk.aufzeichnen(&mut encoder, teile, bild, kasten);
        }
        let muster_platz = musterprobe::aufzeichnen_wenn_noetig(
            &mut self.musterprobe,
            &self.device,
            &self.fremdbilder,
            &mut encoder,
            muster_bild.filter(|_| neues_bild),
        );
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
            if let Some(bg) = gebundene {
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
        // **Erst nach dem `submit`** (Begruendung an `abholung_starten`).
        if let Some(abholung) = abdruck_platz {
            self.abdruckwerk.abholung_starten(abholung);
        }
        if let (Some(abholung), Some(werk)) = (muster_platz, self.musterprobe.as_mut()) {
            werk.abholung_starten(abholung);
        }
        // **Den Ringplatz erst freigeben, wenn die GPU ihn nicht mehr liest.**
        // Der `DecodedFrame` ist zu diesem Zeitpunkt laengst verworfen (das
        // Fenster laesst ihn direkt nach `upload` fallen); ohne diese zweite
        // Referenz schriebe der Decoder in die Textur, aus der gerade gezeichnet
        // wird — sichtbar als flackernder Riss quer durchs Bild.
        //
        // Nur beim Fremdbild: auf dem Weg ueber den Hauptspeicher gibt es
        // keinen Ringplatz, und bis zum 2026-08-06 wurde hier trotzdem bei
        // JEDEM Bild einer festgehalten — der eines laengst vergangenen
        // Zero-Copy-Bildes, dauerhaft.
        if let Some(gehalten) = zu_halten {
            self.queue.on_submitted_work_done(move || drop(gehalten));
        }
        {
            use crate::app::diagnose as dg;
            dg::hoch(&dg::ENC_SUM_US, enc_uhr.elapsed().as_micros() as u64);
        }
        let pres_uhr = std::time::Instant::now();
        surface_texture.present();
        {
            let us = pres_uhr.elapsed().as_micros() as u64;
            use crate::app::diagnose as dg;
            dg::hoch(&dg::PRES_SUM_US, us);
            dg::hoechstens(&dg::PRES_MAX_US, us);
        }
        self.frames_presented += 1;
        Ok(())
    }
}

