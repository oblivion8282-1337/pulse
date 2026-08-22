//! Wie viel vom Vorhalt die Strecke tatsaechlich gebraucht hat.
//!
//! Kindmodul von [`super`] wie [`super::anpassung`] und
//! [`super::fernsteuerung`]: es liest den privaten Vorhalt mit.
//!
//! ## Warum es das gibt
//!
//! Der Vorhalt beim Steuern steht fest auf
//! [`super::fernsteuerung::FERN_VORHALT_MS`] = 30 ms, und nach unten kommt der
//! Regler in [`super::anpassung`] nicht darunter. Ob 30 auf einer gegebenen
//! Leitung Verschwendung oder knapp bemessen sind, **weiss heute niemand** —
//! gezaehlt wird nur der eine Extremfall, `verspaetet`, also „Vorhalt komplett
//! aufgebraucht, Bild zu spaet". Wie viel Reserve die uebrigen Bilder uebrig
//! liessen, faellt unter den Tisch.
//!
//! Zweimal wurde der Wert deshalb schon aus einer einzelnen Messreihe gesetzt
//! und beim naechsten Netz widerlegt: 5 ms waren am 2026-08-12 auf einer ruhigen
//! Strecke messbar besser und rissen am 2026-08-15 auf der Testinstanz jedes
//! zweite Bild in die Verspaetung; danach zurueck auf 30. Beide Male dieselbe
//! Sorte Fehler — eine feste Zahl, von EINER Leitung abgelesen.
//!
//! ## Was hier gemessen wird, und warum es schon vorliegt
//!
//! [`super::Ausgabetakt::ziel`] zieht seinen Anker laufend auf die **kuerzeste**
//! Laufzeit nach, die die Strecke hergibt. Damit ist der Abstand zwischen dem
//! Zielzeitpunkt eines Bildes und seiner Ankunft genau der Teil des Vorhalts,
//! den dieses Bild NICHT gebraucht hat — und der Rest ist seine Abweichung von
//! der Bestzeit, also seine Schwankung. Die Groesse liegt in jedem Durchlauf
//! vor; sie wurde bisher nur weggeworfen.
//!
//! Zwei Zahlen kommen heraus:
//!
//! * **Die knappste Reserve** im Berichtsfenster — der schlechteste Fall, der
//!   noch rechtzeitig war. Wer den Vorhalt senken will, darf hoechstens um
//!   diese Spanne senken, sonst waere genau dieses Bild zu spaet gewesen.
//! * **Die Verteilung in Vierteln** — wie viele Bilder ein Viertel, die
//!   Haelfte, drei Viertel, den ganzen Vorhalt verbraucht haben. Die knappste
//!   Reserve allein ist ein einzelner Ausreisser und wuerde jede Senkung
//!   blockieren; erst die Verteilung zeigt, ob das die Regel ist oder ein
//!   Einzelfall.
//!
//! ## Was hier bewusst NICHT passiert
//!
//! **Kein Eingriff in den Vorhalt.** Dieses Modul misst und meldet, mehr
//! nicht. Die Untergrenze an die gemessene Reserve zu koppeln, ist der zweite
//! Schritt und braucht diese Zahlen erst als Grundlage — sonst waere es die
//! dritte feste Zahl in Folge.
//!
//! **Zu spaete Bilder gehen nicht in die Verteilung ein.** Ihr Verbrauch ist
//! unbekannt (er kann den Vorhalt beliebig weit ueberschreiten), und gezaehlt
//! werden sie ohnehin schon als [`super::Ausgabetakt::verspaetet`]. Sie hier
//! mitzurechnen hiesse, sie zweimal zu zaehlen und dabei die obere Stufe
//! aufzublaehen.

use std::time::{Duration, Instant};

/// Anzahl der Stufen, in die der Verbrauch einsortiert wird.
///
/// Viertel, weil es die groebste Einteilung ist, aus der sich noch eine
/// Entscheidung ableiten laesst: liegt alles in der ersten Stufe, ist der
/// Vorhalt rund viermal so gross wie noetig.
const STUFEN: usize = 4;

