//! Wohin die Frames gehen: eigener Bildschirm oder der eines Nachbarfensters.
//!
//! Abgetrennt von [`super`], weil dort die UEBERSETZUNG einzelner Ereignisse
//! wohnt (welches winit-Ereignis welchen Frame ergibt) und hier die Frage, an
//! WELCHEN Bildschirm sie gehen. Dieselbe Trennung wie bei
//! [`super::strom`] — und dieselbe Ursache: `mod.rs` war ueber die
//! Groessen-Grenze gewachsen (`PLAN.md` §12.1).
//!
//! Als Kindmodul kommt das an die privaten Felder von [`super::Erfassung`],
//! ohne dafuer Zugaenge zu oeffnen, die sonst niemand braucht.

use super::{nachbarn, Bildlage, Erfassung, Nachbar};

impl Erfassung {
    /// Wo dieses Fenster liegt und welche Fenster sonst noch erfassen.
    ///
    /// Vom Aufrufer VOR dem Ereignis gesetzt (`app::window_event`), weil nur
    /// dort alle Sitzungen zugleich sichtbar sind. Wird es nie gerufen, bleibt
    /// das Verhalten von vor dem 2026-08-24.
    pub fn nachbarschaft_setzen(
        &mut self,
        ursprung: Option<(f64, f64)>,
        kandidaten: Vec<Nachbar>,
    ) {
        self.eigener_ursprung = ursprung;
        self.kandidaten = kandidaten;
    }

    /// Welcher Platz ist gemeint, und wo in dessen Bild?
    ///
    /// Ohne bekannte eigene Fensterlage bleibt es beim eigenen Bild — dieselbe
    /// Antwort wie vor der Nachbarschaft, damit Wayland und die Tests
    /// unveraendert laufen.
    pub(super) fn ziel_bestimmen(
        &self,
        lage: Option<Bildlage>,
        x: f64,
        y: f64,
    ) -> Option<(u32, (f64, f64))> {
        let Some((ux, uy)) = self.eigener_ursprung else {
            return lage?.anteil(x, y).map(|a| (self.slot, a));
        };
        nachbarn::treffer((ux + x, uy + y), &self.kandidaten)
    }

    /// Das Ziel wechseln — und dabei das Liegengebliebene sauber abtrennen.
    ///
    /// **Die Warteschlange gehoert noch dem alten Platz.** Sie muss als eigenes
    /// Buendel heraus, bevor der neue gilt: die Huelle traegt genau einen Platz,
    /// und die Reihenfolge ist bedeutungstragend (ein Klick, der seine
    /// Positionierung ueberholt, landet am falschen Ort).
    pub(super) fn ziel_wechseln(&mut self, neu: u32) {
        if neu == self.ziel_slot {
            return;
        }
        if let Some(frames) = self.warteschlange.raeumen() {
            self.ausstehend.push((self.ziel_slot, frames));
        }
        self.ziel_slot = neu;
    }
}
