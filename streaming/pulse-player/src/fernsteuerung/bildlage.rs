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
/// Quelle (Anteile 0..1) und der Groesse des Videobildes in Bildpunkten.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bildlage {
    rechteck: (f64, f64, f64, f64),
    ausschnitt: (f64, f64, f64, f64),
    /// Bildpunkte des VIDEOBILDES (nicht des Ausschnitts). Nur fuer den Nenner
    /// `Breite − 1` (s. [`auf_bildpunktmitte`]).
    quelle: (f64, f64),
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
            quelle: (f64::from(quelle.0), f64::from(quelle.1)),
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
        Some((
            auf_bildpunktmitte(ax + u * ab, self.quelle.0),
            auf_bildpunktmitte(ay + v * ah, self.quelle.1),
        ))
    }
}

/// Anteil an der BILDFLAECHE -> Anteil zwischen erster und letzter Bildspalte.
///
/// **Der Nenner ist `Breite − 1`, nicht `Breite`** (Wire-Spec, praezisiert am
/// 2026-08-12): der Host rechnet mit `px = u·(w−1)` zurueck. Ohne diese
/// Umrechnung waechst der Fehler linear zum Rand, und die letzte Spalte bzw.
/// Zeile ist gar nicht zu treffen — man kommt am fernen Rechner nicht in die
/// rechte untere Ecke, und genau dort liegen Schliessknopf und Startknopf.
///
/// Gerechnet wird ueber die MITTE der getroffenen Bildspalte: Spalte `i` deckt
/// den Flaechenanteil `[i/w, (i+1)/w)` ab, ihre Mitte liegt bei `(i+0,5)/w`,
/// und ankommen soll sie als `i/(w−1)`. Die Mitte des Bildes bleibt dabei exakt
/// die Mitte. Geklemmt, weil die aeussere halbe Spalte sonst negativ bzw. ueber
/// 1 laege — dort steht der Zeiger aber noch IM Bild und muss gesendet werden.
fn auf_bildpunktmitte(anteil: f64, punkte: f64) -> f64 {
    if punkte < 2.0 {
        return 0.0;
    }
    ((anteil * punkte - 0.5) / (punkte - 1.0)).clamp(0.0, 1.0)
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
    /// 50 Prozent, ein Klick oben links meint also die Bildspalte 480 —
    /// und die kommt als `480/(1920−1)` an, nicht als `480/1920`.
    #[test]
    fn zoom_verschiebt_den_bezug_auf_den_ausschnitt() {
        let lage = Bildlage::neu((1920, 1080), (1920, 1080), [0.25, 0.25, 0.5, 0.5]).expect("Lage");
        let (u, v) = lage.anteil(0.0, 0.0).expect("Ecke");
        assert!((u - 479.5 / 1919.0).abs() < 1e-9 && (v - 269.5 / 1079.0).abs() < 1e-9, "{u},{v}");
        let (u, v) = lage.anteil(1920.0, 1080.0).expect("Ecke");
        assert!((u - 1439.5 / 1919.0).abs() < 1e-9 && (v - 809.5 / 1079.0).abs() < 1e-9, "{u},{v}");
        // Und beim Host landet das wieder auf genau der gemeinten Spalte.
        assert_eq!((479.5f64 / 1919.0 * 1919.0).round(), 480.0);
        assert_eq!((1439.5f64 / 1919.0 * 1919.0).round(), 1440.0);
    }

    /// Bruchteile bleiben erhalten — genau dafuer wird in `f64` gerechnet.
    #[test]
    fn bruchteile_gehen_nicht_verloren() {
        let lage = Bildlage::neu((1000, 1000), (1000, 1000), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
        let (u, _) = lage.anteil(500.5, 500.0).expect("innen");
        // Punkt 500,5 im Fenster = Bildspalte 500 (halb getroffen) -> 500/999.
        assert!((u - 500.0 / 999.0).abs() < 1e-12, "{u}");
    }

    /// **Der Rand-Fehler, wegen dem der Nenner `Breite − 1` ist.** Der Host
    /// rechnet `px = round(u·(w−1))`; jede Spalte muss dabei erreichbar sein —
    /// besonders die letzte, sonst kommt man nicht in die rechte untere Ecke.
    #[test]
    fn jede_spalte_und_zeile_ist_erreichbar() {
        let (breite, hoehe) = (1920u32, 1080u32);
        let lage = Bildlage::neu((breite, hoehe), (breite, hoehe), [0.0, 0.0, 1.0, 1.0])
            .expect("Lage");
        let host = |u: f64, punkte: u32| (u * f64::from(punkte - 1)).round() as u32;

        // Mitte jeder Bildspalte -> genau diese Spalte, ueber die volle Breite.
        for i in 0..breite {
            let (u, _) = lage.anteil(f64::from(i) + 0.5, 0.5).expect("innen");
            assert_eq!(host(u, breite), i, "Spalte {i} kommt als {} an", host(u, breite));
        }
        for j in 0..hoehe {
            let (_, v) = lage.anteil(0.5, f64::from(j) + 0.5).expect("innen");
            assert_eq!(host(v, hoehe), j, "Zeile {j}");
        }

        // Und die aeussersten Punkte des Bildes klemmen auf die Randspalten,
        // statt aus dem Bild zu fallen.
        let (u, v) = lage.anteil(1920.0, 1080.0).expect("rechte untere Ecke");
        assert_eq!((host(u, breite), host(v, hoehe)), (1919, 1079));
        let (u, v) = lage.anteil(0.0, 0.0).expect("linke obere Ecke");
        assert_eq!((host(u, breite), host(v, hoehe)), (0, 0));
    }

    /// Ein Bild von einer einzigen Spalte hat keinen Nenner — dann ist der
    /// Anteil 0, nicht unendlich.
    #[test]
    fn ein_bildpunkt_breite_teilt_nicht_durch_null() {
        let lage = Bildlage::neu((100, 100), (1, 1), [0.0, 0.0, 1.0, 1.0]).expect("Lage");
        let (u, v) = lage.anteil(50.0, 50.0).expect("innen");
        assert_eq!((u, v), (0.0, 0.0));
    }

    #[test]
    fn ohne_bild_gibt_es_keine_lage() {
        assert!(Bildlage::neu((1920, 1080), (0, 0), [0.0, 0.0, 1.0, 1.0]).is_none());
        assert!(Bildlage::neu((0, 0), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).is_none());
    }
}
