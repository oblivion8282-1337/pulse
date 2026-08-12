//! Koordinaten-Zuordnung — Bildanteil → Bildschirmpunkt → `SendInput`-Absolute.
//!
//! Zwei Umrechnungen, beide rein und getestet:
//!
//! 1. **Anteil → Punkt im Quell-Rechteck.** Der Steuernde schickt `u,v ∈ [0,1]`
//!    als 0..65535, bezogen auf das **Videobild** — nicht auf seinen eigenen
//!    Bildschirm und nicht auf den Desktop des Hosts. Anteile statt Pixel, weil
//!    Pixelwerte verlangten, dass beide Seiten die Geometrie des Hosts kennen
//!    und einig sind; bei Monitorwechsel oder Auflösungsstufe müsste das neu
//!    abgeglichen werden, und jede Verzögerung dabei setzt Klicks falsch.
//! 2. **Punkt → Absolutkoordinate.** `SendInput` mit `MOUSEEVENTF_ABSOLUTE |
//!    MOUSEEVENTF_VIRTUALDESK` normiert auf den **gesamten virtuellen Desktop**,
//!    nicht auf den Primärmonitor. Ohne `VIRTUALDESK` landen alle Klicks auf dem
//!    Primärschirm — das ist die Erkenntnis aus dem M0-Prüfling.

use windows::Win32::Foundation::RECT;
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

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
/// ein leeres Rechteck. Bei `right == left` panikte `clamp(left, right - 1)`
/// („min > max") — und zwar im Dispatch-Faden, also im Haupt-Faden: die Panik
/// propagierte aus `main` heraus, übersprang `Sitzung::beenden` und
/// `StreamController::stop`, vergiftete die Sperre der Sitzung und nahm damit
/// alles auf einmal mit — Prozess tot, Stream weg, und alles Gedrückte blieb
/// gedrückt.
pub fn anteil_auf_punkt(x: u16, y: u16, rect: &RECT) -> Option<(i32, i32)> {
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    if w <= 0 || h <= 0 {
        return None;
    }
    // Auf (w-1)/(h-1) skalieren, damit 65535 exakt auf den letzten Bildpunkt
    // fällt — sonst erreicht der Zeiger den rechten/unteren Rand nie.
    let px = rect.left + ((x as i64 * (w - 1) as i64 + 32767) / 65535) as i32;
    let py = rect.top + ((y as i64 * (h - 1) as i64 + 32767) / 65535) as i32;
    Some((
        px.clamp(rect.left, rect.right - 1),
        py.clamp(rect.top, rect.bottom - 1),
    ))
}

/// Grenzen des virtuellen Desktops (alle Bildschirme), physische Bildpunkte.
///
/// Physisch nur, weil der Prozess DPI-bewusst ist (`super::injektion::
/// dpi_bewusstsein_setzen`) — ohne das virtualisiert Windows diese Werte.
pub struct VirtualDesktop {
    pub x: i32,
    pub y: i32,
    pub cx: i32,
    pub cy: i32,
}

