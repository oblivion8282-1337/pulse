//! Das Malen der Bildschirm-Karte — duenn ueber [`super::rechnung`], wie
//! [`crate::overlay::fernbedienung`] es fuer den Griff vormacht: nur
//! egui-Grundfunktionen (`allocate_exact_size`/`interact`/`painter()`).
//! Farben ausschliesslich aus [`crate::theme`].
//!
//! [`zeichnen`] entscheidet selbst NICHT, ob eine Karte ueberhaupt sinnvoll
//! ist — das prueft der Aufrufer vorab ueber [`super::rechnung::darstellbar`]
//! und faellt sonst auf die alte Knopfliste zurueck (`fernbedienung.rs`).

use egui::{Align2, Color32, FontFamily, FontId, Rect, Sense, Stroke, StrokeKind, pos2, vec2};

use crate::overlay::{OverlayAction, Schirm};
use crate::theme;

use super::rechnung::{kaestchen, satz};

/// Deckel der Kartenhoehe im Menue — mehr wuerde das Menue sprengen. Vorbild
/// aus dem Entwurf: 132 Punkte bei 264 Punkten Menuebreite.
const HOEHE_MAX: f32 = 132.0;
/// Sichtbarer Spalt zwischen zwei Kaestchen — nur beim Malen abgezogen, nicht
/// Teil der Rechnung: Treffflaeche bleibt die volle, ungeschrumpfte Flaeche.
const LUECKE: f32 = 3.0;

/// Karte plus Satz zeichnen. Klicks landen wie ueberall sonst im Menue in
/// `actions`; das Schliessen des Menues kann nur der Aufrufer selbst
/// umsetzen (ihm gehoert `fern_menue_offen`), deshalb der Rueckgabewert.
pub(crate) fn zeichnen(
    ui: &mut egui::Ui,
    breite: f32,
    schirme: &[Schirm],
    actions: &mut Vec<OverlayAction>,
) -> bool {
    let plaetze = kaestchen(schirme, breite, HOEHE_MAX);
    if plaetze.is_empty() {
        return false;
    }
    let kartenhoehe = plaetze.iter().fold(0.0_f32, |h, (_, r)| h.max(r.max.y));
    let (karte, _) = ui.allocate_exact_size(vec2(breite, kartenhoehe), Sense::hover());

    // Ist die Zuordnung „welcher Schirm ist dieses Fenster" mehrdeutig, ist
    // sie fail-visible bei KEINEM Eintrag gesetzt (Task 3) — `open` kommt
    // aber unabhaengig davon weiter von der App, ein offenes Kaestchen bliebe
    // also anklickbar, ohne dass die Fokus-Suche in `app/mod.rs` je ein Ziel
    // faende: ein Klick, der das Menue schliesst und wortlos nichts tut. Ein
    // offenes Kaestchen ist deshalb nur antippbar, wenn IRGENDWO im System
    // ueberhaupt eine Markierung existiert.
    let markiert = schirme.iter().any(|s| s.dieses_fenster);

    let mut schliessen = false;
    for (i, lokal) in plaetze {
        let schirm = &schirme[i];
        let bereich = lokal.translate(karte.min.to_vec2());
        // Das eigene Kaestchen ist tot — weder ein zweiter Strom noch ein
        // Vorne-Holen des schon aktiven Fensters ergibt einen Sinn.
        let antippbar = if schirm.dieses_fenster {
            false
        } else if schirm.open {
            markiert
        } else {
            true
        };
        let sense = if antippbar { Sense::click() } else { Sense::hover() };
        let id = ui.make_persistent_id(("pulse-schirmkarte", schirm.index));
        let antwort = ui.interact(bereich, id, sense);
        zeichne_kaestchen(ui.painter(), bereich.shrink(LUECKE / 2.0), schirm, antippbar, &antwort);
        if antwort.clicked() {
            schliessen = true;
            actions.push(if schirm.open {
                OverlayAction::RemoteScreenFocus(schirm.index)
            } else {
                OverlayAction::RemoteScreen(schirm.index)
            });
        }
    }

    if let Some(text) = satz(schirme) {
        ui.add_space(4.0);
        ui.label(egui::RichText::new(text).font(theme::font_xs()).color(theme::TEXT_DIM));
    }
    schliessen
}

