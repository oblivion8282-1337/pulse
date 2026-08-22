//! winit-Tastenkennung -> Windows Scancode Satz 1.
//!
//! **Layoutunabhaengig.** `KeyCode` benennt die physische Taste nach demselben
//! Standard wie `KeyboardEvent.code` im Browser (UI Events, `code`-Werte), und
//! der Scancode ist die Nummer, die die Tastatur wirklich schickt. Damit braucht
//! keine der beiden Seiten Wissen ueber die Tastaturbelegung: wer auf einer
//! deutschen Tastatur `Y` drueckt, sendet den Scancode der Taste, auf der beim
//! Host `Z` liegen mag — und genau das ist gewollt, weil der Host die
//! Zuordnung selbst vornimmt.
//!
//! Erweiterte Tasten tragen den `0xE0`-Vorsatz im hohen Byte; der Host macht
//! daraus das `KEYEVENTF_EXTENDEDKEY`-Flag.
//!
//! **Zwei Namensunterschiede zum Browser**, und nur zwei: winit heisst die
//! Windows-/Befehlstasten `SuperLeft`/`SuperRight`, der Browser `MetaLeft`/
//! `MetaRight`. Alles andere ist wortgleich, die Tabelle ist deshalb
//! uebertragbar (Herkunft: `web/src/lib/remote/input.ts` auf dem Zweig
//! `feat/remote-control-windows`).
//!
//! **`Pause` fehlt mit Absicht** — die Taste ist der `0xE1`-Vorsatz-Sonderfall
//! und passt nicht in ein `u16` mit `0xE0`-Regel. Die Wire-Spec spart sie
//! ausdruecklich aus; sie wird nicht gesendet.

use winit::keyboard::KeyCode;

