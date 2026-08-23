//! Die acht Zielkreuze und ihre Auswertung — reine Rechnung.
//!
//! **Die Messlatte kommt aus dem Windows-Labor** (2026-08-12): 0 px auf 8
//! Zielen. Dieselben acht Stellen, aus demselben Grund gewaehlt — vier Ecken
//! (dort schlaegt jede Spiegelung und jeder Ursprungsfehler durch), die Mitte
//! (dort faellt beides gerade NICHT auf), ein fester Punkt nahe der linken
//! oberen Ecke und zwei krumme Anteile (dort schlaegt eine Rundung durch).
//!
//! ## Die Falle, gegen die dieses Modul gebaut ist
//!
//! **0 px ist auch das Ergebnis, wenn gar nichts gemessen wurde.** Eine
//! Auswertung, die je Ziel „Abweichung" als Zahl fuehrt und am Ende das Maximum
//! bildet, meldet bei null empfangenen Ereignissen entweder 0 (leeres Maximum)
//! oder -1 (Windows-Fassung) — und die 0 sieht aus wie ein perfekter Lauf.
//! Deshalb ist die Abweichung hier ein [`Option`], und [`groesste_abweichung`]
//! gibt `None` zurueck, sobald auch nur EIN Ziel ohne Ereignis blieb. Ein
//! Bestanden-Urteil braucht beides: alle Ziele belegt UND das Maximum bei null.

/// Die acht Zielpunkte in globalen Punkten, fuer ein Rechteck der Groesse
/// `breite` x `hoehe` ab `ursprung`.
///
/// Die Eckziele heissen `breite - 1` und `hoehe - 1`, nicht `breite`/`hoehe`:
/// der rechte und der untere Rand gehoeren nicht mehr zum Rechteck
/// (s. `super::obenauf::Rechteck::enthaelt`), ein Ereignis dort ginge an den
/// Nachbarn.
pub fn ziele_fuer(ursprung: (f64, f64), breite: f64, hoehe: f64) -> Vec<(f64, f64)> {
    let (b, h) = (breite - 1.0, hoehe - 1.0);
    [
        (0.0, 0.0),
        (b, 0.0),
        (0.0, h),
        (b, h),
        ((breite / 2.0).floor(), (hoehe / 2.0).floor()),
        (100.0, 100.0),
        ((breite * 0.4).floor(), (hoehe * 0.35).floor()),
        ((breite * 0.8).floor(), (hoehe * 0.83).floor()),
    ]
    .into_iter()
    .map(|(x, y)| (ursprung.0 + x, ursprung.1 + y))
    .collect()
}

/// Was aus einem Ziel geworden ist.
#[derive(Clone, Debug, PartialEq)]
pub struct Treffer {
    pub ziel: (f64, f64),
    /// Die Bewegung, die diesem Ziel zugeordnet wurde. `None` heisst: es gab
    /// **keine** mehr — nicht „daneben", sondern „nichts gemessen".
    pub ist: Option<(f64, f64)>,
    /// Tschebyschew-Abstand in Punkten (`max(|dx|, |dy|)`), wie im
    /// Windows-Labor. `None` genau dann, wenn `ist` `None` ist.
    pub abweichung: Option<f64>,
}

/// Ordnet den Zielen der Reihe nach die empfangenen Bewegungen zu.
///
/// **In der Reihenfolge, nicht frei.** Der Treiber faehrt die Ziele
/// nacheinander an; eine freie Suche „irgendwo in der Liste" wuerde ein Ziel
/// auch dann als getroffen melden, wenn der Zeiger von Anfang an zufaellig
/// dort stand (das Windows-Skript vermerkt genau diese erste Fremdbewegung).
/// Gesucht wird deshalb immer nur im **Rest** hinter der letzten Zuordnung:
/// zuerst nach einem genauen Treffer, sonst nach der naechstgelegenen Bewegung
/// — damit eine Abweichung benannt wird statt nur „nicht gefunden".
pub fn auswerten(ziele: &[(f64, f64)], bewegungen: &[(f64, f64)]) -> Vec<Treffer> {
    let mut ab = 0usize;
    ziele
        .iter()
        .map(|&ziel| {
            let rest = &bewegungen[ab.min(bewegungen.len())..];
            let gewaehlt = rest
                .iter()
                .position(|&b| b == ziel)
                .or_else(|| naechste(rest, ziel));
            match gewaehlt {
                None => Treffer { ziel, ist: None, abweichung: None },
                Some(i) => {
                    let ist = rest[i];
                    ab += i + 1;
                    Treffer { ziel, ist: Some(ist), abweichung: Some(abstand(ist, ziel)) }
                }
            }
        })
        .collect()
}

