//! Welches Player-Fenster meint ein Punkt auf dem Desktop — und wo in dessen
//! Bild?
//!
//! Wer mit gedrueckter Maustaste aus einem Fenster herauszieht, bekommt vom
//! Betriebssystem weiter alle Ereignisse in DIESEM Fenster zugestellt (winit
//! ruft `SetCapture`; X11, Wayland und macOS haben denselben impliziten
//! Zeigerfang). Die Koordinaten liegen dann ausserhalb — und genau dort faengt
//! diese Datei an: sie rechnet den Punkt in den Desktop-Raum, sucht das
//! Fenster, ueber dem er wirklich steht, und liefert dessen Platz samt Anteil
//! im Bild.
//!
//! **Rein und ohne winit**, damit die Zuordnung ohne Fenster pruefbar ist —
//! dasselbe Muster wie [`super::bildlage`] daneben.

use super::Bildlage;

/// Ein Player-Fenster, wie die Zuordnung es sieht.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Nachbar {
    /// Sitzungsnummer des Fensters (`app::Session`-Schluessel). Nur fuer den
    /// Vorrang — auf die Leitung geht sie nie.
    pub id: u64,
    /// Der Stream des Hosts, den dieses Fenster zeigt. DAS geht auf die
    /// Leitung, in der Huelle der Nachricht.
    pub slot: u32,
    /// Linke obere Ecke der Fensterinnenflaeche auf dem Desktop, physische
    /// Punkte. Bezugsgroesse fuer `Bildlage`, die fensterlokal rechnet.
    pub ursprung: (f64, f64),
    /// Wo im Fenster das Bild liegt und welcher Teil der Quelle darin steht.
    pub lage: Bildlage,
}

/// Reihenfolge, in der die Fenster befragt werden.
///
/// **Das eigene zuerst, danach das zuletzt fokussierte, danach der Rest.**
/// winit gibt die Stapelreihenfolge nicht heraus; der Fokus ist ihr
/// Stellvertreter, denn ein Fenster wird durch Anklicken zugleich fokussiert
/// und nach vorne geholt. Im Zieh-Fall stimmt das sogar per Bauart: das
/// ziehende Fenster IST das fokussierte, liegt also oben — und im
/// ueberlappenden Bereich sieht man genau dieses.
///
/// `sort_by_key` ist stabil: gleichrangige Fenster behalten ihre Reihenfolge,
/// damit dieselbe Lage nicht von Lauf zu Lauf ein anderes Ergebnis liefert.
pub fn vorrang(kandidaten: &mut [Nachbar], eigenes: u64, zuletzt_fokussiert: Option<u64>) {
    kandidaten.sort_by_key(|n| {
        if n.id == eigenes {
            0
        } else if Some(n.id) == zuletzt_fokussiert {
            1
        } else {
            2
        }
    });
}

