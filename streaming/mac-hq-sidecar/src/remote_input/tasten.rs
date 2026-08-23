//! Windows-Scancode Satz 1 -> macOS-Virtualcode (`kVK_*`, Carbon
//! `HIToolbox/Events.h`).
//!
//! **Auf der Leitung fahren immer Windows-Scancodes Satz 1** — unabhaengig
//! davon, wer sendet und wer empfaengt (`pulse-fernsteuerung/src/format.rs`,
//! `SATZ1_TASTEN` ist das vollstaendige Vokabular, 104 Eintraege). Der Player
//! erzeugt sie layoutunabhaengig aus der physischen Tastenposition
//! (`pulse-player/src/fernsteuerung/tasten.rs`); dieser Injektor bildet sie
//! auf das ab, was `CGEvent` auf macOS versteht: den Carbon-Virtualcode.
//!
//! **Quelle der `kVK_*`-Werte:** das echte SDK-Header auf dieser Maschine,
//! `/Library/Developer/CommandLineTools/SDKs/MacOSX26.2.sdk/.../HIToolbox.framework/Versions/A/Headers/Events.h`
//! — nicht aus dem Gedaechtnis abgeschrieben.
//!
//! Apples Virtualcodes sind wie die Windows-Scancodes **physische
//! Tastenpositionen auf einer ANSI-Tastatur**, keine Zeichen — dieselbe
//! Layoutunabhaengigkeit wie auf der Sender-Seite bleibt also erhalten.
//!
//! **Vier Grundtasten haben auf dem Mac keine wortgleiche Taste** und sind
//! deshalb ueber die physische Position eines Apple Extended Keyboard II
//! gebildet, nicht geraten:
//! - `Einfg` (`0xE052`) -> `kVK_Help` (`0x72`): auf dem Extended Keyboard sitzt
//!   „Help" exakt dort, wo bei einer PC-Tastatur „Insert" sitzt (uebernommenes
//!   Muster aus Microsoft Remote Desktop / VNC-Clients fuer macOS-Hosts).
//! - `Druck` (`0xE037`) -> `kVK_F13` (`0x69`) und `Rollen` (`0x46`) ->
//!   `kVK_F14` (`0x6B`): auf demselben Keyboard tragen F13/F14/F15 aufgedruckt
//!   „Print Screen"/„Scroll Lock"/„Pause" — dieselbe physische Zuordnung wird
//!   hier fuer die ersten beiden uebernommen (Pause sendet der Player laut
//!   `format.rs` ohnehin nie, s. dort).
//! - `<`/`>` (`IntlBackslash`, `0x56`) -> `kVK_ISO_Section` (`0x0A`): die
//!   Zusatztaste links neben der linken Umschalttaste auf ISO-Tastaturen, auf
//!   dem Mac dieselbe physische Position.
//!
//! Alles andere ist eine wortgleiche Uebersetzung derselben physischen Taste.

