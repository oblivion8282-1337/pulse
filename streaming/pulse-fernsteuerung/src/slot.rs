//! Ob ein Slot ueberhaupt existieren kann, und ob ein laufender Stream ihn
//! traegt.
//!
//! Ein `slot` benennt **einen der gleichzeitig laufenden Streams des Hosts**
//! (Spezifikation, Abschnitt „Der `slot`"), nicht einen Monitor. Zwei Regeln
//! genuegen, um einer eingehenden Fernsteuer-Nachricht ihren Stream
//! zuzuordnen:
//!
//! * Ein Stream, der seinen Platz **nennt**, traegt nur Frames genau dieses
//!   Platzes.
//! * Ein Stream, der ihn **nicht nennt**, traegt jeden Platz — der Regelfall,
//!   solange eine Plattform das Feld nicht mitschickt.
//!
//! Dazu die Schranke [`SLOT_MAX`]: ein Platz jenseits davon ist **unbekannt**,
//! nicht „vom ungenannten Stream getragen". Unbekannt heisst hier immer: still
//! verwerfen, die Sitzung bleibt stehen — die eine Abweichung von fail-closed
//! in der ganzen Fernsteuerung, weil Streams asynchron enden und ein Platz
//! zwischen Absenden und Ankunft verschwinden kann (ein Rennen, kein Angriff).
//! Wie eine Plattform aus dieser Entscheidung ein Ziel macht (welcher Prozess,
//! welches Rechteck), bleibt bei ihr.

/// Höchster Platz, den dieser Sidecar überhaupt für möglich hält (0..=98).
///
/// Dieselbe Schranke wie `desktop/electron/sidecar.ts::MAX_STREAM_SLOTS` (99
/// Plätze) und `_SLOT_MAX` im chat-gateway — wird sie dort bewegt, gehört sie
/// hier mitgezogen.
///
/// **Wozu die Schranke hier nochmal.** Ohne sie trüge die Regel „ein Stream
/// ohne erklärten Platz trägt jeden Platz" auch ein `slot: 999` — eine Zahl,
/// die es im ganzen System nicht geben kann, landete auf dem einen Stream
/// dieses Prozesses. Ein Platz jenseits der Schranke gilt deshalb als
/// **unbekannt**: still verworfen, Sitzung bleibt stehen. Ausdrücklich **kein**
/// Protokollfehler — sonst genügte ein `slot: 999`, um eine laufende
/// Fernsteuerung abzuwürgen (Spezifikation, „Der `slot`").
pub const SLOT_MAX: u64 = 98;

/// Liegt der Platz innerhalb der Schranke ([`SLOT_MAX`])?
///
/// Nimmt bewusst `u64`, nicht `u32`: das Feld kommt roh von der Leitung, und
/// ein Wert jenseits von `u32` wurde hier frueher stillschweigend auf
/// `u32::MAX` gekappt — der gekappte Wert lag danach zwar selbst wieder
/// ausserhalb der Schranke, aber nur zufaellig, und die Kappung haette einen
/// Platz genau an der `u32`-Grenze unbemerkt verfaelscht.
pub fn im_bereich(slot: u64) -> bool {
    slot <= SLOT_MAX
}

/// Trägt ein Stream mit diesem erklärten Platz den angefragten? Die beiden
/// Regeln aus der Modul-Doku: der erklärte Platz gilt strikt, der ungenannte
/// trägt jeden.
pub fn traegt_slot(erklaert: Option<u32>, angefragt: u64) -> bool {
    erklaert.is_none() || erklaert.map(u64::from) == Some(angefragt)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der erklärte Platz gilt strikt, der ungenannte trägt jeden — die beiden
    /// Regeln aus der Modul-Doku, hier festgehalten.
    #[test]
    fn slot_regeln() {
        assert!(traegt_slot(None, 0));
        assert!(traegt_slot(None, 7));
        assert!(traegt_slot(Some(1), 1));
        assert!(!traegt_slot(Some(1), 0));
    }

    /// Die Schranke gilt auch jenseits von `u32` — hier wurde frueher gekappt,
    /// und ein `slot: 5_000_000_000` landete auf dem einen Strom des
    /// Prozesses.
    #[test]
    fn jenseits_der_schranke_ist_ausserhalb() {
        assert!(im_bereich(0));
        assert!(im_bereich(SLOT_MAX));
        assert!(!im_bereich(SLOT_MAX + 1));
        assert!(!im_bereich(5_000_000_000));
    }
}
