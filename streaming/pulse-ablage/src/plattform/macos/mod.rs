//! Die geteilte Zwischenablage auf macOS — `NSPasteboard`.
//!
//! **Warum diese Umsetzung in der Kiste liegt und nicht beim Verbraucher.**
//! Wayland steht im Player (nur er ist dort Steuernder, Linux kann nicht Host
//! sein) — auf macOS gibt es **beide** Rollen: der `mac-hq-sidecar` ist Host,
//! der `pulse-player` der Steuernde. Und beide Haelften einer Zwischenablage
//! sind spiegelbildlich gleich (Entwurf: „Es gibt keine Sender- und keine
//! Empfaengerseite"): dieselben drei Traits, dieselben Aufrufe. Beim
//! Verbraucher laege der Code deshalb ZWEIMAL im Baum — genau der Fehler, gegen
//! den die gemeinsamen Kisten gebaut sind. **Windows lag genau deshalb falsch**
//! und ist am 2026-08-31 nachgezogen ([`crate::plattform::windows`]).
//!
//! ## Was macOS anders macht als die beiden anderen
//!
//! | | Windows | Wayland | **macOS** |
//! |---|---|---|---|
//! | Beobachten | `WM_CLIPBOARDUPDATE` | `wl_data_device::selection` | **Abfrage** von `changeCount` (200 ms) |
//! | Faul liefern | `WM_RENDERFORMAT` | `wl_data_source::send` | `pasteboard:provideDataForType:` |
//! | Faden | Fenster (`HWND_MESSAGE`) | Ereignisschleife + Schreibfaden | eigene Run-Loop |
//!
//! Es gibt auf macOS **keine Aenderungs-Benachrichtigung**; alle pollen, das
//! ist kein Notbehelf. Die Abfrage liest **keinen Inhalt**, nur eine Zahl.
//!
//! ## Zwei Dinge aus der Kiste werden hier NICHT gebraucht
//!
//! * **`crate::eigentum::Anspruch`** ist eine Wayland-Not (Seriennummer aus
//!   einem frischen Eingabeereignis, sonst verwirft der Compositor den Anspruch
//!   still). macOS kennt das nicht — [`Ablagequelle::seriennummer`] liefert
//!   hier eine feste Zahl, jeder angemeldete Anspruch wird sofort eingeloest.
//!   Dasselbe tut die Windows-Umsetzung.
//! * **`Ablagestand::erwartet`**, der Zaehler fuer eigene Aenderungen, deren
//!   MELDUNG noch unterwegs ist. Hier ist keine unterwegs: die eigenen
//!   Vorgaenge liefern den neuen Zaehlerstand zurueck, und
//!   [`faden`] legt ihn als „gesehen" ab. Verbucht wird deshalb ueber
//!   [`crate::stand::Ablagestand::selbst_geaendert_quittiert`] — mit dem
//!   Meldungs-Zaehler waere der Poll-Faden ein Rennen, das die naechste echte
//!   Kopie des Nutzers schluckt (Begruendung an der Methode).
//!
//! **Ungeprueft auf der Entwicklungsmaschine.** Belegt ist, dass alles hier
//! uebersetzt (`cargo check --target aarch64-apple-darwin` gegen genau diese
//! Dateien); jedes Verhalten am echten Fach ist gefolgert. Die Rechnung
//! darueber — Zustandsfuehrung, Fristen, Buchfuehrung — liegt in
//! [`crate::lage`] und [`crate::stand`] und ist dort gefahren.

mod auftragsbuch;
mod eigner;
mod fach;
mod faden;

use std::sync::{Mutex, MutexGuard};

use crate::beobachter::Beobachter;
use crate::eigentum::Eigentum;
use crate::plattform::Ablagequelle;
use crate::stand::Ablagestand;

use auftragsbuch::Auftrag;

/// Der Stand zwischen dem Eigner-Faden und dem Takt des Verbrauchers.
///
/// **Am PROZESS, nicht an dieser Struktur**: es gibt genau ein Fach je Maschine
/// und genau einen Eigner-Faden je Prozess. Dieselbe Bauart wie auf Windows
/// ([`crate::plattform::windows`]).
static GETEILT: Mutex<Ablagestand> = Mutex::new(Ablagestand::neu());

