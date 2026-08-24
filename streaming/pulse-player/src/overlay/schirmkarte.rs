//! Die massstaebliche Karte der Bildschirme des ferngesteuerten Rechners —
//! ersetzt im Menue am Griff die fruehere Liste von „+ Name"-Knoepfen.
//!
//! **Rechnung und Zeichnung getrennt**, wie bei [`crate::fernsteuerung::nachbarn`]
//! und [`crate::fernsteuerung::bildlage`]: [`kaestchen`], [`satz`] und
//! [`darstellbar`] nehmen nur Zahlen, kein egui-Kontext — pruefbar ohne
//! Fenster. Das Malen ([`zeichnen`]) liegt duenn darueber und ruft nur
//! egui-Grundfunktionen auf, wie [`super::fernbedienung`] es fuer den Griff
//! vormacht. `zeichnen` selbst entscheidet NICHT, ob eine Karte ueberhaupt
//! sinnvoll ist — das prueft der Aufrufer vorab ueber `darstellbar` und
//! faellt sonst auf die alte Knopfliste zurueck (s. dort in
//! `fernbedienung.rs`).

use egui::{Align2, Color32, FontFamily, FontId, Rect, Sense, Stroke, StrokeKind, pos2, vec2};

use super::{OverlayAction, Schirm};
use crate::theme;

/// Deckel der Kartenhoehe im Menue — mehr wuerde das Menue sprengen. Vorbild
/// aus dem Entwurf: 132 Punkte bei 264 Punkten Menuebreite.
const HOEHE_MAX: f32 = 132.0;
/// Sichtbarer Spalt zwischen zwei Kaestchen — nur beim Malen abgezogen, nicht
/// Teil der Rechnung: Treffflaeche bleibt die volle, ungeschrumpfte Flaeche.
const LUECKE: f32 = 3.0;
/// Ab wann gilt eine Achse ueberhaupt als gestaffelt: ihre Spannweite muss den
/// groessten Einzelschirm auf dieser Achse um mehr als diesen Faktor
/// uebertreffen — sonst waere ein Bildschirmrahmen oder eine leicht schiefe
/// Aufstellung schon eine behauptete Anordnung.
const STAFFELUNG_SCHWELLE: f32 = 1.15;
/// Abstand von der Mitte einer gestaffelten Achse, ab dem ein Schirm als klar
/// links/rechts bzw. oben/unten gilt statt „in der Mitte" — als Anteil der
/// groessten Schirmgroesse auf dieser Achse.
const MITTE_TOLERANZ: f32 = 0.15;

// ── Rechnung ─────────────────────────────────────────────────────────────

/// Ein Schirm mit brauchbarer Lage und Groesse — Zwischenschritt, den
/// [`kaestchen`] UND [`richtungswort`] brauchen, deshalb einmal gemeinsam
/// herausgeschaelt statt zweimal gefiltert.
struct Brauchbar {
    /// Position in den Eingabe-Schirmen, NICHT `Schirm::index` — der
    /// Aufrufer von [`kaestchen`] braucht sie, um wieder an Name, Nummer,
    /// `open` und `dieses_fenster` zu kommen.
    i: usize,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

/// Nur Schirme mit vollstaendiger Lage UND einer Groesse groesser Null — ein
/// Schirm ohne beides faellt heraus, statt die Rechnung zu verderben (Nenner
/// Null, oder ein Punkt, den es auf der Karte gar nicht gibt).
fn brauchbare(schirme: &[Schirm]) -> Vec<Brauchbar> {
    schirme
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let (x, y, w, h) = (s.x?, s.y?, s.width?, s.height?);
            (w > 0 && h > 0).then_some(Brauchbar { i, x, y, w, h })
        })
        .collect()
}

