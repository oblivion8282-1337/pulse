//! Die geteilte Zwischenablage auf Windows — `AddClipboardFormatListener` und
//! verzoegertes Rendern ueber `WM_RENDERFORMAT`.
//!
//! **Warum diese Umsetzung seit dem 2026-08-31 in der Kiste liegt und nicht
//! mehr im `win-hq-sidecar`.** Sie lag dort, solange Windows nur EINEN
//! Verbraucher hatte: den Sidecar als Host. Der `pulse-player` ist der zweite —
//! der Steuernde —, und beide Haelften einer Zwischenablage sind
//! spiegelbildlich gleich (Entwurf: „Es gibt keine Sender- und keine
//! Empfaengerseite"): dieselben drei Traits, dieselben Win32-Vorgaenge. Im
//! Sidecar erreichbar heisst fuer den Player: gar nicht erreichbar — ein
//! Windows-Nutzer, der einen anderen Rechner steuerte, teilte deshalb nichts.
//! Dieselbe Lage und dieselbe Antwort wie auf macOS ([`super::macos`]).
//!
//! ## Wo die Grenze liegt — und warum genau dort
//!
//! Hierher gehoert, was am Betriebssystem haengt: der Faden samt
//! Nachrichtenfenster ([`fenster`]), das Protokoll zwischen den beiden Faeden
//! ([`auftragsbuch`]), die Win32-Vorgaenge auf dem Fach ([`fach`]) und die
//! Trait-Umsetzung darueber (diese Datei).
//!
//! **Beim Verbraucher bleibt, was am Verbraucher haengt** und auf beiden Seiten
//! verschieden ist: welcher Rahmen wohin, wer taktet, wann Schluss ist. Der
//! Sidecar nimmt die Werte ueber eine stdio-Operation entgegen, reiht sie ein
//! und taktet auf einem eigenen Faden (`win-hq-sidecar/src/ablage.rs`); der
//! Player taktet in seiner Fensterschleife und fuehrt eine Zustandsmaschine je
//! SITZUNG (`app/ablage.rs`). Das laesst sich nicht zusammenlegen, ohne einem
//! der beiden eine fremde Bauform aufzuzwingen.
//!
//! ## Ein Faden je Prozess, eine Zwischenablage je Maschine
//!
//! Der Zustand haengt am PROZESS, nicht an [`WinAblage`] — es gibt genau eine
//! Zwischenablage je Maschine und genau einen Fensterfaden je Prozess. Wer sie
//! haelt, wenn mehrere in Frage kommen, entscheidet deshalb der Verbraucher:
//! auf dem Host der Renderer unter den Sidecar-Prozessen
//! (`web/src/lib/remote/ablageTraeger.ts`), im Player die Traegerwahl unter den
//! Sitzungen.
//!
//! **Erst [`starten`] ruehrt die Zwischenablage an.** Ein Prozess, der den Ruf
//! nie bekommt, baut kein Fenster, startet keinen Faden und beobachtet nichts.
//!
//! **Ungeprueft auf der Entwicklungsmaschine.** Belegt ist, dass alles hier
//! uebersetzt (`cargo check --target x86_64-pc-windows-msvc` gegen genau diese
//! Dateien, und `scripts/gate-rust.sh` faehrt es bei jeder Aenderung an dieser
//! Kiste); jedes Verhalten am echten Fach ist gefolgert. Die Rechnung darueber
//! — Zustandsfuehrung, Fristen, Buchfuehrung — liegt in [`crate::lage`] und
//! [`crate::stand`] und ist dort gefahren.

mod auftragsbuch;
mod fach;
mod fenster;

use std::sync::{Mutex, MutexGuard};

use crate::beobachter::Beobachter;
use crate::eigentum::Eigentum;
use crate::plattform::Ablagequelle;
use crate::stand::Ablagestand;

use auftragsbuch::Auftrag;

/// Der Stand zwischen dem Fensterfaden und dem Takt des Verbrauchers.
///
/// **Am PROZESS, nicht an [`WinAblage`]** (s. Modulkopf). Dieselbe Bauart wie
/// auf macOS.
static GETEILT: Mutex<Ablagestand> = Mutex::new(Ablagestand::neu());

fn stand() -> MutexGuard<'static, Ablagestand> {
    GETEILT.lock().unwrap_or_else(|e| e.into_inner())
}

