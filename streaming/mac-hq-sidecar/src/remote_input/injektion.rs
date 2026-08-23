//! Der CoreGraphics-Teil: aus einem geprueften Frame wird ein echtes Ereignis.
//!
//! Alles hier ist **Ausfuehrung ohne Entscheidung** — was injiziert wird,
//! entscheidet `pulse_fernsteuerung::sitzung`, wohin, dessen Zuordnung. Eine
//! `CGEventSource` wird einmal erzeugt (`kCGEventSourceStateHIDSystemState`),
//! jedes Ereignis traegt [`PULSE_MARKE`] in `kCGEventSourceUserData` und geht
//! auf `kCGHIDEventTapLocation` hinaus.
//!
//! **Drei Stellen weichen von Windows ab**, alle drei nachgemessen am
//! 2026-08-23 (`docs/plans/2026-08-23-macos-eingabe-messungen.md`): Ziehen ist
//! ein eigener Ereignistyp, macOS zaehlt Doppelklicks nicht selbst, und die
//! Umschalttasten-Kennzeichnung wird nicht gefuellt. Die Rechnung dazu steht in
//! [`super::abbildung`] und [`super::klickzaehler`] — dort, wo sie sich pruefen
//! laesst. Hier steht nur, wann sie angewandt wird.
//!
//! ## Grenzen der Injektion — dokumentiert, kein Fehler
//!
//! Gegenstueck zu Strg+Alt+Entf und den Fenstern hoeherer Integritaet auf
//! Windows:
//!
//! * **Cmd+Tab und Mission Control gehen an den WindowServer**, nicht an ein
//!   Programm. Sie lassen sich per `CGEventPost` nicht ausloesen — der
//!   Steuernde kann den Programmwechsler des Hosts nicht bedienen.
//! * **Ein sicheres Eingabefeld sperrt die Tastatur aus.** Solange irgendein
//!   Programm `EnableSecureEventInput` haelt (Passwortfelder, der Anmeldeschirm,
//!   viele Passwortverwalter), kommt kein injiziertes Tastenereignis mehr an.
//!   Die Maus laeuft weiter: der Steuernde sieht einen lebenden Zeiger und eine
//!   tote Tastatur, ohne Meldung.
//! * **Ohne Bedienungshilfen-Freigabe tut `CGEventPost` wortlos gar nichts** —
//!   deshalb die Auskunft in [`crate::berechtigung`], die der Gesundheitscheck
//!   meldet, statt es zu behaupten.

use std::sync::Mutex;
use std::time::Instant;

use objc2_core_foundation::{CFRetained, CGPoint};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGScrollEventUnit,
};
use pulse_fernsteuerung::druck::Druck;
use pulse_fernsteuerung::plattform::Injektor;

use super::abbildung::{bewegungs_typ, flags_aus, knopf_ereignis, zeilen};
use super::klickzaehler::Klickzaehler;
use super::tasten;

/// Die Unterschrift dieses Prozesses unter jedem selbst injizierten Ereignis.
///
/// **Wortgleiche Begruendung wie auf Windows**
/// (`win-hq-sidecar/src/remote_input/injektion.rs`): die Wache hoert systemweit
/// mit, ob der Host selbst an Maus und Tastatur sitzt — und sieht dabei auch
/// alles, was hier abgefeuert wird. Ohne Unterschrift hielte sie die
/// Fremdeingabe fuer den Host, loeste den Vorrang aus und sperrte den
/// Steuernden mit seiner eigenen ersten Mausbewegung dauerhaft aus.
///
/// `kCGEventSourceUserData` ist das Gegenstueck zu Windows' `dwExtraInfo`: ein
/// Feld, das unveraendert bis zum Mithoerer durchlaeuft. Der Wert ist derselbe
/// wie dort („PULS" in ASCII); es geht nicht um Geheimhaltung, sondern darum,
/// die eigene Spur wiederzuerkennen.
///
/// **Gemessen 2026-08-23**, nicht angenommen: 13 von 13 injizierten Ereignissen
/// tragen die Marke noch an `kCGSessionEventTap`, also **hinter** dem
/// WindowServer, wo die Wache sitzt — auch die beiden Arten, die macOS selbst
/// umformt (`FlagsChanged` aus einem Tastencode, `*Dragged` aus einer Bewegung
/// bei gedruecktem Knopf). Zahlen: `docs/plans/2026-08-23-macos-eingabe-messungen.md`,
/// Nachtrag 6.
///
/// Die Messung an `kCGHIDEventTapLocation` — der Stelle, auf die injiziert wird
/// — sagt darueber **nichts**: dort sieht der Mithoerer das Ereignis, bevor der
/// WindowServer es angefasst hat. Wer den Stempel so prueft, misst ihn gegen
/// sich selbst.
pub const PULSE_MARKE: i64 = 0x5055_4C53;