/// Kleinstes umschliessendes Rechteck (`min_x, min_y, max_x, max_y`) ueber
/// alle brauchbaren Schirme. `None` nur, wenn keiner brauchbar ist.
fn huelle(brauchbar: &[Brauchbar]) -> Option<(i32, i32, i32, i32)> {
    let erster = brauchbar.first()?;
    let mut ecken = (erster.x, erster.y, erster.x + erster.w as i32, erster.y + erster.h as i32);
    for b in &brauchbar[1..] {
        ecken.0 = ecken.0.min(b.x);
        ecken.1 = ecken.1.min(b.y);
        ecken.2 = ecken.2.max(b.x + b.w as i32);
        ecken.3 = ecken.3.max(b.y + b.h as i32);
    }
    Some(ecken)
}

/// Huellrechteck aller brauchbaren Schirme, massstaeblich in `breite` x
/// `hoehe_max` eingepasst — EINE Skalierung fuer x und y, deshalb bleiben
/// Seitenverhaeltnis (ein Hochkant-Monitor steht hochkant) und Anordnung
/// (links bleibt links) erhalten. Der `usize` je Eintrag ist die Position in
/// `schirme`, s. [`Brauchbar::i`].
///
/// Kein Schirm brauchbar -> leeres Ergebnis. Sonst ist die Spannweite auf
/// beiden Achsen garantiert groesser Null (ein einzelner brauchbarer Schirm
/// bringt sie schon ueber seine eigene Breite/Hoehe mit, und die ist per
/// `brauchbare` > 0) — die Division kann also nie durch Null gehen.
pub fn kaestchen(schirme: &[Schirm], breite: f32, hoehe_max: f32) -> Vec<(usize, Rect)> {
    let brauchbar = brauchbare(schirme);
    let Some((min_x, min_y, max_x, max_y)) = huelle(&brauchbar) else {
        return Vec::new();
    };
    let massstab =
        (breite / (max_x - min_x) as f32).min(hoehe_max / (max_y - min_y) as f32);
    brauchbar
        .into_iter()
        .map(|b| {
            let rect = Rect::from_min_size(
                pos2((b.x - min_x) as f32 * massstab, (b.y - min_y) as f32 * massstab),
                vec2(b.w as f32 * massstab, b.h as f32 * massstab),
            );
            (b.i, rect)
        })
        .collect()
}

/// Kann aus `schirme` ueberhaupt eine sinnvolle Karte werden? Zwei
/// unabhaengige Gruende sprechen dagegen, EIN Tor fuer beide:
///
/// * **Weniger als zwei brauchbare Schirme.** Meldet der ferne Rechner keine
///   Lage (aeltere Gegenstelle, s. `Schirm`-Doku) oder nur fuer einen
///   einzigen, gibt es nichts zu vergleichen — eine Karte mit hoechstens
///   einem Kaestchen ist keine Karte.
/// * **Zwei brauchbare Schirme liegen exakt deckungsgleich.** Scheitert die
///   Lage-Abfrage am Host, meldet er bewusst `0/0` statt das Feld
///   wegzulassen (`win-hq-sidecar/src/ops/list_monitors.rs`) — „erkennbar
///   falsch und hier behandelbar" steht dort woertlich; das hier ist die
///   Behandlung. Ohne sie zeichnete [`kaestchen`] zwei Rechtecke exakt
///   uebereinander: nur eines waere sichtbar, und das obenauf liegende
///   `ui.interact`-Rechteck schluckte jeden Klick auf das andere. Erfasst
///   nebenbei echte Bildschirmspiegelung, die real dieselbe Lage traegt.
///
/// Der Aufrufer faellt bei `false` auf die alte Knopfliste zurueck — die
/// Schirme SIND ja da, nur ohne verwertbare Lage.
pub fn darstellbar(schirme: &[Schirm]) -> bool {
    let brauchbar = brauchbare(schirme);
    if brauchbar.len() < 2 {
        return false;
    }
    for i in 0..brauchbar.len() {
        for j in (i + 1)..brauchbar.len() {
            let (a, b) = (&brauchbar[i], &brauchbar[j]);
            if a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h {
                return false;
            }
        }
    }
    true
}

