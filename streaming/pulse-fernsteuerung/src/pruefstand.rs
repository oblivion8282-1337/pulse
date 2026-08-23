//! Die Plattform fuer Tests: statt zu injizieren wird mitgeschrieben.
//!
//! **Warum das eine ausdrueckliche Plattform ist.** Vorher fing der
//! Windows-Injektor sich im Testbau selbst ab (`#[cfg(not(test))]` um den
//! echten `SendInput`-Aufruf). Das funktionierte, war aber unsichtbar: wer die
//! Datei las, sah nicht, dass die Tests etwas anderes ausfuehren als der
//! Auslieferbau. Als Trait-Umsetzung steht es da.
//!
//! Kein globaler Zustand: jeder Test baut sich seinen eigenen Pruefstand.
//! Deshalb braucht diese Kiste auch keine prozessweite Reihenfolge-Sperre —
//! die gab es im Windows-Sidecar nur, weil Sitzung, Wache und
//! Strom-Registrierung dort prozessweit lagen.

use std::sync::Mutex;

use crate::druck::Druck;
use crate::plattform::{Injektor, Umgebung, Wache, Zielsuche};
use crate::zuordnung::Rechteck;

/// Was ohne Testlauf ans Betriebssystem gegangen waere.
///
/// **Nicht mehr `Copy`** seit `Taste` ein `Vec` traegt — Aufrufer, die frueher
/// `spur[0]` per Wert gematcht haben, matchen jetzt `&spur[0]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ereignis {
    Setzen { punkt: (i32, i32), zieht: bool },
    Knopf { btn: u8, down: bool },
    Rad { dv: i16, dh: i16 },
    /// `mods`: die gedrueckten Scancodes zum Zeitpunkt dieses Aufrufs,
    /// sortiert — genau das, was der Injektor als `gedrueckt` bekommen hat
    /// (s. `plattform::Injektor::taste`). Ohne dieses Feld waere die
    /// Trait-Erweiterung von keinem Test gedeckt: sie ginge verloren, ohne
    /// dass ein Test rot wuerde.
    Taste { scan: u16, down: bool, mods: Vec<u16> },
}

#[derive(Default)]
pub struct PruefInjektor {
    spur: Mutex<Vec<Ereignis>>,
}

impl PruefInjektor {
    /// Die Spur abholen und leeren.
    pub fn nimm(&self) -> Vec<Ereignis> {
        std::mem::take(&mut self.spur.lock().unwrap())
    }

    fn schreibe(&self, e: Ereignis) {
        self.spur.lock().unwrap().push(e);
    }
}

impl Injektor for PruefInjektor {
    fn maus_setzen(&self, punkt: (i32, i32), gedrueckt: &Druck) {
        // `zieht` haelt fest, ob der Injektor die Zieh-Unterscheidung
        // ueberhaupt treffen KANN — das ist der macOS-Fall, und ein Test darf
        // belegen, dass die Menge ankommt.
        self.schreibe(Ereignis::Setzen { punkt, zieht: !gedrueckt.knoepfe_unten().is_empty() });
    }
    fn maus_knopf(&self, btn: u8, down: bool) {
        self.schreibe(Ereignis::Knopf { btn, down });
    }
    fn maus_rad(&self, dv: i16, dh: i16) {
        self.schreibe(Ereignis::Rad { dv, dh });
    }
    fn taste(&self, scan: u16, down: bool, gedrueckt: &Druck) {
        self.schreibe(Ereignis::Taste { scan, down, mods: gedrueckt.tasten_unten() });
    }
}

/// Eine Wache, die sich stellen laesst.
#[derive(Default)]
pub struct PruefWache {
    /// Regt sich der Host gerade?
    pub regung: Mutex<bool>,
    /// Laesst sich die Wache ueberhaupt aufstellen? `false` prueft die
    /// Startverweigerung.
    pub aufstellbar: Mutex<bool>,
    pub steht: Mutex<bool>,
}

impl PruefWache {
    pub fn neu() -> Self {
        Self { regung: Mutex::new(false), aufstellbar: Mutex::new(true), steht: Mutex::new(false) }
    }
    pub fn regen(&self, ja: bool) {
        *self.regung.lock().unwrap() = ja;
    }
}

impl Wache for PruefWache {
    fn starten(&self) -> Result<(), String> {
        if !*self.aufstellbar.lock().unwrap() {
            return Err("Pruefstand: Wache nicht aufstellbar".to_string());
        }
        *self.steht.lock().unwrap() = true;
        Ok(())
    }
    fn stoppen(&self) {
        *self.steht.lock().unwrap() = false;
    }
    fn host_regt_sich(&self) -> bool {
        *self.regung.lock().unwrap()
    }
    fn rest_ms(&self) -> u64 {
        if self.host_regt_sich() { 5_000 } else { 0 }
    }
}

/// Eine Umgebung, deren Zielauskunft sich stellen laesst.
pub struct PruefUmgebung {
    pub ziel: Mutex<ZielAntwort>,
    pub zeiger_sichtbar: Mutex<bool>,
    pub fern_aktiv: Mutex<bool>,
    pub meldungen: Mutex<Vec<String>>,
    /// Wie oft das Sitzungsende gemeldet wurde. Zaehler statt Schalter, damit
    /// ein Test belegen kann, dass es NICHT bei jedem Zeigerwechsel laeuft.
    pub beendet: Mutex<u32>,
}

/// Was `PruefUmgebung::ziel` antworten soll — `Zielsuche` selbst ist nicht
/// `Clone`, deshalb diese kleine Bauanleitung daneben.
#[derive(Clone, Copy)]
pub enum ZielAntwort {
    Gefunden { rechteck: Option<Rechteck>, sichtbar: bool },
    KeinStrom,
    NichtAufloesbar,
}

impl Default for PruefUmgebung {
    fn default() -> Self {
        Self {
            ziel: Mutex::new(ZielAntwort::Gefunden {
                rechteck: Some(Rechteck { links: 100, oben: 200, rechts: 1100, unten: 800 }),
                sichtbar: true,
            }),
            zeiger_sichtbar: Mutex::new(true),
            fern_aktiv: Mutex::new(false),
            meldungen: Mutex::new(Vec::new()),
            beendet: Mutex::new(0),
        }
    }
}

impl Umgebung for PruefUmgebung {
    fn ziel(&self, _slot: u64) -> Zielsuche {
        match *self.ziel.lock().unwrap() {
            ZielAntwort::Gefunden { rechteck, sichtbar } => {
                Zielsuche::Gefunden { rechteck, sichtbar }
            }
            ZielAntwort::KeinStrom => Zielsuche::KeinStrom,
            ZielAntwort::NichtAufloesbar => {
                Zielsuche::NichtAufloesbar("Pruefstand".to_string())
            }
        }
    }
    fn host_zeiger_zeigen(&self, zeigen: bool) {
        *self.zeiger_sichtbar.lock().unwrap() = zeigen;
    }
    fn sitzung_beendet(&self) {
        *self.beendet.lock().unwrap() += 1;
    }
    fn fern_aktiv_setzen(&self, aktiv: bool) {
        *self.fern_aktiv.lock().unwrap() = aktiv;
    }
    fn vorrang_melden(&self, gilt: bool, hold_ms: u64) {
        self.meldungen.lock().unwrap().push(format!("vorrang={gilt} hold={hold_ms}"));
    }
    fn fehler_melden(&self, grund: &str) {
        self.meldungen.lock().unwrap().push(format!("fehler={grund}"));
    }
}
