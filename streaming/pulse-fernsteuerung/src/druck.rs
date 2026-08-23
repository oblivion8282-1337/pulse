//! Die Menge dessen, was gerade **physisch unten** ist — und ihre Freigabe.
//!
//! Eigener Typ, weil daran die wichtigste Zusage der Fernsteuerung haengt:
//! „Alles loslassen beim Ende." Wer drueckt, muss vermerken; sonst bleibt beim
//! Sitzungsende, beim Verwerfen, beim Hello oder beim Prozessende etwas unten,
//! und die W-Taste laeuft im Spiel des fremden Rechners weiter.
//!
//! Wer freigibt, entscheidet die Sitzung ([`crate::sitzung`]) — hier steht
//! nur, **wie** freigegeben wird.

use std::collections::HashSet;

use crate::plattform::Injektor;

#[derive(Default)]
pub struct Druck {
    /// Gedrueckte Maustasten (btn-Code).
    knoepfe: HashSet<u8>,
    /// Gedrueckte Tasten (voller Scancode inkl. `0xE0`-Praefix).
    tasten: HashSet<u16>,
}

impl Druck {
    pub fn knopf(&mut self, btn: u8, down: bool) {
        vermerken(&mut self.knoepfe, btn, down);
    }

    pub fn taste(&mut self, scan: u16, down: bool) {
        vermerken(&mut self.tasten, scan, down);
    }

    /// Haben **wir** diesen Knopf unten? Nur dann darf sein Hoch-Ereignis das
    /// Orts-Tor umgehen (s. `crate::ausfuehrung`) — sonst klemmte eine
    /// Maustaste am fremden Rechner, sobald das Quell-Rechteck wegfaellt.
    pub fn knopf_ist_unten(&self, btn: u8) -> bool {
        self.knoepfe.contains(&btn)
    }

    /// Welche Maustasten gerade unten sind.
    ///
    /// **Fuer den Injektor, nicht fuer den Kern.** macOS muss eine Bewegung
    /// bei gedruecktem Knopf als Zieh-Ereignis abfeuern und braucht dafuer zu
    /// wissen, welcher Knopf zieht. Sortiert, damit die Antwort nicht von der
    /// Streuung der Menge abhaengt — sonst zoege ein Injektor mit zwei
    /// gedrueckten Knoepfen mal den einen, mal den anderen.
    pub fn knoepfe_unten(&self) -> Vec<u8> {
        let mut v: Vec<u8> = self.knoepfe.iter().copied().collect();
        v.sort_unstable();
        v
    }

    /// Welche Tasten gerade unten sind.
    ///
    /// **Fuer den Injektor, nicht fuer den Kern** — dasselbe Prinzip wie
    /// [`Self::knoepfe_unten`]: macOS braucht die Menge, um ein
    /// Tastatur-Ereignis mit der richtigen Umschalttasten-Kennzeichnung
    /// (`.maskCommand` &c.) abzufeuern; Windows fuellt das selbst. Sortiert
    /// aus demselben Grund wie dort: die Antwort darf nicht von der Streuung
    /// der Menge abhaengen.
    pub fn tasten_unten(&self) -> Vec<u16> {
        let mut v: Vec<u16> = self.tasten.iter().copied().collect();
        v.sort_unstable();
        v
    }

    pub fn anzahl(&self) -> usize {
        self.knoepfe.len() + self.tasten.len()
    }