fn abstand(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).abs().max((a.1 - b.1).abs())
}

fn naechste(rest: &[(f64, f64)], ziel: (f64, f64)) -> Option<usize> {
    rest.iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            abstand(**a, ziel).partial_cmp(&abstand(**b, ziel)).expect("keine NaN-Lagen")
        })
        .map(|(i, _)| i)
}

/// Die groesste Abweichung ueber alle Ziele — **oder `None`, sobald ein Ziel
/// gar kein Ereignis bekommen hat.**
///
/// Das ist die tragende Zeile dieses Moduls. Wer sie zu
/// `treffer.iter().filter_map(...).fold(0.0, f64::max)` vereinfacht, bekommt
/// bei null empfangenen Ereignissen eine glatte 0 zurueck — und damit einen
/// Lauf, der als bestanden gilt, obwohl nichts angekommen ist.
pub fn groesste_abweichung(treffer: &[Treffer]) -> Option<f64> {
    if treffer.is_empty() {
        return None;
    }
    treffer
        .iter()
        .try_fold(0.0f64, |groesste, t| t.abweichung.map(|a| groesste.max(a)))
}

/// Wie viele Ziele ganz ohne Ereignis blieben.
pub fn ohne_ereignis(treffer: &[Treffer]) -> usize {
    treffer.iter().filter(|t| t.ist.is_none()).count()
}

