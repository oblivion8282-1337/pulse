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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static ANGEFORDERT: AtomicBool = AtomicBool::new(false);

// ── Rueckstaffelung ──────────────────────────────────────────────────────────
//
// **Wogegen.** Ein Zuschauer, dessen Decoder endgueltig ausgestiegen ist,
// fordert ohne Unterlass Vollbilder an und hoert nie wieder auf — am
// 2026-08-01 im Browser mit AV1 10 bit gemessen: **425 Anforderungen** in
// einem Lauf, nachdem Chromes Hardware-Decoder mitten im Strom auf `dav1d`
// zurueckfiel und der kein 10 bit kann (Messakte
// `profiles/browser-2026-08-01-windows-av1-10bit.json`). Jede davon kostet den
// Sender ein volles Intra-Bild, und weil der Strom EINER ist, zahlen alle
// anderen Zuschauer mit: bei fester Bitrate bricht die Bildqualitaet ein und
// der Bildfluss geht in Stoesse. Ein einzelner kaputter Empfaenger legt so die
// Uebertragung fuer die ganze Runde lahm.
//
// **Warum die ERSTE sofort durchgeht.** Unter Intra-Refresh hat der Strom nach
// dem Start kein Vollbild mehr; ein neu dazukommender Zuschauer sieht ohne
// diese eine Anforderung ueberhaupt nichts. Eine Staffelung, die schon beim
// ersten Mal bremst, macht aus dem Einstieg eine Wartezeit — genau das, was
// `session.rs::EINSTIEG_REQUEST_INTERVAL` auf der Empfaengerseite vermeidet.
// Gestaffelt wird deshalb erst die WIEDERHOLUNG.
//
// **Warum hier und nicht im MediaMTX-Fork.** Patch 0002 drosselt dort schon auf
// eine Anforderung je 2 s — aber PFADWEIT. Eine schaerfere Bremse an dieser
// Stelle traefe eine echte Zuschauermenge mit: zehn Zuschauer, die nach einem
// Verlustereignis gleichzeitig anfordern, sind ein berechtigter Fall. Hier
// unterscheidet die Staffelung nicht nach Zuschauer (das kann der Sender
// nicht), wohl aber nach ANDAUERN: ein Ereignis ebbt ab, ein kaputter Decoder
// nicht.

/// Ab wann eine Anforderungsfolge als beendet gilt. Kommt so lange nichts,
/// faengt die Leiter wieder oben an.
///
/// Gemessen an dem, was im gesunden Betrieb passiert: MediaMTX fordert in der
/// Lagerfassung von jedem WebRTC-Sender **alle zwei Sekunden** eines an
/// (2026-08-02: 7 in 18 s). Dieser Takt darf nicht als Sturm gelten — mit
/// dieser Ruhe-Schwelle setzt er die Leiter jedes Mal zurueck und wird
/// unveraendert bedient.
const RUHE: Duration = Duration::from_secs(2);

/// Bis zu dieser Zahl in Folge geht jede Anforderung sofort durch.
///
/// Zwei und nicht eine: die erste ist der Einstieg, die zweite faengt den Fall
/// ab, dass genau dieses eine Vollbild selbst beschaedigt ankommt (bei 5 %
/// Verlust kommt ein Vollbild aus 25-35 Paketen nur mit ~28 % Wahrscheinlichkeit
/// heil an — die Zahl steht in `pulse-player/src/session.rs`).
const SOFORT: u32 = 2;

/// Bis zu dieser Zahl in Folge gilt die erste Bremsstufe.
const MITTEL: u32 = 5;

/// Erste Bremsstufe (ab der dritten Anforderung in Folge).
const ABSTAND_MITTEL: Duration = Duration::from_secs(1);

/// Zweite Bremsstufe. Weiter herunter geht es NICHT: ein Zuschauer, der
/// wirklich nur ein Vollbild braucht, bekaeme sonst nie eines.
const ABSTAND_LANGSAM: Duration = Duration::from_secs(2);

/// Wie viele Anforderungen die Staffelung bisher verworfen hat. Nur zum
/// Berichten — der Wert gehoert in die Diagnose, weil sonst nicht zu
/// unterscheiden ist, ob wenige Vollbilder heissen „es wurde wenig
/// angefordert" oder „es wurde viel gebremst".
static GEDROSSELT: AtomicU64 = AtomicU64::new(0);

struct Leiter {
    /// Wann zuletzt IRGENDEINE Anforderung eintraf — auch eine verworfene.
    /// Nicht die zuletzt angenommene: bei einem Abstand von zwei Sekunden waere
    /// die Ruhe-Schwelle sonst bei jeder angenommenen Anforderung erreicht und
    /// die Leiter fiele nie ueber die erste Stufe hinaus.
    letzte_anfrage: Option<Instant>,
    letzte_angenommen: Option<Instant>,
    in_folge: u32,
}

