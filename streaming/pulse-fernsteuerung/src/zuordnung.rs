//! Koordinaten-Zuordnung — Bildanteil auf einen Punkt im Quell-Rechteck.
//!
//! Der Steuernde schickt `u,v` als 0..65535, bezogen auf das **Videobild** —
//! nicht auf seinen eigenen Bildschirm und nicht auf den Desktop des Hosts.
//! Anteile statt Pixel, weil Pixelwerte verlangten, dass beide Seiten die
//! Geometrie des Hosts kennen und einig sind; bei Monitorwechsel oder
//! Aufloesungsstufe muesste das neu abgeglichen werden, und jede Verzoegerung
//! dabei setzt Klicks falsch.
//!
//! **Die Einheit des Ergebnisses gehoert der Plattform.** Auf Windows sind es
//! physische Bildpunkte (der Prozess ist DPI-bewusst), auf macOS Punkte im
//! globalen Anzeigeraum. Die Rechnung hier kennt den Unterschied nicht und
//! muss ihn nicht kennen: sie rechnet Anteile in ein Rechteck, das ihr die
//! Plattform gibt.
//!
//! Die Umrechnung auf `SendInput`-Absolutkoordinaten steht NICHT hier, sondern
//! im Windows-Sidecar (`remote_input/zuordnung.rs`) — sie gilt nur dort.

/// Das Quell-Rechteck, halboffen: rechte und untere Kante gehoeren dem
/// Nachbarn.
///
/// **Eigener Typ statt des Plattform-Typs.** Windows liefert `RECT`, macOS
/// `CGRect` (Ursprung plus Groesse, Fliesskomma). Beide werden von ihrer
/// Plattform hierher umgerechnet; die Klemm-Zusage der Spezifikation wird
/// genau einmal umgesetzt, nicht je Betriebssystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rechteck {
    pub links: i32,
    pub oben: i32,
    pub rechts: i32,
    pub unten: i32,
}

/// Normierte Videobild-Koordinate (0..65535) → physischer Bildschirmpunkt im
/// Quell-Rechteck. Ins Rechteck geklemmt: der Steuernde kann nur dorthin
/// klicken, wo er per Aufnahme auch hinsehen darf.
///
/// `None` bei einem **entarteten Rechteck** (keine Breite oder keine Höhe) — es
/// gibt dann keinen Bildpunkt, auf den sich ein Anteil abbilden ließe. Der
/// Aufrufer verwirft die Bewegung, wie bei einem Ziel ohne Rechteck.
///
/// Das ist kein Vorsichts-`if`: `DwmGetWindowAttribute` liefert für ein
/// **gecloaktes** Fenster (anderer virtueller Desktop, minimiertes UWP-Fenster)
/// ein leeres Rechteck — ein geschlossenes oder ausgeblendetes Fenster liefert
/// auf beiden Plattformen ein leeres Rechteck. Bei `right == left` panikte
/// `clamp(left, right - 1)` („min > max") — und zwar im Dispatch-Faden, also im
/// Haupt-Faden: die Panik propagierte aus `main` heraus, übersprang
/// `Sitzung::beenden` und `StreamController::stop`, vergiftete die Sperre der
/// Sitzung und nahm damit alles auf einmal mit — Prozess tot, Stream weg, und
/// alles Gedrückte blieb gedrückt.
pub fn anteil_auf_punkt(x: u16, y: u16, r: &Rechteck) -> Option<(i32, i32)> {
    let w = r.rechts - r.links;
    let h = r.unten - r.oben;
    if w <= 0 || h <= 0 {
        return None;
    }
    // Auf (w-1)/(h-1) skalieren, damit 65535 exakt auf den letzten Bildpunkt
    // fällt — sonst erreicht der Zeiger den rechten/unteren Rand nie.
    let px = r.links + ((x as i64 * (w - 1) as i64 + 32767) / 65535) as i32;
    let py = r.oben + ((y as i64 * (h - 1) as i64 + 32767) / 65535) as i32;
    klemmen(px, py, r)
}

