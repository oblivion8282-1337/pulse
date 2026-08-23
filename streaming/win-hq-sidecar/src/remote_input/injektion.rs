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

/// Die Unterschrift dieses Prozesses unter jedem selbst injizierten Ereignis.
///
/// **Wofür.** Die Wache (`super::wache`) hört systemweit mit, ob der Host
/// selbst an Maus und Tastatur sitzt — und sieht dabei auch alles, was hier
/// abgefeuert wird. Ohne Unterschrift hielte sie die Fremdeingabe für den Host,
/// löste den Vorrang aus und sperrte den Steuernden mit seiner eigenen ersten
/// Mausbewegung dauerhaft aus.
///
/// `dwExtraInfo` wandert unverändert bis in den Hook — dafür ist das Feld da.
/// Der Wert ist beliebig und nur hier gebunden ("PULS" in ASCII); es geht nicht
/// um Geheimhaltung, sondern darum, die eigene Spur wiederzuerkennen.
pub const PULSE_MARKE: usize = 0x5055_4C53;

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
                // Die eigene Spur, damit die Wache sie nicht für den Host hält
                // (s. [`PULSE_MARKE`]).
                dwExtraInfo: PULSE_MARKE,
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
/// Der Aufrufer hat den Scancode bereits geprüft (Gültigkeitsprüfung jetzt in
/// `pulse_fernsteuerung::format`) — hier wird nicht mehr entschieden, hier
/// wird abgefeuert.
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
                // s. [`PULSE_MARKE`] — ohne die Marke übersteuerte sich die
                // Fernsteuerung mit ihren eigenen Tastendrücken selbst.
                dwExtraInfo: PULSE_MARKE,
            },
        },
    };
    abfeuern(input);
}

/// Ein fertiges `INPUT` an Windows geben.
///
/// **Bewusst ohne Testbau-Riegel** — anders als der macOS-Zwilling, der im
/// Testbau aufzeichnet statt zu posten. Zwei Gründe, und der zweite wiegt
/// schwerer:
///
/// 1. Der Windows-Injektor entscheidet nichts. Was abgefeuert wird, steht in
///    [`tasten_ereignis`] und [`ist_erweitert`] — reine Funktionen, die ihre
///    eigenen Tests haben. Auf macOS entstehen Ereignistyp, Kennzeichnung und
///    Klickstand dagegen erst beim Bauen des Ereignisses, also hinter dem
///    Aufruf; dort braucht es die Aufzeichnung, um überhaupt etwas prüfen zu
///    können.
/// 2. Ein **stummer** Riegel (nur `return` im Testbau, ohne Aufzeichnung) wäre
///    hier eine Falle: er machte Injektionstests schreibbar und garantiert
///    nichtssagend — genau die Sorte Test, die in dieser Etappe fünfmal grün
///    war, obwohl sie richtig und falsch nicht trennte.
///
/// Heute erreicht kein Test diese Zeile. **Wer das ändert, zeichnet auf**,
/// statt still nichts zu tun; sonst bedient `cargo test` die Maschine des
/// Entwicklers.
fn abfeuern(input: INPUT) {
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}

/// Erweiterte Taste? Nur der `0xE0`-Präfix zählt — `0xE1` (Pause) schickt der
/// Steuernde laut Spezifikation gar nicht erst, und ein trotzdem eingegangener
/// `0xE1`-Code wird vorher in der Sitzung abgewiesen (Gültigkeitsprüfung jetzt
/// in `pulse_fernsteuerung::format`).
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