fn stand() -> MutexGuard<'static, Ablagestand> {
    GETEILT.lock().unwrap_or_else(|e| e.into_inner())
}

/// Den Eigner-Faden aufstellen. Idempotent.
///
/// **Erst dieser Ruf ruehrt die Zwischenablage an.** Auf dem Host bestimmt der
/// Renderer damit den Traeger (ein Sidecar-Prozess je Stream-Platz, aber nur
/// eine Ablage je Maschine); im Player geschieht es, wenn eine Erfassung
/// beginnt.
pub fn starten() -> Result<(), String> {
    faden::starten()
}

/// Steht der Faden?
pub fn steht() -> bool {
    faden::steht()
}

/// Den Faden abbauen — **nachdem** das Eigentum abgegeben ist.
pub fn stoppen() {
    faden::stoppen();
}

/// Das `NSPasteboard` als Plattform der Zustandsmaschine.
///
/// Ohne Felder, wie `WinAblage`: der Zustand haengt am Prozess.
pub struct MacAblage;

impl Beobachter for MacAblage {
    fn geaendert(&mut self) -> bool {
        stand().aenderung_abholen()
    }

    /// Das Ergebnis des zuletzt abgeschlossenen Lesevorgangs — **blockiert
    /// nie**. Steht keines bereit, ist `None` die sichere Antwort: sie kostet
    /// ein Einfuegen, nie einen falschen Inhalt.
    fn lesen(&self) -> Option<String> {
        stand().gelesenes()
    }
}

impl Eigentum for MacAblage {
    fn beanspruchen(&mut self) -> Result<(), String> {
        if !steht() {
            return Err("kein Ablage-Eigner-Faden".to_string());
        }
        auftragsbuch::auftrag(Auftrag::Beanspruchen);
        // **Die Plattform wird gefragt, nicht geraten**: der Auftrag laeuft auf
        // dem Eigner-Faden, und ob er geglueckt ist, steht danach im Stand.
        if stand().eigen() {
            Ok(())
        } else {
            Err("Anspruch nicht angenommen".to_string())
        }
    }

    /// Den Inhalt an den wartenden Rueckruf geben.
    ///
    /// Nur hinterlegen — abgeholt wird er auf dem Eigner-Faden, wo das
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
        auftragsbuch::auftrag(Auftrag::Freigeben(zurueck.map(str::to_string)));
    }
}

impl Ablagequelle for MacAblage {
    fn einfuegen_wartet(&mut self) -> bool {
        stand().wartet()
    }

    /// **macOS kennt keine Seriennummer** — das ist eine reine Wayland-Not
    /// (s. Modulkopf). Jeder angemeldete Anspruch wird sofort eingeloest.
    fn seriennummer(&self) -> Option<u32> {
        Some(0)
    }

    fn eigentuemer(&self) -> bool {
        stand().eigen()
    }

    /// Steht der Eigner-Faden? Nur dann findet ueberhaupt etwas statt — und nur
    /// dann verspricht die Oberflaeche es (der Schalter im Fern-Menue des
    /// Players haengt genau hier).
    fn wirksam(&self) -> bool {
        steht()
    }

    fn lesen_anstossen(&mut self) {
        {
            let mut g = stand();
            if !g.lesen_offen() {
                return;
            }
            // **Die eigene Ablage braucht keinen Auftrag** — was dort liegt,
            // kam ohnehin von der Gegenseite, und „nichts Eigenes" steht
            // sofort fest. Der Riegel, an dem es haengt, sitzt trotzdem im
            // Auftrag selbst ([`auftragsbuch::auftraege_abarbeiten`]): dort
            // waere ein Lesen der eigenen Auswahl ein Selbstblock, und ein
            // Riegel gehoert an die Stelle, an der der Schaden entstuende.
            if g.eigen() {
                g.lesen_fertig(None);
                return;
            }
            g.lesen_beginnen();
        }
        // **Die Sperre faellt VOR dem Auftrag**: der Eigner-Faden nimmt sie
        // selbst, sobald er ihn ausfuehrt.
        auftragsbuch::auftrag(Auftrag::Lesen);
    }

    fn lesen_bereit(&mut self) -> bool {
        stand().lesen_bereit()
    }
}
