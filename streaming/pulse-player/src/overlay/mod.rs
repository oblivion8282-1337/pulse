//! Bedienoberflaeche IM Player-Fenster: Lautstaerke, Stumm, Vollbild und ein
//! Statistik-Feld — gezeichnet mit egui in dieselbe Oberflaeche wie das Bild.
//!
//! **Warum im Fenster und nicht in der App.** Das Fenster war bis hierher eine
//! reine Anzeigeflaeche; alles wurde per RPC aus Pulse gesteuert. Der Nutzer
//! will die Bedienung dort haben, wo er hinschaut. Folge, die man kennen muss:
//! ein Klick hierher macht dieses Fenster aktiv, und Pulses Tastenkuerzel
//! hoeren am Fenster der Web-App zu — die wirken dann bis zum naechsten Klick
//! in Pulse nicht. Deshalb oeffnet das Fenster auch ohne Aktivierung
//! (`with_active(false)` in [`crate::app`]).
//!
//! **Zeichnen nur wenn nötig.** Die Fensterschleife schlaeft mit
//! `ControlFlow::Wait`. Das Overlay blendet sich nach [`HIDE_AFTER`] ohne
//! Mausbewegung aus; ob ohne neues Bild ueberhaupt ein Durchgang noetig ist,
//! entscheidet [`Overlay::wants_redraw`] — VOR dem egui-Aufbau, nicht darin.
//! Drei Fehler steckten hier, alle gemessen an einem 144-fps-Stream:
//!
//! 1. Die Sichtbarkeitspruefung sass INNERHALB des Durchgangs und sparte nur
//!    die Widgets — Eingabe-Aufbau, Tessellierung, Pufferschreiben und ein
//!    leerer zweiter Render-Pass liefen auf jedem Bild weiter.
//! 2. `RedrawRequested` ging an egui, und egui antwortet darauf mit
//!    `repaint: true` (`egui-winit-0.35.0/src/lib.rs:493-501`). Wer das in ein
//!    `request_redraw` uebersetzt, baut eine Endlosschleife: 2500-3400
//!    Durchgaenge je Sekunde bei 144 ankommenden Bildern.
//! 3. `visible` als GRUND fuer einen Durchgang zu nehmen (statt nur als
//!    Bedingung fuers Mitzeichnen) hielt dieselbe Schleife am Leben, weil jede
//!    Ausgabe den naechsten Durchlauf ausloest.
//!
//! **Bildrate und Bitrate kommen fertig aus der Sitzung** (`SessionStats::fps`
//! / `kbps`). Sie hier aus zwei Abfragen selbst zu bilden war ein Fehler: der
//! Melde-Takt der Sitzung (250 ms) und das eigene Messfenster liefen
//! gegeneinander, wodurch die Anzeige bei gleichmaessigem Strom um ueber 30 %
//! schwankte.

//! Was gezeichnet wird — Statistik-Feld und Bedienleiste — steht in
//! [`controls`]; hier liegt die Schleife, die entscheidet, WANN.

mod controls;
mod fernbedienung;
mod typen;

pub use typen::{Ereignisantwort, OverlayAction, StatsView};
use typen::PresentRate;

use std::time::{Duration, Instant};

use anyhow::Result;

use crate::theme;
use winit::window::Window;

/// Wie lange das Overlay nach der letzten Mausbewegung sichtbar bleibt.
const HIDE_AFTER: Duration = Duration::from_secs(3);
/// Taste, die im Fernsteuerungs-Modus das Menue am Griff auf- und zuklappt.
///
/// **Warum eine Dreierkombination und keine einzelne Taste.** Waehrend der
/// Fernsteuerung geht JEDE Taste an den fernen Rechner — was hier abgefangen
/// wird, fehlt dort. Ein `F8` waere bequem und naehme dem Gesteuerten eine
/// Funktionstaste weg, ohne dass er es je erfuehre. `Strg+Alt+Umschalt` traegt
/// kaum ein Programm als Kuerzel, und der Verlust ist damit fast sicher keiner.
const FERN_MENUE_TASTE: egui::Key = egui::Key::P;
/// Was am Griff im Hinweisfeld steht — an EINER Stelle, damit Hinweis und
/// abgefangene Kombination nicht auseinanderlaufen.
const FERN_MENUE_HINWEIS: &str = "Pulse-Menue (Strg+Alt+Umschalt+P) — zum Verschieben ziehen";
/// Obergrenze des Schiebers. Ueber 100 % verstaerkt der Player (wie die App).
const MAX_VOLUME_PERCENT: f32 = 200.0;