/// Einen Bildschirmpunkt ins Quell-Rechteck klemmen. `None` bei einem entarteten
/// Rechteck (keine Breite oder keine Höhe) — dort gibt es keinen Punkt, auf den
/// sich klemmen ließe (Begründung des Falls s. [`anteil_auf_punkt`]).
///
/// Die **eine** Stelle, an der die Klemm-Zusage der Spezifikation rechnerisch
/// eingelöst wird: absolute Bewegung, relative Bewegung und das Orts-Tor für
/// Knopf und Rad (`super::ausfuehrung`) gehen alle hier durch. Halboffen —
/// rechte und untere Kante gehören dem Nachbarn.
pub fn klemmen(px: i32, py: i32, r: &Rechteck) -> Option<(i32, i32)> {
    if r.rechts <= r.links || r.unten <= r.oben {
        return None;
    }
    Some((
        px.clamp(r.links, r.rechts - 1),
        py.clamp(r.oben, r.unten - 1),
    ))
}

/// Die Mitte des Quell-Rechtecks — Startpunkt für relative Bewegung ohne
/// bekannte Zeigerlage (`super::ausfuehrung::relatives_ziel`). `None` bei
/// entartetem Rechteck.
pub fn mitte(r: &Rechteck) -> Option<(i32, i32)> {
    klemmen(
        r.links + (r.rechts - r.links) / 2,
        r.oben + (r.unten - r.oben) / 2,
        r,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(l: i32, t: i32, r: i32, b: i32) -> Rechteck {
        Rechteck { links: l, oben: t, rechts: r, unten: b }
    }

    #[test]
    fn ecken_treffen_die_raender() {
        let r = rect(100, 200, 1100, 800); // 1000x600 an (100,200)
        assert_eq!(anteil_auf_punkt(0, 0, &r), Some((100, 200)));
        // 65535 muss den LETZTEN Bildpunkt treffen, nicht den ersten daneben.
        assert_eq!(anteil_auf_punkt(65535, 65535, &r), Some((1099, 799)));
    }

    #[test]
    fn mitte_bleibt_mitte() {
        let r = rect(0, 0, 1921, 1081);
        let (px, py) = anteil_auf_punkt(32767, 32767, &r).unwrap();
        assert!((px - 960).abs() <= 1, "px={px}");
        assert!((py - 540).abs() <= 1, "py={py}");
    }

    #[test]
    fn geklemmt_bleibt_im_rechteck() {
        let r = rect(0, 0, 100, 100);
        let (px, py) = anteil_auf_punkt(65535, 65535, &r).unwrap();
        assert!(px < 100 && py < 100, "innerhalb: {px},{py}");
    }

    /// Ein entartetes Rechteck (leer oder verdreht) wird abgewiesen statt
    /// darin gerechnet. Genau das liefert `DwmGetWindowAttribute` für ein
    /// gecloaktes Fenster — vorher panikte hier `clamp` (min > max) und riss im
    /// Dispatch-Faden den ganzen Prozess mit.
    #[test]
    fn entartetes_rechteck_wird_abgewiesen() {
        assert_eq!(anteil_auf_punkt(0, 0, &rect(0, 0, 0, 0)), None);
        assert_eq!(anteil_auf_punkt(3000, 3000, &rect(0, 0, 0, 0)), None);
        // Nur die Breite leer (rechte Kante = linke Kante) — der Panik-Fall.
        assert_eq!(anteil_auf_punkt(65535, 0, &rect(500, 100, 500, 700)), None);
        // Nur die Höhe leer.
        assert_eq!(anteil_auf_punkt(0, 65535, &rect(0, 100, 800, 100)), None);
        // Verdreht (rechts < links) — kommt aus keiner gesunden Abfrage, wäre
        // aber derselbe Panik-Fall.
        assert_eq!(anteil_auf_punkt(0, 0, &rect(800, 600, 100, 100)), None);
        // Ein Rechteck von genau einem Bildpunkt trägt dagegen.
        assert_eq!(anteil_auf_punkt(65535, 65535, &rect(7, 9, 8, 10)), Some((7, 9)));
    }

    /// Klemmen ist die eine Stelle, an der die Klemm-Zusage rechnerisch
    /// eingelöst wird — halboffen, und bei entartetem Rechteck `None`.
    #[test]
    fn klemmen_haelt_das_rechteck_halboffen() {
        let r = rect(100, 200, 1100, 800);
        assert_eq!(klemmen(600, 500, &r), Some((600, 500)));
        assert_eq!(klemmen(-9999, -9999, &r), Some((100, 200)));
        assert_eq!(klemmen(9999, 9999, &r), Some((1099, 799)));
        assert_eq!(klemmen(0, 0, &rect(0, 0, 0, 10)), None);
        assert_eq!(mitte(&r), Some((600, 500)));
        assert_eq!(mitte(&rect(5, 5, 5, 5)), None);
    }
}
