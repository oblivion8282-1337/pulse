//! Der wievielte Klick ist das? — die Rechnung hinter `kCGMouseEventClickState`.
//!
//! **Gemessen am 2026-08-23** (`docs/plans/2026-08-23-macos-eingabe-messungen.md`,
//! Messung 2): macOS zaehlt Doppelklicks **nicht** selbst. Zwei Klicks im
//! Doppelklick-Abstand, beide mit `clickState = 1`, ergaben nur die
//! Einfuegemarke; erst mit `clickState = 2` beim zweiten wurde das Wort
//! markiert. Windows zaehlt selbst — hier muss der Injektor zaehlen.
//!
//! Ohne diese Zahl fehlt beim Fernsteuern jedes Doppelklick-Markieren, **ohne
//! dass irgendetwas fehlschlaegt oder eine Meldung erzeugt**. Genau die Sorte
//! Fehler, die man der Leitung zuschreibt statt dem Injektor.
//!
//! **Eigene Datei, ohne CoreGraphics.** Die Rechnung ist rein und damit
//! pruefbar; alles, was `CGEvent` anfasst, liegt nebenan in
//! [`super::injektion`]. Ein Zaehler, der dort mit im Injektor stuende, waere
//! nur an einer echten Maus zu belegen.

/// Zeitliches Fenster: `NSEvent.doubleClickInterval`, Apples Vorgabe.
///
/// **Fest, nicht ausgelesen.** Die Nutzereinstellung („Doppelklickgeschwindigkeit")
/// liegt in AppKit bzw. unter `com.apple.mouse.doubleClickThreshold`; AppKit ist
/// hier keine Abhaengigkeit — und die Einstellung des HOSTS waere ohnehin die
/// falsche: geklickt wird an der Maus des Steuernden. 500 ms ist damit die
/// Doppelklick-Geschwindigkeit der Fernsteuerung, unabhaengig davon, was beide
/// Seiten fuer sich eingestellt haben. **Ungemessen**, ob das jemand als zu
/// traege oder zu hastig empfindet.
pub const FRIST_MS: u64 = 500;

/// Oertliches Fenster, je Achse, in CG-Punkten.
///
/// **Ohne das zaehlte ein Zieh-und-Klick als Doppelklick**: zwei Klicks kommen
/// beim Fernsteuern leicht binnen 500 ms, auch wenn der Steuernde dazwischen
/// quer ueber den Bildschirm gefahren ist. Ein Zeitfenster allein traegt diesen
/// Fall nicht.
///
/// macOS veroeffentlicht keinen Wert dafuer. 5 Punkte je Achse lehnt sich an
/// Windows' `SM_CXDOUBLECLK` an (Vorgabe 4 Pixel) und ist um eine Stufe
/// grosszuegiger, weil die Anteilsrechnung der Leitung (0..65535 auf das
/// Quell-Rechteck) beim Umrechnen ohnehin rundet.
pub const RADIUS: i32 = 5;

/// Der Klickzaehler. Eine laufende Kette oder keine.
#[derive(Default)]
pub struct Klickzaehler {
    kette: Option<Kette>,
}

/// Eine Folge von Klicks, die als Doppel-, Dreifach-, … Klick zaehlt.
///
/// **Die beiden Anker sind absichtlich verschieden:** die Frist misst ab dem
/// VORIGEN Klick (das ist, was ein Doppelklick-Abstand bedeutet — sonst waere
/// ein Dreifachklick nur binnen 500 ms ab dem ersten moeglich), das Orts-Fenster
/// ab dem ERSTEN Klick der Kette (sonst wanderte eine Folge von Schritten zu je
/// 5 Punkten beliebig weit ueber den Schirm und zaehlte dabei immer weiter
/// hoch).
struct Kette {
    /// Der Ort des **ersten** Klicks der Kette.
    anker: (i32, i32),
    /// Der Zeitpunkt des **letzten** Klicks der Kette.
    zuletzt_ms: u64,
    /// Der Knopf, der diese Kette begonnen hat.
    knopf: u8,
    stand: i64,
}