/// Was ein Berichtsfenster ueber die Reserve sagt.
///
/// `pub(crate)`, weil die Zusammenfassung in `app/mod.rs` sie ausgibt —
/// [`super::Ausgabetakt::reserve_abholen`] reicht sie dorthin durch.
pub(crate) struct Bericht {
    /// Die knappste Reserve, die noch rechtzeitig war. `None` = im Fenster
    /// wurde nichts gemessen (kein Bild, oder Takt aus).
    pub knappste: Option<Duration>,
    /// Wie viele Bilder je Viertel des Vorhalts verbraucht haben — Stufe 0 ist
    /// „bis zu einem Viertel", Stufe 3 „drei Viertel bis ganz".
    pub stufen: [u32; STUFEN],
}

pub(super) struct Reserve {
    knappste: Option<Duration>,
    stufen: [u32; STUFEN],
    /// Der Vorhalt, gegen den die laufende Messung gilt.
    ///
    /// **Aendert er sich, wird verworfen statt weitergezaehlt.** Ein Fenster,
    /// dessen Stufen teils gegen 30 ms und teils gegen 45 ms gerechnet sind,
    /// beschreibt nichts — und der Vorhalt aendert sich im Betrieb an mehreren
    /// Stellen (Regler, Beginn und Ende einer Fernsteuerung, `set_option`).
    /// Der Abgleich hier faengt sie alle; an jeder einzelnen Stelle daran zu
    /// denken, ginge irgendwann schief.
    gemessen_bei: Duration,
}

impl Reserve {
    pub(super) fn neu() -> Self {
        Self { knappste: None, stufen: [0; STUFEN], gemessen_bei: Duration::ZERO }
    }

    /// Ein eingereihtes Bild verbuchen.
    ///
    /// `ziel` ist sein Anzeigezeitpunkt, `jetzt` seine Ankunft, `vorhalt` der
    /// zu diesem Zeitpunkt wirksame Vorhalt.
    pub(super) fn buchen(&mut self, vorhalt: Duration, ziel: Instant, jetzt: Instant) {
        if vorhalt.is_zero() {
            return;
        }
        if vorhalt != self.gemessen_bei {
            self.zuruecksetzen();
            self.gemessen_bei = vorhalt;
        }
        // Zu spaet: nicht verbuchen (s. Modulkopf).
        if ziel <= jetzt {
            return;
        }
        // `ziel` liegt nie weiter als einen Vorhalt in der Zukunft — `ziel()`
        // zieht den Anker sonst nach. Geklemmt wird trotzdem: die Zusage gilt
        // fuer den Regelweg, und eine Stufe ausserhalb des Feldes waere ein
        // Absturz statt einer schiefen Zahl.
        let reserve = ziel.duration_since(jetzt).min(vorhalt);
        self.knappste = Some(match self.knappste {
            Some(bisher) => bisher.min(reserve),
            None => reserve,
        });
        let verbraucht = vorhalt - reserve;
        let stufe = (verbraucht.as_nanos() * STUFEN as u128 / vorhalt.as_nanos()) as usize;
        self.stufen[stufe.min(STUFEN - 1)] += 1;
    }

    /// Den Bericht abholen und das Fenster neu beginnen.
    ///
    /// Anders als die uebrigen Zaehler des Takts (`verspaetet`, `nachgezogen`)
    /// ist das hier bewusst **nicht** kumulativ: eine knappste Reserve ueber
    /// eine ganze Sitzung waere der schlechteste Augenblick, den es je gab —
    /// meist der Einstieg — und danach unbrauchbar fuer eine Aussage darueber,
    /// was die Strecke JETZT tut.
    pub(super) fn abholen(&mut self) -> Bericht {
        let bericht = Bericht { knappste: self.knappste, stufen: self.stufen };
        self.zuruecksetzen();
        bericht
    }

