//! Die Vorgaenge am `NSPasteboard` selbst — und **nur** sie.
//!
//! Jede Funktion hier ist ein Aufruf ans Betriebssystem und sonst nichts; die
//! Rechnung darueber steht in [`super::faden`], die Zustandsfuehrung in
//! [`crate::lage`]. Derselbe Schnitt wie `win-hq-sidecar/src/ablage/fach.rs`.
//!
//! **Ungeprueft auf der Entwicklungsmaschine.** Belegt ist, dass diese Aufrufe
//! uebersetzen (`cargo check --target aarch64-apple-darwin`); ihr Verhalten am
//! echten Fach ist gefolgert.

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2_app_kit::{NSPasteboard, NSPasteboardType, NSPasteboardTypeOwner, NSPasteboardTypeString};
use objc2_foundation::{NSArray, NSString};

use super::eigner::Eigner;

/// Das allgemeine Fach. Es gibt genau eines je Maschine — deshalb gibt es auch
/// genau einen Traeger je Maschine (s. Entwurf, „Wer besitzt die Ablage bei
/// mehreren Plaetzen").
pub(super) fn fach() -> Retained<NSPasteboard> {
    NSPasteboard::generalPasteboard()
}

/// Der eine Typ, den Stufe 1 kennt. Dateien und Bilder sind ausdruecklich
/// Stufe 2 (s. Entwurf, „Nicht-Ziele").
fn text_typen() -> Retained<NSArray<NSPasteboardType>> {
    // SAFETY: eine Konstante, die AppKit beim Laden anlegt und nie aendert —
    // dieselbe Begruendung wie bei `kCFRunLoopDefaultMode` im mac-Sidecar.
    NSArray::from_slice(&[unsafe { NSPasteboardTypeString }])
}

/// Der Aenderungszaehler. **Die ganze Beobachtung haengt an dieser einen
/// Zahl** — macOS meldet eine Aenderung nicht, es laesst sie abfragen.
///
/// Der Aufruf liest **keinen Inhalt**, und das ist der Punkt: eine Aenderung zu
/// bemerken kostet nichts an Vertraulichkeit.
pub(super) fn zaehlerstand(pb: &NSPasteboard) -> isize {
    pb.changeCount()
}

/// Liegt Text im Fach?
///
/// **Auch das liest den Inhalt nicht:** `availableTypeFromArray` fragt die
/// angebotenen Typen ab. Bei einem fremden Eigentuemer mit verzoegertem Rendern
/// wird dabei nichts eingeloest — er hat die Typen angemeldet, nicht die Daten.
pub(super) fn text_da(pb: &NSPasteboard) -> bool {
    pb.availableTypeFromArray(&text_typen()).is_some()
}

/// Beanspruchen — **ohne Daten zu hinterlegen.** Liefert den neuen
/// Zaehlerstand.
///
/// Das ist das verzoegerte Rendern auf macOS: `declareTypes:owner:` meldet nur
/// an, dass hier Text zu haben WAERE. Erst wenn jemand einfuegt, fragt AppKit
/// den Eigentuemer ueber `pasteboard:provideDataForType:` (s.
/// [`super::eigner`]), und erst dieser Moment loest die Uebertragung aus.
///
/// **Der Rueckgabewert ist die Buchfuehrung**, nicht Beiwerk: an ihm erkennt
/// [`super::faden`] die eigene Aenderung wieder und laesst sie nicht als
/// Neuigkeit hinausgehen.
pub(super) fn beanspruchen(pb: &NSPasteboard, eigner: &Eigner) -> isize {
    let proto: &ProtocolObject<dyn NSPasteboardTypeOwner> = ProtocolObject::from_ref(eigner);
    let obj: &AnyObject = proto.as_ref();
    // SAFETY: `new_owner` muss von passendem Typ sein — er erfuellt
    // `NSPasteboardTypeOwner`, und genau das verlangt die Methode.
    unsafe { pb.declareTypes_owner(&text_typen(), Some(obj)) };
    // **Nicht der Rueckgabewert von `declareTypes`, sondern der Stand danach.**
    // Beide sollten gleich sein; abweichen koennen sie nur, wenn in genau
    // diesem Augenblick jemand anders geschrieben hat — und dann ist der
    // spaetere Stand der richtige, sonst hielte der Poll unsere eigene
    // Aenderung fuer eine fremde und kuendigte sie an.
    zaehlerstand(pb)
}

/// Den gemerkten Vorbestand zurueckschreiben. Liefert den neuen Zaehlerstand.
///
/// **Wir bleiben danach Eigentuemer**, und das ist auf jeder Plattform so:
/// fremdes Eigentum laesst sich nirgends zurueckgeben. Was in der Ablage liegt,
/// gehoert wieder dem Nutzer — der Unterschied faellt erst auf, wenn dieser
/// Prozess endet.
pub(super) fn zurueckschreiben(pb: &NSPasteboard, text: &str) -> isize {
    pb.clearContents();
    let s = NSString::from_str(text);
    if !pb.setString_forType(&s, unsafe { NSPasteboardTypeString }) {
        eprintln!(
            "[ablage] Vorbestand nicht zurueckgeschrieben — die Ablage bleibt leer."
        );
    }
    zaehlerstand(pb)
}

/// Das Fach raeumen. Liefert den neuen Zaehlerstand.
///
/// Danach gehoert es niemandem mehr: `clearContents` nimmt die angemeldeten
/// Typen zurueck, und ohne Typen fragt AppKit auch niemanden mehr nach Daten.
pub(super) fn raeumen(pb: &NSPasteboard) -> isize {
    pb.clearContents();
    zaehlerstand(pb)
}

/// Die FREMDE Auswahl lesen. **Das ist der eine Aufruf hier, der blockieren
/// kann** — haelt sie ein fremdes Programm mit verzoegertem Rendern, wartet er
/// auf dessen Antwort. Er laeuft deshalb auf dem Eigner-Faden, nie auf dem, der
/// die Fernsteuerung traegt.
pub(super) fn lesen(pb: &NSPasteboard) -> Option<String> {
    let typ = pb.availableTypeFromArray(&text_typen())?;
    pb.stringForType(&typ).map(|s| s.to_string())
}

/// Einem wartenden Einfuegevorgang antworten — **innerhalb** des Rueckrufs
/// `pasteboard:provideDataForType:`, wo das einfuegende Programm wartet.
pub(super) fn antworten(pb: &NSPasteboard, typ: &NSPasteboardType, text: &str) {
    let s = NSString::from_str(text);
    pb.setString_forType(&s, typ);
}