/// Der macOS-Injektor.
pub struct MacInjektor {
    zustand: Mutex<Zustand>,
}

/// Alles, was zwischen zwei Ereignissen stehen bleibt.
///
/// **Warum der Injektor ueberhaupt Zustand fuehrt** — anders als der auf
/// Windows, der ein ZST ist: `CGEventCreateMouseEvent` verlangt bei **jedem**
/// Maus-Ereignis eine Lage, auch beim Knopf; `Injektor::maus_knopf` und
/// `Injektor::maus_rad` bekommen aber weder Lage noch Gedrueckt-Menge. Beides
/// wird deshalb aus dem letzten Aufruf uebernommen, der es hatte. Das traegt,
/// weil `pulse_fernsteuerung::ausfuehrung` vor jedem Knopf-Runter und vor jedem
/// Rad-Ereignis die Lage noch einmal behauptet (`maus_setzen`) — nachzulesen
/// dort im Modulkopf, samt Begruendung.
struct Zustand {
    quelle: CFRetained<CGEventSource>,
    /// Wo dieser Prozess den Zeiger zuletzt selbst hingesetzt hat.
    zeiger: Option<CGPoint>,
    /// Die Kennzeichnung aus dem letzten Aufruf, der die Gedrueckt-Menge sah.
    ///
    /// **Eine Stelle, an der sie veralten kann:** `Druck::loslassen` gibt erst
    /// die Knoepfe frei und dann die Tasten. Ein Hoch-Ereignis eines Knopfes
    /// traegt dort also noch die Kennzeichnung einer Taste, die eine Zeile
    /// spaeter losgelassen wird. Gemessen ist das nur fuer den gleichgelagerten
    /// Fall auf der Tastatur (Nachtrag 1 der Messakte: ein Cmd-Hoch mit noch
    /// gesetzter eigener Kennzeichnung laesst Cmd nicht haengen) — fuer die Maus
    /// ist es plausibel und ungeprueft.
    flags: CGEventFlags,
    klick: Klickzaehler,
    /// Der Klickstand je Knopf. Ein Hoch-Ereignis traegt denselben Stand wie
    /// sein Runter-Ereignis — so machen es echte Maeuse, und ein Programm, das
    /// den Doppelklick erst beim Loslassen auswertet, saehe sonst eine 1.
    stand: [i64; 5],
    /// Monotone Zeitbasis fuer den Klickzaehler.
    beginn: Instant,
}

/// **Warum das hier steht.** `CGEventSource` ist ein CoreFoundation-Objekt ohne
/// eigene Faden-Zusage, und `Injektor` verlangt `Sync` (die Sitzung wird vom
/// Dispatch-Faden und vom Wecker der Wache gerufen). Die Quelle liegt hinter
/// derselben Sperre wie der uebrige Zustand — es gibt also nie zwei Faeden
/// gleichzeitig darauf, und ein CF-Objekt darf zwischen Faeden wandern, solange
/// der Zugriff gereiht ist. **Wer die Quelle aus der Sperre herausholt, nimmt
/// diese Zusage mit.**
unsafe impl Send for Zustand {}

impl MacInjektor {
    /// `Err` heisst: CoreGraphics gibt keine Ereignisquelle her. Dann kann
    /// dieser Prozess nicht injizieren, und der Aufrufer verweigert die Sitzung,
    /// statt still nichts zu tun.
    pub fn neu() -> Result<Self, String> {
        let quelle = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .ok_or_else(|| "CGEventSourceCreate lieferte nichts".to_string())?;
        Ok(Self {
            zustand: Mutex::new(Zustand {
                quelle,
                zeiger: None,
                flags: CGEventFlags::empty(),
                klick: Klickzaehler::default(),
                stand: [1; 5],
                beginn: Instant::now(),
            }),
        })
    }

