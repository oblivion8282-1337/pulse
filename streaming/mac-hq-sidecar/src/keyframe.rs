//! Offene Anforderung eines Vollbilds.
//!
//! **Wozu.** Paketverlust ist in der heutigen Kette nicht reparierbar: es gibt
//! keine Nachlieferung, und der Zuschauer wartet nach jeder Luecke bis zum
//! naechsten regulaeren Vollbild. Ueber RTMPS gibt es dafuer gar keinen
//! Rueckkanal — der eigene WHIP-Sendeweg (`whip::mod`) ist der erste Weg, auf
//! dem die Anforderung eines Zuschauers den Encoder ueberhaupt erreicht.
//!
//! Und im Intra-Refresh-Betrieb (Aufgabe 3, noch aussenvor) ist sie nicht nur
//! Reparatur, sondern Voraussetzung: dort hat der Strom nach dem Start KEIN
//! Vollbild mehr, ein neu dazukommender Zuschauer kaeme ohne diese Anforderung
//! gar nicht erst ins Bild.
//!
//! **Warum das hier steht und nicht im WHIP-Modul**: eingeloest wird die
//! Anforderung vom Encoder (`crate::encode`), der `take_keyframe_request()` je
//! Bild abfragt. Ein Merker im WHIP-Modul waere von dort aus nicht erreichbar,
//! ohne die Abhaengigkeit umzudrehen. Wer die Anforderung stellt, bleibt dem
//! Aufrufer ueberlassen — heute der WHIP-Empfaenger, morgen vielleicht etwas
//! anderes.
//!
//! Ohne Rueckkanal ist das Modul wirkungslos, nicht schaedlich:
//! `take_keyframe_request` liefert dann immer `false`, und der Encoder bleibt
//! bei seinem regulaeren Vollbild-Abstand.
//!
//! **Zwilling zu `keyframe.rs`/`encode/mod.rs::take_keyframe_request` in den
//! anderen beiden Sidecars** — dort mit einer vollen Rueckstaffelung
//! (Windows) bzw. einer festen Sperrfrist (Linux). Hier absichtlich nur die
//! Sperrfrist: macOS hat noch keinen gemessenen PLI-Sturm, der eine Treppe
//! rechtfertigt, und eine ungenutzte Stufenlogik waere Komplexitaet ohne
//! Gegenwert.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Deckel der Drossel fuer angeforderte Vollbilder.
///
/// Muss [`crate::encode::KEYFRAME_SEKUNDEN_UNBEDENKLICH`] entsprechen — s.
/// Test `deckel_haengt_am_unbedenklichen_abstand`, der die beiden Zahlen
/// zusammenhaelt (Gleitkomma-Rechnung im `const` waere hier der unbequemere
/// Weg). **Bewusst NICHT an der gestreckten Vorgabe** (`keyframe_abstand_sekunden`,
/// 60 s wie auf Linux und Windows, ueber die Umgebung veraenderbar): eine
/// Bremse, die der Vorgabe folgte, verwuerfe eine Anforderung den ganzen
/// Vollbild-Abstand lang — genau der Fehler, der bei den Zwillingen am
/// 2026-08-18 gefunden und behoben wurde.
pub(crate) const DROSSEL_DECKEL: Duration = Duration::from_millis(2_000);

/// Merkt sich die letzte angenommene Anforderung und fasst dichte Folgen zu
/// einer zusammen.
///
/// Nimmt die Zeit als Parameter statt selbst `Instant::now()` zu rufen — so
/// ist sie ohne Warten pruefbar (dasselbe Muster, mit dem
/// `encode::abstand_sekunden_aus` von der Umgebung getrennt wurde).
struct Drossel {
    letzte_angenommen: Mutex<Option<Duration>>,
}

impl Drossel {
    const fn neu() -> Self {
        Self { letzte_angenommen: Mutex::new(None) }
    }

    /// `true` = diese Anforderung wird angenommen (und damit sofort
    /// abgeholt — der Name spiegelt, dass hier kein zweiter Merker noetig
    /// ist: die Drossel selbst ist der Speicher).
    fn anfordern_und_abholen(&self, jetzt: Duration) -> bool {
        // Eine vergiftete Sperre darf den Rueckkanal nicht stilllegen: lieber
        // die Anforderung durchlassen als den Stream fuer alle Zuschauer
        // einfrieren.
        let mut letzte = self.letzte_angenommen.lock().unwrap_or_else(|e| e.into_inner());
        let angenommen = letzte.is_none_or(|t| jetzt.saturating_sub(t) >= DROSSEL_DECKEL);
        if angenommen {
            *letzte = Some(jetzt);
        }
        angenommen
    }
}

