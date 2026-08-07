//! Das Pruefmuster und die Auswertung eines ausgelesenen Puffers.
//!
//! **Warum das Muster positionsabhaengig sein MUSS.** Ein gleichfoermiges
//! Muster (alle Bytes gleich) wuerde einen Weg, der um einen Versatz daneben
//! liest, als fehlerfrei durchgehen lassen — und genau das ist eine der
//! Fehlerklassen, die hier auffallen soll. Deshalb haengt jedes Byte an seiner
//! Position; ein um `d` verschobener Lesevorgang liefert dann fast ueberall
//! einen anderen Wert.
//!
//! **Und warum die Varianten sich an JEDER Position unterscheiden muessen.**
//! Der Nachweis lautet: „nach dem Warten steht ueberall das NEUE Muster".
//! Gaebe es Positionen, an denen alt und neu zufaellig gleich sind, waeren das
//! Stellen, an denen ein fehlendes Warten unsichtbar bliebe. Der
//! Varianten-Schluessel wird deshalb per XOR aufgetragen: `a XOR k1` und
//! `a XOR k2` sind fuer `k1 != k2` an *jeder* Position verschieden.

/// Das Muster fuer Position `i` und Variante `variante`.
pub fn muster(i: usize, variante: u8) -> u8 {
    // Multiplikation mit einer ungeraden Konstante und Herausschieben der
    // oberen Bits: billig, und benachbarte Positionen bekommen weit
    // auseinanderliegende Werte. Es muss kein guter Zufall sein — es muss
    // positionsabhaengig und wiederholbar sein.
    let streu = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    ((streu >> 29) as u8) ^ variante.wrapping_mul(0x5B).wrapping_add(0x1D)
}

/// Einen ganzen Puffer mit einer Variante fuellen.
pub fn fuellen(bytes: usize, variante: u8) -> Vec<u8> {
    (0..bytes).map(|i| muster(i, variante)).collect()
}

/// Das Ergebnis eines Vergleichs.
///
/// Die drei Zahlen sind bewusst getrennt: „abweichend" allein saehe bei einem
/// veralteten Lesevorgang genauso aus wie bei zerschossenem Speicher, und das
/// sind verschiedene Befunde. Dieselbe Lehre wie beim FEC-Zaehler, der den
/// Versagensfall von XOR nicht sah.
#[derive(Default, Clone, Copy)]
pub struct Vergleich {
    /// Bytes, die das NEUE (erwartete) Muster tragen.
    pub neu: usize,
    /// Bytes, die noch das ALTE Muster tragen — der Fingerabdruck eines zu
    /// frueh gelesenen Puffers.
    pub veraltet: usize,
    /// Weder das eine noch das andere. Ein halb ueberschriebenes Byte gibt es
    /// nicht, wohl aber einen Lesevorgang mitten in einer laufenden Kopie mit
    /// verschobenen Grenzen — deshalb ein eigener Zaehler statt einer Annahme.
    pub fremd: usize,
}

impl Vergleich {
    pub fn abweichend(&self) -> usize {
        self.veraltet + self.fremd
    }

    /// In einem Wort fuer die Ergebniszeile.
    pub fn kurz(&self) -> String {
        if self.abweichend() == 0 {
            format!("{} Bytes alle neu", self.neu)
        } else {
            format!("{} veraltet, {} fremd", self.veraltet, self.fremd)
        }
    }
}

/// Einen ausgelesenen Puffer gegen das erwartete und das vorherige Muster
/// halten.
pub fn vergleichen(gelesen: &[u8], neu: u8, alt: u8) -> Vergleich {
    let mut v = Vergleich::default();
    for (i, &b) in gelesen.iter().enumerate() {
        if b == muster(i, neu) {
            v.neu += 1;
        } else if b == muster(i, alt) {
            v.veraltet += 1;
        } else {
            v.fremd += 1;
        }
    }
    v
}
