//! Was der Treiber schickt — die reine Seite: aus Zielpunkten werden Frames.
//!
//! **Die Anteilsrechnung steht hier bewusst NICHT als Umkehrung von
//! `zuordnung::anteil_auf_punkt`.** Sie kommt aus der Spezifikation
//! (`docs/plans/2026-08-12-input-wire-protokoll-v2.md`): `u = px / (breite - 1)`,
//! auf 0..65535 gestreckt. Wer sie stattdessen durch Umkehren der Empfaengerseite
//! gewinnt, misst nichts mehr: ein systematischer Fehler dort wuerde beim
//! Erzeugen gleich wieder herausgerechnet, und der Lauf saehe gruen aus.

use pulse_fernsteuerung::bauen::{self, Rahmen, anteil_zu_u16};
use pulse_fernsteuerung::format::Knopf;

/// Ein Bildpunkt im Quell-Rechteck auf die 65536 Stufen der Leitung.
///
/// `spanne` ist die **Breite bzw. Hoehe** des Quell-Rechtecks, nicht die
/// letzte Koordinate — geteilt wird durch `spanne - 1`, damit der letzte
/// Bildpunkt genau auf 65535 faellt.
pub fn anteil(px: f64, spanne: f64) -> u16 {
    if spanne <= 1.0 {
        return 0;
    }
    anteil_zu_u16(px / (spanne - 1.0))
}

/// Die Nachrichten eines Nachweislaufs: je Eintrag ein `remote_input` mit
/// seinen Frames.
///
/// Der Aufbau folgt dem Windows-Treiber, mit **einer** Ergaenzung: zwei Klicks
/// kurz hintereinander an derselben Stelle. Das ist auf macOS der Fall, der auf
/// Windows gar nicht vorkommt — dort zaehlt das System Doppelklicks selbst, hier
/// muss der Injektor es tun (gemessen, Messung 2 der Messakte). Ohne diesen
/// zweiten Klick bliebe der Klickzaehler des Sidecars ungeprueft.
///
/// **Vor jedem Knopf und jedem Rad steht eine Zeigerlage.** Das ist keine
/// Vorsicht, sondern das Orts-Tor: `pulse_fernsteuerung::ausfuehrung` laesst
/// Knopf und Rad nur durch, wenn eine gueltige Lage vorliegt.
pub fn nachrichten(
    ziele: &[(f64, f64)],
    ursprung: (f64, f64),
    breite: f64,
    hoehe: f64,
    mitte: (f64, f64),
    tastenfolge: &[u16],
) -> Vec<Vec<Rahmen>> {
    let punkt = |p: (f64, f64)| {
        bauen::maus_abs(
            anteil(p.0 - ursprung.0, breite),
            anteil(p.1 - ursprung.1, hoehe),
        )
    };
    let mut nachrichten: Vec<Vec<Rahmen>> = ziele.iter().map(|&z| vec![punkt(z)]).collect();

    for _ in 0..2 {
        nachrichten.push(vec![
            punkt(mitte),
            bauen::maus_knopf(Knopf::Links, true),
            bauen::maus_knopf(Knopf::Links, false),
        ]);
    }
    nachrichten.push(vec![punkt(mitte), bauen::maus_rad(pulse_fernsteuerung::format::RASTE as i16, 0)]);

    // Buendel zu hoechstens 32 Frames — das ist die Obergrenze, die der
    // Gateway durchlaesst, und zugleich die Gegenprobe auf die Buendelung, die
    // v2 gegenueber v1 neu erlaubt.
    let mut buendel = Vec::new();
    for &scan in tastenfolge {
        buendel.push(bauen::taste(scan, true));
        buendel.push(bauen::taste(scan, false));
        if buendel.len() >= 32 {
            nachrichten.push(std::mem::take(&mut buendel));
        }
    }
    if !buendel.is_empty() {
        nachrichten.push(buendel);
    }
    nachrichten
}

