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
pub fn anteil_auf_punkt(x: u16, y: u16, rect: &RECT) -> (i32, i32) {
    let w = (rect.right - rect.left).max(1);
    let h = (rect.bottom - rect.top).max(1);
    // Auf (w-1)/(h-1) skalieren, damit 65535 exakt auf den letzten Bildpunkt
    // fällt — sonst erreicht der Zeiger den rechten/unteren Rand nie.
    let px = rect.left + ((x as i64 * (w - 1) as i64 + 32767) / 65535) as i32;
    let py = rect.top + ((y as i64 * (h - 1) as i64 + 32767) / 65535) as i32;
    (
        px.clamp(rect.left, rect.right - 1),
        py.clamp(rect.top, rect.bottom - 1),
    )
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
    let nx = ((px - vd.x) as i64 * 65535 / (vd.cx - 1).max(1) as i64) as i32;
    let ny = ((py - vd.y) as i64 * 65535 / (vd.cy - 1).max(1) as i64) as i32;
    (nx, ny)
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
        assert_eq!(anteil_auf_punkt(0, 0, &r), (100, 200));
        // 65535 muss den LETZTEN Bildpunkt treffen, nicht den ersten daneben.
        assert_eq!(anteil_auf_punkt(65535, 65535, &r), (1099, 799));
    }

    #[test]
    fn mitte_bleibt_mitte() {
        let r = rect(0, 0, 1921, 1081);
        let (px, py) = anteil_auf_punkt(32767, 32767, &r);
        assert!((px - 960).abs() <= 1, "px={px}");
        assert!((py - 540).abs() <= 1, "py={py}");
    }

    #[test]
    fn geklemmt_bleibt_im_rechteck() {
        let r = rect(0, 0, 100, 100);
        let (px, py) = anteil_auf_punkt(65535, 65535, &r);
        assert!(px < 100 && py < 100, "innerhalb: {px},{py}");
    }

    /// Zweitbildschirm links vom Primären: der Ursprung des virtuellen Desktops
    /// ist dann negativ. Genau dort geht eine Rechnung schief, die den
    /// Primärschirm für den Nullpunkt hält.
    #[test]
    fn absolut_spannt_den_ganzen_virtuellen_desktop() {
        let vd = VirtualDesktop { x: -2560, y: 0, cx: 5120, cy: 1440 };
        assert_eq!(punkt_auf_absolut(-2560, 0, &vd).0, 0);
        assert_eq!(punkt_auf_absolut(2559, 0, &vd).0, 65535);
    }
}