pub fn virtueller_desktop() -> VirtualDesktop {
    unsafe {
        VirtualDesktop {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            cx: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            cy: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// Physischer Bildschirmpunkt → `SendInput`-Absolutkoordinate (0..65535 über den
/// GESAMTEN virtuellen Desktop, wie im M0-Prüfling nachgemessen).
pub fn punkt_auf_absolut(px: i32, py: i32, vd: &VirtualDesktop) -> (i32, i32) {
    // Auf die MITTE der Kachel zielen, die Windows diesem Bildpunkt zuweist:
    // beim Einspielen rechnet es `p = n * cx / 65536` zurück, also ist
    // `n = (p * 65536 + 32768) / cx` die echte Umkehrung.
    //
    // HIER STAND `p * 65535 / (cx - 1)` — Kante auf Kante. Das ist zur
    // Windows-Rechnung nur eine Näherung und trifft daneben, sobald der
    // virtuelle Desktop breit genug ist. Gemessen am 2026-08-12 über drei
    // Bildschirme (7680 px breit, Ursprung −2560): die alte Fassung traf 42 von
    // 45 Punkten, die neue 45 von 45. Bei einem einzelnen 2560er Schirm hob
    // sich der Fehler zufällig auf — deshalb ist er wochenlang nicht
    // aufgefallen, und deshalb ist eine Messung über MEHRERE Bildschirme keine
    // Kür.
    //
    // **`px - vd.x` KANN negativ sein** — hier stand das Gegenteil, und für
    // Bildschirm-Ziele stimmt es auch (`vd.x` ist das Minimum über alle
    // Bildschirme). Für FENSTER-Ziele nicht: das Quell-Rechteck kommt aus
    // `DWMWA_EXTENDED_FRAME_BOUNDS`, und ein Fenster darf über den Rand des
    // Desktops hinausragen (halb aus dem Bild gezogen) — DWM gibt genau das
    // zurück. Ungeklemmt ginge daraus eine negative Absolutkoordinate an
    // `SendInput`, das sie als riesigen Wert liest. Also erst auf den Desktop
    // klemmen, dann normieren; der Zeiger kann ohnehin nirgends hin, wo kein
    // Bildschirm ist.
    let n = |p: i32, v: i32, span: i32| -> i32 {
        let span = span.max(1);
        let p = p.clamp(v, v + span - 1);
        ((((p - v) as i64 * 65536 + 32768) / span as i64) as i32).clamp(0, 65535)
    };
    (n(px, vd.x, vd.cx), n(py, vd.y, vd.cy))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(l: i32, t: i32, r: i32, b: i32) -> RECT {
        RECT { left: l, top: t, right: r, bottom: b }
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

    /// Zweitbildschirm links vom Primären: der Ursprung des virtuellen Desktops
    /// ist dann negativ. Genau dort geht eine Rechnung schief, die den
    /// Primärschirm für den Nullpunkt hält.
    #[test]
    fn absolut_spannt_den_ganzen_virtuellen_desktop() {
        let vd = VirtualDesktop { x: -2560, y: 0, cx: 5120, cy: 1440 };
        // Nicht exakt 0 und 65535: gezielt wird auf die MITTE der Kachel, die
        // Windows dem Bildpunkt zuweist. Entscheidend ist, dass die Rückrechnung
        // `n * cx / 65536` wieder auf demselben Bildpunkt landet — das prüft
        // `absolut_rechnet_sich_zurueck` unten.
        assert_eq!(punkt_auf_absolut(-2560, 0, &vd).0, 6);
        assert_eq!(punkt_auf_absolut(2559, 0, &vd).0, 65529);
    }

    /// Ein Fenster darf über den Rand des Desktops hinausragen (halb aus dem
    /// Bild gezogen); `DWMWA_EXTENDED_FRAME_BOUNDS` gibt das so zurück. Die
    /// Absolutkoordinate muss trotzdem im Bereich bleiben — ungeklemmt ging
    /// hier eine NEGATIVE Zahl an `SendInput`, die Windows als riesigen Wert
    /// liest.
    #[test]
    fn punkte_ausserhalb_des_desktops_bleiben_im_bereich() {
        let vd = VirtualDesktop { x: 0, y: 0, cx: 2560, cy: 1440 };
        for (px, py) in [(-300, -80), (-1, -1), (5000, 4000), (2560, 1440)] {
            let (nx, ny) = punkt_auf_absolut(px, py, &vd);
            assert!((0..=65535).contains(&nx), "x={px} → {nx}");
            assert!((0..=65535).contains(&ny), "y={py} → {ny}");
        }
        // Links über die Kante hinaus landet auf der ersten Spalte, nicht im
        // Negativen; rechts darüber hinaus auf der letzten.
        assert_eq!(punkt_auf_absolut(-300, 0, &vd), punkt_auf_absolut(0, 0, &vd));
        assert_eq!(
            punkt_auf_absolut(5000, 0, &vd),
            punkt_auf_absolut(2559, 0, &vd)
        );
    }

    /// Die eigentliche Zusage: Windows muss aus der Absolutkoordinate WIEDER
    /// den gesendeten Bildpunkt machen. Nachgestellt wird dessen Rechenweg
    /// (`p = n * cx / 65536`), über den ganzen Desktop und beide Achsen.
    ///
    /// Genau diese Zusage hat die vorherige Fassung verletzt — am Rand nie, in
    /// der Fläche an jedem fünfzehnten Punkt. Ein Test auf die Ränder allein
    /// hätte das nie gefunden.
    #[test]
    fn absolut_rechnet_sich_zurueck() {
        for &(cx, cy, x0, y0) in &[
            (5120, 1440, -2560, 0),
            (7680, 1440, -2560, 0),
            (2560, 1440, 0, 0),
            (4480, 1440, 0, 0),
        ] {
            let vd = VirtualDesktop { x: x0, y: y0, cx, cy };
            for schritt in 0..200 {
                let px = x0 + (schritt * (cx - 1)) / 199;
                let py = y0 + (schritt * (cy - 1)) / 199;
                let (nx, ny) = punkt_auf_absolut(px, py, &vd);
                let zurueck_x = x0 + ((nx as i64 * cx as i64) / 65536) as i32;
                let zurueck_y = y0 + ((ny as i64 * cy as i64) / 65536) as i32;
                assert_eq!(zurueck_x, px, "x bei cx={cx} px={px} n={nx}");
                assert_eq!(zurueck_y, py, "y bei cy={cy} py={py} n={ny}");
            }
        }
    }
}
