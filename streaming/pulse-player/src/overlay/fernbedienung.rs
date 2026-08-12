//! Die Bedienung im **Fernsteuerungs-Modus**: ein verschiebbarer Griff statt
//! der Leiste am unteren Rand.
//!
//! **Warum die Leiste hier falsch ist.** Sie taucht bei jeder Mausbewegung auf
//! (`HIDE_AFTER` in `super`) — beim Zusehen genau richtig, beim Steuern eine
//! Dauererscheinung, denn dort bewegt man die Maus ununterbrochen. Schwerer
//! wiegt aber, was sie dabei anrichtet: solange sie sichtbar ist, meldet egui
//! den Zeiger als „verbraucht" (`Ereignisantwort::verbraucht`), und die
//! Erfassung schickt in diesem Bereich weder Bewegung noch Klick an den fernen
//! Rechner. Ein Streifen ueber die **volle Fensterbreite** ist damit tot — und
//! zwar genau unten, wo bei Windows die Taskleiste liegt.
//!
//! Der Griff hier ist dieselbe Idee auf der kleinsten moeglichen Flaeche: ein
//! Symbol, das man **wegziehen** kann, wenn es doch einmal im Weg ist. Das
//! Verschieben ist deshalb kein Komfort, sondern der Ersatz fuer das
//! Ausblenden, das es hier nicht geben darf — ohne sichtbaren Griff gaebe es
//! keinen Weg zurueck in die Bedienung.
//!
//! **Erreichbar bleibt er auch ohne Zeiger.** Mit Zeigerfang
//! (`input_capture` mit `pointer_lock`) gibt es keinen lokalen Mauszeiger mehr,
//! mit dem sich irgendetwas anklicken liesse. Deshalb oeffnet
//! [`super::FERN_MENUE_TASTE`] das Menue auch per Tastatur, und die Erfassung
//! schluckt genau diese Kombination, statt sie weiterzureichen
//! (`crate::fernsteuerung::Erfassung::menue_taste`).

use super::{Overlay, OverlayAction};
use crate::theme;

/// Kantenlaenge des Griffs. Bewusst groesser als ein Leisten-Symbol: er ist ein
/// Ziehpunkt, und was man ziehen soll, muss man treffen koennen.
pub(super) const GRIFF: f32 = 34.0;

/// Abstand des Griffs von der Fensterecke in seiner Ausgangslage.
///
/// Oben links, weil dort am wenigsten im Weg steht: unten sitzt bei Windows die
/// Taskleiste, oben rechts die Fensterknoepfe. Das Statistikfeld liegt zwar
/// ebenfalls oben links — es weicht deshalb nach unten aus, solange der Griff da
/// ist (`super::paint`).
pub(super) const RAND: f32 = 12.0;

impl Overlay {
    /// Griff plus (wenn offen) Klappmenue. Wird im Fernsteuerungs-Modus
    /// ANSTELLE der Leiste gezeichnet, und anders als sie **immer** — nicht nur
    /// nach einer Mausbewegung.
    pub(super) fn build_fernbedienung(
        &mut self,
        ctx: &egui::Context,
        is_fullscreen: bool,
        actions: &mut Vec<OverlayAction>,
    ) {
        let griff = egui::Area::new(egui::Id::new("pulse-fern-griff"))
            .default_pos(egui::pos2(RAND, RAND))
            // Der Griff bewegt sich nur am eigenen Symbol — `movable` allein
            // machte auch das aufgeklappte Menue zur Ziehflaeche, und dann
            // verschoebe jeder Griff an den Lautstaerkeregler das Ganze.
            .movable(true)
            .constrain(true)
            .show(ctx, |ui| {
                let bild = egui::Image::new(theme::icon::pulse_mark())
                    .fit_to_exact_size(egui::vec2(GRIFF - 10.0, GRIFF - 10.0))
                    .tint(if self.fern_menue_offen { theme::PRIMARY } else { theme::TEXT });
                let knopf = ui.add_sized(
                    egui::vec2(GRIFF, GRIFF),
                    egui::Button::image(bild)
                        .fill(theme::LEISTE_BG)
                        .corner_radius(theme::RADIUS_MD),
                );
                if knopf.clicked() {
                    self.fern_menue_offen = !self.fern_menue_offen;
                }
                knopf.on_hover_text(super::FERN_MENUE_HINWEIS)
            });

        if !self.fern_menue_offen {
            return;
        }
        // Das Menue haengt UNTER dem Griff und wandert mit ihm. Eigene Area und
        // nicht `popup`: ein egui-Popup schliesst beim Klick daneben, und
        // „daneben" ist hier das ferne Bild — der Klick soll dorthin gehen, das
        // Menue aber offen bleiben, bis man es selbst zumacht.
        let unter_griff = griff.response.rect.left_bottom() + egui::vec2(0.0, 6.0);
        egui::Area::new(egui::Id::new("pulse-fern-menue"))
            .fixed_pos(unter_griff)
            .constrain(true)
            .show(ctx, |ui| {
                egui::Frame::NONE
                    .fill(theme::LEISTE_BG)
                    .corner_radius(theme::RADIUS_MD)
                    .inner_margin(egui::Margin::symmetric(theme::PAD_X as i8, theme::PAD_Y as i8))
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 6.0;
                        if !self.title.is_empty() {
                            ui.label(
                                egui::RichText::new(&self.title)
                                    .font(theme::font_xs())
                                    .color(theme::TEXT),
                            );
                        }
                        self.volume_group(ui, actions);
                        ui.with_layout(
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| {
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
                                // Vollbild bleibt erreichbar: der Doppelklick
                                // ins Bild geht im Fernsteuerungs-Modus an den
                                // fernen Rechner, nicht mehr an das Fenster.
                                Self::action_button(
                                    ui,
                                    actions,
                                    if is_fullscreen {
                                        theme::icon::fullscreen_exit()
                                    } else {
                                        theme::icon::fullscreen_enter()
                                    },
                                    if is_fullscreen { "Vollbild verlassen" } else { "Vollbild" },
                                    false,
                                    OverlayAction::Fullscreen(!is_fullscreen),
                                );
                            },
                        );
                        // Trennen steht unten und allein — es beendet die
                        // Fernsteuerung, nicht den Stream. Wer danach nur
                        // zusieht, hat wieder die gewohnte Leiste.
                        if ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new("Fernsteuerung beenden")
                                        .font(theme::font_xs())
                                        .color(theme::TEXT),
                                )
                                .fill(theme::GRUPPE_BG)
                                .corner_radius(theme::RADIUS_MD),
                            )
                            .clicked()
                        {
                            self.fern_menue_offen = false;
                            actions.push(OverlayAction::RemoteDisconnect);
                        }
                    });
            });
    }
}