/// `None` = nicht abgebildet. Der Aufrufer verwirft die Taste dann still,
/// statt zu raten — ein erfundener Virtualcode kaeme als falsche Taste an.
///
/// Bewusst ein `match` und keine Nachschlagetabelle, aus demselben Grund wie
/// beim Sender (`pulse-player/src/fernsteuerung/tasten.rs`): der Compiler baut
/// eine Sprungtabelle, es gibt nichts zu belegen und nichts zu bauen.
pub fn virtualcode(scan: u16) -> Option<u8> {
    #[rustfmt::skip]
    let vk: u8 = match scan {
        // --- Buchstabenreihe (physische Positionen) ---
        0x1e => 0x00, // A
        0x1f => 0x01, // S
        0x20 => 0x02, // D
        0x21 => 0x03, // F
        0x23 => 0x04, // H
        0x22 => 0x05, // G
        0x2c => 0x06, // Z
        0x2d => 0x07, // X
        0x2e => 0x08, // C
        0x2f => 0x09, // V
        0x30 => 0x0B, // B
        0x10 => 0x0C, // Q
        0x11 => 0x0D, // W
        0x12 => 0x0E, // E
        0x13 => 0x0F, // R
        0x15 => 0x10, // Y
        0x14 => 0x11, // T
        0x16 => 0x20, // U
        0x17 => 0x22, // I
        0x18 => 0x1F, // O
        0x19 => 0x23, // P
        0x24 => 0x26, // J
        0x25 => 0x28, // K
        0x26 => 0x25, // L
        0x32 => 0x2E, // M
        0x31 => 0x2D, // N

        // --- Zifferreihe ---
        0x02 => 0x12, // 1
        0x03 => 0x13, // 2
        0x04 => 0x14, // 3
        0x05 => 0x15, // 4
        0x06 => 0x17, // 5
        0x07 => 0x16, // 6
        0x08 => 0x1A, // 7
        0x09 => 0x1C, // 8
        0x0a => 0x19, // 9
        0x0b => 0x1D, // 0

        // --- Symbole der Hauptreihe ---
        0x0c => 0x1B, // kVK_ANSI_Minus
        0x0d => 0x18, // kVK_ANSI_Equal
        0x29 => 0x32, // kVK_ANSI_Grave
        0x1a => 0x21, // kVK_ANSI_LeftBracket
        0x1b => 0x1E, // kVK_ANSI_RightBracket
        0x2b => 0x2A, // kVK_ANSI_Backslash
        0x27 => 0x29, // kVK_ANSI_Semicolon
        0x28 => 0x27, // kVK_ANSI_Quote
        0x33 => 0x2B, // kVK_ANSI_Comma
        0x34 => 0x2F, // kVK_ANSI_Period
        0x35 => 0x2C, // kVK_ANSI_Slash
        // IntlBackslash: kein ANSI-Gegenstueck, physische ISO-Zusatztaste
        // links neben Shift (s. Modulkopf).
        0x56 => 0x0A, // kVK_ISO_Section

        // --- Steuertasten ---
        0x01 => 0x35, // kVK_Escape
        0x0e => 0x33, // kVK_Delete (macOS' "Delete" = Backspace-Position)
        0x0f => 0x30, // kVK_Tab
        0x1c => 0x24, // kVK_Return
        0x39 => 0x31, // kVK_Space
        0x3a => 0x39, // kVK_CapsLock
        0x2a => 0x38, // kVK_Shift (links)
        0x36 => 0x3C, // kVK_RightShift
        0x1d => 0x3B, // kVK_Control (links)
        0x38 => 0x3A, // kVK_Option (links Alt)

        // --- Rechte Zusatztasten und Windows-/Befehlstasten (alle
        //     erweitert, `0xE0`-Vorsatz) ---
        0xe01d => 0x3E, // rechte Strg-Taste (kVK_RightControl)
        0xe038 => 0x3D, // rechte Alt-Taste (kVK_RightOption)
        0xe05b => 0x37, // linke Windows-/Befehlstaste (kVK_Command)
        0xe05c => 0x36, // rechte Windows-/Befehlstaste (kVK_RightCommand)
        0xe05d => 0x6E, // Kontextmenue-Taste (kVK_ContextualMenu)

        // --- Funktionstasten ---
        0x3b => 0x7A, // F1
        0x3c => 0x78, // F2
        0x3d => 0x63, // F3
        0x3e => 0x76, // F4
        0x3f => 0x60, // F5
        0x40 => 0x61, // F6
        0x41 => 0x62, // F7
        0x42 => 0x64, // F8
        0x43 => 0x65, // F9
        0x44 => 0x6D, // F10
        0x57 => 0x67, // F11
        0x58 => 0x6F, // F12

        // --- Navigationsblock (alle erweitert, `0xE0`-Vorsatz) ---
        0xe047 => 0x73, // Pos1 (kVK_Home)
        0xe04f => 0x77, // Ende (kVK_End)
        0xe049 => 0x74, // Bild hoch (kVK_PageUp)
        0xe051 => 0x79, // Bild runter (kVK_PageDown)
        0xe048 => 0x7E, // Pfeil hoch (kVK_UpArrow)
        0xe050 => 0x7D, // Pfeil runter (kVK_DownArrow)
        0xe04b => 0x7B, // Pfeil links (kVK_LeftArrow)
        0xe04d => 0x7C, // Pfeil rechts (kVK_RightArrow)
        // Einfg: kein ANSI-Gegenstueck, physische Extended-Keyboard-Position
        // (s. Modulkopf).
        0xe052 => 0x72, // Einfg (kVK_Help)
        0xe053 => 0x75, // Entf (kVK_ForwardDelete)

        // --- Ziffernblock ---
        0x45 => 0x47, // kVK_ANSI_KeypadClear (NumLock-Position)
        0xe035 => 0x4B, // Ziffernblock Divide (kVK_ANSI_KeypadDivide)
        0x37 => 0x43, // kVK_ANSI_KeypadMultiply
        0x4a => 0x4E, // kVK_ANSI_KeypadMinus
        0x4e => 0x45, // kVK_ANSI_KeypadPlus
        0xe01c => 0x4C, // Ziffernblock-Enter (kVK_ANSI_KeypadEnter)
        0x53 => 0x41, // kVK_ANSI_KeypadDecimal
        0x52 => 0x52, // kVK_ANSI_Keypad0
        0x4f => 0x53, // kVK_ANSI_Keypad1
        0x50 => 0x54, // kVK_ANSI_Keypad2
        0x51 => 0x55, // kVK_ANSI_Keypad3
        0x4b => 0x56, // kVK_ANSI_Keypad4
        0x4c => 0x57, // kVK_ANSI_Keypad5
        0x4d => 0x58, // kVK_ANSI_Keypad6
        0x47 => 0x59, // kVK_ANSI_Keypad7
        0x48 => 0x5B, // kVK_ANSI_Keypad8
        0x49 => 0x5C, // kVK_ANSI_Keypad9

        // --- Sonstige ---
        // Rollen/Druck: kein ANSI-Gegenstueck, physische Extended-Keyboard-
        // Position (s. Modulkopf).
        0x46 => 0x6B, // Rollen (kVK_F14)
        0xe037 => 0x69, // Druck (kVK_F13)

        _ => return None,
    };
    Some(vk)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Der Pruefstein kommt vom Sender.** Zu jedem Scancode, den ein
    /// Steuernder schicken kann, muss dieser Injektor ein Ziel haben — sonst
    /// verschluckt der Mac stillschweigend Tasten, die auf Windows ankommen.
    #[test]
    fn jeder_gesendete_scancode_hat_ein_ziel() {
        for &scan in pulse_fernsteuerung::format::SATZ1_TASTEN {
            assert!(
                virtualcode(scan).is_some(),
                "{scan:#06x} steht im Vokabular, hat hier aber kein Ziel"
            );
        }
    }

    /// Und keine zwei Scancodes duerfen auf denselben Virtualcode zeigen —
    /// eine Doppelung waere eine Taste, die als eine andere ankommt, und das
    /// faellt beim Lesen nicht auf.
    #[test]
    fn kein_virtualcode_doppelt() {
        let mut gesehen = std::collections::BTreeMap::new();
        for &scan in pulse_fernsteuerung::format::SATZ1_TASTEN {
            let vk = virtualcode(scan).expect("Ziel vorhanden");
            if let Some(anderer) = gesehen.insert(vk, scan) {
                panic!("{vk:#04x} doppelt: {anderer:#06x} und {scan:#06x}");
            }
        }
    }

    /// Stichprobe der drei Faelle, in denen der Mac keine wortgleiche Taste
    /// hat (s. Modulkopf) — damit steht die Begruendung nicht nur im
    /// Kommentar, sondern haelt auch bei einer spaeteren Aenderung.
    #[test]
    fn extended_keyboard_stellvertreter() {
        assert_eq!(virtualcode(0xe052), Some(0x72)); // Einfg -> Help
        assert_eq!(virtualcode(0xe037), Some(0x69)); // Druck -> F13
        assert_eq!(virtualcode(0x46), Some(0x6B)); // Rollen -> F14
        assert_eq!(virtualcode(0x56), Some(0x0A)); // IntlBackslash -> ISO_Section
    }

    /// Layoutunabhaengigkeit bleibt erhalten: Y und Z sind auf einer
    /// deutschen Tastatur vertauscht, die Scancodes (und damit das Ziel) nicht
    /// — derselbe Beleg wie in der Sender-Tabelle.
    #[test]
    fn buchstaben_bleiben_positionstreu() {
        assert_eq!(virtualcode(0x15), Some(0x10)); // Y-Position -> kVK_ANSI_Y
        assert_eq!(virtualcode(0x2c), Some(0x06)); // Z-Position -> kVK_ANSI_Z
    }

    /// Ein unbekannter Scancode wird nicht geraten.
    #[test]
    fn unbekanntes_wird_nicht_geraten() {
        assert_eq!(virtualcode(0x0000), None);
        assert_eq!(virtualcode(0xffff), None);
        // 0xE11D ist der Pause-Praefix-Sonderfall, den `format::scancode_gueltig`
        // schon ausschliesst — dieser Injektor bildet ihn ebenfalls nicht ab.
        assert_eq!(virtualcode(0xe11d), None);
    }
}
