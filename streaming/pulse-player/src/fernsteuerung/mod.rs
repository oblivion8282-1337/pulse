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
mod schlange;
mod tasten;
mod winit_abbild;

pub use bildlage::Bildlage;
pub use rahmen::Knopf;
pub use schlange::Abgabe;

use std::collections::BTreeSet;
use std::time::Instant;

use winit::event::{ElementState, WindowEvent};
use winit::keyboard::{KeyCode, PhysicalKey};

use schlange::Schlange;
use winit_abbild::{knopf_aus_nummer, knopf_von_winit, rad_von_winit};

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
            warteschlange: Schlange::default(),
            tasten_unten: BTreeSet::new(),
            knoepfe_unten: BTreeSet::new(),
            letzte_zeigerlage: None,
            rasten: rahmen::Rastensammler::default(),
            rest_dx: 0.0,
            rest_dy: 0.0,
            unbekannte_tasten: 0,
            unbekannte_codes: BTreeSet::new(),
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
        self.warteschlange.verworfene_bewegungen()
    }

    /// Wie viele Tastenereignisse mangels Abbildung gefallen sind.
    pub fn unbekannte_tasten(&self) -> u64 {
        self.unbekannte_tasten
    }

    /// Erfassung ein- oder ausschalten.
    ///
    /// **Jedes Einschalten beginnt einen neuen Eingabestrom** und stellt ihm
    /// ein Hello voran — auch wenn die Erfassung aus Sicht des Players schon an
    /// war (s. [`Self::strom_beginnen`]).
    ///
    /// **Beim Ausschalten** wird fuer alles Gedrueckte das Hoch-Ereignis
    /// nachgereicht. Der Host laesst zwar bei Sitzungsende ebenfalls alles los,
    /// aber „Erfassung aus" ist kein Sitzungsende: wer den Mauszeiger aus dem
    /// Fenster nimmt, waehrend W gedrueckt ist, liefe sonst im Spiel weiter.
    pub fn setzen(&mut self, aktiv: bool, slot: u32, zeigerfang: bool) {
        if aktiv {
            self.strom_beginnen();
        } else if self.aktiv {
            self.alles_loslassen();
        }
        self.aktiv = aktiv;
        self.slot = slot;
        self.zeigerfang = aktiv && zeigerfang;
    }

    /// Einen neuen Eingabestrom beginnen: Hello nach VORN, Zustand auf null.
    ///
    /// **Am Strom, nicht an der Flanke** (2026-08-12). Vorher entstand das
    /// Hello nur beim Uebergang aus→an. Der Host haelt seinen Zustand aber ueber
    /// die ganze stdio-Sitzung und die ueberlebt Sitzungswechsel: war die
    /// Erfassung im Player schon „an", als drueben ein neuer Eingabestrom
    /// begann, kam als erstes eine Bewegung an — und der Host ist fail-closed
    /// (`Eingabe vor dem Hello-Handschlag`, im Zwei-Geraete-Test am 2026-08-12
    /// belegt, danach stand die Sitzung still). Ein weiteres Hello ist laut
    /// Wire-Spec ausdruecklich erlaubt und heisst „neuer Strom"; es zu wenig zu
    /// senden legt die Fernsteuerung lahm, es zu oft zu senden kostet nichts.
    ///
    /// **Das Hello geht nach VORN, das Liegengebliebene dahinter.** Beides hat
    /// je einen Grund:
    /// * Die Hoch-Ereignisse des vorigen Stroms (aus [`Self::alles_loslassen`])
    ///   bleiben stehen — **hier stand bis zum 2026-08-12 ein `clear()`**, das
    ///   sie wegwarf, wenn zwischen Aus und Ein kein Abholen lag; die Taste
    ///   blieb dann beim Host gedrueckt.
    /// * Vor dem Hello duerfen sie trotzdem nicht liegen: hat der Host in
    ///   diesem Strom noch kein Hello gesehen, beendet ihn schon das erste
    ///   Frame davor. Dahinter sind sie hoechstens ueberfluessig, denn der Host
    ///   gibt beim Hello ohnehin alles frei — und genau deshalb vergisst der
    ///   Player hier auch seine eigene Menge des Gedrueckten.
    ///
    /// Bewegungen fallen: sie sind ueberholt, und die Wire-Spec erlaubt genau
    /// das.
    fn strom_beginnen(&mut self) {
        self.warteschlange.neuer_strom(rahmen::hello());
        self.tasten_unten.clear();
        self.knoepfe_unten.clear();
        // Der Zeiger kann inzwischen woanders stehen, und Reste einer alten
        // Geste gehoeren nicht in die neue.
        self.letzte_zeigerlage = None;
        self.rasten.zuruecksetzen();
        self.rest_dx = 0.0;
        self.rest_dy = 0.0;
    }

    /// Den Zeigerfang nachfuehren, ohne den Strom anzufassen.
    ///
    /// **Windows loest `ClipCursor` beim Fokusverlust auf, und winit stellt es
    /// nicht wieder her.** Ohne diese Stelle glaubte die Erfassung nach
    /// Alt+Tab und zurueck weiter an einen gefangenen Zeiger: `CursorMoved`
    /// wuerde weiter ignoriert, relative Bewegungen kaemen von einem freien
    /// Zeiger, und die Bedienleiste waere nicht mehr zu treffen. Wer den Griff
    /// erneuert (oder ihn verliert), sagt es hier.
    pub fn zeigerfang_nachfuehren(&mut self, gefangen: bool) {
        let neu = self.aktiv && gefangen;
        if neu == self.zeigerfang {
            return;
        }
        self.zeigerfang = neu;
        // Betriebsartwechsel: die Reste gehoeren zur alten Art, und wo der
        // Zeiger jetzt steht, weiss vor dem naechsten `CursorMoved` niemand.
        self.rest_dx = 0.0;
        self.rest_dy = 0.0;
        self.letzte_zeigerlage = None;
    }

    /// Hoch-Ereignisse fuer alles Gedrueckte, in fester Reihenfolge.
    fn alles_loslassen(&mut self) {
        for scan in std::mem::take(&mut self.tasten_unten) {
            self.warteschlange.einreihen(rahmen::taste(scan, false));
        }
        for nummer in std::mem::take(&mut self.knoepfe_unten) {
            if let Some(knopf) = knopf_aus_nummer(nummer) {
                self.warteschlange.einreihen(rahmen::maus_knopf(knopf, false));
            }
        }
    }

    /// Ein Fensterereignis uebersetzen. `lage` ist `None`, solange kein Bild
    /// steht — dann fallen Zeigerereignisse aus, Tasten laufen weiter.
    ///
    /// `leiste_greift` sagt, ob die Bedienleiste im Fenster den Zeiger gerade
    /// für sich beansprucht (egui `consumed`). Sie liegt ÜBER dem Bild, ein
    /// Klick auf ihr ist also im Bildrechteck und trotzdem keiner fuer den
    /// fernen Rechner — wer die Lautstaerke zieht, will nicht zugleich
    /// dorthin klicken.
    ///
    /// Diese Stelle ist bewusst duenn: sie ordnet winit-Typen den Methoden
    /// darunter zu, mehr nicht. **`KeyEvent` laesst sich ausserhalb von winit
    /// nicht bauen** (das Feld `platform_specific` ist `pub(crate)`), ein Test
    /// gegen `WindowEvent::KeyboardInput` ist also unmoeglich — geprueft werden
    /// deshalb [`Self::taste`] und [`tasten::scancode`] einzeln.
    pub fn on_window_event(
        &mut self,
        ereignis: &WindowEvent,
        lage: Option<Bildlage>,
        leiste_greift: bool,
    ) {
        if !self.aktiv {
            return;
        }
        match ereignis {
            WindowEvent::CursorMoved { position, .. } => {
                // IMMER merken, auch auf dem Rand und auf der Leiste: Knopf und
                // Rad tragen keine Position, und ohne die letzte waere nicht zu
                // entscheiden, ob sie ins Bild gehoeren.
                self.letzte_zeigerlage = Some((position.x, position.y));
                if self.zeigerfang || leiste_greift {
                    return;
                }
                let Some(lage) = lage else { return };
                self.zeigerposition(lage, position.x, position.y);
            }
            // Zeiger aus dem Fenster: seine letzte Lage sagt nichts mehr, und
            // ein Rad-Ereignis danach gehoert nicht mehr ins Bild.
            WindowEvent::CursorLeft { .. } => self.letzte_zeigerlage = None,
            WindowEvent::MouseInput { state, button, .. } => {
                // `Other` faellt hier weg — ein unbekannter Knopf beendet beim
                // Host die Sitzung, also wird er gar nicht erst gesendet.
                let Some(knopf) = knopf_von_winit(*button) else { return };
                let runter = *state == ElementState::Pressed;
                // **Der DRUCK gehoert ins Bild** (Wire-Spec, praezisiert am
                // 2026-08-12): sonst kommt ein Klick auf dem Briefkasten-Rand
                // oder auf der Bedienleiste beim Host dort an, wo der Zeiger
                // zuletzt IM Bild stand — also irgendwo.
                //
                // **Das LOSLASSEN geht immer durch**, sofern der Knopf beim
                // Host wirklich unten ist (das prueft [`Self::knopf`]). Wer
                // im Bild drueckt und auf dem Rand loslaesst, haette sonst
                // einen klemmenden Knopf am fremden Rechner.
                if runter && !self.zeiger_im_bild(lage, leiste_greift) {
                    return;
                }
                self.knopf(knopf, runter);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                // Rad ebenso: ein Streichen ueber der Leiste oder dem Rand ist
                // keine Eingabe fuer den fernen Rechner.
                if !self.zeiger_im_bild(lage, leiste_greift) {
                    return;
                }
                let (senkrecht, waagerecht) = rad_von_winit(*delta);
                self.rad(senkrecht, waagerecht);
            }
            WindowEvent::KeyboardInput { event, .. } => {
                let PhysicalKey::Code(code) = event.physical_key else { return };
                self.taste_von_code(code, event.state == ElementState::Pressed);
            }
            // Fokus weg = die Tasten kommen nicht mehr an, das Hoch-Ereignis
            // also auch nicht. Ohne diese Zeile bliebe die Taste beim Host
            // haengen, bis die Sitzung endet.
            WindowEvent::Focused(false) => self.alles_loslassen(),
            _ => {}
        }
    }

    /// Steht der Zeiger auf dem BILDINHALT — und zwar so, dass ein Klick dort
    /// gemeint ist?
    ///
    /// Bei gefangenem Zeiger gegenstandslos: der Zeiger steht still, der ferne
    /// wird ueber Differenzen gefuehrt, und die Leiste ist dann nicht zu
    /// treffen. Ohne bekannte Zeigerlage lautet die Antwort **nein** — der Host
    /// ist fail-closed, und wo wir nicht hinsehen, klicken wir nicht.
    fn zeiger_im_bild(&self, lage: Option<Bildlage>, leiste_greift: bool) -> bool {
        if self.zeigerfang {
            return true;
        }
        if leiste_greift {
            return false;
        }
        let (Some(lage), Some((x, y))) = (lage, self.letzte_zeigerlage) else { return false };
        lage.anteil(x, y).is_some()
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

    /// Absolute Zeigerposition (physische Fensterpunkte). Ausserhalb des
    /// Bildrechtecks wird nichts gesendet — so verlangt es die Wire-Spec.
    pub fn zeigerposition(&mut self, lage: Bildlage, x: f64, y: f64) {
        if !self.aktiv {
            return;
        }
        let Some((u, v)) = lage.anteil(x, y) else { return };
        self.warteschlange.bewegung(rahmen::maus_abs(rahmen::anteil_zu_u16(u), rahmen::anteil_zu_u16(v)));
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
        self.warteschlange.einreihen(rahmen::maus_knopf(knopf, runter));
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
        self.warteschlange.einreihen(rahmen::maus_rad(dv, dh));
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
        self.warteschlange.einreihen(rahmen::taste(scan, runter));
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
        self.warteschlange.bewegung(rahmen::maus_rel(dx, dy));
    }

    /// Abholen, wenn es Zeit ist (s. [`Schlange::abholen`]).
    pub fn abholen(&mut self, jetzt: Instant) -> Abgabe {
        self.warteschlange.abholen(jetzt)
    }

    /// Alles herausnehmen, ohne auf den Takt zu warten. Fuer den Abbau einer
    /// Sitzung: die Hoch-Ereignisse aus [`Self::setzen`] duerfen nicht mit dem
    /// Fenster verschwinden.
    pub fn raeumen(&mut self) -> Option<Vec<String>> {
        self.warteschlange.raeumen()
    }
}

/// Ganze Bildpunkte aus einer Bruchteil-Bewegung — der Rest bleibt liegen und
/// zaehlt beim naechsten Ereignis mit.
///
/// Abgeschnitten statt gerundet (`trunc`): so ist der Rest immer kleiner als
/// ein Punkt und traegt nie ein Vorzeichen gegen die Bewegungsrichtung.
fn ganze_punkte(rest: &mut f64, wert: f64) -> i16 {
    if !wert.is_finite() || !rest.is_finite() {
        *rest = 0.0;
        return 0;
    }
    *rest += wert;
    let ganz = rest.trunc().clamp(f64::from(i16::MIN), f64::from(i16::MAX));
    *rest -= ganz;
    // Nur, wenn die Klemmung oben zugeschlagen hat: der Ueberschuss wird
    // verworfen statt aufgehoben, sonst liefe der Zeiger danach nach.
    if rest.abs() >= 1.0 {
        *rest = 0.0;
    }
    ganz as i16
}

#[cfg(test)]
mod tests;
