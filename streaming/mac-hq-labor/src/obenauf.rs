//! Liegt das Pruefziel wirklich obenauf? — die Frage, deren falsche Antwort im
//! Windows-Labor mehrere Anlaeufe gekostet hat.
//!
//! **Die Lehre kommt von dort** (`streaming/win-hq-labor/testbench/`,
//! 2026-08-12): ein Windows-Systemdialog legte eine bildschirmfuellende
//! Abdunklung ueber alles, schluckte jede Injektion — und der Lauf sah aus wie
//! „Injektor tot": der Sidecar meldete `processed: 30`, das Pruefziel sah null
//! Ereignisse. Ein Nullergebnis ohne diese Pruefung ist deshalb nicht „0
//! Treffer", sondern **ungueltig**, und der Unterschied ist der zwischen einer
//! Fehlersuche am richtigen und am falschen Ende.
//!
//! Auf macOS gibt es dasselbe in mindestens zwei Auspraegungen: ein
//! Berechtigungsdialog (Bedienungshilfen, Bildschirmaufnahme) mit seiner
//! Abdunklung, und ein fremdes Vollbild-Programm, das auf einem anderen
//! Schreibtisch (Space) liegt — dann steht das eigene Fenster gar nicht in der
//! Liste der sichtbaren Fenster.
//!
//! ## Was hier drin steht und was nicht
//!
//! Hier steht nur die **Beurteilung** einer bereits eingesammelten Fensterliste
//! — reine Rechnung, in Tests festzunageln. Das Einsammeln selbst
//! (`CGWindowListCopyWindowInfo`) liegt in [`super::fensterliste`], weil es
//! ohne laufendes Fenstersystem nicht prueffaehig ist.
//!
//! **Positiv geprueft, nicht ueber eine Liste bekannter Stoerer** — dieselbe
//! Entscheidung wie auf Windows. Nach Fensterklassen oder Programmnamen zu
//! suchen hiesse, jede kuenftige macOS-Ausgabe nachzupflegen; gefragt wird
//! stattdessen: liegt unter DIESEM Punkt wirklich ein Fenster DIESES Prozesses?

/// Ein Rechteck in globalen CoreGraphics-Punkten (Ursprung oben links).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rechteck {
    pub x: f64,
    pub y: f64,
    pub breite: f64,
    pub hoehe: f64,
}

impl Rechteck {
    /// Halboffen wie CoreGraphics selbst: der linke und der obere Rand gehoeren
    /// dazu, der rechte und der untere nicht. Sonst gaelten zwei aneinander
    /// stossende Fenster an ihrer gemeinsamen Kante beide als zustaendig.
    pub fn enthaelt(&self, punkt: (f64, f64)) -> bool {
        punkt.0 >= self.x
            && punkt.0 < self.x + self.breite
            && punkt.1 >= self.y
            && punkt.1 < self.y + self.hoehe
    }
}