impl Klickzaehler {
    /// Der wievielte Klick ist das? Erster Klick = 1, Doppelklick = 2, und die
    /// Kette bricht **nicht** bei zwei ab — macOS kennt Dreifachklick (Absatz
    /// markieren) und weiter.
    ///
    /// `jetzt_ms` muss aus einer **monotonen** Uhr kommen: liefe die Zeit
    /// rueckwaerts, saehe die Differenz unten null Millisekunden und die Kette
    /// zaehlte weiter, statt neu zu beginnen.
    ///
    /// **Ein Knopfwechsel bricht die Kette**, unabhaengig von Frist und Ort:
    /// Links, rechts, links binnen 500 ms am selben Ort darf den zweiten
    /// Linksklick nicht zum Doppelklick machen. Ob macOS je Knopf getrennt
    /// zaehlt oder ebenfalls abbricht, ist nicht gemessen; abbrechen ist die
    /// vorsichtigere von beiden Auslegungen — ein zu viel gezaehlter Klick
    /// oeffnet eine Datei, die niemand oeffnen wollte, ein zu wenig gezaehlter
    /// kostet einen Doppelklick in einer Reihenfolge, die kaum jemand tippt.
    /// **Bis 2026-08-24 stand diese Entscheidung in `injektion.rs`**, hinter
    /// `CGEventPost` und damit ausserhalb jedes Unit-Tests (Mutationstest der
    /// Pruefung vom 2026-08-23, Befund 1) — hierher gehoert sie, weil sie
    /// reine Rechnung ist wie alles andere in dieser Datei.
    pub fn zaehle(&mut self, punkt: (i32, i32), jetzt_ms: u64, knopf: u8) -> i64 {
        let fortsetzung = self.kette.as_ref().is_some_and(|k| {
            k.knopf == knopf
                && jetzt_ms.saturating_sub(k.zuletzt_ms) <= FRIST_MS
                && nah(k.anker, punkt)
        });
        match &mut self.kette {
            Some(kette) if fortsetzung => {
                kette.stand += 1;
                kette.zuletzt_ms = jetzt_ms;
                kette.stand
            }
            platz => {
                *platz = Some(Kette { anker: punkt, zuletzt_ms: jetzt_ms, knopf, stand: 1 });
                1
            }
        }
    }

    /// Die laufende Kette verwerfen — der naechste Klick beginnt wieder bei 1.
    ///
    /// Ein Knopfwechsel bricht die Kette bereits von selbst (s.
    /// [`Self::zaehle`]) — das hier ist der manuelle Weg fuer alles andere,
    /// wofuer eine Kette absichtlich verworfen werden soll, ohne auf Frist,
    /// Ort oder Knopf zu warten.
    pub fn kette_brechen(&mut self) {
        self.kette = None;
    }
}