/// Ein einzelnes Kaestchen: Rahmen und Fuellung nach Zustand, dann die
/// Beschriftung.
fn zeichne_kaestchen(
    painter: &egui::Painter,
    rect: Rect,
    schirm: &Schirm,
    antippbar: bool,
    antwort: &egui::Response,
) {
    if schirm.dieses_fenster {
        // Dieses Fenster: Akzentrahmen, kraeftig gefuellt.
        painter.rect_filled(rect, theme::RADIUS_MD, theme::GRUPPE_BG);
        painter.rect_filled(rect, theme::RADIUS_MD, primaer_getoent(56));
        painter.rect_stroke(rect, theme::RADIUS_MD, Stroke::new(2.0, theme::PRIMARY), StrokeKind::Inside);
    } else if schirm.open {
        // Offen, aber ein anderes Fenster: normal. Hellt beim Zeiger nur auf,
        // wenn der Klick auch etwas bewirkt (`antippbar`) — sonst saehe ein im
        // mehrdeutigen Fall totes Kaestchen trotzdem wie ein Knopf aus, der
        // gerade reagiert (I2).
        painter.rect_filled(rect, theme::RADIUS_MD, theme::GRUPPE_BG);
        let rahmen =
            if antippbar && antwort.hovered() { theme::TEXT } else { theme::SLIDER_RAIL };
        painter.rect_stroke(rect, theme::RADIUS_MD, Stroke::new(1.0, rahmen), StrokeKind::Inside);
    } else {
        // Nicht offen: gedaempft, gestrichelt, antippbar — hellt beim
        // Zeiger zur Akzentfarbe auf, damit „hier tut sich was" sichtbar ist.
        let rahmen = if antwort.hovered() { theme::PRIMARY } else { theme::TEXT_DIM };
        gestrichelt(painter, rect, rahmen);
    }
    let textfarbe = if schirm.open || schirm.dieses_fenster { theme::TEXT } else { theme::TEXT_DIM };
    zeichne_beschriftung(painter, rect, schirm, textfarbe);
}

/// `theme::PRIMARY` mit eigener Deckung statt voller — keine neue Farbe,
/// derselbe Farbton, nur durchsichtig genug, dass die Flaeche dahinter
/// durchscheint (Entwurf: `color-mix(in srgb, primary 22%, gruppe)`).
fn primaer_getoent(deckung: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(theme::PRIMARY.r(), theme::PRIMARY.g(), theme::PRIMARY.b(), deckung)
}

/// Gestrichelter Umriss — im Player bisher ohne Vorbild (`Stroke` kam nur als
/// `Stroke::NONE` vor, s. `theme::apply_style`). `Shape::dashed_line` deckt
/// keine Rundung ab, deshalb hier ohne `RADIUS_MD` — bei den kleinen
/// Kaestchen faellt das kaum auf.
fn gestrichelt(painter: &egui::Painter, rect: Rect, farbe: Color32) {
    let punkte =
        [rect.left_top(), rect.right_top(), rect.right_bottom(), rect.left_bottom(), rect.left_top()];
    painter.extend(egui::Shape::dashed_line(&punkte, Stroke::new(1.0, farbe), 4.0, 3.0));
}

/// Nummer immer, Name nur wenn er ins Kaestchen passt — gemessen ueber
/// [`passt_breite`], nicht ueber eine geratene Mindestgroesse.
fn zeichne_beschriftung(painter: &egui::Painter, rect: Rect, schirm: &Schirm, textfarbe: Color32) {
    let nummer_font = theme::font_xs();
    let name_font = FontId::new(9.0, FontFamily::Proportional);
    let zeigt_name = !schirm.name.is_empty()
        && rect.height() >= 30.0
        && passt_breite(painter, &schirm.name, name_font.clone(), rect.width() - 6.0);

    if zeigt_name {
        let nummer_rect = painter.text(
            rect.center() - vec2(0.0, 1.0),
            Align2::CENTER_BOTTOM,
            schirm.index,
            nummer_font,
            textfarbe,
        );
        painter.text(
            pos2(rect.center().x, nummer_rect.bottom() + 1.0),
            Align2::CENTER_TOP,
            &schirm.name,
            name_font,
            theme::TEXT_DIM,
        );
    } else {
        painter.text(rect.center(), Align2::CENTER_CENTER, schirm.index, nummer_font, textfarbe);
    }
}

/// Layoutet `text` probehalber (ohne ihn zu zeichnen) und vergleicht die
/// tatsaechliche Breite mit dem verfuegbaren Platz.
fn passt_breite(painter: &egui::Painter, text: &str, font: FontId, verfuegbar: f32) -> bool {
    verfuegbar > 0.0
        && painter.layout_no_wrap(text.to_string(), font, Color32::TRANSPARENT).size().x <= verfuegbar
}