static DROSSEL: Drossel = Drossel::neu();
static ANGEFORDERT: AtomicBool = AtomicBool::new(false);

/// Wie viele Anforderungen die Drossel bisher verworfen hat. Nur zum
/// Berichten.
static GEDROSSELT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Zeit seit dem ersten Aufruf — der Prozess-Anfang dient als billige, monotone
/// Uhr fuer die Drossel; der ABSOLUTE Wert ist ohne Belang, nur der Abstand
/// zwischen zwei Aufrufen zaehlt.
fn seit_prozessstart() -> Duration {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed()
}

/// Beim naechsten Bild ein Vollbild erzeugen — sofern die Drossel es zulaesst
/// (s. [`DROSSEL_DECKEL`]). **Die Drossel ist Pflicht:** ohne sie legt ein
/// Zuschauer mit PLI-Sturm den Encoder lahm, weil jede seiner Anforderungen
/// ein volles Intra-Bild kostet und der Strom fuer alle anderen Zuschauer
/// EINER ist.
pub(crate) fn request_keyframe() {
    if DROSSEL.anfordern_und_abholen(seit_prozessstart()) {
        ANGEFORDERT.store(true, Ordering::Relaxed);
    } else {
        let n = GEDROSSELT.fetch_add(1, Ordering::Relaxed) + 1;
        // Die ersten drei einzeln (da faellt die Entscheidung), danach jede
        // fuenfzigste — ein anhaltender Sturm soll sichtbar bleiben, ohne das
        // Log zu fuellen, das er ja gerade erklaeren soll.
        if n <= 3 || n.is_multiple_of(50) {
            eprintln!("[keyframe] Anforderung innerhalb des Deckels verworfen (insgesamt {n})");
        }
    }
}

/// Anforderung abholen und loeschen — genau ein Vollbild je angenommener
/// Anforderung.
///
/// **Muss pro Bild aufgerufen werden, auch wenn nichts anliegt.** Der Encoder
/// setzt daraus `pict_type`; bliebe der Merker stehen, waere JEDES folgende
/// Bild ein Vollbild und bei fester Bitrate braeche die Bildqualitaet
/// zusammen.
pub(crate) fn take_keyframe_request() -> bool {
    // Erst lesen, nur bei Bedarf schreiben. Der Merker wird je Bild abgefragt
    // und liegt fast immer auf `false`; ein bedingungsloses `swap` schriebe
    // dabei jedes Mal auf eine geteilte Cache-Zeile, ohne dass sich etwas
    // aendert.
    ANGEFORDERT.load(Ordering::Relaxed) && ANGEFORDERT.swap(false, Ordering::Relaxed)
}

