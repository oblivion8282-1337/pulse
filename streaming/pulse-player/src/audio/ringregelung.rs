//! Rueckfuehrung des Ausgabe-Rings auf einen Sollfuellstand.
//!
//! **Ohne sie steigt der Fuellstand nur:** jede Lieferpause schiebt ihn hoch,
//! und nichts baut ihn wieder ab. Der harte Deckel in `audio.rs`
//! (`MAX_RING_SECONDS`) greift erst bei sechs Sekunden und ist damit keine
//! Regelung, sondern ein Notausgang.
//!
//! Zwei Kreise mit sehr verschiedenen Zeitkonstanten, weil ein einzelner nicht
//! beides kann: Sekunden Rueckstand abbauen UND dabei unhoerbar bleiben.
//!
//! Eigenes Modul, damit `audio.rs` der Ausgabepfad bleibt: die Regelung ist ein
//! abgeschlossenes Stueck mit eigenen Messbegruendungen, und die Datei war mit
//! ihnen ueber die harte Groessen-Grenze von 500 Zeilen gewachsen
//! (`PLAN.md` §12.1).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Sollfuellstand des Rings in Millisekunden.
///
/// **Warum es den ueberhaupt braucht.** Bis 2026-08-05 gab es ihn nicht:
/// `target_fill` wurde ausschliesslich von `av_offset_ms` gesetzt, und dessen
/// Vorgabe ist 0. Die Anlaufsperre in `fill_output` griff damit nie, und es gab
/// weder Sollwert noch Rueckfuehrung — der Fuellstand war das freilaufende
/// Integral aller Liefer-Schwankungen: beim Verbinden zufaellig gesetzt, von
/// jedem Haenger einseitig nach oben geschoben, nie wieder abgebaut. Gemessen
/// am 2026-08-05: nach EINER Lieferpause blieb er bei 5980 ms stehen (dem
/// harten Deckel), mit 767 Unterlaeufen und 1,7 s verworfenem Ton — waehrend
/// das Bild wieder tadellos mit 60 fps lief. Sechs Sekunden Ton hinterher,
/// dauerhaft, ohne Erholung und ohne Meldung. Messakte
/// `profiles/ton-2026-08-05-windows-ringregelung.json`.
///
/// **Woher die 60 ms kommen** — aus Messwerten, nicht aus dem Gefuehl:
/// * In den gesunden Laeufen stellte sich der Ring von selbst auf 73-168 ms
///   ein. Das ist die Spanne, die die Strecke ohne Regelung erzeugt.
/// * Der Ankunftsabstand lag in der Produktion bei hoechstens 18-29 ms. Zwei
///   bis drei davon zu ueberbruecken sind rund 50-60 ms.
/// * Die Untergrenze setzt das Geraet: WASAPI-Shared ruft typisch alle 10 ms,
///   und in `fill_output` muss mindestens ein voller Aufruf Vorrat liegen,
///   sonst zaehlt jeder Jitter als Unterlauf.
///
/// **Getrennt von `av_offset_ms`, und das ist der Kern.** Jener ist der
/// Nutzer-Trim aus der Oberflaeche. Ihn als Sollwert zu missbrauchen hiess:
/// "Ton um 0 ms verschieben" bedeutet "gar kein Puffer" — genau der Fehler,
/// den es hier zu beheben gilt. Der Trim ist jetzt ein ZUSCHLAG hierauf.
pub(super) const RING_SOLL_MS: usize = 60;

/// Ab dem Wievielfachen des Sollwerts grob gekappt wird.
///
/// Darunter regelt der Feinabbau. Der Schnitt klingt wie ein kurzer Aussetzer —
/// verglichen mit sechs Sekunden bleibendem Versatz ist das der bessere Tausch,
/// aber er ist teuer genug, dass er nicht bei jedem Jitter feuern darf.
const RING_KAPP_FAKTOR: usize = 3;

/// Sperrfrist nach einer Grobkappung.
///
/// Ohne sie erzeugen mehrere Lieferpausen kurz hintereinander mehrere Schnitte.
/// Der Wert ist NICHT gemessen — er ist ein begruendeter Anfang, und wer ihn
/// aendert, misst nach.
const RING_KAPP_SPERRE: Duration = Duration::from_secs(5);