/// Mittelpunkt eines brauchbaren Schirms auf der jeweiligen Achse.
fn mitte_x_von(b: &Brauchbar) -> f32 {
    b.x as f32 + b.w as f32 / 2.0
}
fn mitte_y_von(b: &Brauchbar) -> f32 {
    b.y as f32 + b.h as f32 / 2.0
}

/// Wie [`Schirm::dieses_fenster`] zu den anderen brauchbaren Schirmen steht —
/// „links", „unten", „in der Mitte", eine Kombination wie „oben links", oder
/// `None`, wenn keine Achse gestaffelt ist (z. B. nur ein Schirm) oder dieses
/// Fenster unter den brauchbaren Schirmen nicht auftaucht.
///
/// Auf einer gestaffelten Achse zaehlt ein Mittelstreifen von
/// [`MITTE_TOLERANZ`] als „in der Mitte" — aber NUR waagerecht: senkrecht
/// gibt es kein drittes Wort, weil „oben"/„unten" bei zwei gestapelten
/// Schirmen die gebraeuchlichen sind und ein „in der Mitte" dort nichts
/// beitraegt, das nicht schon durch die Nicht-Nennung gesagt waere.
///
/// **„in der Mitte" verlangt zusaetzlich, dass es links UND rechts
/// tatsaechlich etwas gibt.** Der Abstand zur Huellrechteck-Mitte allein
/// reicht nicht: ein sehr viel groesserer Schirm zieht diese Mitte zu sich
/// heran und faellt dadurch selbst ins Mittelband — obwohl er bei genau ZWEI
/// Schirmen unmoeglich „in der Mitte" sein kann, es gibt niemanden auf beiden
/// Seiten (Beispiel: 3840 breit neben 1024 breit, direkt nebeneinander — der
/// grosse Schirm landet ohne diese Zusatzpruefung faelschlich „in der
/// Mitte"). Landet ein Schirm im Mittelband, ohne dass beide Seiten belegt
/// sind, gewinnt stattdessen die Seite, auf der niemand ist — dort steht er
/// dann selbst.
fn richtungswort(schirme: &[Schirm]) -> Option<String> {
    let brauchbar = brauchbare(schirme);
    let eigener = brauchbar.iter().find(|b| schirme[b.i].dieses_fenster)?;
    let (min_x, min_y, max_x, max_y) = huelle(&brauchbar)?;

    let breiteste = brauchbar.iter().map(|b| b.w).max()? as f32;
    let hoechste = brauchbar.iter().map(|b| b.h).max()? as f32;
    let waag = (max_x - min_x) as f32 > breiteste * STAFFELUNG_SCHWELLE;
    let senk = (max_y - min_y) as f32 > hoechste * STAFFELUNG_SCHWELLE;

    let mitte_x = (min_x + max_x) as f32 / 2.0;
    let mitte_y = (min_y + max_y) as f32 / 2.0;
    let eigene_x = mitte_x_von(eigener);
    let eigene_y = mitte_y_von(eigener);

    let mut worte = Vec::new();
    if senk {
        if eigene_y < mitte_y - hoechste * MITTE_TOLERANZ {
            worte.push("oben");
        } else if eigene_y > mitte_y + hoechste * MITTE_TOLERANZ {
            worte.push("unten");
        }
    }
    if waag {
        let hat_links = brauchbar.iter().any(|b| b.i != eigener.i && mitte_x_von(b) < eigene_x);
        let hat_rechts = brauchbar.iter().any(|b| b.i != eigener.i && mitte_x_von(b) > eigene_x);
        if eigene_x < mitte_x - breiteste * MITTE_TOLERANZ {
            worte.push("links");
        } else if eigene_x > mitte_x + breiteste * MITTE_TOLERANZ {
            worte.push("rechts");
        } else if hat_links && hat_rechts {
            worte.push("in der Mitte");
        } else if hat_rechts {
            // Niemand links von mir, aber jemand rechts -> ich bin der Linke.
            worte.push("links");
        } else if hat_links {
            worte.push("rechts");
        }
    }
    (!worte.is_empty()).then(|| worte.join(" "))
}