/// Alles vergessen, was vom vorigen Stream uebrig ist.
///
/// **Warum das noetig ist, und warum es mehr als Kosmetik ist.** Der Zustand
/// dieses Moduls ist prozessweit (`static`), ein Stream-Wechsel raeumt ihn also
/// nicht von selbst ab. Zwei Dinge ueberleben ihn sonst:
///
/// * Der Merker `ANGEFORDERT` — harmlos: das erste Bild eines frisch
///   gestarteten Encoders ist ohnehin ein Vollbild, ein zusaetzlich gesetztes
///   `pict_type` aendert daran nichts.
/// * **Der Drossel-Zeitstempel — nicht harmlos.** Faellt eine echte Anforderung
///   des neuen Streams in den Deckel (s. [`DROSSEL_DECKEL`]) der letzten
///   angenommenen aus dem ALTEN, wird sie stillschweigend verworfen. Der
///   Zuschauer wartet dann bis zum naechsten regulaeren Vollbild — beim
///   heutigen Abstand hoechstens zwei Sekunden, beim gestreckten bis zu einer
///   Minute. Das ist genau der Zustand, gegen den dieses Modul gebaut wurde.
///
/// Zwilling zu `win-hq-sidecar/src/keyframe.rs::reset`, dort aus demselben
/// Grund und an derselben Stelle im Ablauf gerufen.
pub(crate) fn reset() {
    ANGEFORDERT.store(false, Ordering::Relaxed);
    *DROSSEL.letzte_angenommen.lock().unwrap_or_else(|e| e.into_inner()) = None;
    GEDROSSELT.store(0, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Zwei Anforderungen dicht hintereinander duerfen nur EIN Vollbild
    /// ausloesen — sonst legt ein Zuschauer mit PLI-Sturm den Encoder lahm.
    #[test]
    fn drossel_fasst_dichte_anforderungen_zusammen() {
        let d = Drossel::neu();
        assert!(d.anfordern_und_abholen(Duration::ZERO));
        assert!(!d.anfordern_und_abholen(Duration::from_millis(10)));
    }

    /// Nach dem Mindestabstand geht wieder eines durch.
    #[test]
    fn nach_dem_mindestabstand_wieder_erlaubt() {
        let d = Drossel::neu();
        assert!(d.anfordern_und_abholen(Duration::ZERO));
        assert!(d.anfordern_und_abholen(DROSSEL_DECKEL + Duration::from_millis(1)));
    }

    /// Der Deckel darf der gestreckten Vorgabe NICHT folgen: sonst verwirft der
    /// Sender eine Anforderung den ganzen Vollbild-Abstand lang. Gegenstueck zu
    /// `drossel_deckel_entspricht_dem_unbedenklichen_abstand` im Linux-Sidecar.
    #[test]
    fn deckel_haengt_am_unbedenklichen_abstand() {
        assert_eq!(
            DROSSEL_DECKEL.as_secs_f32(),
            crate::encode::KEYFRAME_SEKUNDEN_UNBEDENKLICH
        );
    }

    /// Merker UND Drossel sind prozessweit — Tests, die beides anfassen,
    /// wuerden sich sonst gegenseitig die Zustaende umschreiben.
    static SERIELL: Mutex<()> = Mutex::new(());

    #[test]
    fn genau_ein_vollbild_je_anforderung() {
        let _g = SERIELL.lock().unwrap_or_else(|e| e.into_inner());
        // Ausgangszustand HERSTELLEN, nicht annehmen. Hier stand bis zum
        // 2026-08-20 die Annahme "kein anderer Test in diesem Modul ruft die
        // prozessweite `request_keyframe()` an" — die stimmt heute, ist aber
        // eine Aussage ueber alle kuenftigen Tests, und `SERIELL` schuetzt nur
        // innerhalb dieses Moduls. Ein `reset()` kostet nichts und macht den
        // Test von der Reihenfolge unabhaengig.
        reset();
        assert!(!take_keyframe_request(), "nach reset darf nichts anliegen");
        request_keyframe();
        assert!(take_keyframe_request(), "die Anforderung muss ankommen");
        assert!(
            !take_keyframe_request(),
            "sie darf nicht kleben bleiben — sonst wird jedes Bild ein Vollbild"
        );
    }

    /// **Der Fall, um den es wirklich geht.** Nicht "reset setzt Felder
    /// zurueck", sondern: eine echte Anforderung des NEUEN Streams darf nicht
    /// an der Drossel des alten scheitern.
    ///
    /// Ohne `reset` verwirft die Drossel sie stillschweigend, wenn sie in den
    /// Deckel der letzten angenommenen faellt — und der Zuschauer wartet bis
    /// zum naechsten regulaeren Vollbild. Beim gestreckten Abstand ist das bis
    /// zu eine Minute: genau der Zustand, den dieses Modul verhindern soll.
    #[test]
    fn nach_reset_wird_eine_anforderung_des_neuen_streams_angenommen() {
        let d = Drossel::neu();
        // Alter Stream: eine Anforderung wird angenommen.
        assert!(d.anfordern_und_abholen(Duration::ZERO));
        // Ohne Zuruecksetzen faellt die naechste in den Deckel — belegt, dass
        // der Fall ueberhaupt eintreten kann.
        assert!(
            !d.anfordern_und_abholen(Duration::from_millis(100)),
            "Vorbedingung: innerhalb des Deckels wird verworfen"
        );
        // Stream-Wechsel.
        *d.letzte_angenommen.lock().unwrap() = None;
        // Neuer Stream, dieselbe Uhr: muss jetzt durchgehen.
        assert!(
            d.anfordern_und_abholen(Duration::from_millis(101)),
            "nach dem Zuruecksetzen darf die Drossel des alten Streams nicht mehr sperren"
        );
    }
}