/// Feinabbau: ein FRAME je so vielen angehaengten Samples.
///
/// **Hier stand bis 2026-08-08 "ein Sample je so vielen angehaengten" — das war
/// die Beschreibung eines Fehlers**, nicht der Absicht: der Ring haelt
/// verschraenktes PCM, ein einzeln entferntes Sample kippt die Kanalzuordnung
/// (s. [`Ringregelung::nach_anhaengen`]). Entfernt wird jetzt immer ein volles
/// Frame.
///
/// Ebenso widerlegt: die frueher hier genannten "0,05 % Tonhoehenfehler … baut
/// 40 ms in gut einer Minute ab". Ein Frame je 2000 angehaengter Samples sind
/// bei Stereo 0,1 % und damit 40 ms in gut 40 Sekunden — der Abbau ist doppelt
/// so schnell wie beschrieben. Er bleibt weit unter der Wahrnehmungsschwelle,
/// und schneller abzubauen ist hier die richtige Richtung; die Zahl gehoert nur
/// richtig dagestanden. Resampling waere die Alternative und scheidet aus: der
/// Weg hat schon einen Resampler, und ihn laufend zu verstimmen zieht hoerbar
/// die Tonhoehe. Fuer die gemessene Groessenordnung (Sekunden) waere es
/// entweder unhoerbar langsam oder hoerbar falsch.
const RING_FEIN_TEILER: usize = 2000;

/// Zustand der Regelung. Liegt in `Shared` und wird nur vom Fuetter-Thread
/// beschrieben.
#[derive(Default)]
pub(super) struct Ringregelung {
    /// Wie oft der Ring grob auf den Sollwert gekappt wurde.
    ///
    /// **Gehoert gemeldet, nicht verschwiegen.** Der Schnitt ist hoerbar, und
    /// ein Eingriff, den niemand sieht, ist genau die Sorte Fehler, die hier
    /// behoben wird: der alte 6-Sekunden-Deckel kappte auch, nur eben zu spaet
    /// und lautlos.
    pub(super) resyncs: u64,
    /// Zaehlt angehaengte Samples fuer den Feinabbau (s. [`RING_FEIN_TEILER`]).
    fein_zaehler: usize,
    /// Wann zuletzt grob gekappt wurde — fuer [`RING_KAPP_SPERRE`].
    letzte_kappung: Option<Instant>,
}

