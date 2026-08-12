//! Rueckfuehrung des Ausgabe-Rings auf einen Sollfuellstand.
//!
//! **Ohne sie steigt der Fuellstand nur:** jede Lieferpause schiebt ihn hoch,
//! und nichts baut ihn wieder ab. Der harte Deckel in `audio.rs`
//! (`MAX_RING_SECONDS`) greift erst bei sechs Sekunden und ist damit keine
//! Regelung, sondern ein Notausgang.
//!
//! **Seit 2026-08-13 ist das hier nur noch der Notausgang.** Die laufende
//! Regelung macht [`super::uhrenabgleich`], indem er die Abspielrate nachfuehrt.
//! Was bleibt, ist der eine grobe Schnitt fuer Rueckstaende, die keine
//! Ratenkorrektur mehr einholt — ein Vielfaches des Sollwerts, wie es nach
//! einem Nachhol-Schwall entsteht.
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
/// Darunter regelt der Uhrenabgleich, ohne zu schneiden. Der Schnitt klingt wie ein kurzer Aussetzer —
/// verglichen mit sechs Sekunden bleibendem Versatz ist das der bessere Tausch,
/// aber er ist teuer genug, dass er nicht bei jedem Jitter feuern darf.
const RING_KAPP_FAKTOR: usize = 3;

/// Sperrfrist nach einer Grobkappung.
///
/// Ohne sie erzeugen mehrere Lieferpausen kurz hintereinander mehrere Schnitte.
/// Der Wert ist NICHT gemessen — er ist ein begruendeter Anfang, und wer ihn
/// aendert, misst nach.
const RING_KAPP_SPERRE: Duration = Duration::from_secs(5);



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
    /// Wann zuletzt grob gekappt wurde — fuer [`RING_KAPP_SPERRE`].
    letzte_kappung: Option<Instant>,
}

