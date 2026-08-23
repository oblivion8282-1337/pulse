//! Virtualcode (macOS `kVK_*`) -> Scancode Satz 1 — die Rueckrichtung der
//! Tabelle, die der Sidecar fuer die Injektion benutzt.
//!
//! ## Warum das Messmittel eine EIGENE Tabelle hat
//!
//! Die naheliegende Abkuerzung waere, `mac_hq_sidecar::remote_input::tasten` zu
//! benutzen und rueckwaerts zu suchen. Dann prueft der Nachweis die Tabelle
//! gegen sich selbst: ein vertauschtes Paar (Y/Z, Klammer auf/zu) faellt nicht
//! auf, weil Hin- und Rueckweg denselben Fehler machen und sich aufheben.
//! Dieselbe Ueberlegung steht im Windows-Pruefziel — es liest den Scancode roh
//! aus der Windows-Nachricht, statt ihn ueber `MapVirtualKey` zurueckzurechnen,
//! und genau daran ist dort einmal eine rechte Strg-Taste als linke
//! durchgerutscht.
//!
//! Diese Tabelle ist deshalb aus zwei fremden Quellen geschrieben: Carbon
//! `HIToolbox/Events.h` fuer die `kVK_*`-Werte und die uebliche
//! AT-Satz-1-Belegung fuer die Scancodes.
//!
//! **Drei Eintraege sind NICHT unabhaengig**, und das gehoert dazugesagt:
//! `0x46` (Rollen), `0xE037` (Druck) und `0xE05D` (Kontextmenue) haben auf einer
//! Mac-Tastatur kein Gegenstueck aus erster Hand — dort ist die Gleichsetzung
//! (F14, F13, `kVK_ContextualMenu`) aus dem Sidecar uebernommen. Fuer diese drei
//! kann dieses Messmittel keinen unabhaengigen Beleg liefern.
//!
//! Was gar kein Satz-1-Gegenstueck hat (Fn, F16-F20, Lautstaerke, die
//! JIS-Tasten, Ziffernblock-Gleich), liefert `None` — und wird im Protokoll als
//! `null` gemeldet, nicht geraten.

