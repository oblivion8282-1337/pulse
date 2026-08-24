//! Winit-Ereignisse in die Methoden darunter uebersetzen — der duennste Teil
//! der Erfassung.
//!
//! Abgetrennt von [`super`], aus demselben Grund wie [`super::ziel`]/
//! [`super::strom`] daneben: `mod.rs` war ueber die Groessen-Grenze
//! gewachsen (`PLAN.md` §12.1), und genau diese Stelle ist die eigene
//! Aufgabe, die der Modulkopf von `mod.rs` schon vorher benannte: sie
//! „ordnet winit-Typen den Methoden darunter zu, mehr nicht".
//!
//! Als Kindmodul kommt das an die privaten Felder von [`Erfassung`], ohne
//! dafuer Zugaenge zu oeffnen, die sonst niemand braucht.

use winit::event::{ElementState, WindowEvent};
use winit::keyboard::{KeyCode, PhysicalKey};

use super::winit_abbild::{knopf_von_winit, rad_von_winit};
use super::{Bildlage, Erfassung};

impl Erfassung {
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
    /// deshalb [`Self::taste`] und [`super::tasten::scancode`] einzeln.
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
            // Zeiger aus dem Fenster: seine letzte Lage sagt nur dann noch
            // etwas, wenn eine Maustaste unten ist — GENAU DANN zieht jemand
            // ueber die Fenstergrenze, und das System stellt die Bewegungen
            // (Zeigerfang des Systems) weiterhin DIESEM Fenster zu. Ohne
            // gehaltenen Knopf ist „ausser Sicht" wieder „kein Klick" (auch
            // ausserhalb von Wayland — dort ist ein Zeiger ausser Sicht der
            // Normalfall, kein Zug).
            WindowEvent::CursorLeft { .. } => {
                if self.knoepfe_unten.is_empty() {
                    self.letzte_zeigerlage = None;
                }
            }
            WindowEvent::MouseInput { state, button, .. } => {
                // `Other` faellt hier weg — ein unbekannter Knopf beendet beim
                // Host die Sitzung, also wird er gar nicht erst gesendet.
                let Some(knopf) = knopf_von_winit(*button) else { return };
                let runter = *state == ElementState::Pressed;
                // Der DRUCK gehoert ins Bild und zielt dabei frisch — der
                // Platz kommt vom Tor, nicht vom zuletzt per Bewegung
                // bestaetigten `ziel_slot` (s. [`Self::ziel_am_zeiger`]).
                // Das LOSLASSEN geht immer durch, OHNE das Ziel zu wechseln:
                // es gehoert dorthin, wohin die Bewegung gezielt hat.
                if runter {
                    let Some(slot) = self.ziel_am_zeiger(lage, leiste_greift) else { return };
                    self.ziel_wechseln(slot);
                }
                self.knopf(knopf, runter);
            }
            // Rad ebenso: zielt aus demselben Grund frisch wie der Druck.
            WindowEvent::MouseWheel { delta, .. } => {
                let Some(slot) = self.ziel_am_zeiger(lage, leiste_greift) else { return };
                self.ziel_wechseln(slot);
                let (senkrecht, waagerecht) = rad_von_winit(*delta);
                self.rad(senkrecht, waagerecht);
            }
            WindowEvent::ModifiersChanged(neu) => self.modifikatoren = neu.state(),
            WindowEvent::KeyboardInput { event, .. } => {
                let PhysicalKey::Code(code) = event.physical_key else { return };
                let runter = event.state == ElementState::Pressed;
                // Die Kombination fuer das Menue am Griff bleibt HIER. Sie geht
                // nicht hinaus, weil sie sonst auf dem gesteuerten Rechner
                // ankaeme und dort etwas ausloeste — und weil ein Kuerzel, das
                // beide Seiten sehen, keines ist. Das Umschalten selbst macht
                // das Overlay (es bekommt dieselben Ereignisse ueber egui).
                if self.menue_kombination(code, runter) {
                    return;
                }
                self.taste_von_code(code, runter);
            }
            // Fokus weg = die Tasten kommen nicht mehr an, das Hoch-Ereignis
            // also auch nicht. Ohne diese Zeile bliebe die Taste beim Host
            // haengen, bis die Sitzung endet.
            WindowEvent::Focused(false) => self.alles_loslassen(),
            _ => {}
        }
    }

    /// Welcher Platz ist unter dem Zeiger gemeint — und zwar so, dass ein
    /// Klick dort gemeint ist? `None` heisst: kein Platz, kein Klick.
    ///
    /// **Liefert den Platz mit, statt ihn wegzuwerfen.** Knopf und Rad
    /// stempeln damit denselben frisch bestimmten Platz, den dieses Tor gerade
    /// geprueft hat — nicht den zuletzt per BEWEGUNG bestaetigten `ziel_slot`.
    /// Beides lief auseinander, wenn ein `CursorMoved` ohne eigenes Bild
    /// (`lage: None`) die Zeigerlage zwar merkte, `zeigerposition` und damit
    /// `ziel_wechseln` aber nie erreichte: der naechste Klick haette sonst mit
    /// veraltetem Ziel gestempelt, obwohl der Zeiger laengst ueber dem
    /// Nachbarn stand.
    ///
    /// Bei gefangenem Zeiger gegenstandslos: der Zeiger steht still, der ferne
    /// wird ueber Differenzen gefuehrt, und die Leiste ist dann nicht zu
    /// treffen — das Ziel bleibt einfach das laufende. Ohne bekannte
    /// Zeigerlage lautet die Antwort **kein Platz** — der Host ist
    /// fail-closed, und wo wir nicht hinsehen, klicken wir nicht.
    fn ziel_am_zeiger(&self, lage: Option<Bildlage>, leiste_greift: bool) -> Option<u32> {
        if self.zeigerfang {
            return Some(self.ziel_slot);
        }
        if leiste_greift {
            return None;
        }
        let (x, y) = self.letzte_zeigerlage?;
        self.ziel_bestimmen(lage, x, y).map(|(slot, _)| slot)
    }

    /// Ist das die Tastenkombination fuer das Menue am Griff — und damit nichts,
    /// was hinausgehen darf?
    ///
    /// **Nur die Buchstabentaste wird geschluckt, nicht die Umschalttasten.**
    /// Strg, Alt und Umschalt gehen weiter an den Host; sie kommen dort als
    /// Druck und Loslassen an und richten fuer sich genommen nichts an. Sie
    /// zurueckzuhalten hiesse zu raten, wann eine Kombination gemeint ist und
    /// wann der Nutzer wirklich Strg gedrueckt haelt — und ein verschlucktes
    /// Strg bleibt am anderen Ende haengen.
    ///
    /// Der Name spiegelt [`crate::overlay`]: dort steht dieselbe Kombination
    /// als `FERN_MENUE_TASTE` samt Begruendung fuer die Wahl. Zwei Stellen,
    /// bewusst — die eine schaltet, die andere schluckt, und beide muessen
    /// dasselbe meinen.
    fn menue_kombination(&mut self, code: KeyCode, runter: bool) -> bool {
        if code != KeyCode::KeyP {
            return false;
        }
        if runter {
            let m = self.modifikatoren;
            if m.control_key() && m.alt_key() && m.shift_key() {
                self.menue_geschluckt = true;
                return true;
            }
            return false;
        }
        // Loslassen: nur schlucken, wenn das Druecken geschluckt wurde.
        std::mem::take(&mut self.menue_geschluckt)
    }
}