/// Eine Zeile aus `CGWindowListCopyWindowInfo`.
#[derive(Clone, Debug, PartialEq)]
pub struct Fensterzeile {
    pub nummer: u32,
    pub pid: i32,
    /// `kCGWindowLayer`. Wird **nicht** gefiltert: gerade die hohen Schichten
    /// (Menueleiste 24, Dock 20, Systemabdunklung) sind die Stoerer, um die es
    /// geht. Sie steht nur zur Ansprache im Protokoll.
    pub schicht: i32,
    pub rechteck: Rechteck,
    /// `kCGWindowOwnerName` — fehlt ohne Bildschirmaufnahme-Freigabe, deshalb
    /// `Option`. Nur zum Benennen, nie zum Entscheiden.
    pub eigner: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Lage {
    /// Unter dem Punkt liegt das eigene Fenster, und nichts davor.
    Obenauf,
    /// Etwas Fremdes liegt davor — der Lauf ist ungueltig, nicht durchgefallen.
    Verdeckt(Fensterzeile),
    /// Unter dem Punkt liegt ueberhaupt kein sichtbares Fenster. Auf macOS ist
    /// das der Fall „eigenes Fenster auf einem anderen Space" — auch ungueltig.
    KeinFenster,
}

/// Beurteilt einen einzelnen Punkt.
///
/// **`liste` MUSS von vorn nach hinten sortiert sein** — genau so liefert
/// `CGWindowListCopyWindowInfo` sie. Die ganze Aussage haengt daran: entschieden
/// wird ueber das **erste** Fenster, das den Punkt ueberdeckt.
pub fn beurteilen(liste: &[Fensterzeile], eigene_pid: i32, punkt: (f64, f64)) -> Lage {
    match liste.iter().find(|z| z.rechteck.enthaelt(punkt)) {
        None => Lage::KeinFenster,
        Some(z) if z.pid == eigene_pid => Lage::Obenauf,
        Some(z) => Lage::Verdeckt(z.clone()),
    }
}

/// Beurteilt mehrere Punkte und meldet den **ersten** Punkt, an dem es nicht
/// stimmt. Alle Ziele werden geprueft, nicht nur die Mitte: die Menueleiste und
/// das Dock ueberdecken genau die Raender, an denen die Eckziele liegen — eine
/// Pruefung nur in der Mitte gaebe dort gruenes Licht und liesse die Ecken
/// stillschweigend ins Leere laufen.
pub fn ersten_fehler_finden(
    liste: &[Fensterzeile],
    eigene_pid: i32,
    punkte: &[(f64, f64)],
) -> Option<((f64, f64), Lage)> {
    punkte.iter().find_map(|&p| match beurteilen(liste, eigene_pid, p) {
        Lage::Obenauf => None,
        andere => Some((p, andere)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ICH: i32 = 4242;

    fn zeile(pid: i32, x: f64, y: f64, b: f64, h: f64) -> Fensterzeile {
        Fensterzeile {
            nummer: pid as u32,
            pid,
            schicht: 0,
            rechteck: Rechteck { x, y, breite: b, hoehe: h },
            eigner: None,
        }
    }

    #[test]
    fn eigenes_fenster_ganz_vorn_ist_obenauf() {
        let liste = [zeile(ICH, 0.0, 0.0, 100.0, 100.0)];
        assert_eq!(beurteilen(&liste, ICH, (50.0, 50.0)), Lage::Obenauf);
    }

    /// **Der Fall, um den es geht.** Ein fremdes Fenster liegt davor.
    ///
    /// Mutationsfest gegen die naheliegendste Fehlfassung
    /// (`liste.iter().any(|z| z.pid == eigene_pid)`): das eigene Fenster steht
    /// hier in der Liste, nur eben dahinter.
    #[test]
    fn fremdes_fenster_davor_verdeckt() {
        let liste = [zeile(99, 0.0, 0.0, 100.0, 100.0), zeile(ICH, 0.0, 0.0, 100.0, 100.0)];
        match beurteilen(&liste, ICH, (50.0, 50.0)) {
            Lage::Verdeckt(z) => assert_eq!(z.pid, 99),
            andere => panic!("erwartet Verdeckt, war {andere:?}"),
        }
    }

    /// **Die Gegenprobe dazu, und sie ist die wichtigere.** Ein fremdes Fenster
    /// liegt zwar vorn, aber nicht ueber dem Punkt — dann ist der Punkt frei.
    ///
    /// Ohne diesen Test waere eine Fassung gruen, die jedes fremde Fenster
    /// irgendwo auf dem Schirm als Verdeckung meldet. Sie wuerde jeden Lauf auf
    /// dieser Maschine fuer ungueltig erklaeren (es liegt immer irgendein
    /// Fenster herum) — ein Messmittel, das nie misst.
    #[test]
    fn fremdes_fenster_neben_dem_punkt_stoert_nicht() {
        let liste = [zeile(99, 200.0, 200.0, 50.0, 50.0), zeile(ICH, 0.0, 0.0, 100.0, 100.0)];
        assert_eq!(beurteilen(&liste, ICH, (50.0, 50.0)), Lage::Obenauf);
    }

    /// Leere Liste und „eigenes Fenster gar nicht dabei" sind derselbe Befund:
    /// kein Fenster unter dem Punkt. Auf macOS heisst das in aller Regel
    /// „anderer Schreibtisch".
    ///
    /// Mutationsfest gegen die zweite Fehlfassung (Vorgabe `Obenauf`, wenn
    /// nichts gefunden wird) — die saehe auf einem leeren Space gruen aus.
    #[test]
    fn ohne_fenster_unter_dem_punkt_gilt_kein_fenster() {
        assert_eq!(beurteilen(&[], ICH, (50.0, 50.0)), Lage::KeinFenster);
        let nur_fremd_woanders = [zeile(99, 500.0, 500.0, 10.0, 10.0)];
        assert_eq!(beurteilen(&nur_fremd_woanders, ICH, (50.0, 50.0)), Lage::KeinFenster);
    }

    /// Der Punkt liegt neben dem eigenen Fenster. Auch das ist kein „obenauf" —
    /// sonst gaebe ein zu klein aufgezogenes Fenster gruenes Licht fuer Ziele,
    /// die es gar nicht abdeckt.
    #[test]
    fn punkt_ausserhalb_des_eigenen_fensters_ist_nicht_obenauf() {
        let liste = [zeile(ICH, 0.0, 0.0, 100.0, 100.0)];
        assert_eq!(beurteilen(&liste, ICH, (150.0, 50.0)), Lage::KeinFenster);
    }

    /// Die Raender, halboffen. Der rechte und der untere gehoeren **nicht**
    /// mehr dazu — das ist der Punkt, an dem die Eckziele `(breite-1)` und
    /// `(hoehe-1)` heissen und nicht `breite`/`hoehe`.
    #[test]
    fn die_raender_sind_halboffen() {
        let r = Rechteck { x: 10.0, y: 20.0, breite: 100.0, hoehe: 50.0 };
        assert!(r.enthaelt((10.0, 20.0)), "linke obere Ecke gehoert dazu");
        assert!(r.enthaelt((109.0, 69.0)), "letzter Punkt innen");
        assert!(!r.enthaelt((110.0, 40.0)), "rechter Rand gehoert nicht dazu");
        assert!(!r.enthaelt((50.0, 70.0)), "unterer Rand gehoert nicht dazu");
        assert!(!r.enthaelt((9.0, 40.0)));
        assert!(!r.enthaelt((50.0, 19.0)));
    }

    /// Ein Fenster mit hoher Schicht (Menueleiste, Systemabdunklung) wird
    /// **nicht** ausgenommen. Genau dafuer ist die Pruefung da.
    #[test]
    fn hohe_schicht_wird_nicht_ausgenommen() {
        let mut menueleiste = zeile(1, 0.0, 0.0, 1000.0, 25.0);
        menueleiste.schicht = 24;
        let liste = [menueleiste, zeile(ICH, 0.0, 0.0, 1000.0, 800.0)];
        assert!(matches!(beurteilen(&liste, ICH, (500.0, 10.0)), Lage::Verdeckt(_)));
        assert_eq!(beurteilen(&liste, ICH, (500.0, 400.0)), Lage::Obenauf);
    }

    /// `ersten_fehler_finden` meldet den ersten schlechten Punkt — und nur
    /// dann, wenn es wirklich einen gibt.
    #[test]
    fn mehrere_punkte_werden_alle_geprueft() {
        let mut menueleiste = zeile(1, 0.0, 0.0, 1000.0, 25.0);
        menueleiste.schicht = 24;
        let liste = [menueleiste, zeile(ICH, 0.0, 0.0, 1000.0, 800.0)];

        let mitte_und_ecke = [(500.0, 400.0), (0.0, 0.0)];
        let (punkt, lage) = ersten_fehler_finden(&liste, ICH, &mitte_und_ecke).expect("Ecke faellt");
        assert_eq!(punkt, (0.0, 0.0));
        assert!(matches!(lage, Lage::Verdeckt(_)));

        let nur_mitte = [(500.0, 400.0)];
        assert!(ersten_fehler_finden(&liste, ICH, &nur_mitte).is_none());
    }
}
