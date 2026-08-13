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

use std::sync::atomic::{AtomicU64, Ordering};

use super::{Sitzung, Zustand, wache};

/// Wie oft ein geltender Vorrang **wiederholt** gemeldet wird, gezählt in
/// Weckern à 100 ms (`wache::WECKER_MS`) — also einmal je Sekunde.
///
/// **Warum überhaupt wiederholt** (Bughunt 2026-08-14): die Meldung fährt über
/// den `remote_signal`-Weiterleiter des Gateways, und der verwirft über seinem
/// Sekundendeckel **still**. Geht ausgerechnet das „Vorrang beginnt" verloren,
/// bleibt der Steuernde bei „kein Vorrang" — und die spätere Ende-Meldung
/// fällt bei ihm in die Flankenprüfung und wird verschluckt. Dann zieht er
/// sein Gehaltenes nicht nach, und die W-Taste bleibt tot, obwohl der Finger
/// darauf liegt. Eine Wiederholung je Sekunde repariert das binnen einer
/// Sekunde und kostet gegen den 60/s-Deckel nichts.
///
/// **Warum hier und nicht im Renderer:** Chromium drosselt Zeitgeber in
/// verdeckten Fenstern auf höchstens einen Lauf je Minute, und der Host spielt
/// typischerweise im Vollbild (dieselbe Falle, an der die Verbindungswacht
/// schon einmal hing, s. `web/src/lib/remote/wachten.ts`). Dieser Faden ist
/// nativ und wird von niemandem gedrosselt.
const WIEDERHOLUNG_TAKTE: u64 = 10;

/// Wecker seit der letzten Meldung (s. [`WIEDERHOLUNG_TAKTE`]).
static SEIT_MELDUNG: AtomicU64 = AtomicU64::new(0);

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
    melden(jetzt);
    jetzt
}

/// Den Zustand nach vorn melden. Der Renderer reicht ihn an den Steuernden
/// weiter (`web/src/lib/remote/vorrang.ts`).
fn melden(gilt: bool) {
    SEIT_MELDUNG.store(0, Ordering::Relaxed);
    crate::events::emit(serde_json::json!({
        "ev": "remote_state",
        "state": if gilt { "host_active" } else { "live" },
        // Wie lange der Vorrang noch gilt — damit der Steuernde „noch 4 s"
        // sehen kann statt nur „gesperrt". Zugleich die Verfallszeit, an der
        // der Host-Renderer einen Platz aussortiert, dessen Sidecar
        // verschwunden ist (s. `vorrang.ts`).
        "hold_ms": wache::rest_ms(),
    }));
}

/// Der Wecker der Wache (alle 100 ms, aus ihrem eigenen Faden).
///
/// **Warum es diesen Weg überhaupt gibt.** Der Vorrang ENDET von selbst, wenn
/// der Host Ruhe gibt — es kommt kein Ereignis, das ihn beendet. Hinge das Ende
/// allein an der nächsten Eingabe-Nachricht, erführe ein Steuernder, der gerade
/// nur eine Taste hält und nichts sendet, nie davon: seine Taste bliebe tot, bis
/// er zufällig die Maus bewegt.
///
/// **`try_lock` und nicht `lock`:** der Wecker läuft blind, ohne Anlass und
/// alle 100 ms. Wartete er auf die Sitzungssperre, stauten sich unter Last
/// Wecker hinter einer Nachricht, die gerade injiziert — und feuerten danach
/// alle hintereinander los. Ein übersprungener Wecker kostet dagegen 100 ms
/// Verzug, und der nächste holt ihn ein; nachzuführen gibt es nichts, denn er
/// liest einen Zustand und keine Ereignisfolge. (Den Hook-Rückruf trägt er
/// **nicht** — dafür gibt es den zweiten Faden, s. [`wache::wecker_starten`].)
/// Eine **vergiftete** Sperre wird dagegen übernommen — aus demselben Grund wie
/// in [`Sitzung::sperre`].
pub(super) fn tick() {
    let gilt = {
        let mut z = match Sitzung::singleton().inner.try_lock() {
            Ok(z) => z,
            Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return,
        };
        nachfuehren(&mut z)
    };
    // Die Wiederholung läuft OHNE die Sitzungssperre — sie liest nichts aus
    // dem Zustand, und `emit` reiht nur ein.
    if !gilt {
        return;
    }
    if SEIT_MELDUNG.fetch_add(1, Ordering::Relaxed) + 1 >= WIEDERHOLUNG_TAKTE {
        melden(true);
    }
}
