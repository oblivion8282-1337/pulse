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
mod ereignisse;
mod nachbarn;
pub(crate) mod rahmen;
mod schlange;
mod strom;
mod tasten;
#[cfg(target_os = "linux")]
pub(crate) mod wayland;
mod winit_abbild;
mod ziel;

pub use bildlage::Bildlage;
pub use nachbarn::{vorrang, Nachbar};
pub use rahmen::Knopf;
pub use schlange::Abgabe;

use std::collections::BTreeSet;
use std::time::Instant;

use winit::keyboard::KeyCode;

use rahmen::ganze_punkte;
use schlange::Schlange;

/// Der zweite Abnehmer der Fensterereignisse.
pub struct Erfassung {
    aktiv: bool,
    /// Welcher Stream des Hosts gemeint ist. Steht in der Huelle, nicht im
    /// Frame (s. Wire-Spec) — die Erfassung traegt ihn nur mit.
    slot: u32,
    /// Wohin die naechsten Frames gehen. Weicht vom eigenen `slot` ab, sobald
    /// der Zeiger ueber einem anderen Player-Fenster steht (s. `nachbarn`).
    ziel_slot: u32,
    /// Fertige Buendel, die noch ihren ALTEN Platz tragen — entstehen beim
    /// Zielwechsel und gehen vor allem anderen hinaus.
    ausstehend: Vec<(u32, Vec<String>)>,
    /// Linke obere Ecke der eigenen Fensterinnenflaeche auf dem Desktop.
    ///
    /// `None` heisst „Lage unbekannt" — unter Wayland gibt winit sie
    /// grundsaetzlich nicht heraus (`inner_position()` liefert dort
    /// `NotSupportedError`), und die Tests brauchen sie nicht. Dann bleibt es
    /// beim eigenen Bild und beim eigenen Platz.
    eigener_ursprung: Option<(f64, f64)>,
    /// Alle erfassenden Player-Fenster derselben Fernsteuerungs-Sitzung, in der
    /// Reihenfolge, in der sie befragt werden (s. `nachbarn::vorrang`).
    kandidaten: Vec<Nachbar>,
    /// Wayland: Platz und Bildlage DES FENSTERS, ueber dem der Zeiger laut
    /// Datengeraet waehrend eines laufenden Zugs steht (s.
    /// `wayland::zug::Gastverbindung::zeiger_ueber` Modulkopf, „Einheit").
    /// `None`, solange kein Zug laeuft — dann bleibt es bei den beiden
    /// bestehenden Wegen (s. `ziel_bestimmen`). Nur vom Aufrufer gesetzt
    /// (`app::wayland_zug`), der als Einziger alle Fenster kennt und die vom
    /// Compositor gemeldete Flaeche einem davon zuordnen kann — dieselbe
    /// Arbeitsteilung wie bei `eigener_ursprung`/`kandidaten` und
    /// `nachbarschaft_setzen`.
    wayland_ziel: Option<(u32, Bildlage)>,
    /// Zeiger gefangen? Dann werden relative Bewegungen gesendet statt
    /// absoluter. Es gibt dafuer keinen Protokollschalter: der Host behandelt
    /// beide Opcodes zustandslos.
    zeigerfang: bool,
    /// Die fertigen Frames samt Takt und Flutkontrolle (s. [`schlange`]).
    warteschlange: Schlange,
    /// Was gerade gedrueckt ist — Grundlage fuer „alles loslassen".
    tasten_unten: BTreeSet<u16>,
    knoepfe_unten: BTreeSet<u8>,
    /// Wo der Zeiger zuletzt stand (physische Fensterpunkte), auch ausserhalb
    /// des Bildes. **Knopf und Rad tragen keine Position** — ohne diese hier
    /// waere nicht zu entscheiden, ob sie ins Bild gehoeren.
    letzte_zeigerlage: Option<(f64, f64)>,
    /// Bruchteile des Mausrades, die noch keine ganze Raste ergeben haben.
    rasten: rahmen::Rastensammler,
    /// Bruchteile relativer Bewegungen (Wayland liefert beschleunigte
    /// Bruchteile). Getrennt je Achse, wie beim Rad.
    rest_dx: f64,
    rest_dy: f64,
    /// Wie viele Tastenereignisse mangels Scancode-Abbildung gefallen sind
    /// (F13-F24, IntlRo/IntlYen, Lang1/Lang2, Medientasten, ...).
    unbekannte_tasten: u64,
    /// Welche Tasten das waren — nur, damit jede genau einmal im Protokoll
    /// landet. Eine gehaltene Taste schriebe es sonst voll.
    unbekannte_codes: BTreeSet<KeyCode>,
    /// Kennung der Fernsteuerungs-Sitzung, fuer die zuletzt eingeschaltet
    /// wurde. Geht **nicht** ueber die Leitung und wird hier nicht gedeutet —
    /// sie beantwortet allein, ob liegengebliebene Frames noch an dasselbe Ziel
    /// gehen (s. [`Self::einschalten`]).
    sitzung: Option<String>,
    /// Wie oft die Notbremse gezogen wurde (Warteschlange uebervoll, s.
    /// [`Self::einreihen`]). Ein Betriebsfehler, kein Normalfall — deshalb
    /// getrennt von den verworfenen Bewegungen gezaehlt.
    notbremsen: u64,
    /// Zustand der Umschalttasten, mitgefuehrt fuer die eine Kombination, die
    /// hier bleibt statt hinauszugehen (s. [`Self::menue_kombination`]).
    /// Winit liefert ihn nur als eigenes Ereignis, nicht am Tastendruck.
    modifikatoren: winit::keyboard::ModifiersState,
    /// Wurde das Druecken der Menue-Taste geschluckt? Dann muss ihr Loslassen
    /// ebenfalls geschluckt werden — **auch wenn die Umschalttasten inzwischen
    /// los sind**. Sonst bekaeme der Host ein Hoch-Ereignis zu einer Taste, die
    /// bei ihm nie gedrueckt wurde.
    menue_geschluckt: bool,
}

