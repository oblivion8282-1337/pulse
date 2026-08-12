//! Was in die Oberflaeche geht: das Bild passend zugeschnitten, die
//! Bedienleiste darueber.
//!
//! **Herausgeloest aus [`super`] am 2026-08-07**, aus demselben Grund wie
//! seinerzeit `bildquelle`: die Datei dort riss die HARTE Groessengrenze
//! (`PLAN.md` §12.1), als der Rueckweg der Latenz-Sonde dazukam. Beides hier
//! sind reine Zutraeger des Zeichendurchgangs und haengen an keinem Zustand des
//! Renderers — `fit_viewport` ist sogar eine reine Funktion.

use crate::overlay::{Overlay, OverlayAction, StatsView};

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
///
/// **`pub(crate)`, weil die Eingabe-Erfassung dasselbe Rechteck braucht**
/// (`crate::fernsteuerung::Bildlage`): der absolute Zeigeranteil bezieht sich
/// auf das Bild, nicht auf das Fenster. Eine zweite Fassung dort hiesse, dass
/// Klick und Bild auseinanderlaufen koennen, sobald hier etwas geaendert wird.
pub fn fit_viewport(win_w: f32, win_h: f32, src_w: f32, src_h: f32) -> (f32, f32, f32, f32) {
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