pub struct Overlay {
    ctx: egui::Context,
    state: egui_winit::State,
    renderer: egui_wgpu::Renderer,
    last_activity: Instant,
    /// Es liegt Eingabe an, die egui sehen MUSS, auch wenn nichts sichtbar ist:
    /// Doppelklick (Vollbild) und `Esc` haengen am egui-Durchgang, und `Esc`
    /// setzt bewusst keine Aktivitaet (sonst blitzte die Leiste beim Verlassen
    /// des Vollbilds auf). Ohne dieses Flag waere beides tot, sobald das
    /// Overlay ausgeblendet ist.
    input_pending: bool,
    /// Es gibt neue Messwerte anzuzeigen (die Sitzung meldet sie 4-mal je
    /// Sekunde). Ohne diese Unterscheidung waere die Anzeige entweder
    /// eingefroren oder die Schleife wieder im Leerlauf.
    stats_dirty: bool,
    /// Ob beim letzten Durchgang wirklich etwas gezeichnet wurde. Beim Wechsel
    /// auf unsichtbar braucht es genau EINEN weiteren Durchgang, der die
    /// Oberflaeche ohne Overlay neu zeichnet — sonst bliebe es im Standbild
    /// (keine neuen Bilder) fuer immer stehen.
    painted: bool,
    /// Lautstaerke in Prozent (0-200) — der Wert, den der Schieber zeigt.
    volume_percent: f32,
    /// Lautstaerke vor dem Stummschalten, fuer den Weg zurueck.
    volume_before_mute: f32,
    present_rate: PresentRate,
    /// Wer hier streamt — steht links in der Leiste, wie in der App.
    title: String,
    /// Statistikfeld sichtbar. Vorgabe AN: es war bisher immer zu sehen, und
    /// ein Schalter darf einem nicht die gewohnte Anzeige wegnehmen.
    stats_visible: bool,
    /// Gibt es ein Zurueck in die Kachel? Bei 10 bit nicht — dort kann das
    /// `<video>` der App das Bild nicht darstellen (gemessen 2026-07-26).
    can_reattach: bool,
    /// Steuert dieser Zuschauer den fernen Rechner gerade? Dann tritt der Griff
    /// an die Stelle der Leiste (`fernbedienung`).
    fernsteuerung: bool,
    /// Ist das Menue am Griff aufgeklappt? Ueberlebt das Ende der Fernsteuerung
    /// nicht — sonst haenge es beim naechsten Mal schon offen da.
    fern_menue_offen: bool,
}

impl Overlay {
    /// `surface_format` muss das Format der Fenster-Oberflaeche sein — egui
    /// zeichnet in dieselbe Textur wie das Bild.
    pub fn new(
        device: &wgpu::Device,
        surface_format: wgpu::TextureFormat,
        window: &Window,
        volume: f32,
    ) -> Result<Self> {
        let ctx = egui::Context::default();
        let state = egui_winit::State::new(
            ctx.clone(),
            egui::ViewportId::ROOT,
            window,
            Some(window.scale_factor() as f32),
            None,
            None,
        );
        // `dithering` aus: das Bild bringt sein eigenes Dither mit (shader.wgsl),
        // und die Oberflaeche traegt 10 bit — egui hat hier nichts zu glaetten.
        let renderer = egui_wgpu::Renderer::new(
            device,
            surface_format,
            egui_wgpu::RendererOptions { dithering: false, ..Default::default() },
        );
        // Aussehen der App uebernehmen + den SVG-Lader anmelden, sonst bleiben
        // die Symbole leer.
        theme::install_fonts(&ctx);
        theme::apply_style(&ctx);
        egui_extras::install_image_loaders(&ctx);

        let percent = (volume * 100.0).clamp(0.0, MAX_VOLUME_PERCENT);
        Ok(Self {
            ctx,
            state,
            renderer,
            // Beim Oeffnen kurz zeigen, damit sichtbar ist, dass es Bedienung gibt.
            last_activity: Instant::now(),
            input_pending: true,
            stats_dirty: false,
            painted: false,
            volume_percent: percent,
            volume_before_mute: if percent > 0.0 { percent } else { 100.0 },
            present_rate: PresentRate { at: Instant::now(), frames: 0, per_second: None },
            title: String::new(),
            stats_visible: true,
            can_reattach: true,
            fernsteuerung: false,
            fern_menue_offen: false,
        })
    }

