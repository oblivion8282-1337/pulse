//! Was das Overlay ZEICHNET: Statistik-Feld oben links, Bedienleiste unten.
//!
//! Abgetrennt vom Rest des Moduls (`super`), weil dort die Zeichen-Schleife
//! wohnt — wann ueberhaupt ein Durchgang noetig ist, mit den drei teuer
//! erkauften Regeln im dortigen Modulkopf. Hier steht nur das Aussehen, und die
//! Groessen-Policy (PLAN.md §12.1) verlangt den Schnitt ohnehin.
//!
//! Die Leiste ist absichtlich dieselbe wie unter der Kachel in der App
//! (`web/src/lib/stream/components/TileDock.svelte`): solange das Fenster
//! offen ist, blendet die App ihre eigene aus, und diese hier ist die EINZIGE
//! Bedienung des Streams. Farben, Masse und Symbole kommen aus [`crate::theme`].

use super::{MAX_VOLUME_PERCENT, Overlay, OverlayAction, StatsView};
use crate::theme;

impl Overlay {
    /// Statistik oben links.
    pub(super) fn build_stats(&self, ctx: &egui::Context, s: &StatsView<'_>) {
        let (fps, kbps) = (s.fps, s.kbps);
        egui::Area::new(egui::Id::new("pulse-stats"))
            .anchor(egui::Align2::LEFT_TOP, egui::vec2(12.0, 12.0))
            .interactable(false)
            .show(ctx, |ui| {
                egui::Frame::popup(ui.style())
                    .fill(egui::Color32::from_black_alpha(170))
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 2.0;
                        let mut row = |k: &str, v: String| {
                            ui.horizontal(|ui| {
                                ui.colored_label(egui::Color32::from_white_alpha(140), k);
                                ui.monospace(v);
                            });
                        };
                        row("Bild", format!("{}x{}{}", s.width, s.height, if s.ten_bit_source { " · 10 bit" } else { "" }));
                        row("Bilder/s", fps.map_or_else(|| "—".into(), |v| v.to_string()));
                        // Der Vergleich der beiden Zeilen ist der Kern: oben
                        // wie viele Bilder ankommen und dekodiert werden, hier
                        // wie viele davon wirklich auf dem Schirm landen.
                        row(
                            "Gezeichnet/s",
                            self.present_rate
                                .per_second
                                .map_or_else(|| "—".into(), |v| v.to_string()),
                        );
                        if s.never_drawn > 0 {
                            row("Nie gezeichnet", s.never_drawn.to_string());
                        }
                        if s.acquire_misses > 0 {
                            row("Ohne Oberflaeche", s.acquire_misses.to_string());
                        }
                        if s.upload_us + s.render_us > 0 {
                            // Getrennt, weil die Gegenmassnahmen verschieden
                            // sind: viel „Hochladen" heisst Kopier- und
                            // Pufferarbeit, viel „Ausgeben" heisst Warten auf
                            // den Bildschirmtakt.
                            row(
                                "Hochladen",
                                format!("{:.1} ms", s.upload_us as f64 / 1000.0),
                            );
                            row("Ausgeben", format!("{:.1} ms", s.render_us as f64 / 1000.0));
                        }
                        row("Bitrate", kbps.map_or_else(|| "—".into(), |v| format!("{v} kbit/s")));
                        row(
                            "Decoder",
                            if s.decoder.is_empty() {
                                "—".to_string()
                            } else if s.hardware {
                                format!("{} (HW)", s.decoder)
                            } else {
                                s.decoder.to_string()
                            },
                        );
                        row("Ausgabe", s.surface_format.to_string());
                        // Zwei Ursachen getrennt lassen: Paketverlust ist ein
                        // Netzproblem, uebersprungene Bilder eines der Anzeige.
                        row("Verworfen", format!("{} · {} uebersprungen", s.frames_dropped, s.frames_skipped));
                        row("Paketverlust", s.packets_lost.to_string());
                        row("Puffer", format!("{} Pakete · Ziel {} ms", s.buffered_packets, s.jitter_target_ms));
                        row(
                            "Ton",
                            if s.audio_active {
                                format!("laeuft · {} Aussetzer", s.audio_underruns)
                            } else {
                                "stumm".to_string()
                            },
                        );
                        if s.recording {
                            row("Mitschnitt", "laeuft".to_string());
                        }
                    });
            });
    }

    /// Ein Symbolknopf im Stil der App-Leiste.
    fn icon_button(
        ui: &mut egui::Ui,
        src: egui::ImageSource<'static>,
        tooltip: &str,
        aktiv: bool,
    ) -> egui::Response {
        let bild = egui::Image::new(src)
            .fit_to_exact_size(egui::vec2(theme::ICON, theme::ICON))
            // Die Symbole liegen weiss vor; eingefaerbt wird hier, damit ein
            // aktiver Zustand dieselbe Farbe traegt wie in der App.
            .tint(if aktiv { theme::PRIMARY } else { theme::TEXT });
        ui.add(egui::Button::image(bild).corner_radius(theme::RADIUS_MD))
            .on_hover_text(tooltip)
    }

    /// Symbolknopf, der bei Klick genau eine Aktion meldet — der Regelfall in
    /// der Leiste.
    fn action_button(
        ui: &mut egui::Ui,
        actions: &mut Vec<OverlayAction>,
        src: egui::ImageSource<'static>,
        tooltip: &str,
        aktiv: bool,
        action: OverlayAction,
    ) {
        if Self::icon_button(ui, src, tooltip, aktiv).clicked() {
            actions.push(action);
        }
    }

    /// Bedienleiste unten.
    pub(super) fn build_controls(
        &mut self,
        ctx: &egui::Context,
        is_fullscreen: bool,
        actions: &mut Vec<OverlayAction>,
    ) {
        egui::Area::new(egui::Id::new("pulse-controls"))
            .anchor(egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -16.0))
            .show(ctx, |ui| {
                egui::Frame::NONE
                    .fill(theme::LEISTE_BG)
                    .corner_radius(theme::RADIUS_MD)
                    .inner_margin(egui::Margin::symmetric(theme::PAD_X as i8, theme::PAD_Y as i8))
                    .show(ui, |ui| {
                        // `horizontal()` richtet an der OBERKANTE aus: der Name
                        // stand dadurch hoeher als die Knoepfe daneben.
                        // `Align::Center` legt alles auf eine Mittellinie.
                        let layout = egui::Layout::left_to_right(egui::Align::Center);
                        ui.with_layout(layout, |ui| self.controls_row(ui, is_fullscreen, actions));
                    });
            });
    }

    /// Der Inhalt der Leiste, von links nach rechts.
    fn controls_row(
        &mut self,
        ui: &mut egui::Ui,
        is_fullscreen: bool,
        actions: &mut Vec<OverlayAction>,
    ) {
        // Wer hier streamt — links, wie in der App.
        if !self.title.is_empty() {
            ui.label(
                egui::RichText::new(&self.title).font(theme::font_xs()).color(theme::TEXT),
            );
            ui.add_space(theme::GAP);
        }

        self.volume_group(ui, actions);

        Self::action_button(
            ui,
            actions,
            theme::icon::stats(),
            "Diagnose-Stats (Codec/FPS/Bitrate)",
            self.stats_visible,
            OverlayAction::ToggleStats,
        );
        Self::action_button(
            ui,
            actions,
            theme::icon::chat(),
            "Live-Chat",
            false,
            OverlayAction::Chat,
        );
        // Nur wenn es ein Zurueck gibt: bei 10 bit kann die Kachel das Bild
        // nicht darstellen, ein Knopf dafuer waere eine Zusage, die das
        // Programm nicht halten kann.
        if self.can_reattach {
            Self::action_button(
                ui,
                actions,
                theme::icon::reattach(),
                "Wieder in der App zeigen",
                false,
                OverlayAction::Reattach,
            );
        }
        Self::action_button(
            ui,
            actions,
            if is_fullscreen { theme::icon::fullscreen_exit() } else { theme::icon::fullscreen_enter() },
            if is_fullscreen { "Vollbild verlassen" } else { "Vollbild" },
            false,
            OverlayAction::Fullscreen(!is_fullscreen),
        );
        Self::action_button(
            ui,
            actions,
            theme::icon::close(),
            "Stream schliessen",
            false,
            OverlayAction::Close,
        );
    }

    /// Stumm-Knopf, Schieber und Prozentwert in einer abgesetzten Gruppe —
    /// `bg-black/40 rounded-md` wie in der App.
    fn volume_group(&mut self, ui: &mut egui::Ui, actions: &mut Vec<OverlayAction>) {
        egui::Frame::NONE
            .fill(theme::GRUPPE_BG)
            .corner_radius(theme::RADIUS_MD)
            .inner_margin(egui::Margin::symmetric(8, 4))
            .show(ui, |ui| {
                ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                    // Nur HIER die Schiene zurueckholen: `apply_style` macht
                    // Knopfflaechen absichtlich durchsichtig, und egui nimmt
                    // fuer beides dieselbe Farbe.
                    ui.style_mut().visuals.widgets.inactive.bg_fill = theme::SLIDER_RAIL;
                    ui.style_mut().visuals.widgets.hovered.bg_fill = theme::SLIDER_RAIL;
                    ui.style_mut().spacing.slider_width = 96.0;

                    let muted = self.volume_percent <= 0.0;
                    if Self::icon_button(
                        ui,
                        if muted { theme::icon::volume_off() } else { theme::icon::volume_on() },
                        if muted { "Ton an" } else { "Stummschalten" },
                        false,
                    )
                    .clicked()
                    {
                        self.volume_percent = if muted {
                            // Nie auf 0 zurueckschalten, sonst wirkt der Knopf
                            // beim zweiten Druecken wie kaputt.
                            self.volume_before_mute.max(10.0)
                        } else {
                            self.volume_before_mute = self.volume_percent;
                            0.0
                        };
                        actions.push(OverlayAction::Volume(self.volume_percent / 100.0));
                    }
                    let slider = ui.add(
                        egui::Slider::new(&mut self.volume_percent, 0.0..=MAX_VOLUME_PERCENT)
                            .show_value(false)
                            .handle_shape(egui::style::HandleShape::Circle),
                    );
                    if slider.changed() {
                        if self.volume_percent > 0.0 {
                            self.volume_before_mute = self.volume_percent;
                        }
                        actions.push(OverlayAction::Volume(self.volume_percent / 100.0));
                    }
                    // Feste Zeichenbreite, sonst wandert die halbe Leiste bei
                    // jedem Prozentschritt (in der App macht das `font-mono`).
                    ui.label(
                        egui::RichText::new(format!("{:>3.0}%", self.volume_percent))
                            .font(theme::font_mono())
                            .color(theme::TEXT_DIM),
                    );
                });
            });
    }
}