#[cfg(test)]
mod tests {
    use super::*;
    use pulse_fernsteuerung::zuordnung::{Rechteck, anteil_auf_punkt};

    fn schirm(breite: i32, hoehe: i32) -> Rechteck {
        Rechteck { links: 0, oben: 0, rechts: breite, unten: hoehe }
    }

    /// **Der eigentliche Nachweis der Rechnung:** jeder Zielpunkt, den der
    /// Treiber anfaehrt, kommt am Empfaenger als **genau dieser** Bildpunkt
    /// wieder heraus — die Kette Spezifikations-Formel -> Leitung ->
    /// `anteil_auf_punkt` ist verlustfrei.
    ///
    /// Mutationsprobe: `spanne` statt `spanne - 1` als Nenner, und das Ziel in
    /// der rechten unteren Ecke landet bei 1918/1078 statt 1919/1079.
    #[test]
    fn jedes_ziel_kommt_als_derselbe_bildpunkt_an() {
        for (b, h) in [(1920, 1080), (2560, 1440), (3840, 2160), (1366, 768)] {
            let r = schirm(b, h);
            for (zx, zy) in crate::ziele::ziele_fuer((0.0, 0.0), f64::from(b), f64::from(h)) {
                let u = anteil(zx, f64::from(b));
                let v = anteil(zy, f64::from(h));
                assert_eq!(
                    anteil_auf_punkt(u, v, &r),
                    Some((zx as i32, zy as i32)),
                    "{b}x{h} Ziel {zx},{zy} -> {u},{v}"
                );
            }
        }
    }

    /// Auf einem zweiten Schirm ist der Anteil **im Quell-Rechteck** gemeint,
    /// nicht auf dem gesamten Schreibtisch — deshalb geht der Ursprung vorher
    /// heraus. Genau daran scheitern fremde Fernsteuerungen (Anmerkung im
    /// Windows-Treiber).
    #[test]
    fn der_ursprung_geht_vor_der_rechnung_heraus() {
        let b = 1920.0;
        let ziele = crate::ziele::ziele_fuer((1920.0, -200.0), b, 1080.0);
        let rechte_kante = ziele[1];
        assert_eq!(anteil(rechte_kante.0 - 1920.0, b), 65535);
        // Ohne Abzug waere der Anteil geklemmt und jedes Ziel laege rechts unten.
        assert_eq!(anteil(rechte_kante.0, b), 65535);
        assert_eq!(anteil(ziele[0].0 - 1920.0, b), 0, "linke Kante ist 0, nicht 65535");
    }

    /// Ein entartetes Rechteck ergibt keinen Anteil statt einer Division durch
    /// null.
    #[test]
    fn entartete_spanne_ergibt_null() {
        assert_eq!(anteil(0.0, 1.0), 0);
        assert_eq!(anteil(5.0, 0.0), 0);
    }

    /// Der Aufbau: acht Zielnachrichten, zwei Klickfolgen, eine Radnachricht,
    /// dann die Tasten in Buendeln zu hoechstens 32.
    #[test]
    fn der_aufbau_stimmt() {
        let ziele = crate::ziele::ziele_fuer((0.0, 0.0), 1920.0, 1080.0);
        let tasten: Vec<u16> = (0..20).map(|_| 0x1e).collect();
        let n = nachrichten(&ziele, (0.0, 0.0), 1920.0, 1080.0, (960.0, 540.0), &tasten);
        assert_eq!(n[..8].iter().map(Vec::len).collect::<Vec<_>>(), vec![1; 8]);
        assert_eq!(n[8].len(), 3, "Lage, Knopf runter, Knopf hoch");
        assert_eq!(n[9].len(), 3, "und dasselbe noch einmal fuer den Doppelklick");
        assert_eq!(n[10].len(), 2, "Lage und Rad");
        assert!(n[11..].iter().all(|b| b.len() <= 32), "kein Buendel ueber 32 Frames");
        assert_eq!(n[11..].iter().map(Vec::len).sum::<usize>(), 40, "20 Tasten, runter und hoch");
    }
}
