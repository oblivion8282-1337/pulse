//! Wo im Fenster das Videobild liegt — und welcher Teil der Quelle darin steht.
//!
//! Die absolute Zeigerposition der Wire-Spec ist ein Anteil **am Bildinhalt**,
//! nicht am Fenster. Zwischen beiden liegen zwei Dinge, und beide muessen
//! herausgerechnet werden:
//!
//! * der **Rand** (das Bild behaelt sein Seitenverhaeltnis, das Fenster hat ein
//!   beliebiges — links/rechts oder oben/unten bleibt Schwarz stehen), und
//! * der **Zoom-Ausschnitt** (wer hineingezoomt hat, sieht nur einen Teil der
//!   Quelle; ein Klick in die Mitte des Fensters meint dann die Mitte des
//!   AUSSCHNITTS, nicht die Mitte des Bildschirms des Hosts).
//!
//! Beide Zahlen kommen von dort, wo sie ohnehin entstehen:
//! [`crate::render::fit_viewport`] fuer den Rand (dieselbe Funktion, die den
//! Zeichen-Ausschnitt setzt — eine zweite Fassung hier hiesse, dass Klick und
//! Bild auseinanderlaufen koennen) und [`crate::render::zoom_ausschnitt`] fuer
//! den Zoom.
//!
//! Gerechnet wird in `f64`. winit liefert die Zeigerposition so, und auf ganze
//! Fensterpunkte gerundet ginge auf dem Weg zu 65536 Stufen Genauigkeit
//! verloren, die es umsonst gibt.

/// Bild-Rechteck im Fenster (physische Punkte) samt sichtbarem Ausschnitt der
/// Quelle (Anteile 0..1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bildlage {
    rechteck: (f64, f64, f64, f64),
    ausschnitt: (f64, f64, f64, f64),
}

impl Bildlage {
    /// `None`, solange es kein Bild gibt (Quellgroesse 0) oder das Fenster
    /// entartet ist. **Ohne Bild wird nicht gezeigt und deshalb auch nicht
    /// geklickt** — der Steuernde waere sonst blind.
    pub fn neu(fenster: (u32, u32), quelle: (u32, u32), ausschnitt: [f32; 4]) -> Option<Self> {
        if fenster.0 == 0 || fenster.1 == 0 || quelle.0 == 0 || quelle.1 == 0 {
            return None;
        }
        let (x, y, breite, hoehe) = crate::render::fit_viewport(
            fenster.0 as f32,
            fenster.1 as f32,
            quelle.0 as f32,
            quelle.1 as f32,
        );
        if breite <= 0.0 || hoehe <= 0.0 {
            return None;
        }
        Some(Self {
            rechteck: (f64::from(x), f64::from(y), f64::from(breite), f64::from(hoehe)),
            ausschnitt: (
                f64::from(ausschnitt[0]),
                f64::from(ausschnitt[1]),
                f64::from(ausschnitt[2]),
                f64::from(ausschnitt[3]),
            ),
        })
    }

    /// Zeigerposition (physische Punkte) -> Anteil am Bildinhalt, jeweils 0..1.
    ///
    /// `None`, wenn der Zeiger auf dem Rand steht: die Wire-Spec sagt
    /// ausdruecklich, dass Raender ausserhalb des Bildes **nicht** gesendet
    /// werden. Geklemmt kaeme dort ein Klick auf der Bildkante an, den niemand
    /// ausgeloest hat.
    pub fn anteil(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let (rx, ry, rb, rh) = self.rechteck;
        let u = (x - rx) / rb;
        let v = (y - ry) / rh;
        if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
            return None;
        }
        let (ax, ay, ab, ah) = self.ausschnitt;
        Some((ax + u * ab, ay + v * ah))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ganzes Bild, gleiches Seitenverhaeltnis: die Ecken sind exakt 0 und 1.
    #[test]
    fn ecken_ohne_rand_und_ohne_zoom() {
        let lage = Bildlage::neu((1920, 1080), (2560, 1440), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
        assert_eq!(lage.anteil(0.0, 0.0), Some((0.0, 0.0)));
        assert_eq!(lage.anteil(1920.0, 1080.0), Some((1.0, 1.0)));
        let (u, v) = lage.anteil(960.0, 540.0).expect("Mitte");
        assert!((u - 0.5).abs() < 1e-9 && (v - 0.5).abs() < 1e-9, "{u},{v}");
    }

    /// Breiteres Fenster: der Rand links gehoert nicht zum Bild, und die linke
    /// Bildkante liegt hinter ihm.
    #[test]
    fn seitlicher_rand_wird_herausgerechnet() {
        // 2000x1000 Fenster, 16:9-Quelle -> Bild ist 1777,8 breit, Rand 111,1.
        let lage = Bildlage::neu((2000, 1000), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
        assert_eq!(lage.anteil(50.0, 500.0), None, "linker Rand ist nicht das Bild");
        assert_eq!(lage.anteil(1950.0, 500.0), None, "rechter Rand ebenso");
        let (u, _) = lage.anteil(1000.0, 500.0).expect("Mitte");
        assert!((u - 0.5).abs() < 1e-9, "Fenstermitte ist Bildmitte: {u}");
    }

    #[test]
    fn rand_oben_und_unten_wird_herausgerechnet() {
        let lage = Bildlage::neu((1000, 2000), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
        assert_eq!(lage.anteil(500.0, 10.0), None);
        let (_, v) = lage.anteil(500.0, 1000.0).expect("Mitte");
        assert!((v - 0.5).abs() < 1e-9, "{v}");
    }

    /// Zweifacher Zoom auf die Bildmitte: das Fenster zeigt dann die mittleren
    /// 50 Prozent, ein Klick oben links meint also den Punkt (0,25 / 0,25).
    #[test]
    fn zoom_verschiebt_den_bezug_auf_den_ausschnitt() {
        let lage = Bildlage::neu((1920, 1080), (1920, 1080), [0.25, 0.25, 0.5, 0.5]).expect("Lage");
        let (u, v) = lage.anteil(0.0, 0.0).expect("Ecke");
        assert!((u - 0.25).abs() < 1e-9 && (v - 0.25).abs() < 1e-9, "{u},{v}");
        let (u, v) = lage.anteil(1920.0, 1080.0).expect("Ecke");
        assert!((u - 0.75).abs() < 1e-9 && (v - 0.75).abs() < 1e-9, "{u},{v}");
    }

    /// Bruchteile bleiben erhalten — genau dafuer wird in `f64` gerechnet.
    #[test]
    fn bruchteile_gehen_nicht_verloren() {
        let lage = Bildlage::neu((1000, 1000), (1000, 1000), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
        let (u, _) = lage.anteil(500.5, 500.0).expect("innen");
        assert!((u - 0.5005).abs() < 1e-9, "{u}");
    }

    #[test]
    fn ohne_bild_gibt_es_keine_lage() {
        assert!(Bildlage::neu((1920, 1080), (0, 0), [0.0, 0.0, 1.0, 1.0]).is_none());
        assert!(Bildlage::neu((0, 0), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).is_none());
    }
}
