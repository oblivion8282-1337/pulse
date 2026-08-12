//! Der Win32-Teil: `SendInput` und das DPI-Bewusstsein des Prozesses.
//!
//! Alles hier ist Ausführung ohne Entscheidung — was injiziert wird, entscheidet
//! die Sitzung (`super`), wohin, die Zuordnung (`super::zuordnung`).
//!
//! **Grenzen der Injektion** (dokumentiert, kein Fehler): `SendInput` erreicht
//! weder Strg+Alt+Entf noch Fenster höherer Integrität (Rechteabfragen,
//! Administrator-Fenster bei nicht erhöhtem Sidecar). Die Windows-Taste geht
//! durch.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSE_EVENT_FLAGS,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
    SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{XBUTTON1, XBUTTON2};

/// Prozess auf Per-Monitor-DPI-Bewusstsein v2 setzen.
///
/// **Pflicht vor der ersten Injektion** (Spezifikation, Abschnitt
/// „DPI-Pflicht"): ohne das sind sämtliche Koordinaten-Schnittstellen bei einer
/// Skalierung ≠ 100 % virtualisiert, und die Zuordnung ist dann systematisch
/// falsch — der Klick landet nicht dort, wo der Steuernde hingezeigt hat. Gilt
/// für jedes Programm, das hier misst; das Prüfziel
/// `streaming/win-hq-labor/testbench/eingabe-pruefziel.ps1` setzt es aus
/// demselben Grund.
pub fn dpi_bewusstsein_setzen() -> Result<(), String> {
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
    };
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
        .map_err(|e| e.to_string())
}

/// Ist der Scancode so injizierbar, wie Satz 1 ihn kennt?
///
/// Satz 1 hat genau zwei Formen: `0x00xx` (Grundtaste) und `0xE0xx` (erweiterte
/// Taste). **Alles andere darf nicht injiziert werden**, denn `wScan` trägt nur
/// das niederwertige Byte: `0xE11D` (der `0xE1`-Präfix der Pause-Taste) käme
/// nach `& 0xFF` als **linke Strg-Taste** an — und bliebe, weil das Hoch-
/// Ereignis unter demselben missgeformten Code gemerkt wird, am fremden Rechner
/// gedrückt. Die Spezifikation verlangt bei Missgeformtem Beenden statt Raten;
/// geprüft wird deshalb in der Sitzung (`super::einspielen`, fail-closed),
/// bevor irgendetwas abgefeuert wird. Der Steuernde schickt `Pause` laut
/// Spezifikation ohnehin nicht.
pub fn scancode_gueltig(scan: u16) -> bool {
    matches!(scan >> 8, 0x00 | 0xE0)
}

/// btn-Code → (`SendInput`-Flag, mouseData). `None` = unbekannt → fail-closed.
pub fn tasten_ereignis(btn: u8, down: bool) -> Option<(MOUSE_EVENT_FLAGS, i32)> {
    Some(match btn {
        0 => (if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP }, 0),
        1 => (if down { MOUSEEVENTF_RIGHTDOWN } else { MOUSEEVENTF_RIGHTUP }, 0),
        2 => (if down { MOUSEEVENTF_MIDDLEDOWN } else { MOUSEEVENTF_MIDDLEUP }, 0),
        3 => (
            if down { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP },
            XBUTTON1 as i32,
        ),
        4 => (
            if down { MOUSEEVENTF_XDOWN } else { MOUSEEVENTF_XUP },
            XBUTTON2 as i32,
        ),
        _ => return None,
    })
}

/// Ein `MOUSEINPUT`-Ereignis abfeuern. `data` = mouseData (Rad-Delta / XButton).
pub fn maus(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    abfeuern(input);
}

/// Eine Taste per Scancode (Satz 1) abfeuern. `0xE0`-Präfix → Extended-Flag,
/// Scancode = niederwertiges Byte (Windows-Konvention: das Präfix steckt im
/// Flag, nicht in `wScan`). `wVk = 0` — reine Scancode-Injektion, damit die
/// Belegung beider Seiten keine Rolle spielt.
///
/// Der Aufrufer hat den Scancode geprüft ([`scancode_gueltig`]) — hier wird
/// nicht mehr entschieden, hier wird abgefeuert.
pub fn taste(scan: u16, down: bool) {
    let mut flags: KEYBD_EVENT_FLAGS = KEYEVENTF_SCANCODE;
    if ist_erweitert(scan) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: (scan & 0xFF) as u16,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    abfeuern(input);
}

/// Ein fertiges `INPUT` an Windows geben — **im Testlauf nur mitschreiben**.
///
/// Die Tests laufen auf der Maschine des Entwicklers; ein `SendInput` daraus
/// bewegte deren echten Zeiger und tippte in deren echtes Fenster (und auf
/// genau dieser Maschine läuft womöglich gerade ein Stream). Trotzdem müssen
/// die Sitzungs-Tests prüfen können, WAS injiziert worden wäre — allen voran
/// die Freigabe des Gedrückten auf den Verwerf-Pfaden. Deshalb der Umweg über
/// [`pruefspur`]: im Testbau landet jedes Ereignis fadenlokal in einer Liste,
/// im Auslieferbau gibt es die Liste gar nicht.
fn abfeuern(input: INPUT) {
    if pruefspur::mitschreiben(&input) {
        return;
    }
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}

/// Auslieferbau: nichts mitschreiben, es wird wirklich injiziert.
#[cfg(not(test))]
mod pruefspur {
    pub(super) fn mitschreiben(_input: &super::INPUT) -> bool {
        false
    }
}

