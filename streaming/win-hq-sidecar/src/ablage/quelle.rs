//! Die drei Traits aus `pulse-ablage`, auf Windows gelegt.
//!
//! Alles hier ist **duenn mit Absicht**: die Rechnung steht in
//! `pulse_ablage::lage` (Zustandsfuehrung) und in [`super::geteilt`]
//! (Buchfuehrung ueber eigene und fremde Aenderungen), die Win32-Aufrufe in
//! [`super::fenster`]. Diese Datei ist nur die Naht dazwischen — und sie hat
//! genau eine Regel: **sie blockiert nie**. Was warten muss, wartet auf dem
//! Fensterfaden.

use pulse_ablage::beobachter::Beobachter;
use pulse_ablage::eigentum::Eigentum;
use pulse_ablage::plattform::Ablagequelle;

use super::fenster::{self, Auftrag};

/// Die Windows-Zwischenablage als Plattform der Zustandsmaschine.
///
/// Ohne Felder: der Zustand haengt am PROZESS (es gibt genau eine
/// Zwischenablage je Maschine und genau einen Fensterfaden je Prozess), nicht
/// an dieser Struktur.
pub(super) struct WinAblage;

impl Beobachter for WinAblage {
    fn geaendert(&mut self) -> bool {
        fenster::geteilt().aenderung_abholen()
    }

    /// Das Ergebnis des zuletzt abgeschlossenen Lesevorgangs — **blockiert
    /// nie**. Steht noch keines bereit, ist `None` die sichere Antwort: sie
    /// kostet ein Einfuegen, nie einen falschen Inhalt.
    fn lesen(&self) -> Option<String> {
        fenster::geteilt().gelesenes()
    }
}

impl Eigentum for WinAblage {
    /// Beanspruchen **ohne Daten zu hinterlegen** — `SetClipboardData(
    /// CF_UNICODETEXT, NULL)`. Erst wenn jemand einfuegt, fragt Windows mit
    /// `WM_RENDERFORMAT` nach.
    fn beanspruchen(&mut self) -> Result<(), String> {
        if !fenster::steht() {
            return Err("kein Ablage-Fensterfaden".to_string());
        }
        fenster::auftrag(Auftrag::Beanspruchen);
        // **Die Plattform wird gefragt, nicht geraten**: der Auftrag laeuft auf
        // dem Fensterfaden, und ob er geglueckt ist, steht danach im Stand.
        if fenster::geteilt().eigen() {
            Ok(())
        } else {
            Err("Anspruch nicht angenommen".to_string())
        }
    }

    /// Den Inhalt an den wartenden Rendervorgang geben.
    ///
    /// Nur hinterlegen — abgeholt wird er auf dem Fensterfaden, wo das
    /// einfuegende Programm wartet. **Ein leerer Text ist eine gueltige
    /// Antwort** und heisst „es kam nichts".
    fn liefern(&mut self, text: &str) {
        fenster::geteilt().antwort_setzen(text);
    }

    fn freigeben(&mut self, zurueck: Option<&str>) {
        // Hat der Nutzer inzwischen selbst kopiert, gehoert ihm die Ablage —
        // sie mit einem Merkposten von vorhin zu ueberschreiben waere derselbe
        // stille Verlust, gegen den der Merkposten ueberhaupt gebaut ist.
        if !fenster::geteilt().eigen() {
            return;
        }
        fenster::auftrag(Auftrag::Freigeben(zurueck.map(str::to_string)));
    }
}

impl Ablagequelle for WinAblage {
    fn einfuegen_wartet(&mut self) -> bool {
        fenster::geteilt().wartet()
    }

    /// **Windows kennt keine Seriennummer** — das ist eine reine Wayland-Not
    /// (dort verlangt `set_selection` eine aus einem frischen
    /// Eingabeereignis, und ohne Fokus verwirft der Compositor den Anspruch
    /// still). Hier wird jeder angemeldete Anspruch sofort eingeloest.
    fn seriennummer(&self) -> Option<u32> {
        Some(0)
    }

    fn eigentuemer(&self) -> bool {
        fenster::geteilt().eigen()
    }

    /// Steht der Fensterfaden? Nur dann findet ueberhaupt etwas statt — und
    /// nur dann verspricht die Oberflaeche es (`Ablagequelle::wirksam`).
    fn wirksam(&self) -> bool {
        fenster::steht()
    }

    fn lesen_anstossen(&mut self) {
        let mut g = fenster::geteilt();
        if !g.lesen_offen() {
            return;
        }
        // **Die eigene Ablage wird nicht gelesen, und schon gar nicht ueber den
        // Fensterfaden.** Halten wir sie mit verzoegertem Rendern, schickte
        // `GetClipboardData` uns selbst ein `WM_RENDERFORMAT` — auf ebendiesem
        // Faden. Was dort liegt, kam ohnehin von der Gegenseite; „nichts
        // Eigenes" ist die richtige Antwort, und sie steht sofort fest.
        if g.eigen() {
            g.lesen_fertig(None);
            return;
        }
        g.lesen_beginnen();
        // **Die Sperre faellt VOR dem Auftrag**: der Fensterfaden nimmt sie
        // selbst, sobald er den Auftrag ausfuehrt.
        drop(g);
        fenster::auftrag(Auftrag::Lesen);
    }

    fn lesen_bereit(&mut self) -> bool {
        fenster::geteilt().lesen_bereit()
    }
}