impl Leiter {
    const fn neu() -> Self {
        Self { letzte_anfrage: None, letzte_angenommen: None, in_folge: 0 }
    }

    fn mindestabstand(in_folge: u32) -> Duration {
        if in_folge < SOFORT {
            Duration::ZERO
        } else if in_folge < MITTEL {
            ABSTAND_MITTEL
        } else {
            ABSTAND_LANGSAM
        }
    }

    /// `true` = diese Anforderung wird bedient.
    fn anfordern(&mut self, jetzt: Instant) -> bool {
        if self.letzte_anfrage.is_none_or(|t| jetzt.duration_since(t) >= RUHE) {
            *self = Self::neu();
        }
        self.letzte_anfrage = Some(jetzt);
        let abstand = Self::mindestabstand(self.in_folge);
        if self.letzte_angenommen.is_some_and(|t| jetzt.duration_since(t) < abstand) {
            return false;
        }
        self.letzte_angenommen = Some(jetzt);
        self.in_folge += 1;
        true
    }
}

static LEITER: Mutex<Leiter> = Mutex::new(Leiter::neu());

/// Beim naechsten Bild ein Vollbild erzeugen — sofern die Staffelung es
/// zulaesst (s. den Block ueber [`RUHE`]).
///
/// Mehrere Anforderungen innerhalb eines Bildabstands fallen ausserdem zu einer
/// zusammen — das ist Absicht: bei mehreren Zuschauern auf schlechter Leitung
/// waere sonst jede einzelne ein volles Intra-Bild, und das zahlt der Sender
/// einmal fuer alle. (Die zweite Bremse sitzt server-seitig im
/// MediaMTX-Patch 0002: hoechstens eine Anforderung je 2 s — seit 2026-08-14
/// derselbe Wert wie [`ABSTAND_LANGSAM`] hier; vorher standen dort 300 ms und
/// feuerten damit in die Sperrfrist dieser Datei hinein.)
pub fn request_keyframe() {
    // Eine vergiftete Sperre darf den Rueckkanal nicht stilllegen: lieber die
    // Anforderung durchlassen als den Stream fuer alle Zuschauer einfrieren.
    let angenommen = LEITER
        .lock()
        .map_or(true, |mut l| l.anfordern(Instant::now()));
    if !angenommen {
        let n = GEDROSSELT.fetch_add(1, Ordering::Relaxed) + 1;
        // Die ersten drei einzeln (da faellt die Entscheidung), danach jede
        // fuenfzigste — ein anhaltender Sturm soll sichtbar bleiben, ohne das
        // Log zu fuellen, das er ja gerade erklaeren soll.
        if n <= 3 || n.is_multiple_of(50) {
            eprintln!("[keyframe] Anforderung zurueckgestellt (insgesamt {n})");
        }
        return;
    }
    ANGEFORDERT.store(true, Ordering::Relaxed);
}

