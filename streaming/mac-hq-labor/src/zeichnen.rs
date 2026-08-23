//! Was der Mensch davor sieht: dunkler Grund, acht Zielkreuze, eine Kopfzeile.
//!
//! **Nur Anzeige, keine Messung.** Kein Wert dieses Moduls geht in ein Urteil
//! ein; faellt es aus (`None`), misst der Lauf unveraendert weiter. Deshalb hat
//! es auch keine Tests: es gibt hier nichts, was richtig oder falsch sein
//! koennte, nur sichtbar oder nicht.
//!
//! Wozu es trotzdem taugt: ein Bildschirmfoto belegt, dass das Fenster wirklich
//! oben lag und wo die Ziele lagen. Im Windows-Labor ist genau das mehrfach die
//! Erklaerung fuer einen misslungenen Lauf gewesen.
//!
//! Gezeichnet wird ueber AppKit-Bausteine (`NSTextField` ohne Rahmen), nicht
//! ueber einen Zeichen-Aufsatz: winit bringt keine Zeichenflaeche mit, und
//! `softbuffer` oder `wgpu` waeren eine Abhaengigkeit fuer ein Beiwerk.

use objc2::{MainThreadOnly, Message};
use objc2::rc::Retained;
use objc2_app_kit::{NSColor, NSFont, NSTextField, NSView};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};
// Ueber winits Re-Export, nicht als eigene Abhaengigkeit: die Kiste steckt
// ohnehin im Baum, und zwei Deklarationen koennten auseinanderlaufen.
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

/// Haelt die aufgesetzten Felder am Leben. Faellt sie, verschwinden sie.
// Der Inhalt wird nie gelesen — die Felder muessen nur leben, solange die
// Beschriftung lebt.
pub struct Beschriftung(#[allow(dead_code)] Vec<Retained<NSTextField>>);

/// Setzt Grund, Kreuze und Kopfzeile auf. `None`, wenn das Fenster keinen
/// AppKit-Aufsatz hergibt — dann laeuft die Messung ohne Anzeige weiter.
pub fn aufsetzen(
    fenster: &Window,
    ziele: &[(f64, f64)],
    ursprung: (f64, f64),
    hoehe: f64,
) -> Option<Beschriftung> {
    let mtm = MainThreadMarker::new()?;
    let aufsatz = inhalt(fenster)?;
    if let Some(w) = aufsatz.window() {
        w.setBackgroundColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(
            0.05, 0.05, 0.07, 1.0,
        )));
    }

    let mut felder = Vec::new();
    for (nr, &(zx, zy)) in ziele.iter().enumerate() {
        // Von globalen Punkten (Ursprung oben links) zurueck in
        // Fensterkoordinaten (Ursprung unten links) — die Umkehrung von
        // `crate::lage::fenster_zu_global`.
        let x = zx - ursprung.0;
        let y = hoehe - (zy - ursprung.1);
        felder.push(feld(mtm, &aufsatz, &format!("+{}", nr + 1), x - 14.0, y - 12.0, 60.0, 24.0, 20.0));
    }
    felder.push(feld(
        mtm,
        &aufsatz,
        "PULSE EINGABE-PRUEFZIEL   -   Strg+Alt+Umschalt+Q beendet",
        40.0,
        hoehe - 60.0,
        900.0,
        28.0,
        18.0,
    ));
    Some(Beschriftung(felder))
}

fn inhalt(fenster: &Window) -> Option<Retained<NSView>> {
    let handle = fenster.window_handle().ok()?;
    let RawWindowHandle::AppKit(h) = handle.as_raw() else {
        return None;
    };
    // Der Zeiger kommt aus winit und zeigt auf ein echtes `NSView`. Dass winit
    // dabei seine eigene objc2-Fassung benutzt, aendert am Objekt nichts — es
    // ist dieselbe Klasse zur Laufzeit.
    let sicht: &NSView = unsafe { &*(h.ns_view.as_ptr().cast::<NSView>()) };
    Some(sicht.retain())
}

#[allow(clippy::too_many_arguments)]
fn feld(
    mtm: MainThreadMarker,
    aufsatz: &NSView,
    text: &str,
    x: f64,
    y: f64,
    breite: f64,
    hoehe: f64,
    schrift: f64,
) -> Retained<NSTextField> {
    let rahmen = NSRect::new(NSPoint::new(x, y), NSSize::new(breite, hoehe));
    let f = NSTextField::initWithFrame(NSTextField::alloc(mtm), rahmen);
    {
        f.setStringValue(&NSString::from_str(text));
        f.setBezeled(false);
        f.setDrawsBackground(false);
        f.setEditable(false);
        f.setSelectable(false);
        f.setTextColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.42, 0.21, 1.0)));
        f.setFont(Some(&NSFont::userFixedPitchFontOfSize(schrift).unwrap_or_else(|| NSFont::systemFontOfSize(schrift))));
        aufsatz.addSubview(&f);
    }
    f
}
