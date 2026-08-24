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

    /// Wayland: welches Fenster (Platz + Bildlage) der Zeiger laut
    /// Datengeraet gerade beruehrt — oder `None`, wenn kein Zug laeuft. Vom
    /// Aufrufer VOR jedem Aufruf gesetzt, aus demselben Grund wie
    /// [`Self::nachbarschaft_setzen`]: nur er kennt alle Fenster und kann die
    /// vom Compositor gemeldete Flaeche einem davon zuordnen (s. Feld-Doc an
    /// `wayland_ziel`).
    ///
    /// **Nur auf Linux ausserhalb von Tests aufgerufen** (`app::wayland_zug`,
    /// dort hinter `#[cfg(target_os = "linux")]`) — anders als
    /// [`Self::nachbarschaft_setzen`], die auf jeder Plattform laeuft. Ohne
    /// den `cfg_attr` unten meldete ein Windows-/macOS-Bau (kein `cfg(test)`,
    /// dort ruft niemand diese Methode) sie faelschlich als toten Code.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn wayland_ziel_setzen(&mut self, ziel: Option<(u32, Bildlage)>) {
        self.wayland_ziel = ziel;
    }

    /// Welcher Platz ist gemeint, und wo in dessen Bild?
    ///
    /// **Drei Wege, in dieser Reihenfolge:**
    /// 1. **Wayland** (`wayland_ziel`, gesetzt vom Aufrufer): der Compositor
    ///    hat die Zuordnung Fenster<->Flaeche bereits geleistet — `x`/`y`
    ///    sind dann schon die PHYSISCHEN Punkte GENAU DIESES Fensters (vom
    ///    Aufrufer umgerechnet, s. `app::wayland_zug`), `Bildlage::anteil`
    ///    braucht nichts weiter. Kein `nachbarn::treffer`, keine
    ///    Desktop-Koordinaten — der einfachste der drei Wege, weil die
    ///    schwierigste Arbeit (welches Fenster?) schon erledigt ist.
    /// 2. **Desktop-Koordinaten** (`eigener_ursprung` bekannt):
    ///    `nachbarn::treffer` sucht unter mehreren Fenstern.
    /// 3. **Eigenes Bild** (Ruecfall): dieselbe Antwort wie vor der
    ///    Nachbarschaft.
    ///
    /// **Keine Kollision zwischen 1 und 2.** Wayland liefert winit
    /// grundsaetzlich keine Fensterlagen heraus (s. Feld-Doc an
    /// `eigener_ursprung`) — `eigener_ursprung` ist auf Wayland deshalb FUER
    /// IMMER `None`, der Zweig 2 laeuft dort also ohnehin nie, ganz gleich ob
    /// `wayland_ziel` gerade gesetzt ist. Zweig 1 geht trotzdem ausdruecklich
    /// VOR: er ist die praezisere Auskunft (der Compositor selbst, nicht
    /// eine aus Fensterlagen REKONSTRUIERTE Zuordnung) und soll nicht
    /// zufaellig von einer kuenftigen Aenderung an Zweig 2 verdeckt werden.
    pub(super) fn ziel_bestimmen(
        &self,
        lage: Option<Bildlage>,
        x: f64,
        y: f64,
    ) -> Option<(u32, (f64, f64))> {
        if let Some((slot, wayland_lage)) = &self.wayland_ziel {
            return wayland_lage.anteil(x, y).map(|a| (*slot, a));
        }
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
