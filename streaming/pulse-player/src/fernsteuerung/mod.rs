//! Eingabe-Erfassung: die Seite des STEUERNDEN.
//!
//! Die winit-Ereignisse des Player-Fensters liefen bisher nur an egui (die
//! Bedienleiste). Hier steht ein **zweiter Abnehmer daneben**: er kodiert Maus
//! und Tastatur in die Frames der Wire-Spec
//! (`docs/plans/2026-08-12-input-wire-protokoll-v2.md`) und legt sie in eine
//! Warteschlange, die [`crate::app`] einmal je Takt abholt und als
//! `player:input`-Ereignis nach vorne meldet.
//!
//! **Standard AUS.** Ohne ein `input_capture`-Kommando wird nichts kodiert und
//! nichts gesendet; die Erfassung kostet dann nur das `if` in `on_window_event`.
//!
//! **Getrennt von der Ereignisschleife mit Absicht:** was hier passiert, ist
//! reine Uebersetzung und laesst sich ohne Fenster, ohne GPU und ohne Netz
//! pruefen. In `app/mod.rs` hineingeschrieben waere davon nichts testbar.

mod bildlage;
mod rahmen;
mod tasten;
mod winit_abbild;

pub use bildlage::Bildlage;
pub use rahmen::Knopf;

use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use winit::event::{ElementState, WindowEvent};
use winit::keyboard::PhysicalKey;

use rahmen::Rahmen;
use winit_abbild::{knopf_aus_nummer, knopf_von_winit, rad_von_winit};

/// Hoechstens eine Bewegung je Takt — so steht es in der Wire-Spec.
///
/// **8 ms**, also 125 Abgaben je Sekunde: knapp unter dem Bildabstand bei
/// 144 fps (6,9 ms) und weit ueber allem, was ein Mensch als Verzoegerung
/// bemerkt. Ohne diesen Takt schriebe der Player eine JSON-Zeile je
/// Mausabtastung — gemessen bis zu 900 je Sekunde (s. `FRAME_FLOW_WINDOW` in
/// `app`), und das fuer Positionen, die die naechste ohnehin ueberholt.
///
/// **Tasten, Knoepfe und Rad warten NICHT auf den Takt** (s. [`Erfassung::abholen`]):
/// sie sind selten, und bei ihnen zaehlt jede Millisekunde.
const BEWEGUNGSTAKT: Duration = Duration::from_millis(8);

/// Obergrenze der Warteschlange, ab der Bewegungen fallen.
///
/// Sie greift nur, wenn die Abgabe steht (Electron liest nicht mehr) — im
/// Normalbetrieb liegt hoechstens eine Handvoll Frames darin, weil
/// aufeinanderfolgende Bewegungen zusammengefasst werden. **Tasten, Knoepfe und
/// Rad zaehlen mit, werden aber nie verworfen:** ein verschlucktes Key-Up ist
/// eine klemmende Taste, eine verschluckte Bewegung ist nichts.
const MAX_WARTEND: usize = 256;

/// Was bei einer Abholung herauskommt.
#[derive(Debug, PartialEq, Eq)]
pub enum Abgabe {
    /// Nichts angefallen.
    Nichts,
    /// Es liegt etwas an, aber erst zu diesem Zeitpunkt (Bewegungstakt).
    Spaeter(Instant),
    /// Fertige Frames, Base64, in Reihenfolge.
    Jetzt(Vec<String>),
}

