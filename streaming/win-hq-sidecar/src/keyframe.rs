//! Offene Anforderung eines Vollbilds.
//!
//! **Wozu.** Paketverlust ist in der heutigen Kette nicht reparierbar: es gibt
//! keine Nachlieferung, und der Zuschauer wartet nach jeder Luecke bis zum
//! naechsten regulaeren Vollbild. Ueber RTMPS gibt es dafuer gar keinen
//! Rueckkanal — der eigene WHIP-Sendeweg ist der erste Weg, auf dem die
//! Anforderung eines Zuschauers den Encoder ueberhaupt erreicht.
//!
//! Und im Intra-Refresh-Betrieb ist sie nicht nur Reparatur, sondern
//! Voraussetzung: dort hat der Strom nach dem Start KEIN Vollbild mehr, ein
//! neu dazukommender Zuschauer kaeme ohne diese Anforderung gar nicht erst
//! ins Bild.
//!
//! **Warum das hier steht und nicht im Labor**, obwohl heute nur das Labor
//! einen Rueckkanal hat: eingeloest wird die Anforderung vom Encoder, und der
//! steht hier. Ein Merker im Labor waere von `send_avframe` aus nicht
//! erreichbar, ohne die Abhaengigkeit umzudrehen. Wer die Anforderung stellt,
//! bleibt dem Aufrufer ueberlassen — heute der WHIP-Empfaenger des Labors,
//! morgen vielleicht etwas anderes.
//!
//! Ohne Rueckkanal ist das Modul wirkungslos, nicht schaedlich: `take_*`
//! liefert dann immer `false`, und der Encoder bleibt bei seinem regulaeren
//! Vollbild-Abstand.

use std::sync::atomic::{AtomicBool, Ordering};

static ANGEFORDERT: AtomicBool = AtomicBool::new(false);

/// Beim naechsten Bild ein Vollbild erzeugen.
///
/// Mehrere Anforderungen innerhalb eines Bildabstands fallen zu einer
/// zusammen — das ist Absicht: bei mehreren Zuschauern auf schlechter Leitung
/// waere sonst jede einzelne ein volles Intra-Bild, und das zahlt der Sender
/// einmal fuer alle. (Die zweite Bremse sitzt server-seitig im
/// MediaMTX-Patch 0002: hoechstens eine Anforderung je 300 ms.)
pub fn request_keyframe() {
    ANGEFORDERT.store(true, Ordering::Relaxed);
}

/// Anforderung abholen und loeschen — genau ein Vollbild je Anforderung.
///
/// **Muss pro Bild aufgerufen werden, auch wenn nichts anliegt.** Der Encoder
/// setzt daraus `pict_type`; bliebe der Merker stehen, waere JEDES folgende
/// Bild ein Vollbild und bei fester Bitrate braeche die Bildqualitaet
/// zusammen. Genau diese Falle steht im Linux-Labor am Aufrufort beschrieben.
pub fn take_keyframe_request() -> bool {
    // Erst lesen, nur bei Bedarf schreiben. Der Merker wird je Bild abgefragt
    // und liegt fast immer auf `false`; ein bedingungsloses `swap` schriebe
    // dabei jedes Mal auf eine geteilte Cache-Zeile, ohne dass sich etwas
    // aendert.
    ANGEFORDERT.load(Ordering::Relaxed) && ANGEFORDERT.swap(false, Ordering::Relaxed)
}

/// Der Bild-Typ, der aus einer Anforderung folgt — samt gedrosseltem Protokoll.
///
/// **Ein Encoder je Instanz.** Steht hier und nicht bei einem der Encoder, weil
/// es sonst je Encode-Weg eine eigene Fassung gäbe: der Regelweg hatte sie, der
/// Vulkan-Weg des Labors nicht, und damit fehlte ausgerechnet dort die Zahl,
/// die den Rückkanal messbar macht — „wie viele Anforderungen kamen an" gegen
/// „wie viele wurden eingelöst". Ein Weg ohne diese Zeile beantwortet die Frage
/// nicht, für die es ihn gibt.
#[derive(Default)]
pub struct Anforderungen {
    gezaehlt: u64,
}

impl Anforderungen {
    /// Einmal je Bild rufen, auch wenn nichts anliegt (s.
    /// [`take_keyframe_request`]). `true` = dieses Bild muss ein Vollbild
    /// werden.
    pub fn naechstes_bild(&mut self, pts: i64) -> bool {
        if !take_keyframe_request() {
            return false;
        }
        self.gezaehlt += 1;
        // **Die ersten zehn einzeln, danach jede zwanzigste.**
        //
        // Beide Enden haben einen Grund. Eine Messung dauert Sekunden und
        // braucht jede Anforderung einzeln — sonst lässt sich „empfangen" nicht
        // gegen „eingelöst" halten, und genau diese Gegenüberstellung ist der
        // Rückkanal-Nachweis. Der Dauerbetrieb dagegen ist kein Einzelfall:
        // MediaMTX fordert in der Lagerfassung von jedem WebRTC-Sender alle
        // zwei Sekunden eines an (gemessen 2026-08-02: 7 in 18 s), Zuschauer
        // kommen obendrauf. Eine Zeile je Anforderung wäre über Stunden ein
        // Dauertropfen — und ein Log, das im gesunden Fall mitläuft, erzieht
        // dazu, es zu überlesen.
        let n = self.gezaehlt;
        if n <= 10 || n.is_multiple_of(20) {
            eprintln!("[encode] Vollbild auf Anforderung (pts={pts}, insgesamt {n})");
        }
        true
    }
}

/// Beim Start eines Streams aufrufen.
///
/// Eine Anforderung, die nach dem letzten Bild des vorigen Streams eintrifft,
/// bliebe sonst liegen und kostete den naechsten gleich zu Beginn ein
/// ueberfluessiges Vollbild — bei fester Bitrate ausgerechnet dort, wo der
/// Zuschauer gerade einsteigt.
pub fn reset() {
    ANGEFORDERT.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn genau_ein_vollbild_je_anforderung() {
        // Ausgangszustand ist "nichts angefordert".
        assert!(!take_keyframe_request());
        request_keyframe();
        assert!(take_keyframe_request(), "die Anforderung muss ankommen");
        assert!(
            !take_keyframe_request(),
            "sie darf nicht kleben bleiben — sonst wird jedes Bild ein Vollbild"
        );
    }

    #[test]
    fn mehrfache_anforderung_faellt_zu_einer_zusammen() {
        request_keyframe();
        request_keyframe();
        request_keyframe();
        assert!(take_keyframe_request());
        assert!(!take_keyframe_request(), "drei Anforderungen, ein Vollbild");
    }
}