/// `None` = nicht abgebildet. Der Aufrufer sendet dann gar nichts, statt zu
/// raten — der Host ist fail-closed und ein erfundener Scancode kaeme als
/// falsche Taste an.
///
/// Bewusst ein `match` und keine Nachschlagetabelle: der Compiler baut daraus
/// eine Sprungtabelle, es gibt nichts zu belegen und nichts zu bauen.
pub fn scancode(code: KeyCode) -> Option<u16> {
    #[rustfmt::skip]
    let scan = match code {
        // --- Buchstabenreihe (physische Positionen) ---
        KeyCode::KeyA => 0x1e, KeyCode::KeyB => 0x30, KeyCode::KeyC => 0x2e,
        KeyCode::KeyD => 0x20, KeyCode::KeyE => 0x12, KeyCode::KeyF => 0x21,
        KeyCode::KeyG => 0x22, KeyCode::KeyH => 0x23, KeyCode::KeyI => 0x17,
        KeyCode::KeyJ => 0x24, KeyCode::KeyK => 0x25, KeyCode::KeyL => 0x26,
        KeyCode::KeyM => 0x32, KeyCode::KeyN => 0x31, KeyCode::KeyO => 0x18,
        KeyCode::KeyP => 0x19, KeyCode::KeyQ => 0x10, KeyCode::KeyR => 0x13,
        KeyCode::KeyS => 0x1f, KeyCode::KeyT => 0x14, KeyCode::KeyU => 0x16,
        KeyCode::KeyV => 0x2f, KeyCode::KeyW => 0x11, KeyCode::KeyX => 0x2d,
        KeyCode::KeyY => 0x15, KeyCode::KeyZ => 0x2c,

        // --- Zifferreihe ---
        KeyCode::Digit1 => 0x02, KeyCode::Digit2 => 0x03, KeyCode::Digit3 => 0x04,
        KeyCode::Digit4 => 0x05, KeyCode::Digit5 => 0x06, KeyCode::Digit6 => 0x07,
        KeyCode::Digit7 => 0x08, KeyCode::Digit8 => 0x09, KeyCode::Digit9 => 0x0a,
        KeyCode::Digit0 => 0x0b,

        // --- Symbole der Hauptreihe ---
        KeyCode::Minus => 0x0c, KeyCode::Equal => 0x0d, KeyCode::Backquote => 0x29,
        KeyCode::BracketLeft => 0x1a, KeyCode::BracketRight => 0x1b,
        KeyCode::Backslash => 0x2b, KeyCode::Semicolon => 0x27, KeyCode::Quote => 0x28,
        KeyCode::Comma => 0x33, KeyCode::Period => 0x34, KeyCode::Slash => 0x35,
        KeyCode::IntlBackslash => 0x56,

        // --- Steuertasten ---
        KeyCode::Escape => 0x01, KeyCode::Backspace => 0x0e, KeyCode::Tab => 0x0f,
        KeyCode::Enter => 0x1c, KeyCode::Space => 0x39, KeyCode::CapsLock => 0x3a,
        KeyCode::ShiftLeft => 0x2a, KeyCode::ShiftRight => 0x36,
        KeyCode::ControlLeft => 0x1d, KeyCode::AltLeft => 0x38,

        // --- Rechte Zusatztasten und Windows-Tasten: alle erweitert ---
        KeyCode::ControlRight => 0xe01d, KeyCode::AltRight => 0xe038,
        KeyCode::SuperLeft => 0xe05b, KeyCode::SuperRight => 0xe05c,
        KeyCode::ContextMenu => 0xe05d,

        // --- Funktionstasten ---
        KeyCode::F1 => 0x3b, KeyCode::F2 => 0x3c, KeyCode::F3 => 0x3d,
        KeyCode::F4 => 0x3e, KeyCode::F5 => 0x3f, KeyCode::F6 => 0x40,
        KeyCode::F7 => 0x41, KeyCode::F8 => 0x42, KeyCode::F9 => 0x43,
        KeyCode::F10 => 0x44, KeyCode::F11 => 0x57, KeyCode::F12 => 0x58,

        // --- Navigationsblock (alle erweitert) ---
        KeyCode::Insert => 0xe052, KeyCode::Delete => 0xe053,
        KeyCode::Home => 0xe047, KeyCode::End => 0xe04f,
        KeyCode::PageUp => 0xe049, KeyCode::PageDown => 0xe051,
        KeyCode::ArrowUp => 0xe048, KeyCode::ArrowDown => 0xe050,
        KeyCode::ArrowLeft => 0xe04b, KeyCode::ArrowRight => 0xe04d,

        // --- Ziffernblock ---
        KeyCode::NumLock => 0x45, KeyCode::NumpadDivide => 0xe035,
        KeyCode::NumpadMultiply => 0x37, KeyCode::NumpadSubtract => 0x4a,
        KeyCode::NumpadAdd => 0x4e, KeyCode::NumpadEnter => 0xe01c,
        KeyCode::NumpadDecimal => 0x53,
        KeyCode::Numpad0 => 0x52, KeyCode::Numpad1 => 0x4f, KeyCode::Numpad2 => 0x50,
        KeyCode::Numpad3 => 0x51, KeyCode::Numpad4 => 0x4b, KeyCode::Numpad5 => 0x4c,
        KeyCode::Numpad6 => 0x4d, KeyCode::Numpad7 => 0x47, KeyCode::Numpad8 => 0x48,
        KeyCode::Numpad9 => 0x49,

        // --- Sonstige ---
        KeyCode::ScrollLock => 0x46, KeyCode::PrintScreen => 0xe037,

        // `Pause` liegt hier bewusst NICHT (s. Modulkopf), und alles
        // Multimedia-artige ebenso wenig: dafuer gibt es keine gemessene
        // Zuordnung, und geraten wird nicht.
        _ => return None,
    };
    Some(scan)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Jede Taste, die [`super::scancode`] abbildet.
    ///
    /// Bis zum 2026-08-22 stand sie im Rumpf von
    /// [`keine_doppelten_scancodes`]. Herausgehoben, weil sie jetzt zwei Tests
    /// traegt: die Doppelungspruefung und den Abgleich mit dem gemeinsamen
    /// Vokabular. Waechst `scancode` um eine Taste, ohne dass sie hier
    /// dazukommt, faellt das in `keine_doppelten_scancodes` NICHT auf — dafuer
    /// sorgt der Vokabel-Abgleich unten, denn dann fehlt der Scancode auch im
    /// Vokabular.
    const ALLE_TASTEN: &[KeyCode] = &[
        KeyCode::KeyA, KeyCode::KeyB, KeyCode::KeyC, KeyCode::KeyD, KeyCode::KeyE,
        KeyCode::KeyF, KeyCode::KeyG, KeyCode::KeyH, KeyCode::KeyI, KeyCode::KeyJ,
        KeyCode::KeyK, KeyCode::KeyL, KeyCode::KeyM, KeyCode::KeyN, KeyCode::KeyO,
        KeyCode::KeyP, KeyCode::KeyQ, KeyCode::KeyR, KeyCode::KeyS, KeyCode::KeyT,
        KeyCode::KeyU, KeyCode::KeyV, KeyCode::KeyW, KeyCode::KeyX, KeyCode::KeyY,
        KeyCode::KeyZ, KeyCode::Digit0, KeyCode::Digit1, KeyCode::Digit2,
        KeyCode::Digit3, KeyCode::Digit4, KeyCode::Digit5, KeyCode::Digit6,
        KeyCode::Digit7, KeyCode::Digit8, KeyCode::Digit9, KeyCode::Minus,
        KeyCode::Equal, KeyCode::Backquote, KeyCode::BracketLeft,
        KeyCode::BracketRight, KeyCode::Backslash, KeyCode::Semicolon,
        KeyCode::Quote, KeyCode::Comma, KeyCode::Period, KeyCode::Slash,
        KeyCode::IntlBackslash, KeyCode::Escape, KeyCode::Backspace, KeyCode::Tab,
        KeyCode::Enter, KeyCode::Space, KeyCode::CapsLock, KeyCode::ShiftLeft,
        KeyCode::ShiftRight, KeyCode::ControlLeft, KeyCode::AltLeft,
        KeyCode::ControlRight, KeyCode::AltRight, KeyCode::SuperLeft,
        KeyCode::SuperRight, KeyCode::ContextMenu, KeyCode::F1, KeyCode::F2,
        KeyCode::F3, KeyCode::F4, KeyCode::F5, KeyCode::F6, KeyCode::F7,
        KeyCode::F8, KeyCode::F9, KeyCode::F10, KeyCode::F11, KeyCode::F12,
        KeyCode::Insert, KeyCode::Delete, KeyCode::Home, KeyCode::End,
        KeyCode::PageUp, KeyCode::PageDown, KeyCode::ArrowUp, KeyCode::ArrowDown,
        KeyCode::ArrowLeft, KeyCode::ArrowRight, KeyCode::NumLock,
        KeyCode::NumpadDivide, KeyCode::NumpadMultiply, KeyCode::NumpadSubtract,
        KeyCode::NumpadAdd, KeyCode::NumpadEnter, KeyCode::NumpadDecimal,
        KeyCode::Numpad0, KeyCode::Numpad1, KeyCode::Numpad2, KeyCode::Numpad3,
        KeyCode::Numpad4, KeyCode::Numpad5, KeyCode::Numpad6, KeyCode::Numpad7,
        KeyCode::Numpad8, KeyCode::Numpad9, KeyCode::ScrollLock,
        KeyCode::PrintScreen,
    ];

    #[test]
    fn buchstaben_liegen_auf_ihrer_physischen_position() {
        assert_eq!(scancode(KeyCode::KeyA), Some(0x1e));
        assert_eq!(scancode(KeyCode::KeyW), Some(0x11));
        // Y und Z sind der Beleg fuer die Layoutunabhaengigkeit: auf einer
        // deutschen Tastatur sind sie vertauscht, die Scancodes nicht.
        assert_eq!(scancode(KeyCode::KeyY), Some(0x15));
        assert_eq!(scancode(KeyCode::KeyZ), Some(0x2c));
    }

    #[test]
    fn erweiterte_tasten_tragen_den_e0_vorsatz() {
        for (code, scan) in [
            (KeyCode::ControlRight, 0xe01du16),
            (KeyCode::AltRight, 0xe038),
            (KeyCode::ArrowLeft, 0xe04b),
            (KeyCode::Delete, 0xe053),
            (KeyCode::NumpadEnter, 0xe01c),
            (KeyCode::SuperLeft, 0xe05b),
        ] {
            assert_eq!(scancode(code), Some(scan), "{code:?}");
            assert_eq!(scan >> 8, 0xe0, "{code:?} muss erweitert sein");
        }
    }

    /// Die linken Gegenstuecke sind NICHT erweitert — genau daran haengt beim
    /// Host das `KEYEVENTF_EXTENDEDKEY`-Flag.
    #[test]
    fn linke_gegenstuecke_sind_nicht_erweitert() {
        for code in [KeyCode::ControlLeft, KeyCode::AltLeft, KeyCode::Enter] {
            let scan = scancode(code).expect("abgebildet");
            assert!(scan < 0x100, "{code:?} darf keinen Vorsatz tragen: {scan:#x}");
        }
    }

    /// `Pause` ist der `0xE1`-Sonderfall und wird ausdruecklich nicht gesendet.
    #[test]
    fn pause_wird_nicht_abgebildet() {
        assert_eq!(scancode(KeyCode::Pause), None);
    }

    #[test]
    fn unbekanntes_wird_nicht_geraten() {
        assert_eq!(scancode(KeyCode::MediaPlayPause), None);
        assert_eq!(scancode(KeyCode::F13), None);
    }

    /// Kein Scancode darf doppelt vergeben sein — eine Doppelung waere eine
    /// Taste, die als eine andere ankommt, und das faellt beim Lesen nicht auf.
    #[test]
    fn keine_doppelten_scancodes() {
        let mut gesehen = std::collections::BTreeMap::new();
        for code in ALLE_TASTEN {
            let scan = scancode(*code).unwrap_or_else(|| panic!("{code:?} fehlt in der Tabelle"));
            if let Some(anderer) = gesehen.insert(scan, code) {
                panic!("{scan:#x} doppelt: {anderer:?} und {code:?}");
            }
        }
        assert_eq!(gesehen.len(), ALLE_TASTEN.len());
    }

    /// **Der Pruefstein kommt vom Sender.** Alles, was diese Tabelle erzeugen
    /// kann, muss im gemeinsamen Vokabular stehen — daran prueft jeder
    /// Injektor, ob er vollstaendig ist.
    ///
    /// Die Lehre vom Zeigerbild (2026-08-17): wer eine Pruefung testet,
    /// schreibt die Faelle aus derselben Vorstellung auf, aus der er die
    /// Pruefung geschrieben hat. Ein Test beim Empfaenger allein faende die
    /// Luecke nie.
    #[test]
    fn jeder_gesendete_scancode_steht_im_vokabular() {
        for code in ALLE_TASTEN {
            let scan = scancode(*code).unwrap_or_else(|| panic!("{code:?} fehlt in der Tabelle"));
            assert!(
                pulse_fernsteuerung::format::SATZ1_TASTEN.contains(&scan),
                "{code:?} sendet {scan:#06x}, das nicht im Vokabular steht"
            );
        }
    }

    /// Und umgekehrt: das Vokabular darf nichts fuehren, was kein Sender
    /// erzeugt — sonst muesste jeder Injektor Ziele fuer Codes vorhalten, die
    /// nie kommen, und die Vollstaendigkeitspruefung drueben waere strenger
    /// als noetig.
    #[test]
    fn das_vokabular_fuehrt_nichts_ueberfluessiges() {
        let erzeugbar: std::collections::BTreeSet<u16> =
            ALLE_TASTEN.iter().filter_map(|c| scancode(*c)).collect();
        for scan in pulse_fernsteuerung::format::SATZ1_TASTEN {
            assert!(
                erzeugbar.contains(scan),
                "{scan:#06x} steht im Vokabular, wird aber von niemandem gesendet"
            );
        }
    }
}