/// Der zweite Abnehmer der Fensterereignisse.
pub struct Erfassung {
    aktiv: bool,
    /// Welcher Stream des Hosts gemeint ist. Steht in der Huelle, nicht im
    /// Frame (s. Wire-Spec) — die Erfassung traegt ihn nur mit.
    slot: u32,
    /// Zeiger gefangen? Dann werden relative Bewegungen gesendet statt
    /// absoluter. Es gibt dafuer keinen Protokollschalter: der Host behandelt
    /// beide Opcodes zustandslos.
    zeigerfang: bool,
    warteschlange: VecDeque<Rahmen>,
    /// Was gerade gedrueckt ist — Grundlage fuer „alles loslassen".
    tasten_unten: BTreeSet<u16>,
    knoepfe_unten: BTreeSet<u8>,
    /// Wann zuletzt abgegeben wurde. `None` = noch nie, dann darf sofort.
    letzte_abgabe: Option<Instant>,
    /// Wie viele Bewegungen die Flutkontrolle verworfen hat. Reine Diagnose,
    /// aber die einzige Stelle, an der ein Frame lautlos verschwindet.
    verworfene_bewegungen: u64,
}

impl Default for Erfassung {
    fn default() -> Self {
        Self::neu()
    }
}

impl Erfassung {
    pub fn neu() -> Self {
        Self {
            aktiv: false,
            slot: 0,
            zeigerfang: false,
            warteschlange: VecDeque::new(),
            tasten_unten: BTreeSet::new(),
            knoepfe_unten: BTreeSet::new(),
            letzte_abgabe: None,
            verworfene_bewegungen: 0,
        }
    }

    pub fn aktiv(&self) -> bool {
        self.aktiv
    }

    pub fn slot(&self) -> u32 {
        self.slot
    }

    pub fn zeigerfang(&self) -> bool {
        self.zeigerfang
    }

    pub fn verworfene_bewegungen(&self) -> u64 {
        self.verworfene_bewegungen
    }

    /// Erfassung ein- oder ausschalten.
    ///
    /// **Beim Einschalten** wird die Warteschlange geleert und der Hello-Frame
    /// als erster eingereiht — die Wire-Spec verlangt ihn als ersten Frame der
    /// Sitzung, und alles davor Liegengebliebene gehoerte zu einer anderen.
    ///
    /// **Nur beim Uebergang aus, und das ist wichtig:** ein zweites Hello mitten
    /// im Strom ist beim Host ein Protokollfehler und beendet die Sitzung
    /// (fail-closed). Ein wiederholtes Einschalten — etwa weil nur der Slot
    /// wechselt — darf deshalb keins erzeugen.
    ///
    /// **Beim Ausschalten** wird fuer alles Gedrueckte das Hoch-Ereignis
    /// nachgereicht. Der Host laesst zwar bei Sitzungsende ebenfalls alles los,
    /// aber „Erfassung aus" ist kein Sitzungsende: wer den Mauszeiger aus dem
    /// Fenster nimmt, waehrend W gedrueckt ist, liefe sonst im Spiel weiter.
    pub fn setzen(&mut self, aktiv: bool, slot: u32, zeigerfang: bool) {
        match (self.aktiv, aktiv) {
            (false, true) => {
                self.warteschlange.clear();
                self.tasten_unten.clear();
                self.knoepfe_unten.clear();
                self.warteschlange.push_back(rahmen::hello());
            }
            (true, false) => self.alles_loslassen(),
            // Schon an bzw. schon aus: nur Slot und Zeigerfang wandern nach.
            _ => {}
        }
        self.aktiv = aktiv;
        self.slot = slot;
        self.zeigerfang = aktiv && zeigerfang;
    }

    /// Hoch-Ereignisse fuer alles Gedrueckte, in fester Reihenfolge.
    fn alles_loslassen(&mut self) {
        for scan in std::mem::take(&mut self.tasten_unten) {
            self.warteschlange.push_back(rahmen::taste(scan, false));
        }
        for nummer in std::mem::take(&mut self.knoepfe_unten) {
            if let Some(knopf) = knopf_aus_nummer(nummer) {
                self.warteschlange.push_back(rahmen::maus_knopf(knopf, false));
            }
        }
    }