/// Testbau: statt zu injizieren wird mitgeschrieben (Begründung an
/// [`abfeuern`]). Fadenlokal, damit parallel laufende Tests sich nicht in die
/// Spur des jeweils anderen schreiben.
#[cfg(test)]
pub mod pruefspur {
    use std::cell::RefCell;

    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP};

    /// Was ohne Testlauf an `SendInput` gegangen wäre.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Ereignis {
        Maus { dx: i32, dy: i32, data: i32, flags: u32 },
        Taste { scan: u16, hoch: bool },
    }

    thread_local! {
        static SPUR: RefCell<Vec<Ereignis>> = const { RefCell::new(Vec::new()) };
    }

    pub(super) fn mitschreiben(input: &INPUT) -> bool {
        // Die Union wird nach `r#type` gelesen — genau so, wie Windows sie
        // liest; ein anderer Zweig existiert nicht.
        let ereignis = if input.r#type == INPUT_KEYBOARD {
            let ki = unsafe { input.Anonymous.ki };
            Ereignis::Taste {
                scan: ki.wScan,
                hoch: (ki.dwFlags & KEYEVENTF_KEYUP) == KEYEVENTF_KEYUP,
            }
        } else {
            let mi = unsafe { input.Anonymous.mi };
            Ereignis::Maus {
                dx: mi.dx,
                dy: mi.dy,
                data: mi.mouseData as i32,
                flags: mi.dwFlags.0,
            }
        };
        SPUR.with(|s| s.borrow_mut().push(ereignis));
        true
    }

    /// Die Spur dieses Fadens abholen und leeren.
    pub fn nimm() -> Vec<Ereignis> {
        SPUR.with(|s| std::mem::take(&mut *s.borrow_mut()))
    }
}

/// Erweiterte Taste? Nur der `0xE0`-Präfix zählt — `0xE1` (Pause) schickt der
/// Steuernde laut Spezifikation gar nicht erst, und ein trotzdem eingegangener
/// `0xE1`-Code wird vorher abgewiesen ([`scancode_gueltig`]).
fn ist_erweitert(scan: u16) -> bool {
    (scan >> 8) == 0xE0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nur_e0_ist_erweitert() {
        assert!(ist_erweitert(0xE01D)); // rechte Strg-Taste
        assert!(!ist_erweitert(0x001D)); // linke Strg-Taste
        assert!(!ist_erweitert(0xE11D)); // Pause-Präfix, nicht erweitert
    }

    /// Satz 1 kennt `0x00xx` und `0xE0xx` — sonst nichts. `0xE11D` ist der
    /// Fall, der ohne diese Prüfung als linke Strg-Taste injiziert würde (und
    /// dann gedrückt bliebe), weil `wScan` nur das niederwertige Byte trägt.
    #[test]
    fn nur_satz_1_scancodes_sind_gueltig() {
        assert!(scancode_gueltig(0x001D)); // linke Strg-Taste
        assert!(scancode_gueltig(0x0000));
        assert!(scancode_gueltig(0xE01D)); // rechte Strg-Taste
        assert!(scancode_gueltig(0xE04B)); // Pfeil links
        assert!(!scancode_gueltig(0xE11D)); // Pause-Präfix
        assert!(!scancode_gueltig(0x011D)); // erfundener Präfix
        assert!(!scancode_gueltig(0xFFFF));
    }

    /// Im Testlauf darf nie wirklich injiziert werden — und die Spur muss
    /// tragen, was gemeint war (der Scancode, und ob es ein Hoch-Ereignis
    /// war). Darauf bauen die Freigabe-Tests der Sitzung auf.
    #[test]
    fn testlauf_schreibt_mit_statt_zu_injizieren() {
        let _ = pruefspur::nimm();
        taste(0xE01D, true);
        taste(0x001E, false);
        maus(7, 9, 120, MOUSEEVENTF_LEFTDOWN);
        let spur = pruefspur::nimm();
        assert_eq!(
            spur,
            vec![
                // `wScan` trägt nur das niederwertige Byte — der `0xE0`-Präfix
                // steckt im Extended-Flag, nicht in der Zahl.
                pruefspur::Ereignis::Taste { scan: 0x1D, hoch: false },
                pruefspur::Ereignis::Taste { scan: 0x1E, hoch: true },
                pruefspur::Ereignis::Maus {
                    dx: 7,
                    dy: 9,
                    data: 120,
                    flags: MOUSEEVENTF_LEFTDOWN.0,
                },
            ]
        );
        // Abgeholt heißt geleert — sonst sähe der nächste Test fremde Spuren.
        assert!(pruefspur::nimm().is_empty());
    }

    #[test]
    fn unbekannte_maustaste_hat_kein_ereignis() {
        for btn in 0..=4u8 {
            assert!(tasten_ereignis(btn, true).is_some(), "btn={btn}");
        }
        assert!(tasten_ereignis(5, true).is_none());
        assert!(tasten_ereignis(255, false).is_none());
    }

    /// X1 und X2 unterscheiden sich **nur** im mouseData — beim Flag sind sie
    /// gleich. Wer das vertauscht, schickt jeden Seitenknopf als X1.
    #[test]
    fn x_knoepfe_trennen_sich_ueber_mousedata() {
        let (f1, d1) = tasten_ereignis(3, true).unwrap();
        let (f2, d2) = tasten_ereignis(4, true).unwrap();
        assert_eq!(f1, f2);
        assert_ne!(d1, d2);
    }
}