    /// Den GPU-Zeichner gegen einen fuer ein anderes Oberflaechenformat
    /// tauschen.
    ///
    /// Gebraucht, wenn der Player wegen eines HDR-Stroms das Format der
    /// Oberflaeche wechselt (`render::Renderer::farbraum_fuer_quelle`): egui
    /// uebersetzt seine Pipeline beim Anlegen fuer ein bestimmtes Ziel, und
    /// eine Pipeline fuer `Rgb10a2Unorm` darf nicht in eine
    /// `Rgba16Float`-Flaeche zeichnen.
    ///
    /// **Nur der Zeichner, nicht das ganze Overlay.** Titel, Lautstaerke,
    /// Sichtbarkeit der Leiste und der Zustand von egui selbst haengen an
    /// diesem Objekt; sie beim Formatwechsel zu verlieren waere ein sichtbarer
    /// Ruckler in der Bedienung fuer ein Problem, das nur die GPU hat.
    ///
    /// Was dabei verlorengeht, sind die hochgeladenen Texturen (Symbole,
    /// Schrift). egui laedt sie beim naechsten Durchgang von selbst neu — es
    /// haelt seinen eigenen Bestand und schickt ihn als `textures_delta` mit.
    pub fn zeichner_neu(&mut self, device: &wgpu::Device, surface_format: wgpu::TextureFormat) {
        self.renderer = egui_wgpu::Renderer::new(
            device,
            surface_format,
            egui_wgpu::RendererOptions { dithering: false, ..Default::default() },
        );
        // Alles neu zeichnen lassen — sonst bliebe die Leiste bis zur naechsten
        // Eingabe leer.
        self.ctx.request_repaint();
        self.input_pending = true;
        self.stats_dirty = true;
    }

    /// Fenster-Ereignis an egui geben.
    pub fn on_window_event(
        &mut self,
        window: &Window,
        event: &winit::event::WindowEvent,
    ) -> Ereignisantwort {
        use winit::event::WindowEvent as We;

        // `RedrawRequested` NICHT an egui geben. egui-winit antwortet darauf mit
        // `repaint: true` (`egui-winit-0.35.0/src/lib.rs:493-501`) — wer das in
        // ein `request_redraw` uebersetzt, baut eine Endlosschleife: zeichnen →
        // „bitte neu zeichnen" → zeichnen. Gemessen 2500-3400 Durchgaenge je
        // Sekunde bei 144 ankommenden Bildern, aus zwei je einzeln sinnvollen
        // Zeilen. egui braucht das Ereignis auch nicht; es ist keine Eingabe.
        if matches!(event, We::RedrawRequested) {
            return Ereignisantwort::NICHTS;
        }

        // Nur ECHTE Eingabe zaehlt als Grund fuer einen Durchgang. Vorher stand
        // hier „oder das Overlay ist sichtbar", womit jedes beliebige Ereignis
        // (auch `RedrawRequested`) zum Grund wurde — die zweite Haelfte
        // derselben Endlosschleife.
        let is_input = matches!(
            event,
            We::CursorMoved { .. }
                | We::CursorEntered { .. }
                | We::CursorLeft { .. }
                | We::MouseInput { .. }
                | We::MouseWheel { .. }
                | We::KeyboardInput { .. }
                | We::ModifiersChanged(_)
                | We::Touch(_)
                | We::Focused(_)
        );
        // Zeigerbewegung holt das Overlay zurueck. Tasten bewusst NICHT: `Esc`
        // soll im Vollbild wirken, ohne die Leiste aufblitzen zu lassen.
        if matches!(
            event,
            We::CursorMoved { .. }
                | We::MouseInput { .. }
                | We::MouseWheel { .. }
                | We::CursorEntered { .. }
        ) {
            self.last_activity = Instant::now();
        }
        if is_input {
            self.input_pending = true;
        }
        let response = self.state.on_window_event(window, event);
        Ereignisantwort {
            // Der Repaint-Wunsch gilt nur fuer Eingabe — bei Groessen- und
            // Zustandswechseln fordert das Fenster den Durchgang ohnehin selbst an.
            durchgang: response.repaint && is_input,
            verbraucht: response.consumed,
        }
    }