/// Liegt `punkt` noch im Orts-Fenster um `anker`? Quadrat, nicht Kreis — eine
/// Wurzel waere hier Genauigkeit ohne Gegenwert.
fn nah(anker: (i32, i32), punkt: (i32, i32)) -> bool {
    (anker.0 - punkt.0).abs() <= RADIUS && (anker.1 - punkt.1).abs() <= RADIUS
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORT: (i32, i32) = (400, 300);
    const LINKS: u8 = 0;
    const RECHTS: u8 = 1;

    #[test]
    fn der_erste_klick_ist_einer() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
    }

    #[test]
    fn zwei_schnelle_am_selben_ort_sind_zwei() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
        assert_eq!(z.zaehle(ORT, 1_080, LINKS), 2);
    }

    /// Die Frist ist die Grenze, nicht ihre Umgebung: genau darauf zaehlt es
    /// noch, eine Millisekunde darueber nicht mehr. Ohne beide Haelften kann der
    /// Test die Zahl 500 nicht von 400 oder 600 unterscheiden.
    #[test]
    fn nach_der_frist_beginnt_es_von_vorn() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
        assert_eq!(z.zaehle(ORT, 1_000 + FRIST_MS, LINKS), 2, "genau auf der Frist zaehlt noch");

        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
        assert_eq!(
            z.zaehle(ORT, 1_001 + FRIST_MS, LINKS),
            1,
            "eine Millisekunde darueber nicht mehr"
        );
    }

    /// Der Fall, den ein Zeitfenster allein nicht traegt: schnell, aber
    /// woanders. Ohne Orts-Fenster zaehlte ein Zieh-und-Klick als Doppelklick.
    ///
    /// Auch hier beide Haelften der Grenze, damit der Test den Wert festhaelt
    /// und nicht nur sein Vorhandensein.
    #[test]
    fn schnell_aber_weit_weg_ist_wieder_einer() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
        assert_eq!(z.zaehle((ORT.0 + 200, ORT.1), 1_080, LINKS), 1, "quer ueber den Schirm");

        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
        assert_eq!(
            z.zaehle((ORT.0, ORT.1 + RADIUS), 1_080, LINKS),
            2,
            "genau auf dem Rand zaehlt noch"
        );

        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
        assert_eq!(
            z.zaehle((ORT.0, ORT.1 + RADIUS + 1), 1_080, LINKS),
            1,
            "einen Punkt weiter nicht"
        );
    }

    /// Und die Kette bricht nicht bei zwei ab — Dreifachklick markiert auf
    /// macOS den Absatz.
    #[test]
    fn drei_schnelle_sind_drei() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
        assert_eq!(z.zaehle(ORT, 1_080, LINKS), 2);
        assert_eq!(z.zaehle(ORT, 1_160, LINKS), 3);
    }

    /// Die Frist misst ab dem VORIGEN Klick, nicht ab dem Beginn der Kette:
    /// drei Klicks im Abstand von je 400 ms sind ein Dreifachklick. Waere der
    /// Anker der Beginn, faenge der dritte wieder bei 1 an.
    #[test]
    fn die_frist_misst_ab_dem_vorigen_klick() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 0, LINKS), 1);
        assert_eq!(z.zaehle(ORT, 400, LINKS), 2);
        assert_eq!(z.zaehle(ORT, 800, LINKS), 3);
    }

    /// Das Orts-Fenster misst dagegen ab dem BEGINN der Kette: sonst wanderte
    /// eine Folge kleiner Schritte beliebig weit und zaehlte trotzdem hoch.
    #[test]
    fn das_orts_fenster_misst_ab_dem_beginn_der_kette() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle((0, 0), 0, LINKS), 1);
        assert_eq!(z.zaehle((RADIUS, 0), 80, LINKS), 2, "noch im Fenster um den Beginn");
        assert_eq!(
            z.zaehle((2 * RADIUS, 0), 160, LINKS),
            1,
            "vom Beginn aus zu weit — neue Kette"
        );
    }

    /// Nach einem Kettenbruch beginnt der naechste Klick wieder bei eins, auch
    /// wenn er sofort und am selben Ort kommt.
    #[test]
    fn kette_brechen_beginnt_von_vorn() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1);
        z.kette_brechen();
        assert_eq!(z.zaehle(ORT, 1_010, LINKS), 1);
    }

    /// **Befund 1 der Pruefung vom 2026-08-23.** Ein Linksklick, dann ein
    /// Rechtsklick am selben Ort und innerhalb der Frist: der Rechtsklick ist
    /// Klick 1, nicht Klick 2 — sonst zaehlte „links, dann rechts" als
    /// Doppelklick, obwohl an keiner Maus je zwei gleiche Knoepfe hintereinander
    /// niedergehen. Diese Entscheidung sass bis dahin hinter `CGEventPost` in
    /// `injektion.rs`, unerreichbar fuer einen Unit-Test; die Mutationsprobe
    /// (Kettenbruch beim Knopfwechsel entfernt) macht genau diesen Test rot.
    #[test]
    fn knopfwechsel_bricht_die_kette() {
        let mut z = Klickzaehler::default();
        assert_eq!(z.zaehle(ORT, 1_000, LINKS), 1, "Linksklick");
        assert_eq!(z.zaehle(ORT, 1_080, RECHTS), 1, "Rechtsklick ist Klick 1, nicht 2");
    }
}