/// `None` heisst: dieser Virtualcode hat keine Entsprechung in Satz 1.
pub fn scancode(vk: u16) -> Option<u16> {
    Some(match vk {
        // --- Buchstaben (ANSI-Lage) ---
        0x00 => 0x1e, // A
        0x01 => 0x1f, // S
        0x02 => 0x20, // D
        0x03 => 0x21, // F
        0x04 => 0x23, // H
        0x05 => 0x22, // G
        0x06 => 0x2c, // Z
        0x07 => 0x2d, // X
        0x08 => 0x2e, // C
        0x09 => 0x2f, // V
        0x0b => 0x30, // B
        0x0c => 0x10, // Q
        0x0d => 0x11, // W
        0x0e => 0x12, // E
        0x0f => 0x13, // R
        0x10 => 0x15, // Y
        0x11 => 0x14, // T
        0x1f => 0x18, // O
        0x20 => 0x16, // U
        0x22 => 0x17, // I
        0x23 => 0x19, // P
        0x25 => 0x26, // L
        0x26 => 0x24, // J
        0x28 => 0x25, // K
        0x2d => 0x31, // N
        0x2e => 0x32, // M

        // --- Ziffernreihe und ihre Nachbarn ---
        0x12 => 0x02, // 1
        0x13 => 0x03, // 2
        0x14 => 0x04, // 3
        0x15 => 0x05, // 4
        0x16 => 0x07, // 6   (kVK_ANSI_6 liegt VOR der 5 -- kein Tippfehler)
        0x17 => 0x06, // 5
        0x18 => 0x0d, // =
        0x19 => 0x0a, // 9
        0x1a => 0x08, // 7
        0x1b => 0x0c, // -
        0x1c => 0x09, // 8
        0x1d => 0x0b, // 0
        0x1e => 0x1b, // ]
        0x21 => 0x1a, // [
        0x27 => 0x28, // '
        0x29 => 0x27, // ;
        0x2a => 0x2b, // \
        0x2b => 0x33, // ,
        0x2c => 0x35, // /
        0x2f => 0x34, // .
        0x32 => 0x29, // ` (Akzent)
        0x0a => 0x56, // kVK_ISO_Section -- die Zusatztaste neben der linken Umschalttaste

        // --- Steuertasten ---
        0x24 => 0x1c, // Eingabe
        0x30 => 0x0f, // Tabulator
        0x31 => 0x39, // Leertaste
        0x33 => 0x0e, // Ruecktaste (macOS nennt sie "Delete")
        0x35 => 0x01, // Esc

        // --- Umschalttasten, links und rechts getrennt ---
        0x38 => 0x2a,   // Umschalt links
        0x3c => 0x36,   // Umschalt rechts
        0x3b => 0x1d,   // Strg links
        0x3e => 0xe01d, // Strg rechts
        0x3a => 0x38,   // Alt/Option links
        0x3d => 0xe038, // Alt/Option rechts
        0x37 => 0xe05b, // Befehl links  (Windows-Taste)
        0x36 => 0xe05c, // Befehl rechts (Windows-Taste)
        0x39 => 0x3a,   // Feststelltaste

        // --- Funktionstasten ---
        0x7a => 0x3b, // F1
        0x78 => 0x3c, // F2
        0x63 => 0x3d, // F3
        0x76 => 0x3e, // F4
        0x60 => 0x3f, // F5
        0x61 => 0x40, // F6
        0x62 => 0x41, // F7
        0x64 => 0x42, // F8
        0x65 => 0x43, // F9
        0x6d => 0x44, // F10
        0x67 => 0x57, // F11
        0x6f => 0x58, // F12

        // --- Navigationsblock (in Satz 1 durchweg erweitert) ---
        0x73 => 0xe047, // Pos1
        0x7e => 0xe048, // Pfeil hoch
        0x74 => 0xe049, // Bild hoch
        0x7b => 0xe04b, // Pfeil links
        0x7c => 0xe04d, // Pfeil rechts
        0x77 => 0xe04f, // Ende
        0x7d => 0xe050, // Pfeil runter
        0x79 => 0xe051, // Bild runter
        0x72 => 0xe052, // Einfg (macOS: kVK_Help)
        0x75 => 0xe053, // Entf  (macOS: kVK_ForwardDelete)

        // --- Ziffernblock ---
        0x52 => 0x52,   // 0
        0x53 => 0x4f,   // 1
        0x54 => 0x50,   // 2
        0x55 => 0x51,   // 3
        0x56 => 0x4b,   // 4
        0x57 => 0x4c,   // 5
        0x58 => 0x4d,   // 6
        0x59 => 0x47,   // 7
        0x5b => 0x48,   // 8
        0x5c => 0x49,   // 9
        0x41 => 0x53,   // Komma/Punkt
        0x43 => 0x37,   // *
        0x45 => 0x4e,   // +
        0x4e => 0x4a,   // -
        0x4b => 0xe035, // /
        0x4c => 0xe01c, // Eingabe
        0x47 => 0x45,   // kVK_ANSI_KeypadClear sitzt auf der NumLock-Stelle

        // --- Die drei Gleichsetzungen aus zweiter Hand (s. Modulkopf) ---
        0x6b => 0x46,   // F14 auf der Rollen-Stelle
        0x69 => 0xe037, // F13 auf der Druck-Stelle
        0x6e => 0xe05d, // kVK_ContextualMenu

        _ => return None,
    })
}