/// Der Satz unter der Karte: „Du schaust auf Bildschirm 2 — in der Mitte".
/// `None`, wenn kein Schirm als `dieses_fenster` markiert ist — fail-visible
/// wie die Markierung selbst (Task 3): lieber gar kein Satz als einer, der
/// auf den falschen Bildschirm zeigt.
///
/// Anders als [`richtungswort`] sucht diese Funktion ueber ALLE `schirme`,
/// nicht nur die brauchbaren: `Schirm::index` gibt es immer, auch wenn die
/// Lage fehlt. Fehlt nur die Richtung, faellt allein sie weg — der Satz
/// bleibt, nur ohne Richtungswort.
pub fn satz(schirme: &[Schirm]) -> Option<String> {
    let eigener = schirme.iter().find(|s| s.dieses_fenster)?;
    Some(match richtungswort(schirme) {
        Some(wort) => format!("Du schaust auf Bildschirm {} — {wort}", eigener.index),
        None => format!("Du schaust auf Bildschirm {}", eigener.index),
    })
}

// ── Zeichnung ────────────────────────────────────────────────────────────

/// Karte plus Satz zeichnen. Klicks landen wie ueberall sonst im Menue in
/// `actions`; das Schliessen des Menues kann nur der Aufrufer selbst
/// umsetzen (ihm gehoert `fern_menue_offen`), deshalb der Rueckgabewert.
pub(super) fn zeichnen(
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Schirm mit voller Lage, sonst leer/aus — die Tests setzen nur die
    /// Felder, auf die es ihnen ankommt (`..basis(...)`).
    fn schirm(index: u32, x: i32, y: i32, w: u32, h: u32) -> Schirm {
        Schirm {
            index,
            name: String::new(),
            open: false,
            x: Some(x),
            y: Some(y),
            width: Some(w),
            height: Some(h),
            dieses_fenster: false,
        }
    }

    // ── kaestchen ────────────────────────────────────────────────────────

    #[test]
    fn huellrechteck_massstaeblich_eingepasst_breite_bindet() {
        let s = [schirm(1, 0, 0, 1920, 1080), schirm(2, 1920, 0, 1920, 1080)];
        let plaetze = kaestchen(&s, 300.0, 1000.0);
        assert_eq!(plaetze.len(), 2);
        let (_, a) = plaetze[0];
        let (_, b) = plaetze[1];
        // 3840 Punkte Huelle auf 300 Punkte Karte -> Massstab 0.078125.
        assert!((a.width() - 150.0).abs() < 1e-3);
        assert!((a.height() - 84.375).abs() < 1e-3);
        assert!((b.min.x - 150.0).abs() < 1e-3, "{b:?}");
        // Die Karte fuellt die verfuegbare Breite exakt aus.
        assert!((a.width() + b.width() - 300.0).abs() < 1e-3);
        assert!(a.height() <= 1000.0 && b.height() <= 1000.0);
    }

    #[test]
    fn huehe_wird_gedeckelt_wenn_sie_die_engere_grenze_ist() {
        let s = [schirm(1, 0, 0, 1000, 2000), schirm(2, 0, 2000, 1000, 2000)];
        let plaetze = kaestchen(&s, 500.0, 100.0);
        assert_eq!(plaetze.len(), 2);
        let gesamthoehe: f32 = plaetze.iter().map(|(_, r)| r.height()).sum();
        assert!((gesamthoehe - 100.0).abs() < 1e-3, "Hoehe muss am Deckel enden: {gesamthoehe}");
        // Die Breite bleibt weit unter der verfuegbaren — die Hoehe war die
        // bindende Grenze, nicht die Breite.
        assert!(plaetze[0].1.width() < 500.0);
    }

    #[test]
    fn seitenverhaeltnis_bleibt_bei_hochkant_erhalten() {
        let s = [schirm(1, 0, 0, 1080, 1920)];
        let plaetze = kaestchen(&s, 300.0, 1000.0);
        let (_, r) = plaetze[0];
        let original = 1080.0 / 1920.0;
        assert!((r.width() / r.height() - original).abs() < 1e-4, "{r:?}");
    }

    #[test]
    fn anordnung_bleibt_erhalten() {
        let s = [schirm(1, 0, 0, 1920, 1080), schirm(2, 1920, 0, 1920, 1080)];
        let plaetze = kaestchen(&s, 300.0, 1000.0);
        assert!(plaetze[0].1.min.x < plaetze[1].1.min.x, "links bleibt links");
    }

    #[test]
    fn schirm_ohne_brauchbare_groesse_faellt_heraus() {
        let mut mitte = schirm(2, 1920, 0, 1920, 1080);
        mitte.width = None;
        let mut null = schirm(3, 3840, 0, 0, 1080);
        null.width = Some(0);
        let s = [schirm(1, 0, 0, 1920, 1080), mitte, null];
        let plaetze = kaestchen(&s, 300.0, 1000.0);
        assert_eq!(plaetze.len(), 1, "nur der erste Schirm ist brauchbar: {plaetze:?}");
        assert_eq!(plaetze[0].0, 0);
    }

    #[test]
    fn negative_lage_funktioniert() {
        // Ein Monitor links vom Hauptbildschirm hat eine negative x-Lage.
        let s = [schirm(1, -1920, 0, 1920, 1080), schirm(2, 0, 0, 1920, 1080)];
        let plaetze = kaestchen(&s, 300.0, 1000.0);
        let (_, links) = plaetze[0];
        let (_, rechts) = plaetze[1];
        assert!(links.min.x >= 0.0 && rechts.min.x >= 0.0, "keine negativen Ausgaberechtecke");
        assert!(links.min.x < rechts.min.x);
    }

    #[test]
    fn einzelner_schirm_fuellt_die_flaeche_ohne_durch_null_zu_teilen() {
        let s = [schirm(1, 0, 0, 1920, 1080)];
        let plaetze = kaestchen(&s, 300.0, 100.0);
        assert_eq!(plaetze.len(), 1);
        let (_, r) = plaetze[0];
        assert!(r.width().is_finite() && r.height().is_finite() && r.width() > 0.0 && r.height() > 0.0);
        // Hoehe ist hier die bindende Grenze (1920x1080 ist breiter als das
        // Seitenverhaeltnis von 300x100).
        assert!((r.height() - 100.0).abs() < 1e-3);
    }

    #[test]
    fn kein_brauchbarer_schirm_gibt_leere_karte() {
        let mut s = schirm(1, 0, 0, 0, 0);
        s.width = None;
        assert!(kaestchen(&[s], 300.0, 100.0).is_empty());
        assert!(kaestchen(&[], 300.0, 100.0).is_empty());
    }

    // ── darstellbar ──────────────────────────────────────────────────────

    #[test]
    fn zwei_brauchbare_schirme_sind_darstellbar() {
        let s = [schirm(1, 0, 0, 1920, 1080), schirm(2, 1920, 0, 1920, 1080)];
        assert!(darstellbar(&s));
    }

    #[test]
    fn weniger_als_zwei_brauchbare_schirme_sind_nicht_darstellbar() {
        // Aeltere Gegenstelle meldet gar keine Lage (Task 3) — der Normalfall
        // direkt nach der Auslieferung, solange Host und Steuernder
        // unterschiedliche Versionen fahren.
        let mut ohne_lage_1 = schirm(1, 0, 0, 1920, 1080);
        ohne_lage_1.x = None;
        let mut ohne_lage_2 = schirm(2, 1920, 0, 1920, 1080);
        ohne_lage_2.x = None;
        assert!(!darstellbar(&[ohne_lage_1, ohne_lage_2]), "keine Lage -> keine Karte");

        assert!(!darstellbar(&[schirm(1, 0, 0, 1920, 1080)]), "nur einer -> nichts zu vergleichen");
        assert!(!darstellbar(&[]));
    }

    #[test]
    fn deckungsgleiche_schirme_sind_nicht_darstellbar() {
        // Scheitert die Lage-Abfrage am Host, meldet er `0/0` statt das Feld
        // wegzulassen (`win-hq-sidecar/src/ops/list_monitors.rs`) — zwei
        // Schirme mit gescheiterter Abfrage liegen dann deckungsgleich
        // uebereinander. Dieselbe Lage traegt auch echte Bildschirmspiegelung.
        let a = schirm(1, 0, 0, 1920, 1080);
        let b = schirm(2, 0, 0, 1920, 1080);
        assert!(!darstellbar(&[a, b]), "deckungsgleich -> keine Karte");

        // Ein Pixel Unterschied reicht schon, um wieder darstellbar zu sein.
        let c = schirm(3, 1, 0, 1920, 1080);
        assert!(darstellbar(&[schirm(1, 0, 0, 1920, 1080), c]));
    }

    // ── satz / richtungswort ─────────────────────────────────────────────

    #[test]
    fn zwei_nebeneinander_nur_links_rechts() {
        let mut links = schirm(1, 0, 0, 1920, 1080);
        links.dieses_fenster = true;
        let rechts = schirm(2, 1920, 0, 1920, 1080);
        assert_eq!(
            satz(&[links.clone(), rechts.clone()]),
            Some("Du schaust auf Bildschirm 1 — links".to_string())
        );

        let mut rechts_hier = rechts;
        rechts_hier.dieses_fenster = true;
        let mut links_dort = links;
        links_dort.dieses_fenster = false;
        assert_eq!(
            satz(&[links_dort, rechts_hier]),
            Some("Du schaust auf Bildschirm 2 — rechts".to_string())
        );
    }

    #[test]
    fn drei_in_einer_reihe_die_mitte_ist_in_der_mitte() {
        let links = schirm(1, -1920, 180, 1920, 1080);
        let mut mitte = schirm(2, 0, 0, 2560, 1440);
        mitte.dieses_fenster = true;
        let rechts = schirm(3, 2560, 180, 1920, 1080);
        assert_eq!(
            satz(&[links, mitte, rechts]),
            Some("Du schaust auf Bildschirm 2 — in der Mitte".to_string())
        );
    }

    #[test]
    fn zwei_uebereinander_nur_oben_unten() {
        let oben = schirm(1, 0, -1440, 2560, 1440);
        let mut unten = schirm(2, 0, 0, 2560, 1440);
        unten.dieses_fenster = true;
        assert_eq!(
            satz(&[oben.clone(), unten.clone()]),
            Some("Du schaust auf Bildschirm 2 — unten".to_string())
        );

        let mut oben_hier = oben;
        oben_hier.dieses_fenster = true;
        let mut unten_dort = unten;
        unten_dort.dieses_fenster = false;
        assert_eq!(
            satz(&[oben_hier, unten_dort]),
            Some("Du schaust auf Bildschirm 1 — oben".to_string())
        );
    }

    #[test]
    fn einzelner_schirm_hat_kein_richtungswort() {
        let mut s = schirm(5, 0, 0, 1920, 1080);
        s.dieses_fenster = true;
        assert_eq!(satz(&[s]), Some("Du schaust auf Bildschirm 5".to_string()));
    }

    #[test]
    fn ohne_markierung_gibt_es_keinen_satz() {
        let s = [schirm(1, 0, 0, 1920, 1080), schirm(2, 1920, 0, 1920, 1080)];
        assert_eq!(satz(&s), None, "fail-visible: keine Markierung, kein Satz");
    }

    #[test]
    fn eigener_schirm_ohne_lage_hat_satz_aber_keine_richtung() {
        let bekannt = schirm(1, 0, 0, 1920, 1080);
        let mut unbekannt = Schirm {
            index: 2,
            name: String::new(),
            open: false,
            x: None,
            y: None,
            width: None,
            height: None,
            dieses_fenster: true,
        };
        unbekannt.dieses_fenster = true;
        assert_eq!(
            satz(&[bekannt, unbekannt]),
            Some("Du schaust auf Bildschirm 2".to_string()),
            "die Nummer steht immer fest, auch ohne Lage — nur die Richtung fehlt"
        );
    }

    /// Regression fuer M4: ein sehr viel groesserer Schirm neben einem sehr
    /// viel kleineren zieht die Huellrechteck-Mitte zu sich heran und faellt
    /// dadurch selbst ins Mittelband — obwohl er bei genau ZWEI Schirmen
    /// unmoeglich „in der Mitte" sein kann. Exakt die Zahlen aus der
    /// Code-Review (3840 neben 1024, direkt nebeneinander).
    #[test]
    fn grosser_schirm_neben_kleinem_bekommt_nicht_faelschlich_die_mitte() {
        let mut gross = schirm(1, 0, 0, 3840, 2160);
        gross.dieses_fenster = true;
        let klein = schirm(2, 3840, 0, 1024, 2160);
        assert_eq!(
            satz(&[gross.clone(), klein.clone()]),
            Some("Du schaust auf Bildschirm 1 — links".to_string()),
            "der grosse Schirm ist der linke von zweien, nicht die Mitte"
        );

        let mut klein_hier = klein;
        klein_hier.dieses_fenster = true;
        let mut gross_dort = gross;
        gross_dort.dieses_fenster = false;
        assert_eq!(
            satz(&[gross_dort, klein_hier]),
            Some("Du schaust auf Bildschirm 2 — rechts".to_string())
        );
    }

    /// „in der Mitte" bleibt moeglich, wenn tatsaechlich links UND rechts
    /// etwas steht — und die Achsen kombinieren sich zu „oben links" &co.
    #[test]
    fn vier_schirme_im_raster_kombinieren_oben_unten_mit_links_rechts() {
        let raster = |hier: u32| {
            let mut s = [
                schirm(1, 0, 0, 1920, 1080),
                schirm(2, 1920, 0, 1920, 1080),
                schirm(3, 0, 1080, 1920, 1080),
                schirm(4, 1920, 1080, 1920, 1080),
            ];
            s[(hier - 1) as usize].dieses_fenster = true;
            s
        };
        assert_eq!(satz(&raster(1)), Some("Du schaust auf Bildschirm 1 — oben links".to_string()));
        assert_eq!(satz(&raster(2)), Some("Du schaust auf Bildschirm 2 — oben rechts".to_string()));
        assert_eq!(satz(&raster(3)), Some("Du schaust auf Bildschirm 3 — unten links".to_string()));
        assert_eq!(satz(&raster(4)), Some("Du schaust auf Bildschirm 4 — unten rechts".to_string()));
    }

    /// `STAFFELUNG_SCHWELLE` (1,15) exakt an ihrer Grenze — die bisherigen
    /// Tests trafen sie nur beim Groessenverhaeltnis 1,0 (gleich breite
    /// Schirme haben bei Beruehrung immer 200% Spannweite, weit ueber der
    /// Schwelle). Bei exakt 1150 von 1000 (=115%) ist die Spannweite NICHT
    /// groesser als die Schwelle (`>`, nicht `>=`) — keine Staffelung, kein
    /// Richtungswort.
    #[test]
    fn staffelung_am_schwellenwert_zaehlt_noch_nicht_als_gestaffelt() {
        let mut a = schirm(1, 0, 0, 1000, 1080);
        a.dieses_fenster = true;
        let b = schirm(2, 150, 0, 1000, 1080);
        assert_eq!(satz(&[a, b]), Some("Du schaust auf Bildschirm 1".to_string()));
    }

    /// Ein Punkt ueber der Schwelle: jetzt zaehlt die Achse als gestaffelt.
    #[test]
    fn staffelung_knapp_ueber_dem_schwellenwert_zaehlt_als_gestaffelt() {
        let mut a = schirm(1, 0, 0, 1000, 1080);
        a.dieses_fenster = true;
        let b = schirm(2, 151, 0, 1000, 1080);
        assert_eq!(satz(&[a, b]), Some("Du schaust auf Bildschirm 1 — links".to_string()));
    }
}
