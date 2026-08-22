//! Die `SendInput`-Normierung — Bildschirmpunkt auf 0..65535 ueber den
//! **gesamten** virtuellen Desktop.
//!
//! Die Anteilsrechnung und die Klemmung stehen seit dem 2026-08-22 gemeinsam
//! in `pulse_fernsteuerung::zuordnung`. Was hier bleibt, gilt nur fuer
//! Windows: `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` normiert auf den
//! gesamten virtuellen Desktop, nicht auf den Primaermonitor — das ist die
//! Erkenntnis aus dem M0-Pruefling.

use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

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
///
/// **Grenze der exakten Umkehrung** (nachgerechnet 2026-08-12, alle Bildpunkte
/// je Spannweite): Bis zu einer Spannweite von **32770 px** rechnet sich jeder
/// Punkt lückenlos zurück. Ab 32771 gibt es Spannweiten, bei denen es nicht mehr
/// aufgeht (32771 px: 2 Punkte daneben; 40000 px: 17,9 %) — die Kachel ist dann
/// schmaler als zwei Stufen, und die Abrundung fällt über die Kante. Heute
/// unerreichbar (acht 4K-Schirme nebeneinander sind 30720 px), aber die Grenze
/// gehört hingeschrieben, bevor jemand sie unbemerkt überschreitet.
pub fn punkt_auf_absolut(px: i32, py: i32, vd: &VirtualDesktop) -> (i32, i32) {
    // Auf die MITTE der Kachel zielen, die Windows diesem Bildpunkt zuweist:
    // beim Einspielen rechnet es `p = n * cx / 65536` zurück, also ist
    // `n = (p * 65536 + 32768) / cx` die echte Umkehrung.
    //
    // HIER STAND `p * 65535 / (cx - 1)` — Kante auf Kante. Das ist zur
    // Windows-Rechnung nur eine Näherung und trifft daneben, sobald der
    // virtuelle Desktop breit genug ist. Gemessen am 2026-08-12 über drei
    // Bildschirme (7680 px breit, Ursprung −2560): die alte Fassung traf 42 von
    // 45 Punkten, die neue 45 von 45. Bei einem einzelnen 2560er Schirm hob sich
    // der Fehler **nicht** auf — hier stand das, und es ist falsch: die alte
    // Formel lag dort auf 42 von 2560 Bildpunkten daneben (bei 5120 auf 174, bei
    // 7680 auf 474). Seltener, nicht weg — deshalb ist es wochenlang nicht
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

    /// Die dokumentierte Grenze, ausgefahren: bis zur Spannweite 32770 rechnet
    /// sich **jeder** Bildpunkt zurück — auch acht 4K-Schirme nebeneinander
    /// (30720 px) liegen darunter. Ab 32771 hält die Zusage nicht mehr für alle
    /// Spannweiten; das steht als Grenze an [`punkt_auf_absolut`], damit es
    /// niemand unbemerkt überschreitet.
    #[test]
    fn die_umkehrung_gilt_bis_zur_spannweite_32770() {
        for &span in &[30720, 32770] {
            let vd = VirtualDesktop { x: 0, y: 0, cx: span, cy: 1440 };
            for px in 0..span {
                let (nx, _) = punkt_auf_absolut(px, 0, &vd);
                let zurueck = ((nx as i64 * span as i64) / 65536) as i32;
                assert_eq!(zurueck, px, "span={span} px={px} n={nx}");
            }
        }
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