    /// Eine vergiftete Sperre wird uebernommen: ein Faden, der beim Injizieren
    /// gepanikt ist, darf nicht jede weitere Eingabe blockieren — auch nicht das
    /// Loslassen am Sitzungsende.
    fn zustand(&self) -> std::sync::MutexGuard<'_, Zustand> {
        self.zustand.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Zustand {
    fn jetzt_ms(&self) -> u64 {
        self.beginn.elapsed().as_millis() as u64
    }

    /// Wo ein Maus-Ereignis ohne eigene Lage hingehoert: dorthin, wo wir den
    /// Zeiger zuletzt gesetzt haben. Ist das unbekannt (ein Hoch-Ereignis noch
    /// vor der ersten Bewegung), wird die heutige Zeigerlage des Systems
    /// gelesen — ein leeres `CGEvent` traegt sie.
    fn ort(&self) -> CGPoint {
        self.zeiger.unwrap_or_else(|| {
            CGEvent::new(Some(&self.quelle))
                .map(|e| CGEvent::location(Some(&e)))
                .unwrap_or(CGPoint { x: 0.0, y: 0.0 })
        })
    }

    /// Der Klickstand, den dieses Knopf-Ereignis tragen soll. Warum ein
    /// Hoch-Ereignis denselben bekommt wie sein Runter-Ereignis, steht am Feld
    /// `stand`; warum ueberhaupt selbst gezaehlt wird — und warum ein
    /// Knopfwechsel die Kette bricht —, in [`super::klickzaehler`].
    fn klickstand(&mut self, btn: u8, ort: CGPoint, down: bool) -> i64 {
        if !down {
            return self.stand[btn as usize];
        }
        let jetzt = self.jetzt_ms();
        let stand = self.klick.zaehle((ort.x as i32, ort.y as i32), jetzt, btn);
        self.stand[btn as usize] = stand;
        stand
    }

    /// Stempeln, kennzeichnen, abfeuern. **Der Stempel ist nicht optional** —
    /// s. [`PULSE_MARKE`].
    ///
    /// **Im Testbau wird nicht abgefeuert, sondern aufgezeichnet** (s. [`spur`]).
    /// Zwei Gruende, und der zweite ist der wichtigere:
    ///
    /// 1. `cargo test` liefe sonst dem Entwickler ueber Maus und Tastatur. Der
    ///    Sidecar hat keinen Test, der bis hierher kommt — aber genau das war
    ///    bis zum 2026-08-23 auch der einzige Grund, aus dem es gutging.
    /// 2. Vier tragende Zeilen dieser Datei liessen sich sonst **gar nicht**
    ///    pruefen: Marke, Klickstand, Flags und der Ereignistyp entstehen hier
    ///    und verschwinden hinter `CGEvent::post`. Jede Mutation daran blieb
    ///    gruen. Mit der Spur haelt ein Test sie fest.
    ///
    /// Dass die Marke die Kette bis hinter den WindowServer **wirklich**
    /// ueberlebt, sagt die Spur nicht — das ist gemessen (13 von 13,
    /// Nachtrag 6 der Messakte). Die Messung beweist es einmal, der Test haelt
    /// es. Keins von beidem ersetzt das andere.
    ///
    /// **Grenze, die nicht ueberdehnt werden darf:** `cfg(test)` gilt nur fuer
    /// Unit-Tests *dieser* Kiste. Ein Integrationstest unter `tests/` bindet die
    /// Bibliothek ohne `--test` ein und feuerte echt ab.
    fn abfeuern(&self, ereignis: &CGEvent, flags: CGEventFlags) {
        CGEvent::set_integer_value_field(
            Some(ereignis),
            CGEventField::EventSourceUserData,
            PULSE_MARKE,
        );
        CGEvent::set_flags(Some(ereignis), flags);
        #[cfg(test)]
        spur::vermerken(ereignis);
        #[cfg(not(test))]
        {
            use objc2_core_graphics::CGEventTapLocation;
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(ereignis));
        }
    }
}