/// Den Fensterfaden aufstellen. Idempotent.
pub fn starten() -> Result<(), String> {
    fenster::starten()
}

/// Steht der Fensterfaden?
pub fn steht() -> bool {
    fenster::steht()
}

/// Den Faden abbauen — **nachdem** das Eigentum abgegeben ist.
pub fn stoppen() {
    fenster::stoppen();
}

/// Die Windows-Zwischenablage als Plattform der Zustandsmaschine.
///
/// Ohne Felder: der Zustand haengt am Prozess (s. Modulkopf).
pub struct WinAblage;

impl Beobachter for WinAblage {
    fn geaendert(&mut self) -> bool {
        stand().aenderung_abholen()
    }

    /// Das Ergebnis des zuletzt abgeschlossenen Lesevorgangs — **blockiert
    /// nie**. Steht noch keines bereit, ist `None` die sichere Antwort: sie
    /// kostet ein Einfuegen, nie einen falschen Inhalt.
    fn lesen(&self) -> Option<String> {
        stand().gelesenes()
    }
}

impl Eigentum for WinAblage {
    /// Beanspruchen **ohne Daten zu hinterlegen** — `SetClipboardData(
    /// CF_UNICODETEXT, NULL)`. Erst wenn jemand einfuegt, fragt Windows mit
    /// `WM_RENDERFORMAT` nach.
    fn beanspruchen(&mut self) -> Result<(), String> {
        if !steht() {
            return Err("kein Ablage-Fensterfaden".to_string());
        }
        auftragsbuch::geben(Auftrag::Beanspruchen);
        // **Die Plattform wird gefragt, nicht geraten**: der Auftrag laeuft auf
        // dem Fensterfaden, und ob er geglueckt ist, steht danach im Stand.
        if stand().eigen() {
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
        stand().antwort_setzen(text);
    }

    fn freigeben(&mut self, zurueck: Option<&str>) {
        // Hat der Nutzer inzwischen selbst kopiert, gehoert ihm die Ablage —
        // sie mit einem Merkposten von vorhin zu ueberschreiben waere derselbe
        // stille Verlust, gegen den der Merkposten ueberhaupt gebaut ist.
        if !stand().eigen() {
            return;
        }
        auftragsbuch::geben(Auftrag::Freigeben(zurueck.map(str::to_string)));
    }
}

impl Ablagequelle for WinAblage {
    fn einfuegen_wartet(&mut self) -> bool {
        stand().wartet()
    }

    /// **Windows kennt keine Seriennummer** — das ist eine reine Wayland-Not
    /// (dort verlangt `set_selection` eine aus einem frischen
    /// Eingabeereignis, und ohne Fokus verwirft der Compositor den Anspruch
    /// still). Hier wird jeder angemeldete Anspruch sofort eingeloest.
    fn seriennummer(&self) -> Option<u32> {
        Some(0)
    }

    fn eigentuemer(&self) -> bool {
        stand().eigen()
    }

    /// Steht der Fensterfaden? Nur dann findet ueberhaupt etwas statt — und
    /// nur dann verspricht die Oberflaeche es (`Ablagequelle::wirksam`; der
    /// Schalter im Fern-Menue des Players haengt genau hier).
    fn wirksam(&self) -> bool {
        steht()
    }

    fn lesen_anstossen(&mut self) {
        {
            let mut g = stand();
            if !g.lesen_offen() {
                return;
            }
            // **Die eigene Ablage wird nicht gelesen, und schon gar nicht ueber
            // den Fensterfaden.** Halten wir sie mit verzoegertem Rendern,
            // schickte `GetClipboardData` uns selbst ein `WM_RENDERFORMAT` — auf
            // ebendiesem Faden. Was dort liegt, kam ohnehin von der Gegenseite;
            // „nichts Eigenes" ist die richtige Antwort, und sie steht sofort
            // fest.
            if g.eigen() {
                g.lesen_fertig(None);
                return;
            }
            g.lesen_beginnen();
        }
        // **Die Sperre faellt VOR dem Auftrag**: der Fensterfaden nimmt sie
        // selbst, sobald er den Auftrag ausfuehrt.
        auftragsbuch::geben(Auftrag::Lesen);
    }

    fn lesen_bereit(&mut self) -> bool {
        stand().lesen_bereit()
    }
}
