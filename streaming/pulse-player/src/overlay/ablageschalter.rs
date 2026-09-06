//! Der Schalter „Zwischenablage teilen" im Fern-Menue.
//!
//! **Eigene Datei, obwohl es ein Knopf ist:** `fernbedienung.rs` daneben liegt
//! dicht unter der Groessen-Grenze (`PLAN.md` §12.1) — eine Zeilenzahl steht
//! hier bewusst nicht, sie waere schon beim naechsten Absatz falsch. Dieselbe
//! Arbeitsteilung wie beim Lautstaerkeregler, den das Menue ebenfalls aus
//! einer Nachbardatei holt (`controls::volume_group`).
//!
//! **Was der Schalter bedeutet, entscheidet nicht das Fenster.** Er meldet nur
//! [`OverlayAction::AblageTeilen`]; was daran haengt — den laufenden Anspruch
//! freigeben und den Vorbestand zurueckschreiben — steht in `app::ablage`.
//! Dasselbe Muster wie bei jedem anderen Menuepunkt hier.

use super::{Overlay, OverlayAction};
use crate::theme;

impl Overlay {
    /// Eine Zeile mit Haken. Sichtbar nur im Fernsteuerungs-Modus, weil es
    /// ausserhalb einer Sitzung nichts zu teilen gibt — und nur dort, wo eine
    /// Plattform-Umsetzung ihn auch einloest.
    ///
    /// **Der Abstand gehoert mit hier hinein.** Faellt der Schalter weg, soll
    /// keine Luecke im Menue bleiben; stuende er beim Aufrufer, waere das eine
    /// zweite Stelle mit derselben Bedingung.
    pub(super) fn ablage_schalter(&mut self, ui: &mut egui::Ui, actions: &mut Vec<OverlayAction>) {
        if !self.ablage_verfuegbar {
            return;
        }
        ui.add_space(6.0);
        let mut an = self.ablage_teilen;
        let antwort = ui.checkbox(
            &mut an,
            egui::RichText::new("Zwischenablage teilen")
                .font(theme::font_xs())
                .color(theme::TEXT),
        );
        if antwort.changed() {
            // **Nicht selbst umlegen.** Der Zustand kommt aus `app::ablage`
            // zurueck (`set_ablage_teilen`) — schriebe das Fenster ihn hier
            // schon fest, zeigte es beim Scheitern des Freigebens etwas
            // anderes an, als tatsaechlich gilt.
            actions.push(OverlayAction::AblageTeilen(an));
        }
        antwort.on_hover_text(
            "Aus heisst: nichts geht mehr hinaus — auch nicht die blosse \
             Meldung, dass du etwas kopiert hast. Ein laufender Anspruch wird \
             freigegeben und dein vorheriger Inhalt zurueckgeschrieben.",
        );
        ui.add_space(6.0);
    }
}
