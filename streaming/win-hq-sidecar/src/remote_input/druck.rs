//! Die Menge dessen, was gerade **physisch unten** ist — und ihre Freigabe.
//!
//! Eigener Typ, weil daran die wichtigste Zusage der Fernsteuerung hängt:
//! „Alles loslassen beim Ende." Wer drückt, muss vermerken; sonst bleibt beim
//! Sitzungsende, beim Verwerfen, beim Hello oder beim Prozessende etwas unten,
//! und die W-Taste läuft im Spiel des fremden Rechners weiter.
//!
//! Wer freigibt, entscheidet die Sitzung ([`super::Sitzung`]) — hier steht nur,
//! **wie** freigegeben wird.

use std::collections::HashSet;

use super::injektion;

#[derive(Default)]
pub(in crate::remote_input) struct Druck {
    /// Gedrückte Maustasten (btn-Code).
    knoepfe: HashSet<u8>,
    /// Gedrückte Tasten (voller Scancode inkl. `0xE0`-Präfix).
    tasten: HashSet<u16>,
}

impl Druck {
    pub(in crate::remote_input) fn knopf(&mut self, btn: u8, down: bool) {
        vermerken(&mut self.knoepfe, btn, down);
    }

    pub(in crate::remote_input) fn taste(&mut self, scan: u16, down: bool) {
        vermerken(&mut self.tasten, scan, down);
    }

    /// Haben **wir** diesen Knopf unten? Nur dann darf sein Hoch-Ereignis das
    /// Orts-Tor umgehen (s. [`super::ausfuehrung`]) — sonst klemmte eine
    /// Maustaste am fremden Rechner, sobald das Quell-Rechteck wegfällt.
    pub(in crate::remote_input) fn knopf_ist_unten(&self, btn: u8) -> bool {
        self.knoepfe.contains(&btn)
    }

    pub(in crate::remote_input) fn anzahl(&self) -> usize {
        self.knoepfe.len() + self.tasten.len()
    }

    /// Alles Gedrückte freigeben. Liefert, wie viel es war.
    pub(in crate::remote_input) fn loslassen(&mut self) -> usize {
        let n = self.anzahl();
        let knoepfe = std::mem::take(&mut self.knoepfe);
        let tasten = std::mem::take(&mut self.tasten);
        for btn in knoepfe {
            if let Some((flag, daten)) = injektion::tasten_ereignis(btn, false) {
                injektion::maus(0, 0, daten, flag);
            }
        }
        for scan in tasten {
            injektion::taste(scan, false);
        }
        n
    }
}

/// Druckzustand nachführen: runter merkt sich die Taste, hoch vergisst sie.
fn vermerken<T: Eq + std::hash::Hash>(menge: &mut HashSet<T>, was: T, down: bool) {
    if down {
        menge.insert(was);
    } else {
        menge.remove(&was);
    }
}
