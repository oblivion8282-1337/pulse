//! Die Form des Host-Zeigers, wie sie ueber die Leitung kommt: ein **Name**
//! aus der CSS-Zeigerliste.
//!
//! Getrennt von [`super::eingabe`] aus demselben Grund wie
//! [`crate::fernsteuerung::winit_abbild`]: das hier ist reine Zuordnung, kennt
//! weder Fenster noch Sitzung und ist fuer sich pruefbar. Was die SITZUNG damit
//! macht, steht drueben (`eingabe.rs::remote_pointer`).
//!
//! Die Datei heisst wie ihre beiden Gegenstuecke — Sidecar
//! (`streaming/win-hq-sidecar/src/remote_input/zeigerform.rs`) und Renderer
//! (`web/src/lib/remote/zeigerform.ts`) —, weil die Liste an allen drei Stellen
//! dieselbe sein muss.

/// Den gemeldeten Namen in eine winit-Form uebersetzen.
///
/// Die Namen kommen aus der CSS-Zeigerliste, und winit benennt seine Formen
/// nach derselben — deshalb ist das hier eine Tabelle und keine Uebersetzung.
/// Genau darin liegt die Plattformunabhaengigkeit: winit setzt daraus unter
/// Windows die `IDC_*`-Zeiger, unter macOS `NSCursor` und unter Linux die Namen
/// des installierten Zeiger-Themas. Ein Linux-Rechner, der einen
/// Windows-Rechner steuert, sieht damit seinen eigenen I-Balken.
///
/// **Unbekanntes wird zum Pfeil, nicht zum Fehler.** Der Name kommt vom fernen
/// Rechner; eine neuere Gegenseite darf eine Form kennen, die diese Fassung
/// nicht hat, ohne dass daran etwas bricht. **Mit der Liste des Hosts synchron
/// halten** (s. Modulkopf).
pub(super) fn zeigerform(name: &str) -> winit::window::CursorIcon {
    use winit::window::CursorIcon as C;
    match name {
        "text" => C::Text,
        "pointer" => C::Pointer,
        "wait" => C::Wait,
        "progress" => C::Progress,
        "crosshair" => C::Crosshair,
        "help" => C::Help,
        "not-allowed" => C::NotAllowed,
        "ew-resize" => C::EwResize,
        "ns-resize" => C::NsResize,
        "nwse-resize" => C::NwseResize,
        "nesw-resize" => C::NeswResize,
        "move" => C::Move,
        _ => C::Default,
    }
}

#[cfg(test)]
mod tests {
    use super::zeigerform;
    use winit::window::CursorIcon as C;

    /// Die Namen der Gegenseite treffen die erwarteten Formen. Der Test ist die
    /// eine Stelle, an der die drei Listen (Sidecar, Renderer, Player)
    /// zusammenkommen — faellt hier ein Name durch, kaeme er im Betrieb
    /// wortlos als Standardpfeil an, und niemand suchte danach.
    #[test]
    fn bekannte_namen_werden_uebersetzt() {
        for (name, erwartet) in [
            ("text", C::Text),
            ("pointer", C::Pointer),
            ("wait", C::Wait),
            ("progress", C::Progress),
            ("crosshair", C::Crosshair),
            ("help", C::Help),
            ("not-allowed", C::NotAllowed),
            ("ew-resize", C::EwResize),
            ("ns-resize", C::NsResize),
            ("nwse-resize", C::NwseResize),
            ("nesw-resize", C::NeswResize),
            ("move", C::Move),
            ("default", C::Default),
        ] {
            assert_eq!(zeigerform(name), erwartet, "{name}");
        }
    }

    /// Unbekanntes und Fehlendes werden zum Pfeil — der Name kommt vom fernen
    /// Rechner, und eine neuere Gegenseite darf mehr kennen als diese Fassung.
    #[test]
    fn unbekanntes_wird_zum_pfeil() {
        for name in ["", "zoom-in", "ns-Resize", "beliebiger unsinn"] {
            assert_eq!(zeigerform(name), C::Default, "{name:?}");
        }
    }
}