/// Das Maus-Urteil. `Ok(maximale Abweichung)` oder `Err(Grund)`.
pub fn maus_urteil(treffer: &[Treffer]) -> Result<f64, String> {
    match groesste_abweichung(treffer) {
        None if treffer.is_empty() => Err("keine Ziele ausgewertet".to_string()),
        None => Err(format!(
            "{} von {} Zielen ohne jedes Ereignis",
            ohne_ereignis(treffer),
            treffer.len()
        )),
        Some(max) if max > 0.0 => Err(format!("groesste Abweichung {max} Punkte, gefordert 0")),
        Some(_) => Ok(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acht_ziele_mit_den_vier_ecken() {
        let z = ziele_fuer((0.0, 0.0), 1000.0, 800.0);
        assert_eq!(z.len(), 8);
        assert!(z.contains(&(0.0, 0.0)));
        assert!(z.contains(&(999.0, 0.0)));
        assert!(z.contains(&(0.0, 799.0)));
        assert!(z.contains(&(999.0, 799.0)));
        assert!(z.contains(&(500.0, 400.0)));
    }

    /// Auf einem zweiten Schirm liegt der Ursprung nicht bei (0,0) — dann ist
    /// jedes Ziel verschoben. Genau daran scheitern fremde Fernsteuerungen
    /// (Anmerkung im Windows-Treiber).
    #[test]
    fn der_ursprung_verschiebt_alle_ziele() {
        let z = ziele_fuer((1920.0, -200.0), 1000.0, 800.0);
        assert!(z.contains(&(1920.0, -200.0)));
        assert!(z.contains(&(2919.0, 599.0)));
    }

    #[test]
    fn genaue_treffer_ergeben_null() {
        let ziele = ziele_fuer((0.0, 0.0), 1000.0, 800.0);
        let treffer = auswerten(&ziele, &ziele);
        assert_eq!(ohne_ereignis(&treffer), 0);
        assert_eq!(groesste_abweichung(&treffer), Some(0.0));
        assert_eq!(maus_urteil(&treffer), Ok(0.0));
    }

    /// **Der Kern.** Ohne empfangene Bewegungen ist das Ergebnis `None`, nicht
    /// `Some(0.0)` — und das Urteil ist ein Fehlschlag, kein perfekter Lauf.
    ///
    /// Mutationsprobe: `groesste_abweichung` zu einem `fold(0.0, max)` ueber
    /// die vorhandenen Werte vereinfacht, faellt genau dieser Test.
    #[test]
    fn ohne_ereignisse_gibt_es_keine_null() {
        let ziele = ziele_fuer((0.0, 0.0), 1000.0, 800.0);
        let treffer = auswerten(&ziele, &[]);
        assert_eq!(ohne_ereignis(&treffer), 8);
        assert_eq!(groesste_abweichung(&treffer), None);
        assert!(treffer.iter().all(|t| t.abweichung.is_none()));
        let fehler = maus_urteil(&treffer).expect_err("darf nicht bestehen");
        assert!(fehler.contains("8 von 8"), "{fehler}");
    }

    /// Auch EIN fehlendes Ziel unter sieben genauen Treffern reicht — sonst
    /// bestuende ein Lauf, bei dem die letzte Ecke nie angekommen ist.
    #[test]
    fn ein_einziges_fehlendes_ziel_kippt_das_urteil() {
        let ziele = ziele_fuer((0.0, 0.0), 1000.0, 800.0);
        let treffer = auswerten(&ziele, &ziele[..7]);
        assert_eq!(ohne_ereignis(&treffer), 1);
        assert_eq!(groesste_abweichung(&treffer), None);
        assert!(maus_urteil(&treffer).is_err());
    }

    /// Eine Abweichung wird als Tschebyschew-Abstand gemeldet und kippt das
    /// Urteil. Mutationsprobe gegen ein `maus_urteil`, das nur auf `is_some`
    /// prueft.
    #[test]
    fn eine_abweichung_kippt_das_urteil() {
        let ziele = vec![(10.0, 10.0), (20.0, 20.0)];
        let bewegungen = vec![(10.0, 10.0), (23.0, 21.0)];
        let treffer = auswerten(&ziele, &bewegungen);
        assert_eq!(treffer[1].abweichung, Some(3.0));
        assert_eq!(groesste_abweichung(&treffer), Some(3.0));
        let fehler = maus_urteil(&treffer).expect_err("3 Punkte sind nicht 0");
        assert!(fehler.contains('3'), "{fehler}");
    }

    /// Fremde Bewegungen vor und zwischen den Zielen stoeren nicht — die
    /// Zuordnung laeuft in der Reihenfolge weiter.
    #[test]
    fn fremde_bewegungen_dazwischen_stoeren_nicht() {
        let ziele = vec![(10.0, 10.0), (20.0, 20.0)];
        let bewegungen = vec![(3.0, 4.0), (10.0, 10.0), (12.0, 15.0), (20.0, 20.0)];
        let treffer = auswerten(&ziele, &bewegungen);
        assert_eq!(maus_urteil(&treffer), Ok(0.0));
    }

    /// **Die Reihenfolge zaehlt.** Steht der Zeiger schon vor dem Lauf auf dem
    /// letzten Ziel, darf diese eine Bewegung nicht zwei Ziele bedienen.
    ///
    /// Mutationsprobe: eine Zuordnung ohne Fortschreiten des Startpunkts (freie
    /// Suche in der ganzen Liste) meldet hier zweimal einen genauen Treffer und
    /// damit einen bestandenen Lauf, obwohl das erste Ziel nie angefahren wurde.
    #[test]
    fn eine_bewegung_bedient_nicht_zwei_ziele() {
        let ziele = vec![(10.0, 10.0), (20.0, 20.0)];
        let bewegungen = vec![(20.0, 20.0)];
        let treffer = auswerten(&ziele, &bewegungen);
        assert_eq!(treffer[0].abweichung, Some(10.0), "erstes Ziel: daneben");
        assert_eq!(treffer[1].ist, None, "zweites Ziel: nichts mehr uebrig");
        assert!(maus_urteil(&treffer).is_err());
    }
}