    fn zuruecksetzen(&mut self) {
        self.knappste = None;
        self.stufen = [0; STUFEN];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VORHALT: Duration = Duration::from_millis(40);

    fn reserve_mit(spannen_ms: &[u64]) -> Bericht {
        let mut r = Reserve::neu();
        let jetzt = Instant::now();
        for ms in spannen_ms {
            r.buchen(VORHALT, jetzt + Duration::from_millis(*ms), jetzt);
        }
        r.abholen()
    }

    /// Ein Bild, das die volle Bestzeit trifft, verbraucht nichts — es landet
    /// in der untersten Stufe, und die Reserve ist der ganze Vorhalt.
    #[test]
    fn ungestoertes_bild_verbraucht_nichts() {
        let b = reserve_mit(&[40]);
        assert_eq!(b.knappste, Some(VORHALT));
        assert_eq!(b.stufen, [1, 0, 0, 0]);
    }

    /// Die Einsortierung trifft die Viertel: 40 ms Vorhalt, Reserven von 34,
    /// 25, 15 und 5 ms verbrauchen 6, 15, 25 und 35 ms — also Stufe 0 bis 3.
    #[test]
    fn verbrauch_landet_in_der_richtigen_stufe() {
        let b = reserve_mit(&[34, 25, 15, 5]);
        assert_eq!(b.stufen, [1, 1, 1, 1]);
        assert_eq!(b.knappste, Some(Duration::from_millis(5)));
    }

    /// **Der Fall, um den es geht.** Bleibt alles in der untersten Stufe, ist
    /// der Vorhalt um ein Vielfaches groesser als noetig — genau das soll die
    /// Zahl sichtbar machen, statt es weiter zu vermuten.
    #[test]
    fn ruhige_strecke_zeigt_reichlich_reserve() {
        let b = reserve_mit(&[39, 38, 40, 37, 39]);
        assert_eq!(b.stufen, [5, 0, 0, 0]);
        assert_eq!(b.knappste, Some(Duration::from_millis(37)));
    }

    /// Zu spaete Bilder gehen nicht ein — sie zaehlen als `verspaetet`, und ihr
    /// Verbrauch ist nach oben offen.
    #[test]
    fn zu_spaetes_bild_bleibt_draussen() {
        let mut r = Reserve::neu();
        let jetzt = Instant::now();
        r.buchen(VORHALT, jetzt + Duration::from_millis(30), jetzt);
        r.buchen(VORHALT, jetzt, jetzt);
        r.buchen(VORHALT, jetzt - Duration::from_millis(5), jetzt);
        let b = r.abholen();
        assert_eq!(b.stufen.iter().sum::<u32>(), 1, "nur das rechtzeitige Bild zaehlt");
        assert_eq!(b.knappste, Some(Duration::from_millis(30)));
    }

    /// Ein geaenderter Vorhalt verwirft das laufende Fenster — sonst stuenden
    /// Stufen nebeneinander, die gegen verschiedene Bezugsgroessen gerechnet
    /// sind.
    #[test]
    fn geaenderter_vorhalt_beginnt_neu() {
        let mut r = Reserve::neu();
        let jetzt = Instant::now();
        r.buchen(VORHALT, jetzt + Duration::from_millis(10), jetzt);
        let groesser = Duration::from_millis(60);
        r.buchen(groesser, jetzt + Duration::from_millis(59), jetzt);
        let b = r.abholen();
        assert_eq!(b.stufen, [1, 0, 0, 0], "nur das Bild nach dem Wechsel");
        assert_eq!(b.knappste, Some(Duration::from_millis(59)));
    }

    /// Ohne Takt wird nicht gemessen — „aus" ist eine Ansage, kein Messwert.
    #[test]
    fn ohne_vorhalt_wird_nichts_gebucht() {
        let mut r = Reserve::neu();
        let jetzt = Instant::now();
        r.buchen(Duration::ZERO, jetzt + Duration::from_millis(10), jetzt);
        let b = r.abholen();
        assert_eq!(b.knappste, None);
        assert_eq!(b.stufen, [0; STUFEN]);
    }

    /// Das Abholen beginnt ein neues Fenster.
    #[test]
    fn abholen_setzt_zurueck() {
        let mut r = Reserve::neu();
        let jetzt = Instant::now();
        r.buchen(VORHALT, jetzt + Duration::from_millis(20), jetzt);
        let _ = r.abholen();
        let zweiter = r.abholen();
        assert_eq!(zweiter.knappste, None);
        assert_eq!(zweiter.stufen, [0; STUFEN]);
    }
}