    /// Ist das Overlay gerade sichtbar? Nur dann lohnt ein Neuzeichnen wegen
    /// neuer Zahlen.
    pub fn visible(&self) -> bool {
        self.last_activity.elapsed() < HIDE_AFTER
    }

    /// Gibt es einen GRUND, einen Durchgang anzustossen, obwohl kein neues Bild
    /// da ist?
    ///
    /// Bewusst NICHT `visible()`: sichtbar zu sein ist ein Zustand, kein Grund.
    /// Mit `visible` in dieser Bedingung hielt sich die Schleife selbst am
    /// Leben — jede Ausgabe loest die Antwort des Compositors und damit den
    /// naechsten Durchlauf aus, der wieder „sichtbar" sah. Gemessen 2500-3400
    /// Ausgaben je Sekunde bei 144 ankommenden Bildern, und zwar genau in den
    /// Phasen mit sichtbarem Overlay.
    ///
    /// Gruende sind: es liegt Eingabe an, es gibt neue Zahlen, oder das Overlay
    /// muss ein letztes Mal ohne sich selbst gezeichnet werden (Ausblenden).
    pub fn wants_redraw(&self) -> bool {
        // Der dritte Grund ist der Ausblende-Durchgang. Im Fernsteuerungs-Modus
        // gibt es kein Ausblenden — der Griff steht dauerhaft —, und ohne diese
        // Ausnahme waere `painted && !visible()` dort ab der ersten ruhigen
        // Sekunde immer wahr. Der Sparweg in `App::draw_inner` bliebe fuer die
        // ganze Fernsteuerung abgeschaltet.
        let ausblenden_faellig = self.painted && !self.visible() && !self.fernsteuerung;
        self.input_pending || self.stats_dirty || ausblenden_faellig
    }

    /// Neue Zahlen liegen vor — beim naechsten Durchgang neu zeichnen, wenn das
    /// Overlay sichtbar ist.
    pub fn mark_stats_dirty(&mut self) {
        if self.visible() {
            self.stats_dirty = true;
        }
    }