/// Die geraetebezogene Kennzeichnung, an der sich bei einem `FlagsChanged`
/// ablesen laesst, ob die Taste gedrueckt oder losgelassen wurde.
///
/// **Warum nicht die gewoehnlichen `NSEventModifierFlag*`-Bits:** die sagen nur
/// „irgendeine Umschalttaste", nicht welche. Genau der Unterschied zwischen
/// linker und rechter Strg-Taste ist aber der Fall, an dem ein Messmittel
/// luegt — im Windows-Labor ist daran am 2026-08-12 eine gesendete rechte
/// Strg-Taste als linke im Protokoll gelandet, und der Fehler sah wie einer des
/// Injektors aus. Die geraetebezogenen Bits (`NX_DEVICE*`) trennen beide.
pub fn geraetebit(vk: u16) -> Option<u64> {
    Some(match vk {
        0x3b => 0x0000_0001, // Strg links
        0x38 => 0x0000_0002, // Umschalt links
        0x3c => 0x0000_0004, // Umschalt rechts
        0x37 => 0x0000_0008, // Befehl links
        0x36 => 0x0000_0010, // Befehl rechts
        0x3a => 0x0000_0020, // Alt links
        0x3d => 0x0000_0040, // Alt rechts
        0x3e => 0x0000_2000, // Strg rechts
        0x39 => 0x0001_0000, // Feststelltaste (nur als Zustand, kein Geraetebit)
        0x3f => 0x0080_0000, // Fn
        _ => return None,
    })
}

/// Die gewoehnliche, seitenblinde Kennzeichnung einer Umschalttaste.
///
/// Rueckfall fuer [`geraetebit`]: ob macOS die geraetebezogenen Bits auch bei
/// **injizierten** Umschalttasten fuellt, ist nicht gemessen. Fehlen sie, bleibt
/// wenigstens diese Auskunft — dann ohne Seitenangabe.
pub fn sammelbit(vk: u16) -> Option<u64> {
    Some(match vk {
        0x38 | 0x3c => 0x0002_0000, // Umschalt
        0x3b | 0x3e => 0x0004_0000, // Strg
        0x3a | 0x3d => 0x0008_0000, // Alt/Option
        0x36 | 0x37 => 0x0010_0000, // Befehl
        0x39 => 0x0001_0000,        // Feststelltaste
        0x3f => 0x0080_0000,        // Fn
        _ => return None,
    })
}

/// Der Virtualcode zu einem Scancode — die Umkehrung von [`scancode`].
///
/// **Nur fuer die Selbstprobe** ([`crate::eigenfahrt`]), die ihre eigenen
/// Ereignisse erzeugt. Ein Nachweis am Sidecar benutzt sie nicht: dort kommt
/// der Virtualcode aus der Tabelle des Sidecars, und das Messmittel darf ihn
/// nicht mit derselben Rechnung zurueckuebersetzen, mit der er entstanden ist.
pub fn virtualcode(scan: u16) -> Option<u16> {
    (0..=0xffu16).find(|&vk| scancode(vk) == Some(scan))
}

