//! Ob ein Slot überhaupt existieren kann, und ob ein laufender Stream ihn
//! trägt.
//!
//! Ein `slot` benennt **einen der gleichzeitig laufenden Streams des Hosts**
//! (Spezifikation, Abschnitt „Der `slot`"), nicht einen Monitor. Zwei Regeln
//! genügen, um einer eingehenden Fernsteuer-Nachricht ihren Stream
//! zuzuordnen:
//!
//! * Ein Stream, der seinen Platz **nennt**, trägt nur Frames genau dieses
//!   Platzes.
//! * Ein Stream, der ihn **nicht nennt**, trägt jeden Platz — der Regelfall,
//!   solange eine Plattform das Feld nicht mitschickt.
//!
//! Dazu die Schranke [`SLOT_MAX`]: ein Platz jenseits davon ist **unbekannt**,
//! nicht „vom ungenannten Stream getragen". Unbekannt heißt hier immer: still
//! verwerfen, die Sitzung bleibt stehen — die eine Abweichung von fail-closed
//! in der ganzen Fernsteuerung, weil Streams asynchron enden und ein Platz
//! zwischen Absenden und Ankunft verschwinden kann (ein Rennen, kein Angriff).
//! Wie eine Plattform aus dieser Entscheidung ein Ziel macht (welcher Prozess,
//! welches Rechteck), bleibt bei ihr.

/// Höchster Platz, den dieser Sidecar überhaupt für möglich hält (0..=98).
///
/// Dieselbe Schranke wie an drei weiteren Stellen im Repo. Kanonisch steht sie
/// in `shared/src/dcc_shared/streaming.py::MAX_SLOTS`/`SLOT_MAX` (chat-gateway
/// importiert von dort, `_SLOT_MAX` ist dort nur ein Alias); die beiden
/// TypeScript-Clients halten je eine eigene Kopie, weil kein Importpfad nach
/// Python führt: `desktop/electron/sidecar.ts::MAX_STREAM_SLOTS` (99 Plätze,
/// also derselbe Höchstwert 98) und `web/src/lib/stream/state.svelte.ts::MAX_STREAM_SLOTS`
/// (ebenfalls 99). Eine vierte, unabhängige Kopie trägt
/// `web/src/lib/remote/p2p.ts::SLOT_MAX` (98, direkt wie hier). Wird die
/// Schranke an irgendeiner davon bewegt, gehört sie an allen vieren
/// mitgezogen.
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
/// ein Wert jenseits von `u32` wurde hier früher stillschweigend auf
/// `u32::MAX` gekappt — der gekappte Wert lag danach zwar selbst wieder
/// außerhalb der Schranke, aber nur zufällig, und die Kappung hätte einen
/// Platz genau an der `u32`-Grenze unbemerkt verfälscht.
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

    /// Die Schranke gilt auch jenseits von `u32` — dort wurde früher gekappt,
    /// und ein `slot: 5_000_000_000` landete auf dem einen Strom des
    /// Prozesses.
    ///
    /// **Der Wert `5_000_000_000` allein belegt das nicht**, und genau das hat
    /// eine Mutationsprobe gefunden: er überlebt sowohl eine sättigende
    /// Kappung (`min(u32::MAX)`) als auch einen Überlauf (5e9 mod 2³² =
    /// 705 032 704) — beide Ergebnisse liegen weiterhin weit über der
    /// Schranke, richtige und falsche Rechnung sind also nicht zu
    /// unterscheiden. Der Fall, den der Doc-Kommentar von [`im_bereich`]
    /// ausdrücklich nennt, ist ein Platz **genau an der `u32`-Grenze**: er
    /// wrappt auf eine kleine Zahl und käme als gültiger Platz durch.
    #[test]
    fn jenseits_der_schranke_ist_ausserhalb() {
        assert!(im_bereich(0));
        assert!(im_bereich(SLOT_MAX));
        assert!(!im_bereich(SLOT_MAX + 1));
        assert!(!im_bereich(5_000_000_000));
        // Der eigentliche Fall: wrappt auf 50, also mitten in den gültigen
        // Bereich. Ohne echte u64-Prüfung käme hier ein `true` heraus.
        let an_der_grenze = u32::MAX as u64 + 1 + 50;
        assert_eq!(an_der_grenze as u32 as u64, 50, "der Wert wrappt wirklich");
        assert!(!im_bereich(an_der_grenze), "ein gewrappter Platz ist kein Platz");
    }
}