    /// Alles Gedrueckte freigeben. Liefert, wie viel es war.
    ///
    /// **Der Injektor kommt herein, statt hier zu stehen.** Vorher rief dieses
    /// Modul den Windows-Injektor direkt — damit war die Gedrueckt-Menge an
    /// ein Betriebssystem gebunden, obwohl sie nichts davon weiss.
    pub fn loslassen(&mut self, injektor: &dyn Injektor) -> usize {
        let n = self.anzahl();
        let knoepfe = std::mem::take(&mut self.knoepfe);
        let tasten = std::mem::take(&mut self.tasten);
        for btn in knoepfe {
            injektor.maus_knopf(btn, false);
        }
        // `self` ist an dieser Stelle bereits geleert (beide `mem::take` oben)
        // — konsistent mit `ausfuehrung`, das den Injektor ebenfalls VOR dem
        // eigenen Nachtrag ruft: die Menge, die der Injektor sieht, zaehlt
        // nie das Ereignis mit, das gerade abgefeuert wird.
        //
        // **Hier ist die Menge aber fuer JEDES Hoch-Ereignis leer, nicht nur
        // fuer das eigene** — und das ist eine ungemessene Annahme, keine
        // Tatsache. Die Ereignisse gehen nacheinander hinaus, nicht auf
        // einmal: geht bei gehaltenem Cmd+C das C zuerst hoch, meldet der
        // Injektor "nichts gehalten", obwohl Cmd erst eine Zeile spaeter
        // freigegeben wird. Fuer das Ergebnis ("am Ende ist alles oben")
        // aendert das nichts, denn ein Hoch-Uebergang haengt am Scancode, nicht
        // an der Kennzeichnung. Ob eine Plattform das je anders sieht, ist
        // nicht gemessen — auf macOS feuern Tastenkuerzel auf Runter-, nicht
        // auf Hoch-Ereignissen, dort ist es unauffaellig.
        for scan in tasten {
            injektor.taste(scan, false, self);
        }
        n
    }
}

/// Druckzustand nachfuehren: runter merkt sich die Taste, hoch vergisst sie.
fn vermerken<T: Eq + std::hash::Hash>(menge: &mut HashSet<T>, was: T, down: bool) {
    if down {
        menge.insert(was);
    } else {
        menge.remove(&was);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pruefstand::{Ereignis, PruefInjektor};

    #[test]
    fn vermerken_fuehrt_den_druckzustand() {
        let mut d = Druck::default();
        d.knopf(0, true);
        d.taste(0x1E, true);
        assert_eq!(d.anzahl(), 2);
        assert!(d.knopf_ist_unten(0));
        d.knopf(0, false);
        assert!(!d.knopf_ist_unten(0));
        assert_eq!(d.anzahl(), 1);
    }

    /// Die wichtigste Zusage: was gedrueckt ist, wird beim Loslassen
    /// **abgefeuert** — sonst laeuft die W-Taste am fremden Rechner weiter.
    #[test]
    fn loslassen_feuert_jedes_hoch_ereignis_ab() {
        let inj = PruefInjektor::default();
        let mut d = Druck::default();
        d.knopf(1, true);
        d.taste(0xE01D, true);
        assert_eq!(d.loslassen(&inj), 2);
        assert_eq!(d.anzahl(), 0);
        let spur = inj.nimm();
        assert!(spur.contains(&Ereignis::Knopf { btn: 1, down: false }), "{spur:?}");
        assert!(
            spur.contains(&Ereignis::Taste { scan: 0xE01D, down: false, mods: vec![] }),
            "{spur:?}"
        );
    }

    /// Zweimal loslassen feuert nicht zweimal — sonst kaeme bei jedem
    /// Verwerf-Pfad ein weiteres Hoch-Ereignis heraus.
    #[test]
    fn loslassen_ist_idempotent() {
        let inj = PruefInjektor::default();
        let mut d = Druck::default();
        d.taste(0x11, true);
        assert_eq!(d.loslassen(&inj), 1);
        let _ = inj.nimm();
        assert_eq!(d.loslassen(&inj), 0);
        assert!(inj.nimm().is_empty());
    }

    /// Die Reihenfolge der gedrueckten Knoepfe darf nicht von der Streuung
    /// der Menge abhaengen — sonst zoege ein macOS-Injektor mal den einen,
    /// mal den anderen.
    #[test]
    fn knoepfe_unten_ist_sortiert() {
        let mut d = Druck::default();
        for btn in [4u8, 0, 2] {
            d.knopf(btn, true);
        }
        assert_eq!(d.knoepfe_unten(), vec![0, 2, 4]);
    }

    /// Dieselbe Zusage fuer Tasten — der macOS-Injektor braucht sie fuer die
    /// Umschalttasten-Kennzeichnung, und die Antwort darf nicht von der
    /// Streuung der Menge abhaengen.
    #[test]
    fn tasten_unten_ist_sortiert() {
        let mut d = Druck::default();
        for scan in [0x1Du16, 0x2A, 0x11] {
            d.taste(scan, true);
        }
        assert_eq!(d.tasten_unten(), vec![0x11, 0x1D, 0x2A]);
    }
}