/// Wen meint dieser Punkt? `None` heisst „kein Fenster" — dann wird nichts
/// gesendet, und der Zeiger des Hosts wartet an seiner letzten Stelle.
///
/// Der schwarze Rand eines Fensters zaehlt **nicht** als Treffer; das erledigt
/// [`Bildlage::anteil`], das ausserhalb des Bildinhalts `None` liefert. Ein
/// geklemmter Wert kaeme beim Host als Klick auf der Bildkante an, den niemand
/// ausgeloest hat.
pub fn treffer(punkt: (f64, f64), kandidaten: &[Nachbar]) -> Option<(u32, (f64, f64))> {
    for n in kandidaten {
        let lokal_x = punkt.0 - n.ursprung.0;
        let lokal_y = punkt.1 - n.ursprung.1;
        if let Some(anteil) = n.lage.anteil(lokal_x, lokal_y) {
            return Some((n.slot, anteil));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fenster und Quelle im selben Verhaeltnis: kein Rand, die Ecken sind
    /// dadurch exakt 0 und 1.
    fn fenster(id: u64, slot: u32, x: f64, y: f64) -> Nachbar {
        Nachbar {
            id,
            slot,
            ursprung: (x, y),
            lage: Bildlage::neu((1000, 1000), (1000, 1000), [0.0, 0.0, 1.0, 1.0]).expect("Lage"),
        }
    }

    #[test]
    fn punkt_im_eigenen_fenster() {
        let k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 1000.0, 0.0)];
        let (slot, (u, v)) = treffer((500.0, 500.0), &k).expect("Treffer");
        assert_eq!(slot, 0);
        assert!((u - 0.5).abs() < 1e-9 && (v - 0.5).abs() < 1e-9, "{u},{v}");
    }

    #[test]
    fn punkt_im_nachbarn_traegt_dessen_platz() {
        let k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 1000.0, 0.0)];
        let (slot, (u, v)) = treffer((1500.0, 500.0), &k).expect("Treffer");
        assert_eq!(slot, 1, "der Punkt liegt im zweiten Fenster");
        assert!((u - 0.5).abs() < 1e-9 && (v - 0.5).abs() < 1e-9, "{u},{v}");
    }

    /// Die Luecke zwischen den Fenstern gehoert niemandem. Wichtig, weil dort
    /// nichts gesendet werden darf — nicht etwa auf die Kante geklemmt.
    #[test]
    fn luecke_trifft_niemanden() {
        let k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 1400.0, 0.0)];
        assert_eq!(treffer((1200.0, 500.0), &k), None);
        assert_eq!(treffer((-50.0, 500.0), &k), None);
        assert_eq!(treffer((500.0, 2000.0), &k), None);
    }

    /// Bei Ueberlappung gewinnt das eigene Fenster — es liegt oben, also sieht
    /// man dort genau dieses.
    #[test]
    fn bei_ueberlappung_gewinnt_das_eigene() {
        let mut k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 500.0, 0.0)];
        vorrang(&mut k, 1, None);
        assert_eq!(treffer((700.0, 500.0), &k).expect("Treffer").0, 0);

        // Dasselbe Bild, anderes eigenes Fenster: dann gewinnt das andere.
        vorrang(&mut k, 2, None);
        assert_eq!(treffer((700.0, 500.0), &k).expect("Treffer").0, 1);
    }

    /// Gehoert keines der ueberlappenden Fenster einem selbst, entscheidet der
    /// Fokus.
    #[test]
    fn sonst_gewinnt_das_zuletzt_fokussierte() {
        let mut k = [fenster(1, 0, 0.0, 0.0), fenster(2, 1, 500.0, 0.0)];
        vorrang(&mut k, 99, Some(2));
        assert_eq!(treffer((700.0, 500.0), &k).expect("Treffer").0, 1);

        vorrang(&mut k, 99, Some(1));
        assert_eq!(treffer((700.0, 500.0), &k).expect("Treffer").0, 0);
    }

    /// Gleichrangige behalten ihre Reihenfolge — sonst waere dieselbe Lage von
    /// Lauf zu Lauf verschieden zugeordnet.
    #[test]
    fn vorrang_ist_stabil() {
        let mut k = [fenster(3, 2, 0.0, 0.0), fenster(4, 3, 0.0, 0.0), fenster(5, 4, 0.0, 0.0)];
        vorrang(&mut k, 99, None);
        assert_eq!(k.iter().map(|n| n.id).collect::<Vec<_>>(), vec![3, 4, 5]);
    }

    /// Der Briefkasten-Rand ist kein Treffer: 2000x1000-Fenster auf 16:9-Quelle
    /// laesst links und rechts je 111,1 Punkte schwarz.
    #[test]
    fn rand_ist_kein_treffer() {
        let n = Nachbar {
            id: 1,
            slot: 0,
            ursprung: (0.0, 0.0),
            lage: Bildlage::neu((2000, 1000), (1920, 1080), [0.0, 0.0, 1.0, 1.0]).expect("Lage"),
        };
        assert_eq!(treffer((50.0, 500.0), &[n]), None, "linker Rand");
        assert_eq!(treffer((1950.0, 500.0), &[n]), None, "rechter Rand");
        assert!(treffer((1000.0, 500.0), &[n]).is_some(), "Bildmitte");
    }
}
