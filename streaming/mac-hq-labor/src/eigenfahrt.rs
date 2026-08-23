//! Die Selbstprobe: das Labor faehrt die Ziele selbst an.
//!
//! ## Was sie beweist — und was ausdruecklich nicht
//!
//! Sie beweist, dass **das Messmittel misst**: dass eine auf
//! `kCGHIDEventTapLocation` abgefeuerte Bewegung als dieselbe Lage am Fenster
//! ankommt, dass ein Klickstand ueberlebt, dass eine Raste als Raste erscheint
//! und dass Tasten mit ihrer Seite ankommen. Ohne sie waere das Pruefziel ein
//! Werkzeug, das noch nie etwas gemessen hat — und ein „0 px auf 8 Zielen" aus
//! einem spaeteren Lauf haette keinen Vorlauf, gegen den es sich pruefen liesse.
//!
//! Sie beweist **nichts ueber den Sidecar**. Sie umgeht ihn: der Frame-Weg
//! (Hülle, Sitzung, Zuordnung), die Tastentabelle des Sidecars und dessen
//! Klickzaehler kommen hier gar nicht vor. Der eigentliche Nachweis braucht
//! einen Treiber, der Frames in den echten Sidecar schiebt — dafuer fehlt der
//! Labor-Schalter `PULSE_LABOR_EINGABE_OHNE_STREAM` (s. Bericht).
//!
//! **Die Tasten laufen durch die eigene Tabelle hin und zurueck** — das ist fuer
//! die Abbildung eine Tautologie und fuer die Strecke keine: geprueft wird, dass
//! ueberhaupt ein Tastenereignis ankommt, mit der richtigen Seite, in der
//! richtigen Reihenfolge und mit passendem Runter/Hoch.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGEventType, CGMouseButton, CGScrollEventUnit,
};

use crate::tasten;

/// Die Tastenfolge der Selbstprobe, in Satz-1-Scancodes.
///
/// Bewusst gemischt: Buchstaben und Ziffern (einfache Codes), Leertaste, ein
/// Pfeil und der Ziffernblock-Eingabe (beide **erweitert**, `0xE0`-Vorsatz) und
/// zum Schluss die **rechte** Strg-Taste — der Fall, an dem ein Messmittel
/// luegt, wenn es links und rechts zusammenwirft.
pub const TASTENFOLGE: &[u16] = &[
    0x19, 0x16, 0x26, 0x1f, 0x12, // p u l s e
    0x39, // Leertaste
    0x03, 0x0b, 0x03, 0x09, // 2 0 2 6
    0xe04b, // Pfeil links
    0xe01c, // Ziffernblock-Eingabe
    0xe01d, // Strg rechts
];

/// Der Abstand zwischen zwei abgefeuerten Ereignissen.
///
/// Grosszuegig gewaehlt: das Fenster muss jedes einzeln zugestellt bekommen,
/// und macOS fasst dicht aufeinanderfolgende Bewegungen zusammen
/// (Coalescing). Ein zusammengefasstes Paar sieht in der Auswertung wie ein
/// verlorenes Ziel aus.
const ABSTAND: Duration = Duration::from_millis(140);

/// Faehrt die Probe in einem eigenen Faden. `fertig` wird gesetzt, wenn alles
/// abgefeuert ist.
pub fn starten(ziele: Vec<(f64, f64)>, mitte: (f64, f64), fertig: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        // Ein kurzer Vorlauf: das Fenster ist zwar oben, aber der erste
        // Wechsel in den Vollbild-Schreibtisch laeuft noch aus.
        std::thread::sleep(Duration::from_millis(400));
        if let Some(q) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
            fahren(&q, &ziele, mitte);
        }
        fertig.store(true, Ordering::SeqCst);
    });
}

fn fahren(quelle: &CGEventSource, ziele: &[(f64, f64)], mitte: (f64, f64)) {
    for &z in ziele {
        bewegen(quelle, z);
    }

    // Zwei Klicks kurz hintereinander, der zweite mit Klickstand 2 — genau die
    // Zahl, die macOS nicht selbst vergibt und die der Injektor deshalb selbst
    // fuehrt. Ob sie bis zum Fenster durchlaeuft, hat noch niemand gemessen.
    bewegen(quelle, mitte);
    knopf(quelle, mitte, true, 1);
    knopf(quelle, mitte, false, 1);
    std::thread::sleep(Duration::from_millis(80));
    knopf(quelle, mitte, true, 2);
    knopf(quelle, mitte, false, 2);

    rad(quelle);

    for &scan in TASTENFOLGE {
        let Some(vk) = tasten::virtualcode(scan) else { continue };
        // Die Kennzeichnung wie beim Sidecar: eine Umschalttaste traegt beim
        // Loslassen noch ihre eigene (dessen `Druck` wird erst danach
        // fortgeschrieben — Nachtrag 1 der Messakte).
        let flagge = umschaltflagge(vk);
        taste(quelle, vk, true, flagge);
        taste(quelle, vk, false, flagge);
    }
}

fn umschaltflagge(vk: u16) -> CGEventFlags {
    match vk {
        0x38 | 0x3c => CGEventFlags::MaskShift,
        0x3b | 0x3e => CGEventFlags::MaskControl,
        0x3a | 0x3d => CGEventFlags::MaskAlternate,
        0x36 | 0x37 => CGEventFlags::MaskCommand,
        _ => CGEventFlags::empty(),
    }
}

fn abfeuern(ereignis: &CGEvent, flags: CGEventFlags) {
    CGEvent::set_flags(Some(ereignis), flags);
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(ereignis));
    std::thread::sleep(ABSTAND);
}

fn bewegen(quelle: &CGEventSource, punkt: (f64, f64)) {
    let ort = CGPoint { x: punkt.0, y: punkt.1 };
    if let Some(e) =
        CGEvent::new_mouse_event(Some(quelle), CGEventType::MouseMoved, ort, CGMouseButton::Left)
    {
        abfeuern(&e, CGEventFlags::empty());
    }
}

fn knopf(quelle: &CGEventSource, punkt: (f64, f64), runter: bool, stand: i64) {
    let typ = if runter { CGEventType::LeftMouseDown } else { CGEventType::LeftMouseUp };
    let ort = CGPoint { x: punkt.0, y: punkt.1 };
    if let Some(e) = CGEvent::new_mouse_event(Some(quelle), typ, ort, CGMouseButton::Left) {
        CGEvent::set_integer_value_field(Some(&e), CGEventField::MouseEventClickState, stand);
        abfeuern(&e, CGEventFlags::empty());
    }
}

fn rad(quelle: &CGEventSource) {
    if let Some(e) =
        CGEvent::new_scroll_wheel_event2(Some(quelle), CGScrollEventUnit::Line, 2, 1, 0, 0)
    {
        abfeuern(&e, CGEventFlags::empty());
    }
}

fn taste(quelle: &CGEventSource, vk: u16, runter: bool, flagge: CGEventFlags) {
    if let Some(e) = CGEvent::new_keyboard_event(Some(quelle), vk, runter) {
        // **Dieselbe Kennzeichnung auf Runter UND Hoch** — nicht aus
        // Bequemlichkeit, sondern weil der Sidecar es genauso macht: `Druck`
        // wird erst NACH dem Injektor-Aufruf fortgeschrieben, ein Cmd-Hoch
        // traegt dort also noch sein eigenes `.maskCommand` (Nachtrag 1 der
        // Messakte). Wer hier beim Hoch die Kennzeichnung wegliesse, faehre
        // eine Probe, die den Ernstfall nicht nachstellt.
        abfeuern(&e, flagge);
    }
}
