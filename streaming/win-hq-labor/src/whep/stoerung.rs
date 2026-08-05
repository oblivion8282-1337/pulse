//! Die Störung am Prüfstand: ein Stoß verworfener Pakete, absichtlich erzeugt.
//!
//! **Warum selbst erzeugen und nicht abwarten.** Anders wäre die Messung nicht
//! wiederholbar — man wüsste nie, ob gerade etwas verlorenging und wie viel.
//! Der Stoß liegt fest in Zeitpunkt und Menge, und beides steht in der Messakte.
//!
//! **Warum als eigenes Stück und nicht in der Messschleife.** Es ist eine
//! Vorrichtung des Prüfstands, kein Teil des Messgeräts. In der Schleife
//! musste anschließend ein Kommentar erklären, wie das Messgerät sich selbst
//! nicht belügt (die Sequenznummer darf nicht mitgeführt werden); hier davor
//! gesetzt entsteht die Lücke von selbst, genau wie bei echtem Verlust — der
//! Empfänger dahinter sieht keinen Unterschied und muss keinen kennen.

/// Verwirft ab einer gesetzten Sekunde einen Stoß Pakete am Stück.
///
/// Ein Stoß, nicht verstreute Einzelverluste: er trifft ein Bild sicher,
/// während einzelne Ausfälle oft nur Füllung treffen und dann gar nichts
/// zeigen.
pub(super) struct Verlustquelle {
    ab_ms: Option<u64>,
    pakete: u64,
    offen: u64,
    /// Erst nach dem Stoß gesetzt — danach stört diese Quelle nie wieder.
    durch: bool,
}

/// Was mit dem Paket geschehen soll.
pub(super) enum Urteil {
    /// Durchlassen.
    Behalten,
    /// Verwerfen. Die Sequenznummer darf **nicht** mitgeführt werden: ein
    /// wirklich verlorenes Paket hinterlässt eine Lücke, und genau daran
    /// erkennt der Empfänger den Verlust.
    Verwerfen,
    /// Verwerfen — und das war das letzte des Stoßes. Ab hier ist die Strecke
    /// wieder heil; das ist der Zeitpunkt, ab dem „wie lange bis zum Bild" eine
    /// Frage an den Codec ist und nicht an den Prüfstand.
    LetztesVerworfene,
}

impl Verlustquelle {
    pub(super) fn neu(ab_sekunde: Option<u64>, pakete: u64) -> Self {
        Self { ab_ms: ab_sekunde.map(|s| s * 1000), pakete, offen: 0, durch: false }
    }

    /// Für jedes ankommende Paket rufen, mit seiner Ankunftszeit seit Beginn.
    pub(super) fn pruefe(&mut self, ms: u64) -> Urteil {
        if self.offen == 0 {
            let faellig = !self.durch && self.ab_ms.is_some_and(|ab| ms >= ab) && self.pakete > 0;
            if !faellig {
                return Urteil::Behalten;
            }
            self.offen = self.pakete;
            eprintln!("[messwerk] Verlust beginnt bei {ms} ms ({} Pakete)", self.pakete);
        }
        self.offen -= 1;
        if self.offen == 0 {
            self.durch = true;
            eprintln!("[messwerk] Verlust vorbei bei {ms} ms");
            return Urteil::LetztesVerworfene;
        }
        Urteil::Verwerfen
    }

    /// Wie viele Pakete der Stoß umfasst.
    ///
    /// Gefragt wird das erst, wenn der Stoß durch ist — ohne Zeitpunkt gibt es
    /// keinen, und dann kommt hier auch niemand vorbei.
    pub(super) fn menge(&self) -> u64 {
        self.pakete
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ist_verworfen(u: &Urteil) -> bool {
        !matches!(u, Urteil::Behalten)
    }

    /// Vor dem Zeitpunkt geht alles durch, danach genau so viele wie bestellt —
    /// und danach wieder alles. Läuft der Stoß weiter, misst der Lauf statt der
    /// Erholung nur noch sich selbst.
    #[test]
    fn genau_so_viele_wie_bestellt_und_dann_nie_wieder() {
        let mut q = Verlustquelle::neu(Some(2), 5);
        for ms in [0, 500, 1999] {
            assert!(!ist_verworfen(&q.pruefe(ms)), "vor dem Zeitpunkt darf nichts fehlen");
        }
        let verworfen = (0..5).filter(|_| ist_verworfen(&q.pruefe(2000))).count();
        assert_eq!(verworfen, 5);
        for ms in [2001, 3000, 9000] {
            assert!(!ist_verworfen(&q.pruefe(ms)), "nach dem Stoss ist wieder Ruhe");
        }
    }

    /// Das Ende des Stoßes wird genau einmal gemeldet — daran hängt die Uhr für
    /// die Erholung.
    #[test]
    fn das_ende_wird_genau_einmal_gemeldet() {
        let mut q = Verlustquelle::neu(Some(1), 3);
        let enden = (0..3).filter(|_| matches!(q.pruefe(1000), Urteil::LetztesVerworfene)).count();
        assert_eq!(enden, 1);
    }

    /// Ohne Zeitpunkt stört nichts — so schaltet man die Quelle ab.
    #[test]
    fn ohne_zeitpunkt_keine_stoerung() {
        let mut q = Verlustquelle::neu(None, 60);
        for ms in [0, 5_000, 100_000] {
            assert!(!ist_verworfen(&q.pruefe(ms)));
        }
    }
}