/// Wie viele Anforderungen die Staffelung insgesamt verworfen hat.
pub fn zurueckgestellt() -> u64 {
    GEDROSSELT.load(Ordering::Relaxed)
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
            // Die zurueckgestellten mit in DIESER Zeile, nicht nur in einer
            // eigenen: „wie viele Vollbilder" ohne „wie viele Anforderungen
            // dafuer" ist genau die Zaehlung ohne Bezugsgroesse, an der der
            // Pruefstand schon einmal gescheitert ist (README, 2026-07-31).
            let weg = zurueckgestellt();
            eprintln!(
                "[encode] Vollbild auf Anforderung (pts={pts}, insgesamt {n}, \
                 zurueckgestellt {weg})"
            );
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
///
/// **Die Staffelung geht mit zurueck**, und das ist kein Beiwerk: bliebe sie
/// stehen, faenge ein neuer Stream unter Umstaenden auf der langsamsten Stufe
/// an — und die allererste Anforderung ist im Intra-Refresh-Betrieb genau die,
/// die den Zuschauer ueberhaupt ins Bild bringt. Der Zaehler der verworfenen
/// bleibt absichtlich stehen: er ist eine Bilanz ueber die Prozesslaufzeit,
/// keine Eigenschaft eines Streams.
pub fn reset() {
    ANGEFORDERT.store(false, Ordering::Relaxed);
    if let Ok(mut l) = LEITER.lock() {
        *l = Leiter::neu();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Merker UND Leiter sind prozessweit — zwei Tests, die beides anfassen,
    /// wuerden sich sonst gegenseitig die Zustaende umschreiben. Die Tests der
    /// Leiter selbst brauchen das nicht: die laufen auf einer eigenen Instanz
    /// mit gestellter Uhr.
    static SERIELL: Mutex<()> = Mutex::new(());

    #[test]
    fn genau_ein_vollbild_je_anforderung() {
        let _g = SERIELL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        assert!(!take_keyframe_request(), "Ausgangszustand ist nichts angefordert");
        request_keyframe();
        assert!(take_keyframe_request(), "die Anforderung muss ankommen");
        assert!(
            !take_keyframe_request(),
            "sie darf nicht kleben bleiben — sonst wird jedes Bild ein Vollbild"
        );
    }

    #[test]
    fn mehrfache_anforderung_faellt_zu_einer_zusammen() {
        let _g = SERIELL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        request_keyframe();
        request_keyframe();
        request_keyframe();
        assert!(take_keyframe_request());
        assert!(!take_keyframe_request(), "drei Anforderungen, ein Vollbild");
    }

    // ── Die Staffelung, an einer gestellten Uhr ─────────────────────────────
    //
    // Nicht ueber `request_keyframe()` und `sleep`: ein Test, der zwei Sekunden
    // wartet, wird nicht gefahren.

    /// Der Einstieg darf NIE warten — das ist der ganze Grund, warum die
    /// Staffelung nicht bei der ersten Anforderung anfaengt.
    #[test]
    fn die_erste_geht_sofort_durch() {
        let mut l = Leiter::neu();
        assert!(l.anfordern(Instant::now()));
    }

    #[test]
    fn ab_der_dritten_wird_gebremst() {
        let mut l = Leiter::neu();
        let t0 = Instant::now();
        assert!(l.anfordern(t0), "1. sofort");
        assert!(l.anfordern(t0 + Duration::from_millis(10)), "2. sofort");
        assert!(
            !l.anfordern(t0 + Duration::from_millis(20)),
            "3. faellt in die 1-s-Stufe und muss warten"
        );
        assert!(
            l.anfordern(t0 + Duration::from_millis(1010)),
            "nach einer Sekunde wieder"
        );
    }

    /// Ein Dauersturm landet auf der langsamsten Stufe und bleibt dort.
    #[test]
    fn dauersturm_landet_bei_einer_je_zwei_sekunden() {
        let mut l = Leiter::neu();
        let t0 = Instant::now();
        let mut jetzt = t0;
        let mut angenommen = 0;
        // 20 Sekunden lang alle 50 ms anfordern — das Muster des kaputten
        // 10-Bit-Zuschauers (425 Anforderungen in einem Lauf).
        for _ in 0..400 {
            if l.anfordern(jetzt) {
                angenommen += 1;
            }
            jetzt += Duration::from_millis(50);
        }
        // 2 sofort + 3 im Sekundentakt + der Rest im Zweisekundentakt.
        assert!(
            (10..=14).contains(&angenommen),
            "20 s Dauersturm duerfen nur rund ein Dutzend Vollbilder kosten, waren {angenommen}"
        );
    }

    /// Der Lagertakt von MediaMTX (alle 2 s eine Anforderung) darf NICHT als
    /// Sturm gelten — sonst bremste die Staffelung den gesunden Betrieb aus.
    #[test]
    fn zwei_sekunden_takt_wird_unveraendert_bedient() {
        let mut l = Leiter::neu();
        let mut jetzt = Instant::now();
        for i in 0..10 {
            assert!(l.anfordern(jetzt), "Anforderung {i} im Lagertakt muss durchgehen");
            jetzt += RUHE;
        }
    }

    /// Nach Ruhe faengt die Leiter oben an — sonst zahlte ein Zuschauer, der
    /// eine Minute spaeter dazukommt, fuer einen laengst vergangenen Sturm.
    #[test]
    fn ruhe_setzt_die_leiter_zurueck() {
        let mut l = Leiter::neu();
        let t0 = Instant::now();
        for k in 0..10 {
            l.anfordern(t0 + Duration::from_millis(k * 20));
        }
        assert!(
            !l.anfordern(t0 + Duration::from_millis(300)),
            "mitten im Sturm wird gebremst"
        );
        assert!(
            l.anfordern(t0 + Duration::from_secs(10)),
            "nach Ruhe muss die naechste sofort durchgehen"
        );
    }

    /// `reset()` beim Stream-Start muss die Leiter mitnehmen.
    #[test]
    fn reset_nimmt_die_leiter_mit() {
        let _g = SERIELL.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        // Auf die langsamste Stufe treiben.
        for _ in 0..20 {
            request_keyframe();
        }
        reset();
        assert!(!take_keyframe_request(), "reset loescht auch den Merker");
        request_keyframe();
        assert!(
            take_keyframe_request(),
            "nach reset muss die erste Anforderung des neuen Streams sofort wirken"
        );
    }
}
