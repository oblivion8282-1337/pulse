//! Das Aussehen der App im Player-Fenster — Farben, Schrift, Masse, Symbole.
//!
//! **Warum es das gibt.** Die Bedienleiste im Fenster ist dieselbe wie die
//! unter der Kachel in der App (`web/src/lib/stream/components/TileDock.svelte`).
//! Solange sie beide gleichzeitig sichtbar waren, war das Nebeneinander schon
//! unschoen; seit die Leiste in der App verschwindet, sobald das Fenster
//! offen ist, ist sie die EINZIGE Bedienung fuer diesen Stream — und dann darf
//! sie nicht aussehen wie ein fremdes Programm.
//!
//! **Woher die Werte kommen.** Alle Farben sind die Dark-Theme-Werte aus
//! `web/src/app.css`; die Schrift ist dieselbe Datei wie im Web
//! (`assets/fonts/`, s. dortige `LICENSE.md`); die Symbole werden aus dem
//! Lucide-Paket der Web-App erzeugt (`assets/icons/`, `extract-icons.py`).
//! Nichts davon ist nachempfunden — es ist dieselbe Quelle.
//!
//! **Was NICHT uebertragbar ist**, damit niemand daran verzweifelt: egui
//! zeichnet keine CSS-Uebergaenge und keine Hintergrund-Weichzeichnung
//! (`backdrop-blur`). Die halbdurchsichtigen Flaechen der App wirken deshalb
//! hier etwas flacher. Alles andere — Farbe, Radius, Abstand, Schriftgroesse —
//! ist zahlengleich.

use egui::{Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId};

// ── Farben (dark-Block aus `web/src/app.css`) ───────────────────────────────

/// `--text` — Beschriftung, die gelesen werden soll.
pub const TEXT: Color32 = Color32::from_rgb(0xf0, 0xf1, 0xf3);
/// `--text-dim` — Sekundaeres (Prozentwert, Einheiten).
pub const TEXT_DIM: Color32 = Color32::from_rgb(0x9c, 0xa3, 0xaf);
/// `--primary` — aktiver Zustand (z.B. Chat offen).
pub const PRIMARY: Color32 = Color32::from_rgb(0x3b, 0x82, 0xf6);

/// Untergrund der Leiste. In der App liegt sie ueber dem Bild als
/// `bg-black/40` MIT Weichzeichnung — die kann egui nicht, und ohne sie
/// verschwimmt die Leiste im Bild. Deshalb deutlich dichter als der
/// CSS-Wert; das ist die bewusste Abweichung, ohne die sie sich nicht abhebt.
pub const LEISTE_BG: Color32 = Color32::from_black_alpha(215);
/// Die Lautstaerke-Gruppe innerhalb der Leiste, eine Stufe heller abgesetzt.
pub const GRUPPE_BG: Color32 = Color32::from_rgba_premultiplied(20, 20, 22, 150);
/// Untergrund des Fernsteuerungs-Griffs, wenn der Zeiger darauf steht oder das
/// Menue offen ist.
///
/// Der Zustand haengt an der FLAECHE und nicht am Symbol: die Pulse-Marke
/// bringt ihre eigenen Farben mit, und `tint` multipliziert nur — eine
/// „aktive" Einfaerbung machte daraus ein schmutziges Dunkelpetrol, das sich
/// vom Ruhezustand kaum unterschied.
pub const GRIFF_BG_AKTIV: Color32 = Color32::from_rgba_premultiplied(60, 60, 66, 220);
/// Schiene des Lautstaerke-Reglers. MUSS gesetzt werden: `apply_style` macht
/// alle Knopfflaechen durchsichtig, und egui zeichnet die Schiene aus
/// derselben Farbe (`widgets.inactive.bg_fill`, `slider.rs`) — sie verschwand
/// dadurch mit, und sichtbar blieb nur der Griff.
pub const SLIDER_RAIL: Color32 = Color32::from_rgba_premultiplied(70, 70, 76, 200);
/// Gefuellter Teil links vom Griff — in der App macht das `accent-color`.
pub const SLIDER_FILL: Color32 = Color32::from_rgb(0xd4, 0xd4, 0xd8);
/// `hover:bg-white/15` der Knoepfe. Vormultipliziert geschrieben, weil
/// `from_white_alpha` nicht `const` ist — bei Weiss ist das derselbe Wert in
/// allen vier Kanaelen.
pub const HOVER_BG: Color32 = Color32::from_rgba_premultiplied(38, 38, 38, 38);

// ── Masse (Tailwind-Klassen der Leiste) ─────────────────────────────────────

/// `rounded-md` = 0.375rem = 6 px.
pub const RADIUS_MD: CornerRadius = CornerRadius::same(6);
/// Abstand zwischen den Knoepfen (`gap-1.5` = 6 px).
pub const GAP: f32 = 6.0;
/// Innenabstand der Leiste (`px-2 py-1.5`).
pub const PAD_X: f32 = 8.0;
pub const PAD_Y: f32 = 6.0;
/// Kantenlaenge der Symbole (`size-4` = 16 px).
pub const ICON: f32 = 16.0;

/// Name in der Leiste. In der App sind das 12 px (`text-xs`), hier 13:
/// egui rendert ohne die Feinabstimmung des Browsers, und 12 px wirken im
/// Fenster spuerbar kleiner als dieselbe Zahl im Web.
pub fn font_xs() -> FontId {
    FontId::new(13.0, FontFamily::Proportional)
}
/// Zahlen, die sich staendig aendern (Prozent, fps): feste Zeichenbreite, sonst
/// zappelt die Leiste bei jedem Wert. In der App macht das `font-mono`.
pub fn font_mono() -> FontId {
    FontId::new(11.0, FontFamily::Monospace)
}