impl Ringregelung {
    /// Nach dem Anhaengen frischer Samples anwenden. Gibt zurueck, wie viele
    /// Samples dabei verworfen wurden (fuer den `dropped`-Zaehler).
    ///
    /// Der Schnitt geht auf den Sollwert und trifft damit von selbst eine
    /// Frame-Grenze, solange der Sollwert eine ist (`RING_SOLL_MS * per_ms`).
    /// Die Kanalzahl braucht es hier deshalb nicht mehr — sie war nur fuer den
    /// entfernten Feinabbau noetig, der einzelne Samples anfasste und dabei bis
    /// 2026-08-08 die Kanalzuordnung kippen konnte.
    pub(super) fn nach_anhaengen(&mut self, ring: &mut VecDeque<f32>, soll: usize) -> u64 {
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
        // **Hier stand bis zum 2026-08-13 ein Feinabbau, und er war die Ursache
        // des Fehlers, den er verhindern sollte.** Ein Frame je 2000 angehaengter
        // Samples, gemessen am Fuellstand unmittelbar NACH dem Anhaengen — also
        // im Hochpunkt der Saegezahnkurve. Der Ring pendelte damit um die halbe
        // Paketgroesse unter den Sollwert, die Sicherheitsreserve war
        // aufgezehrt, ein normaler Ankunftsjitter reichte zum Leerlaufen, und
        // der Unterlauf schob den Fuellstand schlagartig wieder hoch. In einem
        // Lauf von 307 s: rund 0,8 s Stille in etwa zwoelf Stuecken und 70 390
        // verworfene Samples — kein Ueberlauf, sondern ein Regelkreis gegen sich
        // selbst (Messakte in den Protokollen vom 2026-08-13).
        //
        // Ersetzt durch [`super::uhrenabgleich`]: der fuehrt die Abspielrate um
        // Bruchteile eines Promille nach, statt Ton zu schneiden — stetig,
        // unhoerbar, und erstmals auch in der Gegenrichtung.
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

    /// **Die beiden Reproduktionen zu Befund 10 sind hier entfallen**, und zwar
    /// gegenstandslos geworden statt stillgelegt: sie belegten, dass der
    /// Feinabbau einzelne Samples entfernte und dabei die Kanalzuordnung
    /// kippte. Den Feinabbau gibt es seit dem 2026-08-13 nicht mehr — die
    /// laufende Regelung macht `super::uhrenabgleich`, ohne den Ring
    /// anzufassen. Ein Test auf einen entfernten Zweig haette nur noch
    /// bewiesen, dass er entfernt ist.
    ///
    /// Was bleibt, ist der Grobschnitt, und der wird hier geprueft.

    /// Ueber dem Vielfachen des Sollwerts wird in EINEM Schnitt zurueckgesetzt.
    #[test]
    fn ueber_der_kappschwelle_geht_es_zurueck_auf_den_sollwert() {
        let soll = RING_SOLL_MS * 96;
        let mut ring = stereo_ring(soll * RING_KAPP_FAKTOR + 100);
        let mut r = Ringregelung::default();

        let verworfen = r.nach_anhaengen(&mut ring, soll);

        assert_eq!(ring.len(), soll);
        assert_eq!(verworfen, (soll * RING_KAPP_FAKTOR + 100 - soll) as u64);
        assert_eq!(r.resyncs, 1);
    }

    /// Der Schnitt trifft eine Kanalgrenze, solange der Sollwert eine ist —
    /// sonst waeren nach dem Schnitt links und rechts vertauscht.
    #[test]
    fn der_grobschnitt_laesst_die_kanalzuordnung_stehen() {
        let soll = RING_SOLL_MS * 96;
        let mut ring = stereo_ring(soll * RING_KAPP_FAKTOR + 100);
        let mut r = Ringregelung::default();
        assert_eq!(ring[0], 1.0, "Vorbedingung: der Ring beginnt auf dem linken Kanal");

        r.nach_anhaengen(&mut ring, soll);

        assert_eq!(ring[0], 1.0, "nach dem Schnitt muss der Ring links beginnen");
    }

    /// Unterhalb der Kappschwelle wird **nichts** mehr angefasst. Genau das ist
    /// die Aenderung vom 2026-08-13: hier lag der Feinabbau, der die
    /// Sicherheitsreserve aufzehrte und damit die Unterlaeufe erzeugte, die er
    /// verhindern sollte.
    #[test]
    fn unter_der_kappschwelle_bleibt_der_ring_unberuehrt() {
        let soll = RING_SOLL_MS * 96;
        // Deutlich ueber dem Sollwert, aber unter dem Kappfaktor.
        let laenge = soll * 2;
        let mut ring = stereo_ring(laenge);
        let mut r = Ringregelung::default();

        let verworfen = r.nach_anhaengen(&mut ring, soll);

        assert_eq!(verworfen, 0, "kein Schnitt unterhalb der Schwelle");
        assert_eq!(ring.len(), laenge, "und der Ring bleibt unveraendert lang");
        assert_eq!(r.resyncs, 0);
    }

    /// Nach einem Schnitt gilt die Sperrfrist — mehrere Lieferpausen kurz
    /// hintereinander duerfen nicht mehrere Schnitte erzeugen.
    #[test]
    fn nach_einem_schnitt_gilt_die_sperrfrist() {
        let soll = RING_SOLL_MS * 96;
        let mut r = Ringregelung::default();
        let mut ring = stereo_ring(soll * RING_KAPP_FAKTOR + 100);
        r.nach_anhaengen(&mut ring, soll);

        let mut wieder_voll = stereo_ring(soll * RING_KAPP_FAKTOR + 100);
        let verworfen = r.nach_anhaengen(&mut wieder_voll, soll);

        assert_eq!(verworfen, 0, "innerhalb der Sperrfrist wird nicht erneut geschnitten");
        assert_eq!(r.resyncs, 1);
    }

    /// Ohne Sollwert (Geraet noch nicht bekannt) passiert gar nichts.
    #[test]
    fn ohne_sollwert_passiert_nichts() {
        let mut ring = stereo_ring(10_000);
        let mut r = Ringregelung::default();
        assert_eq!(r.nach_anhaengen(&mut ring, 0), 0);
        assert_eq!(ring.len(), 10_000);
    }
}