/// Was beim Abholen herauskommt — **mit dem Platz, zu dem die Frames gehoeren**.
///
/// Der Platz muss am BUENDEL haengen, nicht an der Erfassung: sobald ueber die
/// Fenstergrenze gezielt wird, koennen Frames zweier Plaetze kurz nacheinander
/// entstehen, und die Huelle traegt genau einen. Wer den Platz erst beim
/// Absetzen liest, schickte die letzte Bewegung des alten Bildschirms an den
/// neuen.
#[derive(Debug)]
pub enum Eingabeabgabe {
    Nichts,
    Spaeter(Instant),
    Jetzt { slot: u32, frames: Vec<String> },
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
            ziel_slot: 0,
            ausstehend: Vec::new(),
            eigener_ursprung: None,
            kandidaten: Vec::new(),
            wayland_ziel: None,
            zeigerfang: false,
            warteschlange: Schlange::default(),
            tasten_unten: BTreeSet::new(),
            knoepfe_unten: BTreeSet::new(),
            letzte_zeigerlage: None,
            rasten: rahmen::Rastensammler::default(),
            rest_dx: 0.0,
            rest_dy: 0.0,
            unbekannte_tasten: 0,
            unbekannte_codes: BTreeSet::new(),
            sitzung: None,
            notbremsen: 0,
            modifikatoren: winit::keyboard::ModifiersState::empty(),
            menue_geschluckt: false,
        }
    }

    pub fn aktiv(&self) -> bool {
        self.aktiv
    }

    pub fn slot(&self) -> u32 {
        self.slot
    }

    /// Wohin die naechsten Frames gehen. Gleich [`Self::slot`], solange nicht
    /// ueber die Fenstergrenze gezielt wird.
    ///
    /// Ausserhalb von Tests ungenutzt (`ziel_am_zeiger` liest das Feld
    /// direkt) — deshalb `#[cfg(test)]`, sonst meldet ein Nicht-Test-Bau
    /// `dead_code`.
    #[cfg(test)]
    pub fn ziel_slot(&self) -> u32 {
        self.ziel_slot
    }

    pub fn zeigerfang(&self) -> bool {
        self.zeigerfang
    }

    /// Zu welcher Fernsteuerungs-Sitzung diese Erfassung gehoert.
    ///
    /// Nur zum Vergleichen — gedeutet wird die Kennung hier nicht und ueber die
    /// Leitung geht sie ohnehin nicht.
    pub fn sitzung(&self) -> Option<&str> {
        self.sitzung.as_deref()
    }

    pub fn verworfene_bewegungen(&self) -> u64 {
        self.warteschlange.verworfene_bewegungen()
    }

    /// Wie viele Tastenereignisse mangels Abbildung gefallen sind.
    pub fn unbekannte_tasten(&self) -> u64 {
        self.unbekannte_tasten
    }

    /// Taste als winit-Kennung. Getrennt von [`Self::taste`], weil hier die
    /// Abbildung entschieden wird — und damit auch, was mit dem passiert, was
    /// sich NICHT abbilden laesst (F13-F24, IntlRo/IntlYen, Lang1/Lang2,
    /// NumpadEqual, NumpadComma, Medientasten).
    ///
    /// Nicht abgebildet heisst: gar nicht senden. Der Host ist fail-closed, ein
    /// geratener Scancode kaeme als falsche Taste an.
    ///
    /// **Nicht raten bleibt richtig, schweigend fallen lassen war es nicht:**
    /// bis zum 2026-08-12 verschwanden diese Ereignisse ohne Zaehler, Log und
    /// Statistik, waehrend es fuer verworfene Bewegungen laengst einen Zaehler
    /// gab. Wer meldete „meine Taste kommt am fernen Rechner nicht an",
    /// hinterliess damit keine einzige Spur. Gezaehlt wird jedes Ereignis,
    /// gemeldet jede Taste genau einmal — eine gehaltene Taste schriebe das Log
    /// sonst voll (Tastenwiederholung).
    ///
    /// Wiederholungen gehen im Uebrigen MIT: der Host injiziert Scancodes roh,
    /// und die Tastenwiederholung entsteht auf dem sendenden Rechner. Ohne sie
    /// liesse sich am anderen Ende kein Zeichen halten.
    pub fn taste_von_code(&mut self, code: KeyCode, runter: bool) {
        if !self.aktiv {
            return;
        }
        let Some(scan) = tasten::scancode(code) else {
            self.unbekannte_tasten += 1;
            if self.unbekannte_codes.insert(code) {
                eprintln!("pulse-player: Taste ohne Scancode-Abbildung, nicht gesendet: {code:?}");
            }
            return;
        };
        self.taste(scan, runter);
    }

    /// Absolute Zeigerposition (physische Fensterpunkte). Ausserhalb jedes
    /// Bildrechtecks wird nichts gesendet — so verlangt es die Wire-Spec.
    pub fn zeigerposition(&mut self, lage: Bildlage, x: f64, y: f64) {
        if !self.aktiv {
            return;
        }
        let Some((slot, (u, v))) = self.ziel_bestimmen(Some(lage), x, y) else { return };
        self.ziel_wechseln(slot);
        let (x, y) = (rahmen::anteil_zu_u16(u), rahmen::anteil_zu_u16(v));
        self.bewegung_einreihen(rahmen::maus_abs(x, y));
    }

    /// Maustaste. Wird fuer „alles loslassen" mitgefuehrt.
    ///
    /// **Ein Loslassen ohne vorheriges Druecken wird nicht gesendet.** Das ist
    /// die Kehrseite der Bild-Pruefung in [`Self::on_window_event`]: wird der
    /// Druck verworfen (Rand, Bedienleiste), darf das Loslassen nicht als
    /// einzelnes Hoch-Ereignis beim Host ankommen. Umgekehrt gilt: was hier
    /// als unten vermerkt ist, kommt beim Ausschalten sicher hoch.
    pub fn knopf(&mut self, knopf: Knopf, runter: bool) {
        if !self.aktiv {
            return;
        }
        if runter {
            self.knoepfe_unten.insert(knopf as u8);
        } else if !self.knoepfe_unten.remove(&(knopf as u8)) {
            return;
        }
        self.einreihen(rahmen::maus_knopf(knopf, runter));
    }

    /// Mausrad in ZEILEN (Windows-Vorzeichen, `senkrecht > 0` = vom Nutzer weg).
    ///
    /// Gerundet wird im [`rahmen::Rastensammler`], der die Bruchteile ueber
    /// Ereignisse hinweg mitnimmt — ein Praezisions-Touchpad liefert rund 0,33
    /// je Schritt, und jeden davon auf eine volle Raste aufzurunden ergab
    /// dreifache Scrollgeschwindigkeit beim Host. Was noch keine ganze Raste
    /// ist, erzeugt deshalb keinen Frame.
    pub fn rad(&mut self, senkrecht: f64, waagerecht: f64) {
        if !self.aktiv {
            return;
        }
        let (dv, dh) = self.rasten.schritte(senkrecht, waagerecht);
        if dv == 0 && dh == 0 {
            return;
        }
        self.einreihen(rahmen::maus_rad(dv, dh));
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
        self.einreihen(rahmen::taste(scan, runter));
    }

    /// Relative Bewegung bei gefangenem Zeiger (`DeviceEvent::MouseMotion`).
    /// Getrennt vom Fensterereignis, weil winit sie dort nicht liefert.
    ///
    /// **Mit Rest ueber Ereignisse hinweg.** Jede Differenz fuer sich zu runden
    /// hiess: unter Wayland liefert `relative_pointer` beschleunigte
    /// Bruchteile, und langsames Zielen (0,4 Punkte je Ereignis) bewegte den
    /// Zeiger beim Host **gar nicht** — jedes Ereignis rundete auf null, der
    /// Rest ging verloren. Aufgehoben summieren sich zwei bis drei solcher
    /// Ereignisse zum ersten Punkt.
    pub fn zeigerbewegung(&mut self, dx: f64, dy: f64) {
        if !self.aktiv || !self.zeigerfang {
            return;
        }
        let dx = ganze_punkte(&mut self.rest_dx, dx);
        let dy = ganze_punkte(&mut self.rest_dy, dy);
        if dx == 0 && dy == 0 {
            return;
        }
        self.bewegung_einreihen(rahmen::maus_rel(dx, dy));
    }

    /// Abholen, wenn es Zeit ist (s. [`Schlange::abholen`]).
    ///
    /// **Ausstehende Buendel gehen vor**: sie tragen einen alten Platz und
    /// duerfen sich nicht mit dem laufenden mischen. Der Aufrufer ruft in einer
    /// Schleife, bis nichts mehr kommt (s. `app::eingabe::eingaben_abgeben`).
    pub fn abholen(&mut self, jetzt: Instant) -> Eingabeabgabe {
        if !self.ausstehend.is_empty() {
            let (slot, frames) = self.ausstehend.remove(0);
            return Eingabeabgabe::Jetzt { slot, frames };
        }
        match self.warteschlange.abholen(jetzt) {
            Abgabe::Nichts => Eingabeabgabe::Nichts,
            Abgabe::Spaeter(t) => Eingabeabgabe::Spaeter(t),
            Abgabe::Jetzt(frames) => Eingabeabgabe::Jetzt { slot: self.ziel_slot, frames },
        }
    }

    /// Alles herausnehmen, ohne auf den Takt zu warten. Fuer den Abbau einer
    /// Sitzung: die Hoch-Ereignisse aus [`Self::ausschalten`] duerfen nicht mit
    /// dem Fenster verschwinden — und sie gehoeren dem Platz, der zuletzt
    /// gesteuert wurde, nicht dem, mit dem eingeschaltet wurde.
    pub fn raeumen(&mut self) -> Vec<(u32, Vec<String>)> {
        let mut alles = std::mem::take(&mut self.ausstehend);
        if let Some(frames) = self.warteschlange.raeumen() {
            alles.push((self.ziel_slot, frames));
        }
        alles
    }
}

#[cfg(test)]
mod tests;