/// Gedrueckt oder losgelassen? — fuer ein `FlagsChanged`, das das nicht sagt.
///
/// **Gemessen am 2026-08-23** (erster Lauf dieses Pruefziels, Selbstprobe):
/// eine injizierte rechte Strg-Taste kommt mit `modifierFlags == 0x40000` an —
/// dem **seitenblinden** Sammelbit. Das geraetebezogene Bit (`0x2000`) fehlt;
/// macOS fuellt es fuer injizierte Ereignisse nicht. Und schlimmer: der Sender
/// stempelt seine Kennzeichnung auf das Runter- **und** das Hoch-Ereignis (so
/// macht es der Sidecar, s. Nachtrag 1 der Messakte) — aus der Kennzeichnung
/// allein waeren beide „gedrueckt".
///
/// Deshalb zwei Wege, in dieser Reihenfolge:
///
/// 1. Ist das **geraetebezogene** Bit gesetzt, ist es ein Runter. Das ist der
///    Fall an einer echten Tastatur, und dort ist es die genauere Auskunft.
/// 2. Sonst wird umgeschaltet: was noch nicht gehalten wird, geht runter; was
///    gehalten wird, geht hoch.
///
/// Der zweite Weg traegt beide Faelle — auch an echter Tastatur, wo beim
/// Loslassen das Geraetebit fehlt und der Umschalt-Weg richtig „hoch" liefert.
pub fn umschalt_runter(gehalten: &std::collections::BTreeSet<u16>, vk: u16, flags: u64) -> bool {
    match geraetebit(vk) {
        Some(bit) if flags & bit != 0 => true,
        _ => !gehalten.contains(&vk),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    /// Kein Virtualcode darf auf denselben Scancode zeigen wie ein anderer —
    /// eine Doppelung waere eine Taste, die im Protokoll als eine andere
    /// erscheint, und das faellt beim Lesen nicht auf.
    #[test]
    fn kein_scancode_doppelt() {
        let mut gesehen: BTreeMap<u16, u16> = BTreeMap::new();
        for vk in 0..=0xffu16 {
            if let Some(scan) = scancode(vk)
                && let Some(anderer) = gesehen.insert(scan, vk)
            {
                panic!("Scancode {scan:#06x} doppelt: vk {anderer:#04x} und vk {vk:#04x}");
            }
        }
    }

    /// **Der Pruefstein kommt vom Sender**, wie in der Tastentabelle des
    /// Sidecars: jeder Scancode, den dieses Messmittel meldet, muss im
    /// Vokabular stehen, das ein Steuernder ueberhaupt schicken darf. Ein
    /// erfundener Scancode wuerde einen Lauf durchfallen lassen, ohne dass am
    /// Injektor etwas falsch waere.
    #[test]
    fn jeder_gemeldete_scancode_steht_im_vokabular() {
        for vk in 0..=0xffu16 {
            if let Some(scan) = scancode(vk) {
                assert!(
                    pulse_fernsteuerung::format::SATZ1_TASTEN.contains(&scan),
                    "vk {vk:#04x} meldet {scan:#06x}, das kein Sender schicken kann"
                );
            }
        }
    }

    /// Die Umkehrung: was ein Sender schicken darf, muss dieses Messmittel auch
    /// benennen koennen. Ausgenommen sind genau die Tasten, die eine
    /// Mac-Tastatur nicht hat — und die stehen hier namentlich, damit ein
    /// spaeterer Zuwachs auffaellt statt stillschweigend durchzurutschen.
    #[test]
    fn das_vokabular_ist_bis_auf_die_benannten_luecken_abgedeckt() {
        let ohne_mac_taste: &[u16] = &[
            0x54, // SysRq
            0x59, // Ziffernblock =
        ];
        let rueckwaerts: BTreeMap<u16, u16> = (0..=0xffu16)
            .filter_map(|vk| scancode(vk).map(|s| (s, vk)))
            .collect();
        let fehlend: Vec<u16> = pulse_fernsteuerung::format::SATZ1_TASTEN
            .iter()
            .copied()
            .filter(|s| !rueckwaerts.contains_key(s) && !ohne_mac_taste.contains(s))
            .collect();
        assert!(fehlend.is_empty(), "unbenennbare Scancodes: {fehlend:04x?}");
    }

    /// Die Paare, an denen eine vertauschte Tabelle auffaellt: `kVK_ANSI_6`
    /// liegt vor der 5, Y und Z sind auf der deutschen Tastatur vertauscht, und
    /// die eckigen Klammern liegen ueber Kreuz.
    #[test]
    fn die_kreuzweisen_paare_stimmen() {
        assert_eq!(scancode(0x16), Some(0x07), "kVK_ANSI_6");
        assert_eq!(scancode(0x17), Some(0x06), "kVK_ANSI_5");
        assert_eq!(scancode(0x10), Some(0x15), "kVK_ANSI_Y");
        assert_eq!(scancode(0x06), Some(0x2c), "kVK_ANSI_Z");
        assert_eq!(scancode(0x21), Some(0x1a), "kVK_ANSI_LeftBracket");
        assert_eq!(scancode(0x1e), Some(0x1b), "kVK_ANSI_RightBracket");
    }

    /// Links und rechts bleiben getrennt — auf beiden Seiten der Abbildung.
    #[test]
    fn links_und_rechts_bleiben_getrennt() {
        assert_eq!(scancode(0x3b), Some(0x1d), "Strg links");
        assert_eq!(scancode(0x3e), Some(0xe01d), "Strg rechts");
        assert_ne!(scancode(0x38), scancode(0x3c), "Umschalt links/rechts");
        assert_ne!(geraetebit(0x3b), geraetebit(0x3e), "Strg links/rechts");
        assert_ne!(geraetebit(0x38), geraetebit(0x3c), "Umschalt links/rechts");
    }

    /// Was kein Satz-1-Gegenstueck hat, wird nicht geraten.
    #[test]
    fn unbekanntes_wird_nicht_geraten() {
        assert_eq!(scancode(0x3f), None, "Fn");
        assert_eq!(scancode(0x51), None, "Ziffernblock =");
        assert_eq!(scancode(0x4a), None, "Stumm");
        assert_eq!(scancode(0x5d), None, "JIS Yen");
        assert_eq!(scancode(0xff), None);
    }

    /// Hin und zurueck durch die eigene Tabelle. Haelt die Selbstprobe
    /// ehrlich: schickt sie einen Scancode, kommt derselbe wieder heraus.
    #[test]
    fn hin_und_zurueck_durch_die_eigene_tabelle() {
        for &scan in pulse_fernsteuerung::format::SATZ1_TASTEN {
            if let Some(vk) = virtualcode(scan) {
                assert_eq!(scancode(vk), Some(scan), "{scan:#06x}");
            }
        }
    }

    /// Das Sammelbit kennt keine Seite — genau darin unterscheidet es sich vom
    /// Geraetebit, und genau deshalb ist es nur der Rueckfall.
    #[test]
    fn das_sammelbit_kennt_keine_seite() {
        assert_eq!(sammelbit(0x3b), sammelbit(0x3e), "Strg links/rechts");
        assert_eq!(sammelbit(0x38), sammelbit(0x3c), "Umschalt links/rechts");
        assert_ne!(sammelbit(0x3b), sammelbit(0x38), "Strg gegen Umschalt");
        assert_eq!(sammelbit(0x00), None, "A ist keine Umschalttaste");
    }

    /// **Der gemessene Fall.** Eine injizierte rechte Strg-Taste bringt nur das
    /// seitenblinde Sammelbit mit, und zwar auf beiden Ereignissen. Aus der
    /// Kennzeichnung allein waeren es zwei Runter — der Umschalt-Weg trennt
    /// sie.
    ///
    /// Mutationsprobe: eine Fassung, die nur die Kennzeichnung befragt
    /// (`flags & sammelbit != 0`), liefert hier zweimal `true` und faellt.
    #[test]
    fn zwei_gleiche_kennzeichnungen_sind_runter_und_hoch() {
        let mut gehalten = BTreeSet::new();
        const RSTRG: u16 = 0x3e;
        const NUR_SAMMELBIT: u64 = 0x0004_0000;

        assert!(umschalt_runter(&gehalten, RSTRG, NUR_SAMMELBIT), "erstes Mal: runter");
        gehalten.insert(RSTRG);
        assert!(!umschalt_runter(&gehalten, RSTRG, NUR_SAMMELBIT), "zweites Mal: hoch");
    }

    /// An echter Tastatur ist das Geraetebit da und sticht — es sagt zugleich,
    /// welche Seite es war.
    #[test]
    fn das_geraetebit_sticht() {
        let gehalten = BTreeSet::new();
        assert!(umschalt_runter(&gehalten, 0x3e, 0x0004_2000), "Strg rechts mit Geraetebit");
        let mut gehalten = BTreeSet::new();
        gehalten.insert(0x3eu16);
        // Beim Loslassen faellt das Geraetebit weg -> Umschalt-Weg -> hoch.
        assert!(!umschalt_runter(&gehalten, 0x3e, 0x0000_0000));
    }

    /// Eine gewoehnliche Taste kommt hier gar nicht vor (sie hat `KeyDown`/
    /// `KeyUp`); faellt sie doch herein, gilt der Umschalt-Weg.
    #[test]
    fn ohne_geraetebit_gilt_der_umschalt_weg() {
        let gehalten = BTreeSet::new();
        assert!(umschalt_runter(&gehalten, 0x00, 0));
    }
}
