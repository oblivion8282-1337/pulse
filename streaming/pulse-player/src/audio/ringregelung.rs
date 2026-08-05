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

/// Feinabbau: ein Sample je so vielen angehaengten.
///
/// 1 von 2000 sind 0,05 % Tonhoehenfehler — unter der Wahrnehmungsschwelle und
/// baut 40 ms in gut einer Minute ab. Resampling waere die Alternative und
/// scheidet aus: der Weg hat schon einen Resampler, und ihn laufend zu
/// verstimmen zieht hoerbar die Tonhoehe. Fuer die gemessene Groessenordnung
/// (Sekunden) waere es entweder unhoerbar langsam oder hoerbar falsch.
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
    pub(super) fn nach_anhaengen(
        &mut self,
        ring: &mut VecDeque<f32>,
        soll: usize,
        angehaengt: usize,
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
            // Fein: ein Sample je `RING_FEIN_TEILER` angehaengten. Baut den Rest
            // stetig ab, ohne dass man es hoert.
            self.fein_zaehler += angehaengt;
            let mut verworfen = 0;
            while self.fein_zaehler >= RING_FEIN_TEILER && ring.len() > soll {
                self.fein_zaehler -= RING_FEIN_TEILER;
                ring.pop_front();
                verworfen += 1;
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