    /// Baut die Oberflaeche und zeichnet sie ueber das Bild. Gibt zurueck, was
    /// der Nutzer ausgeloest hat.
    #[allow(clippy::too_many_arguments)]
    pub fn paint(
        &mut self,
        window: &Window,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        size: (u32, u32),
        is_fullscreen: bool,
        stats: &StatsView<'_>,
    ) -> Vec<OverlayAction> {
        let mut actions = Vec::new();
        let visible = self.visible();
        self.update_present_rate(stats.frames_presented);

        // Eigene Handle-Kopie: `run_ui` leiht sonst `self.ctx`, waehrend der
        // Aufbau `&mut self` braucht (die Bedienleiste haelt den Schieberwert).
        // `egui::Context` ist ein Arc-Handle — die Kopie ist derselbe Kontext.
        let ctx_handle = self.ctx.clone();
        let input = self.state.take_egui_input(window);
        let full = ctx_handle.run_ui(input, |ui| {
            let ctx = ui.ctx();
            // **Fernsteuerung: der Griff statt der Leiste, und zwar IMMER.**
            // `visible` haengt an der letzten Mausbewegung — beim Steuern
            // bewegt sich die Maus dauernd, die Leiste stuende also praktisch
            // ohne Unterbrechung ueber dem fernen Bild (Begruendung in
            // `fernbedienung`). Der Griff ist klein, verschiebbar und braucht
            // deshalb kein Ausblenden.
            //
            // **Vor Doppelklick und Escape, nicht danach.** Beide gehoeren dem
            // FENSTER, und beim Steuern gehoert dieselbe Geste dem fernen
            // Rechner: ein Doppelklick oeffnet dort eine Datei, Escape schliesst
            // dort einen Dialog. Standen sie davor, riss jeder Doppelklick
            // drueben zusaetzlich das eigene Fenster ins Vollbild und jedes Esc
            // wieder heraus — und zweimal schnell auf den Griff tat dasselbe.
            if self.fernsteuerung {
                // `key_pressed` schliesst die Tastenwiederholung ein
                // (`egui::InputState`, „Includes key-repeat events"): gehalten
                // klappte das Menue rund 30-mal je Sekunde auf und zu, und was
                // am Ende stand, war Zufall. Deshalb ueber die Ereignisliste mit
                // `repeat: false`.
                //
                // **Physische UND logische Taste**: die Erfassung nebenan
                // schluckt `KeyCode::KeyP`, also die POSITION. Pruefte hier nur
                // die logische Taste, bliebe auf Belegungen, die dort kein „p"
                // liefern (Dvorak), die Kombination wirkungslos — geschluckt
                // wuerde sie trotzdem, sie kaeme also nirgends an.
                let umschalten = ctx.input(|i| {
                    i.events.iter().any(|e| match e {
                        egui::Event::Key { key, physical_key, pressed: true, repeat: false, modifiers }
                            if modifiers.ctrl && modifiers.alt && modifiers.shift =>
                        {
                            *key == FERN_MENUE_TASTE || *physical_key == Some(FERN_MENUE_TASTE)
                        }
                        _ => false,
                    })
                });
                if umschalten {
                    self.fern_menue_offen = !self.fern_menue_offen;
                }
                if self.stats_visible {
                    // Unter den Griff, nicht darunter DURCH: beide sitzen in
                    // der Vorgabelage oben links. Zieht der Nutzer den Griff
                    // weg, bleibt hier eine Luecke — das ist der guenstigere
                    // Fehler gegenueber zwei Flaechen uebereinander.
                    let oben = fernbedienung::RAND + fernbedienung::GRIFF + 8.0;
                    self.build_stats(ctx, oben, stats);
                }
                self.build_fernbedienung(ctx, is_fullscreen, &mut actions);
                return;
            }
            // Doppelklick ins Bild schaltet Vollbild — auch wenn das Overlay
            // ausgeblendet ist, sonst waere Vollbild ohne Mausbewegung nicht
            // erreichbar. Im Fernsteuerungs-Modus ist dieser Zweig unerreichbar,
            // und das ist Absicht (s. oben); dort sitzt Vollbild im Menue.
            if ctx.input(|i| i.pointer.button_double_clicked(egui::PointerButton::Primary)) {
                actions.push(OverlayAction::Fullscreen(!is_fullscreen));
            }
            if is_fullscreen && ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
                actions.push(OverlayAction::Fullscreen(false));
            }
            if !visible {
                return;
            }
            if self.stats_visible {
                self.build_stats(ctx, fernbedienung::RAND, stats);
            }
            self.build_controls(ctx, is_fullscreen, &mut actions);
        });