// ── Schrift ─────────────────────────────────────────────────────────────────

/// Plus Jakarta Sans einhaengen — dieselbe Schrift wie im Web.
///
/// Die feste Breite (`Monospace`) bleibt bei egui's eingebauter Schrift: Plus
/// Jakarta Sans hat keinen Monospace-Schnitt, und fuer Zahlenkolonnen ist die
/// gleiche Zeichenbreite wichtiger als die gleiche Schriftfamilie.
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    fonts.font_data.insert(
        "pulse".to_owned(),
        std::sync::Arc::new(FontData::from_static(include_bytes!(
            "../assets/fonts/PlusJakartaSans-Regular.ttf"
        ))),
    );
    fonts.font_data.insert(
        "pulse-semibold".to_owned(),
        std::sync::Arc::new(FontData::from_static(include_bytes!(
            "../assets/fonts/PlusJakartaSans-SemiBold.ttf"
        ))),
    );
    // Vorne einfuegen, nicht ersetzen: die eingebaute Schrift bleibt als
    // Rueckfall fuer Zeichen, die Plus Jakarta Sans nicht hat.
    fonts
        .families
        .entry(FontFamily::Proportional)
        .or_default()
        .insert(0, "pulse".to_owned());
    fonts
        .families
        .entry(FontFamily::Name("semibold".into()))
        .or_default()
        .push("pulse-semibold".to_owned());
    ctx.set_fonts(fonts);
}

/// egui auf Pulse einstellen: durchsichtige Knopfflaechen mit hellem
/// Hover-Schleier, `rounded-md`, Textfarben des Dark-Themes.
///
/// Einmal beim Aufbau setzen. Ohne das zeichnet egui seine graublauen
/// Standardknoepfe, und die Leiste saehe im Fenster anders aus als in der App —
/// was der ganze Zweck dieses Moduls ist.
pub fn apply_style(ctx: &egui::Context) {
    // `all_styles_mut` statt `set_style`: egui fuehrt seit 0.32 einen Stil je
    // Thema (hell/dunkel). Das Fenster ist immer dunkel — indem beide gesetzt
    // werden, bleibt das Aussehen gleich, egal was das System meldet.
    ctx.all_styles_mut(|style| {
        let w = &mut style.visuals.widgets;
        for zustand in [&mut w.inactive, &mut w.active, &mut w.open] {
            zustand.weak_bg_fill = Color32::TRANSPARENT;
            zustand.bg_fill = Color32::TRANSPARENT;
            zustand.bg_stroke = egui::Stroke::NONE;
            zustand.corner_radius = RADIUS_MD;
            zustand.fg_stroke.color = TEXT;
        }
        w.hovered.weak_bg_fill = HOVER_BG;
        w.hovered.bg_fill = HOVER_BG;
        w.hovered.bg_stroke = egui::Stroke::NONE;
        w.hovered.corner_radius = RADIUS_MD;
        w.hovered.fg_stroke.color = TEXT;
        w.noninteractive.fg_stroke.color = TEXT_DIM;

        // Der Regler braucht seine Schiene zurueck (s. SLIDER_RAIL) und den
        // gefuellten Teil bis zum Griff, wie der Regler in der App.
        style.visuals.selection.bg_fill = SLIDER_FILL;
        style.visuals.slider_trailing_fill = true;

        style.visuals.override_text_color = Some(TEXT);
        style.spacing.item_spacing = egui::vec2(GAP, GAP);
        style.spacing.button_padding = egui::vec2(6.0, 4.0);
    });
}

// ── Symbole ─────────────────────────────────────────────────────────────────

/// Die Symbole der Leiste, eingebacken. `egui_extras::install_image_loaders`
/// muss einmal gelaufen sein, sonst bleiben sie leer.
pub mod icon {
    use egui::ImageSource;

    macro_rules! svg {
        ($name:literal) => {
            egui::include_image!(concat!("../assets/icons/", $name, ".svg"))
        };
    }

    pub fn volume_on() -> ImageSource<'static> {
        svg!("volume-2")
    }
    pub fn volume_off() -> ImageSource<'static> {
        svg!("volume-x")
    }
    pub fn chat() -> ImageSource<'static> {
        svg!("message-square")
    }
    pub fn fullscreen_enter() -> ImageSource<'static> {
        svg!("maximize")
    }
    pub fn fullscreen_exit() -> ImageSource<'static> {
        svg!("minimize")
    }
    pub fn reattach() -> ImageSource<'static> {
        svg!("external-link")
    }
    pub fn close() -> ImageSource<'static> {
        svg!("x")
    }
    pub fn stats() -> ImageSource<'static> {
        svg!("activity")
    }
    /// Die Pulse-Marke — der Griff der Fernbedienung im Fernsteuerungs-Modus.
    ///
    /// Kein Lucide-Symbol wie die uebrigen, sondern die Kopie von
    /// `Logo/files/pulse-mark.svg` — die FARBIGE Fassung mit smaragdgruener
    /// Flaeche, und als einziges Symbol hier **ungetoent**. Zuerst stand hier
    /// die weisse: die hat keinen Hintergrund, war ueber dem Bild also
    /// durchsichtig, und die uebliche Einfaerbung dunkelte den Rest ab — uebrig
    /// blieb ein kaum sichtbarer Schatten (am 2026-08-13 am Bild gesehen).
    pub fn pulse_mark() -> ImageSource<'static> {
        svg!("pulse-mark")
    }
}