impl Ringregelung {
    /// Nach dem Anhaengen frischer Samples anwenden. Gibt zurueck, wie viele
    /// Samples dabei verworfen wurden (fuer den `dropped`-Zaehler).
    ///
    /// `kanaele` = Kanalzahl des Ausgabegeraets, als Parameter wie `soll` und
    /// nicht als Feld, damit die Regelung keinen zweiten Stand der
    /// Geraetedaten haelt. Der Ring enthaelt **verschraenktes** PCM, das
    /// `fill_output` unveraendert in den Geraetepuffer kopiert — jeder Abbau
    /// muss deshalb ein ganzes Frame entfernen. Ein einzelnes `pop_front()`
    /// (so stand es bis 2026-08-08 im Feinzweig) kippt die Paritaet: aus
    /// L,R,L,R wird R,L,R,L, und der naechste Feinschritt kippt sie wieder
    /// zurueck — ein Umkippen der Kanalzuordnung im Pakettakt, das kein Zaehler
    /// anzeigt.
    pub(super) fn nach_anhaengen(
        &mut self,
        ring: &mut VecDeque<f32>,
        soll: usize,
        angehaengt: usize,
        kanaele: usize,
    ) -> u64 {
        if soll == 0 {
            return 0;
        }
        let darf_kappen = self.letzte_kappung.is_none_or(|t| t.elapsed() >= RING_KAPP_SPERRE);
        if ring.len() > soll * RING_KAPP_FAKTOR && darf_kappen {
            // Grob: nach einem Nachhol-Schwall in EINEM Schnitt zurueck auf den
            // Sollwert. Hoerbar wie ein kurzer Aussetzer — und der bessere
            // Tausch gegen einen Rueckstand, der sonst bis Sitzungsende bleibt.
            let excess = ring.len() - soll;
            ring.drain(..excess);
            self.resyncs += 1;
            self.letzte_kappung = Some(Instant::now());
            return excess as u64;
        }
        if ring.len() > soll {
            // Fein: ein ganzes Frame je `RING_FEIN_TEILER` angehaengten
            // Samples. Baut den Rest stetig ab, ohne dass man es hoert.
            // Ein einzelnes Sample waere hier falsch — s. den Kanal-Absatz an
            // dieser Funktion.
            let frame = kanaele.max(1);
            self.fein_zaehler += angehaengt;
            let mut verworfen = 0;
            while self.fein_zaehler >= RING_FEIN_TEILER && ring.len() > soll {
                self.fein_zaehler -= RING_FEIN_TEILER;
                let n = frame.min(ring.len());
                ring.drain(..n);
                verworfen += n as u64;
            }
            return verworfen;
        }
        // Unter dem Sollwert wird NICHT abgebaut — sonst arbeitete die Regelung
        // gegen den normalen Jitter und erzeugte die Unterlaeufe, die sie
        // verhindern soll.
        self.fein_zaehler = 0;
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verschraenktes Stereo, an dem sich die Kanaele unterscheiden lassen:
    /// links immer `+1.0`, rechts immer `-1.0`. Index 0 ist eine Kanalgrenze.
    fn stereo_ring(laenge: usize) -> VecDeque<f32> {
        (0..laenge).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect()
    }

    /// **Reproduktion Befund 10.** Der Feinabbau entfernt mit `pop_front()`
    /// genau EIN f32-Sample, kennt aber die Kanalzahl nicht. Der Ring haelt
    /// verschraenktes Multi-Channel-PCM, das `fill_output` unveraendert in den
    /// interleaved Ausgabepuffer kopiert — ein Pop kippt damit die Paritaet:
    /// aus L,R,L,R wird R,L,R,L. Richtig waere, immer ein volles Frame zu
    /// entfernen (`drain(..channels)`).
    #[test]
    fn repro_10_feinabbau_kippt_die_kanalzuordnung() {
        // 48 kHz Stereo, Sollwert wie zur Laufzeit: 60 ms * 96 Samples/ms.
        let soll = RING_SOLL_MS * 96;
        let mut ring = stereo_ring(soll + 1);
        let mut r = Ringregelung::default();
        assert_eq!(ring[0], 1.0, "Vorbedingung: der Ring beginnt auf dem linken Kanal");

        // Genau ein Feinabbau-Schritt: `RING_FEIN_TEILER` angehaengte Samples.
        let verworfen = r.nach_anhaengen(&mut ring, soll, RING_FEIN_TEILER, 2);
        // Der Rueckgabewert zaehlt SAMPLES (so wie im Grobzweig und wie
        // `AudioCounters::dropped` es fuehrt), nicht Frames — ein Stereo-Frame
        // sind also 2. Hier stand in der Reproduktion `1`; das war der Stand
        // des Fehlers (ein einzelnes `pop_front()`), nicht die Sollgroesse.
        assert_eq!(verworfen, 2, "Vorbedingung: der Feinzweig hat gegriffen");

        assert_eq!(
            ring[0], 1.0,
            "nach dem Feinabbau muss der Ring weiter auf dem linken Kanal beginnen — \
             heute steht hier {} (R), die Kanaele sind vertauscht",
            ring[0]
        );
        assert_eq!(
            ring.len(),
            soll - 1,
            "und es muss ein VOLLES Frame (2 Samples) verschwunden sein, nicht eines"
        );
    }

    /// Die zweite Haelfte des Befunds: es ist kein einmaliger dauerhafter
    /// Tausch, sondern ein wiederholtes Umkippen im Opus-Pakettakt. Der zweite
    /// Feinabbau-Schritt dreht die Zuordnung zurueck.
    #[test]
    fn repro_10_feinabbau_kippt_die_kanalzuordnung_wieder_zurueck() {
        let soll = RING_SOLL_MS * 96;
        let mut ring = stereo_ring(soll + 2);
        let mut r = Ringregelung::default();

        r.nach_anhaengen(&mut ring, soll, RING_FEIN_TEILER, 2);
        let nach_eins = ring[0];
        r.nach_anhaengen(&mut ring, soll, RING_FEIN_TEILER, 2);
        let nach_zwei = ring[0];

        assert_eq!(
            (nach_eins, nach_zwei),
            (1.0, 1.0),
            "beide Feinabbau-Schritte muessen den Ring auf dem linken Kanal lassen — \
             heute kippt er auf {nach_eins} und wieder zurueck auf {nach_zwei}"
        );
    }
}