        self.input_pending = false;
        self.stats_dirty = false;
        // Im Fernsteuerungs-Modus steht der Griff dauerhaft — es wurde also
        // gezeichnet, auch wenn `visible` (letzte Mausbewegung) laengst
        // abgelaufen ist. Ohne das haelt `wants_redraw` einen Ausblende-
        // Durchgang fuer faellig, den es hier nie gibt.
        self.painted = visible || self.fernsteuerung;
        self.state.handle_platform_output(window, full.platform_output);
        let tris = self.ctx.tessellate(full.shapes, full.pixels_per_point);
        // Seit egui 0.36 fuehrt `set` je Textur MEHRERE Teilaenderungen
        // (`HashMap<TextureId, SmallVec<[ImageDelta; 1]>>` statt einer Liste von
        // Paaren) — deshalb die zweite Schleife. Die Reihenfolge INNERHALB einer
        // Textur muss bleiben, die zwischen den Texturen ist gleichgueltig;
        // egui-wgpu macht es in `winit.rs:568` genauso.
        for (id, teile) in &full.textures_delta.set {
            for delta in teile {
                self.renderer.update_texture(device, queue, *id, delta);
            }
        }
        let descriptor = egui_wgpu::ScreenDescriptor {
            size_in_pixels: [size.0.max(1), size.1.max(1)],
            pixels_per_point: full.pixels_per_point,
        };
        self.renderer.update_buffers(device, queue, encoder, &tris, &descriptor);
        {
            // `Load`: das Bild steht schon in der Textur, es darf nicht
            // ueberschrieben werden.
            let pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pulse-player-overlay"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            self.renderer.render(&mut pass.forget_lifetime(), &tris, &descriptor);
        }
        for id in &full.textures_delta.free {
            self.renderer.free_texture(id);
        }
        actions
    }

    /// Rate der ausgegebenen Bilder aus dem live gefuehrten Zaehler. Mindestens
    /// eine halbe Sekunde Abstand, damit die Anzeige nicht zappelt.
    fn update_present_rate(&mut self, frames: u64) {
        let elapsed = self.present_rate.at.elapsed();
        if elapsed < Duration::from_millis(500) {
            return;
        }
        if frames >= self.present_rate.frames {
            let delta = frames - self.present_rate.frames;
            self.present_rate.per_second =
                Some((delta as f64 / elapsed.as_secs_f64()).round() as u64);
        }
        self.present_rate.at = Instant::now();
        self.present_rate.frames = frames;
    }

    /// Name des Streamers fuer die Leiste.
    pub fn set_title(&mut self, title: impl Into<String>) {
        self.title = title.into();
    }

    /// Ob der Knopf „wieder in der App zeigen" angeboten wird.
    pub fn set_can_reattach(&mut self, can: bool) {
        self.can_reattach = can;
    }

    /// Fernsteuerungs-Modus ein- oder ausschalten (`input_capture`).
    ///
    /// Beim Ausschalten faellt das Menue zu: es gehoert zum Griff, und der ist
    /// dann weg. Bliebe der Zustand stehen, stuende es beim naechsten Start der
    /// Fernsteuerung ungefragt offen ueber dem Bild.
    pub fn set_fernsteuerung(&mut self, aktiv: bool) {
        if self.fernsteuerung == aktiv {
            return;
        }
        self.fernsteuerung = aktiv;
        if !aktiv {
            self.fern_menue_offen = false;
        }
        // **Einen Durchgang anfordern, sonst bleibt der Griff aus.** Der Ruf
        // kommt aus `input_capture`, also ohne Mausbewegung: `visible()` ist
        // dann falsch, `painted` ebenfalls, und die Sperre in `App::draw_inner`
        // („kein neues Bild und das Overlay will nichts") liesse den
        // `request_redraw` von dort ins Leere laufen. Bei laufendem Video faellt
        // das nicht auf — bei Standbild, Pause oder abgerissenem Strom bliebe
        // der Griff weg, bis der Nutzer zufaellig die Maus bewegt.
        self.input_pending = true;
    }

    /// Statistikfeld umschalten (Knopf in der Leiste).
    pub fn toggle_stats(&mut self) {
        self.stats_visible = !self.stats_visible;
    }

    /// Von aussen gesetzte Lautstaerke (RPC `set_option`) uebernehmen, damit der
    /// Schieber nicht etwas anderes zeigt als anliegt.
    pub fn set_volume(&mut self, volume: f32) {
        let percent = (volume * 100.0).clamp(0.0, MAX_VOLUME_PERCENT);
        self.volume_percent = percent;
        if percent > 0.0 {
            self.volume_before_mute = percent;
        }
    }
}
