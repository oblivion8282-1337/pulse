//! Was die **Sitzung** aus einer Regung des Hosts macht.
//!
//! Getrennt von [`super::wache`], weil das zwei verschiedene Fragen sind: die
//! Wache beantwortet „sitzt der Host gerade selbst an Maus und Tastatur?" und
//! kennt dafür nur Windows; hier steht, was daraus für die laufende
//! Eingabe-Sitzung folgt — und das kennt nur den [`Zustand`].
//!
//! Die Zusage selbst steht im Modulkopf von [`super`]: der Host behält sein
//! Gerät, indem er es anfasst. Die Fremdeingabe wird dann verworfen (über
//! denselben Pfad wie Sichtschutz und unbekannter Slot, `super::nur_handschlag`),
//! die Sitzung bleibt aber stehen — es ist ein Stummschalten, kein Abbruch.

use super::{Sitzung, Zustand, wache};

/// Den Vorrang des Hosts nachführen. Liefert, ob er **jetzt** gilt.
///
/// Die ganze Zustandsänderung liegt an einer Stelle, weil an jedem Übergang
/// mehr hängt als ein Merker:
///
/// * *Vorrang beginnt:* alles Gedrückte des Steuernden freigeben — sonst hält
///   der Host seine eigene Maus, während dessen W-Taste weiterläuft. Und die
///   gemerkte Zeigerlage entwerten: der Host bewegt seinen Zeiger jetzt selbst,
///   ein Klick auf der alten Lage wäre ein Klick ins Blaue (dieselbe Regel wie
///   bei einer verworfenen Bewegung, s. [`super::ausfuehrung`]).
/// * *Vorrang beginnt:* der Host-Cursor gehört zurück ins Bild. Er war für das
///   Cursor-Echo womöglich ausgeblendet — wer selbst steuert, muss seinen
///   Zeiger sehen, und die Zuschauer sollen sehen, was er tut.
/// * *Beide Richtungen:* eine Meldung nach vorn. Ohne sie sieht der Vorrang
///   beim Steuernden aus wie ein Verbindungsabbruch, und sein Client erfährt
///   nicht, wann er das Gehaltene nachziehen muss (`web/src/lib/remote/vorrang.ts`).
///
/// Gebunden an den **Wechsel**, nicht an den Zustand: bei bis zu 125 Nachrichten
/// je Sekunde wäre alles andere ein Strom aus Freigaben, WinRT-Aufrufen und
/// Meldungen.
pub(super) fn nachfuehren(z: &mut Zustand) -> bool {
    let jetzt = wache::host_regt_sich();
    if z.vorrang == jetzt {
        return jetzt;
    }
    z.vorrang = jetzt;
    if jetzt {
        z.druck.loslassen();
        z.zeiger = None;
        crate::capture::cursorsteuerung::zeigen();
    }
    eprintln!(
        "[remote-input] Vorrang des Hosts {}",
        if jetzt { "beginnt — Fremdeingabe wird verworfen" } else { "endet" }
    );
    crate::events::emit(serde_json::json!({
        "ev": "remote_state",
        "state": if jetzt { "host_active" } else { "live" },
        // Wie lange der Vorrang noch gilt — damit der Steuernde „noch 4 s"
        // sehen kann statt nur „gesperrt".
        "hold_ms": wache::rest_ms(),
    }));
    jetzt
}

/// Der Wecker der Wache (alle 100 ms, aus ihrem eigenen Faden).
///
/// **Warum es diesen Weg überhaupt gibt.** Der Vorrang ENDET von selbst, wenn
/// der Host Ruhe gibt — es kommt kein Ereignis, das ihn beendet. Hinge das Ende
/// allein an der nächsten Eingabe-Nachricht, erführe ein Steuernder, der gerade
/// nur eine Taste hält und nichts sendet, nie davon: seine Taste bliebe tot, bis
/// er zufällig die Maus bewegt.
///
/// **`try_lock` und nicht `lock`:** der Wache-Faden darf niemals auf die
/// Sitzungssperre warten. Er trägt den Hook-Rückruf, und ein Hook, der zu lange
/// braucht, wird von Windows stillschweigend entfernt. Ein übersprungener
/// Wecker kostet 100 ms Verzug, ein hängender Faden die ganze Wache. Eine
/// **vergiftete** Sperre wird dagegen übernommen — aus demselben Grund wie in
/// [`Sitzung::sperre`].
pub(super) fn tick() {
    let mut z = match Sitzung::singleton().inner.try_lock() {
        Ok(z) => z,
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return,
    };
    nachfuehren(&mut z);
}