impl Injektor for MacInjektor {
    fn maus_setzen(&self, punkt: (i32, i32), gedrueckt: &Druck) {
        let flags = flags_aus(gedrueckt);
        let (typ, knopf) = bewegungs_typ(gedrueckt);
        let ort = CGPoint { x: f64::from(punkt.0), y: f64::from(punkt.1) };
        let mut z = self.zustand();
        z.zeiger = Some(ort);
        z.flags = flags;
        if let Some(e) = CGEvent::new_mouse_event(Some(&z.quelle), typ, ort, knopf) {
            // Ein Zieh-Ereignis traegt den Klickstand seines ausloesenden
            // Runter-Ereignisses — echte macOS-Zieh-Ereignisse machen das
            // genauso (Befund 3 der Pruefung vom 2026-08-23). Ohne das faellt
            // Doppelklick-und-Ziehen (ein Wort markieren und verschieben) auf
            // zeichenweise zurueck, obwohl der Stand schon im Zustand liegt —
            // `knoepfe_unten().first()` ist dieselbe „kleinster Knopf
            // entscheidet"-Regel wie in `bewegungs_typ`, hier nur zur
            // Kennzahl statt zum Ereignistyp gewendet. Keine Bewegung ohne
            // gedrueckten Knopf (`MouseMoved`) heisst `None` — dafuer gibt es
            // keinen Klickstand zu tragen.
            if let Some(&btn) = gedrueckt.knoepfe_unten().first() {
                CGEvent::set_integer_value_field(
                    Some(&e),
                    CGEventField::MouseEventClickState,
                    z.stand[btn as usize],
                );
            }
            z.abfeuern(&e, flags);
        }
    }

    fn maus_knopf(&self, btn: u8, down: bool) {
        let Some((typ, knopf)) = knopf_ereignis(btn, down) else {
            return;
        };
        let mut z = self.zustand();
        let ort = z.ort();
        let stand = z.klickstand(btn, ort, down);
        if let Some(e) = CGEvent::new_mouse_event(Some(&z.quelle), typ, ort, knopf) {
            CGEvent::set_integer_value_field(Some(&e), CGEventField::MouseEventClickState, stand);
            z.abfeuern(&e, z.flags);
        }
    }

    fn maus_rad(&self, dv: i16, dh: i16) {
        let z = self.zustand();
        // Zwei Achsen in EINEM Ereignis — anders als auf Windows, das je Achse
        // ein eigenes verlangt. `wheel1` ist senkrecht, `wheel2` waagerecht.
        let ereignis = CGEvent::new_scroll_wheel_event2(
            Some(&z.quelle),
            CGScrollEventUnit::Line,
            2,
            zeilen(dv),
            zeilen(dh),
            0,
        );
        // **Kein `CGEventSetLocation`.** Ein Rad-Ereignis geht an das Fenster
        // unter seiner Lage, und `CGEventCreateScrollWheelEvent2` nimmt keine
        // entgegen — das sieht nach einer Luecke aus. Ist es nicht:
        // nachgemessen am 2026-08-23 (Zeile eingebaut und wieder entfernt,
        // TextEdit rollt beide Male gleich weit). Der WindowServer stempelt die
        // Lage beim Einspeisen selbst, und `ausfuehrung` hat den Zeiger
        // unmittelbar davor ohnehin gesetzt.
        if let Some(e) = ereignis {
            z.abfeuern(&e, z.flags);
        }
    }

    fn taste(&self, scan: u16, down: bool, gedrueckt: &Druck) {
        // Kein Ziel auf dieser Tastatur -> still verwerfen statt raten. Ein
        // erfundener Virtualcode kaeme als falsche Taste an, und ein
        // Runter-Ereignis ohne passendes Hoch bliebe haengen.
        let Some(vk) = tasten::virtualcode(scan) else {
            return;
        };
        let flags = flags_aus(gedrueckt);
        let mut z = self.zustand();
        z.flags = flags;
        if let Some(e) = CGEvent::new_keyboard_event(Some(&z.quelle), u16::from(vk), down) {
            z.abfeuern(&e, flags);
        }
    }
}

/// Die Spur: was im Testbau **abgefeuert worden waere** (s. [`Zustand::abfeuern`]).
#[cfg(test)]
#[path = "injektion_spur.rs"]
pub mod spur;

#[cfg(test)]
#[path = "injektion_tests.rs"]
mod injektion_tests;
