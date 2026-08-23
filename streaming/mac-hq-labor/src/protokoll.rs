//! Das maschinenlesbare Protokoll: eine JSON-Zeile je Ereignis auf stdout.
//!
//! **Warum zeilenweise und sofort geschrieben** (dieselbe Entscheidung wie im
//! Windows-Pruefziel): ein zweiter Prozess kann mitlesen, waehrend der Lauf noch
//! laeuft — und wenn das Fenster haengenbleibt, steht das Bisherige trotzdem da.
//! Ein Puffer, der erst am Ende faellt, ist bei einem Messmittel, das den
//! Rechner aussperren kann, die falsche Wahl.
//!
//! **Stdout, nicht der Bildschirm.** Das Fenster deckt alles zu; was dort steht,
//! ist fuer den Menschen davor. Auswertbar ist nur, was hier herauskommt.

use std::io::Write;

/// Ein Schreiber, der jede Zeile sofort ablegt.
pub struct Protokoll {
    ziel: Box<dyn Write>,
    beginn: std::time::Instant,
}

impl Protokoll {
    pub fn neu(datei: Option<std::fs::File>) -> Self {
        let ziel: Box<dyn Write> = match datei {
            // Beide Wege gleichzeitig waeren bequem, aber dann steht das
            // Ergebnis zweimal da und ein Auswerter muss raten, welches
            // gemeint ist. Eine Datei ersetzt stdout.
            Some(f) => Box::new(std::io::BufWriter::new(f)),
            None => Box::new(std::io::stdout()),
        };
        Self { ziel, beginn: std::time::Instant::now() }
    }

    /// Schreibt eine Zeile. `art` wird vorangestellt, `t` ist die Zeit in
    /// Millisekunden seit dem Start.
    pub fn zeile(&mut self, art: &str, mut wert: serde_json::Value) {
        let ms = self.beginn.elapsed().as_millis() as u64;
        if let Some(o) = wert.as_object_mut() {
            let mut vollstaendig = serde_json::Map::new();
            vollstaendig.insert("t".into(), ms.into());
            vollstaendig.insert("art".into(), art.into());
            vollstaendig.append(o);
            wert = serde_json::Value::Object(vollstaendig);
        }
        let _ = writeln!(self.ziel, "{wert}");
        let _ = self.ziel.flush();
    }
}

/// Ein empfangener Klick.
#[derive(Clone, Debug)]
pub struct Klick {
    pub knopf: i64,
    pub runter: bool,
    pub klickstand: i64,
    pub lage: Option<(f64, f64)>,
}

/// Ein empfangenes Radereignis.
#[derive(Clone, Debug)]
pub struct Rad {
    pub dy: f64,
    pub dx: f64,
    pub roll_dy: f64,
    pub roll_dx: f64,
    pub fein: bool,
}

/// Ein empfangenes Tastenereignis.
#[derive(Clone, Debug)]
pub struct Taste {
    pub virtualcode: u16,
    /// `None` = dieser Virtualcode hat kein Satz-1-Gegenstueck
    /// (s. [`crate::tasten`]). Nicht geraten.
    pub scancode: Option<u16>,
    pub runter: bool,
    pub umschalt: u64,
}

/// Alles Empfangene, fuer die Auswertung am Ende.
#[derive(Default)]
pub struct Aufzeichnung {
    pub bewegungen: Vec<(f64, f64)>,
    pub klicks: Vec<Klick>,
    pub raeder: Vec<Rad>,
    pub tasten: Vec<Taste>,
    /// Ereignisse, die vor der ersten bekannten Fenstergeometrie ankamen und
    /// deshalb keine Lage tragen. **Wird gezaehlt, nicht verschwiegen** — sonst
    /// sieht ein Lauf mit falsch ermittelter Geometrie wie ein Lauf ohne
    /// Eingabe aus.
    pub ohne_geometrie: usize,
    /// Mausereignisse ohne zugehoeriges Fenster: deren `locationInWindow` waere
    /// in Bildschirm-, nicht in Fensterkoordinaten und ergaebe eine erfundene
    /// Lage. Ebenfalls gezaehlt statt stillschweigend mitgerechnet.
    pub ohne_fenster: usize,
}