    /// Ein Fensterereignis uebersetzen. `lage` ist `None`, solange kein Bild
    /// steht — dann fallen Bewegungen aus, Tasten laufen weiter.
    ///
    /// Diese Stelle ist bewusst duenn: sie ordnet winit-Typen den Methoden
    /// darunter zu, mehr nicht. **`KeyEvent` laesst sich ausserhalb von winit
    /// nicht bauen** (das Feld `platform_specific` ist `pub(crate)`), ein Test
    /// gegen `WindowEvent::KeyboardInput` ist also unmoeglich — geprueft werden
    /// deshalb [`Self::taste`] und [`tasten::scancode`] einzeln.
    pub fn on_window_event(&mut self, ereignis: &WindowEvent, lage: Option<Bildlage>) {
        if !self.aktiv {
            return;
        }
        match ereignis {
            WindowEvent::CursorMoved { position, .. } if !self.zeigerfang => {
                let Some(lage) = lage else { return };
                self.zeigerposition(lage, position.x, position.y);
            }
            WindowEvent::MouseInput { state, button, .. } => {
                // `Other` faellt hier weg — ein unbekannter Knopf beendet beim
                // Host die Sitzung, also wird er gar nicht erst gesendet.
                if let Some(knopf) = knopf_von_winit(*button) {
                    self.knopf(knopf, *state == ElementState::Pressed);
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (dv, dh) = rad_von_winit(*delta);
                self.rad(dv, dh);
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let PhysicalKey::Code(code) = event.physical_key else { return };
                // Nicht abgebildet heisst: gar nicht senden. Der Host ist
                // fail-closed, ein geratener Scancode kaeme als falsche Taste an.
                let Some(scan) = tasten::scancode(code) else { return };
                // Wiederholungen gehen MIT: der Host injiziert Scancodes roh,
                // und die Tastenwiederholung entsteht auf dem sendenden Rechner.
                // Ohne sie liesse sich am anderen Ende kein Zeichen halten.
                self.taste(scan, event.state == ElementState::Pressed);
            }
            // Fokus weg = die Tasten kommen nicht mehr an, das Hoch-Ereignis
            // also auch nicht. Ohne diese Zeile bliebe die Taste beim Host
            // haengen, bis die Sitzung endet.
            WindowEvent::Focused(false) => self.alles_loslassen(),
            _ => {}
        }
    }

    /// Absolute Zeigerposition (physische Fensterpunkte). Ausserhalb des
    /// Bildrechtecks wird nichts gesendet — so verlangt es die Wire-Spec.
    pub fn zeigerposition(&mut self, lage: Bildlage, x: f64, y: f64) {
        if !self.aktiv {
            return;
        }
        let Some((u, v)) = lage.anteil(x, y) else { return };
        self.bewegung(rahmen::maus_abs(rahmen::anteil_zu_u16(u), rahmen::anteil_zu_u16(v)));
    }

    /// Maustaste. Wird fuer „alles loslassen" mitgefuehrt.
    pub fn knopf(&mut self, knopf: Knopf, runter: bool) {
        if !self.aktiv {
            return;
        }
        if runter {
            self.knoepfe_unten.insert(knopf as u8);
        } else {
            self.knoepfe_unten.remove(&(knopf as u8));
        }
        self.warteschlange.push_back(rahmen::maus_knopf(knopf, runter));
    }

    /// Mausrad in Windows-Rastschritten. Null-Bewegungen fallen weg.
    pub fn rad(&mut self, dv: i16, dh: i16) {
        if !self.aktiv || (dv == 0 && dh == 0) {
            return;
        }
        self.warteschlange.push_back(rahmen::maus_rad(dv, dh));
    }

    /// Taste als Scancode Satz 1. Wird fuer „alles loslassen" mitgefuehrt.
    pub fn taste(&mut self, scan: u16, runter: bool) {
        if !self.aktiv {
            return;
        }
        if runter {
            self.tasten_unten.insert(scan);
        } else {
            self.tasten_unten.remove(&scan);
        }
        self.warteschlange.push_back(rahmen::taste(scan, runter));
    }

    /// Relative Bewegung bei gefangenem Zeiger (`DeviceEvent::MouseMotion`).
    /// Getrennt vom Fensterereignis, weil winit sie dort nicht liefert.
    pub fn zeigerbewegung(&mut self, dx: f64, dy: f64) {
        if !self.aktiv || !self.zeigerfang {
            return;
        }
        let kurz = |v: f64| v.round().clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16;
        let (dx, dy) = (kurz(dx), kurz(dy));
        if dx == 0 && dy == 0 {
            return;
        }
        self.bewegung(rahmen::maus_rel(dx, dy));
    }

    /// Eine Bewegung einreihen — mit Zusammenfassung und Flutkontrolle.
    ///
    /// Absolute Bewegungen **ersetzen** die letzte (die alte Position ist
    /// ueberholt), relative werden **aufsummiert** (jede Differenz zaehlt).
    /// Genau so steht es in der Wire-Spec.
    fn bewegung(&mut self, neu: Rahmen) {
        if let Some(letzter) = self.warteschlange.back_mut() {
            if letzter.opcode() == neu.opcode() {
                match (letzter.rel_werte(), neu.rel_werte()) {
                    (Some((ax, ay)), Some((bx, by))) => {
                        *letzter = rahmen::maus_rel(ax.saturating_add(bx), ay.saturating_add(by));
                    }
                    _ => *letzter = neu,
                }
                return;
            }
        }
        self.warteschlange.push_back(neu);
        self.bewegungen_kappen();
    }

    /// Staut sich die Warteschlange, fallen die AELTESTEN Bewegungen — und nur
    /// die. Bleibt nichts Verwerfbares uebrig, waechst sie weiter: Tasten,
    /// Knoepfe und Rad werden nie verworfen.
    fn bewegungen_kappen(&mut self) {
        while self.warteschlange.len() > MAX_WARTEND {
            let Some(pos) = self.warteschlange.iter().position(Rahmen::ist_bewegung) else {
                return;
            };
            self.warteschlange.remove(pos);
            self.verworfene_bewegungen += 1;
        }
    }

    /// Abholen, wenn es Zeit ist.
    ///
    /// Sofort, sobald etwas Unverzichtbares wartet (Taste, Knopf, Rad, Hello);
    /// sonst hoechstens einmal je [`BEWEGUNGSTAKT`]. Der Ruecklauf
    /// [`Abgabe::Spaeter`] sagt dem Aufrufer, wann er wiederkommen muss — ohne
    /// ihn bliebe die letzte Bewegung einer Geste liegen, bis zufaellig das
    /// naechste Ereignis eintrifft.
    pub fn abholen(&mut self, jetzt: Instant) -> Abgabe {
        if self.warteschlange.is_empty() {
            return Abgabe::Nichts;
        }
        let nur_bewegung = self.warteschlange.iter().all(Rahmen::ist_bewegung);
        if nur_bewegung {
            if let Some(letzte) = self.letzte_abgabe {
                let faellig = letzte + BEWEGUNGSTAKT;
                if jetzt < faellig {
                    return Abgabe::Spaeter(faellig);
                }
            }
        }
        self.letzte_abgabe = Some(jetzt);
        Abgabe::Jetzt(self.leeren())
    }

    /// Alles herausnehmen, ohne auf den Takt zu warten. Fuer den Abbau einer
    /// Sitzung: die Hoch-Ereignisse aus [`Self::setzen`] duerfen nicht mit dem
    /// Fenster verschwinden.
    pub fn raeumen(&mut self) -> Option<Vec<String>> {
        if self.warteschlange.is_empty() {
            return None;
        }
        Some(self.leeren())
    }

    fn leeren(&mut self) -> Vec<String> {
        self.warteschlange
            .drain(..)
            .map(|r| rahmen::base64(r.as_slice()))
            .collect()
    }
}

#[cfg(test)]
mod tests;
