//! Wann ein abgelehntes Paket den Decoder kostet — und wann die Sitzung.
//!
//! Ausgelagert aus [`crate::decode`], weil die Entscheidung fuer sich steht
//! und dort nichts mehr wachsen soll (die Datei liegt weit ueber der
//! Groessen-Grenze). Sie ist ausserdem ohne Decoder pruefbar: reine Zahlen,
//! keine FFmpeg-Zustaende.
//!
//! **Der Kern der Sache.** Einzelne abgelehnte Einheiten sind normal — nach
//! einer Paketluecke ist die naechste Einheit unvollstaendig, bis ein Keyframe
//! kommt, und das darf die Wiedergabe nicht beenden. Ein dauerhaft toter
//! Decoder sieht an der Stelle aber genau gleich aus (beobachtet am
//! 2026-07-26: `av1_cuvid` meldete nach dem zweiten Oeffnen fuer JEDES Paket
//! `CUDA_ERROR_UNKNOWN`, das Bild blieb schwarz, und weil jeder Fehler einzeln
//! als „kaputter Frame" durchging, kam nirgends ein Fehler an). Erst die
//! Haeufigkeit trennt beides.

use std::time::{Duration, Instant};

/// Aufeinanderfolgende abgelehnte Einheiten, ab denen der Decoder als defekt
/// gilt. Bei 60 fps ist das eine halbe Sekunde.
pub const ERROR_LIMIT: u32 = 30;

/// Wie oft **hintereinander** neu aufgebaut wird, bevor die Sitzung als
/// gescheitert gilt.
pub const MAX_REBUILDS: u32 = 2;

/// Wie lange ein frisch aufgebauter Decoder ordentlich arbeiten muss, damit
/// sein Neuaufbau nicht mehr gegen ihn zaehlt.
///
/// **Das ist der Wert, an dem der Zuschauer-Rauswurf nach zwei bis drei
/// Minuten hing** (gemessen 2026-08-06, Messakte
/// `player-2026-08-06-zuschauer-fliegt-nach-zwei-minuten`). Bis dahin war
/// `rebuilds` ein Zaehler ueber die ganze Sitzungsdauer, der **nie**
/// zurueckgesetzt wurde. Drei voellig unabhaengige Fehlerserien — jede rund
/// eine halbe Sekunde lang, dazwischen minutenlang einwandfreier Betrieb mit
/// 60 von 60 Bildern je Sekunde — beendeten damit die Sitzung. Auf einer
/// Leitung, die gelegentlich Pakete verliert, ist das eine Frage von Minuten:
/// im Reproduktionslauf lagen die drei Serien bei 70,5 s, 88,5 s und 160,4 s,
/// und die dritte beendete die Sitzung.
///
/// Genau daher kommt auch die **weite Streuung** der beobachteten Endzeiten
/// (134, 165, 172, 176, 178 s): abgebrochen wird nicht nach einer festen
/// Frist, sondern beim dritten Verlust-Stoss — und wann der kommt, entscheidet
/// die Leitung.
///
/// Die urspruengliche Absicht des Zaehlers bleibt unangetastet: „dieser
/// Decoder ist kaputt, und der Ersatz ist es womoeglich auch" meint einen
/// Ersatz, der SOFORT wieder scheitert. Beide belegten Faelle eines wirklich
/// toten Decoders taten genau das — `av1_cuvid` mit zerschossenem CUDA-Kontext
/// (2026-07-26) und `av1_qsv` ohne Intel-Hardware (2026-08-01) lehnten vom
/// ersten Paket an durchgehend ab. Ein solcher Decoder verbraucht seine zwei
/// Versuche in Sekunden und kommt nie in die Naehe dieser Bewaehrungszeit.
///
/// **Der Wert kommt aus einer Messung, nicht aus dem Bauch — und der erste
/// Anlauf war zu hoch.** Zuerst standen hier 30 Sekunden („das Sechzigfache
/// einer Fehlerserie"). Der Pruefungslauf am selben Abend hat das widerlegt:
/// auf einer Leitung mit Verlust lagen drei Serien bei 40,9 s, 115,5 s,
/// 128,9 s und 145,5 s — die letzten drei also **13,5 und 16,6 Sekunden**
/// auseinander. Mit 30 Sekunden Bewaehrung fiel der Zaehler dazwischen nicht,
/// und die Sitzung endete trotz der Berichtigung nach 145,9 s.
///
/// 5 Sekunden trennen die beiden Faelle sauber, und zwar aus einem Grund, der
/// nicht am Zahlenwert haengt: **ein wirklich toter Decoder nimmt gar kein
/// Paket an.** Er startet die Uhr also nie, egal wie kurz sie gestellt ist.
/// Die Bewaehrung wird ausschliesslich von **angenommenen** Paketen abgetragen
/// (s. [`Neuaufbauten::erfolg`]), nicht von einem Zeitgeber. Damit ist 5 gegen
/// 30 keine Abwaegung zwischen zwei Risiken, sondern nur die Frage, wie lange
/// ein arbeitender Decoder unnoetig unter Verdacht steht.
///
/// Was der Zuschauer stattdessen bekommt, wenn eine Leitung dauernd stoert:
/// ein wiederkehrend stockendes Bild statt eines Rauswurfs. Dass das Bild tot
/// ist oder die Verbindung steht, faengt nicht dieser Zaehler ab, sondern der
/// Einfrier-Waechter ([`crate::einfrieren`]) und der Stille-Abbruch in
/// [`crate::session`] — beide unabhaengig davon.
const BEWAEHRUNG: Duration = Duration::from_secs(5);

/// Was nach einer abgelehnten Einheit zu tun ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorAction {
    /// Vereinzelt — weitermachen.
    Ignore,
    /// Anhaltend — Decoder neu aufbauen.
    Rebuild,
    /// Auch nach Neuaufbau kaputt — Sitzung beenden.
    GiveUp,
}

pub fn classify(consecutive_errors: u32, rebuilds: u32) -> ErrorAction {
    if consecutive_errors < ERROR_LIMIT {
        ErrorAction::Ignore
    } else if rebuilds < MAX_REBUILDS {
        ErrorAction::Rebuild
    } else {
        ErrorAction::GiveUp
    }
}

/// Buchfuehrung ueber die Neuaufbauten samt Bewaehrung.
///
/// **Warum nicht [`crate::stockung::Waechter`]** — die Frage liegt nahe, weil
/// beide im selben `VideoDecoder` stecken und beide „N Ereignisse, dann ist es
/// ein Muster" sagen. Der `Waechter` klingt am ABSTAND der Ereignisse ab
/// (gleitendes Fenster ueber die letzten Zeitpunkte), diese Buchfuehrung
/// ausschliesslich an ERBRACHTER ARBEIT. Der Unterschied ist genau der Fall,
/// den [`Neuaufbauten::erfolg`] abfaengt: ein Decoder, der gar nichts mehr
/// annimmt, wuerde mit einem Gleitfenster allein durch Zeitablauf entlastet.
/// Nachgebaut waere das eine Verhaltensaenderung, keine Vereinfachung.
#[derive(Debug, Default)]
pub struct Neuaufbauten {
    anzahl: u32,
    /// Wann zuletzt neu aufgebaut wurde. `None` heisst: noch nie, oder der
    /// letzte Aufbau hat sich bewaehrt.
    seit: Option<Instant>,
}

impl Neuaufbauten {
    /// Wie viele Neuaufbauten aktuell gegen den Decoder zaehlen.
    pub fn anzahl(&self) -> u32 {
        self.anzahl
    }

    /// Einen Neuaufbau verbuchen. Liefert die neue Anzahl (fuer die Meldung).
    pub fn gezaehlt(&mut self, jetzt: Instant) -> u32 {
        self.anzahl += 1;
        self.seit = Some(jetzt);
        self.anzahl
    }

    /// Ein Paket wurde angenommen — der Decoder arbeitet also.
    ///
    /// Hat er das lange genug getan, faellt der Zaehler auf null zurueck. Nur
    /// hier, und nicht in einem Zeitgeber: die Bewaehrung soll geleistet und
    /// nicht abgesessen werden.
    pub fn erfolg(&mut self, jetzt: Instant) {
        if self.seit.is_some_and(|s| jetzt.duration_since(s) >= BEWAEHRUNG) {
            self.anzahl = 0;
            self.seit = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vereinzelte_fehler_bleiben_folgenlos() {
        assert_eq!(classify(ERROR_LIMIT - 1, 0), ErrorAction::Ignore);
        assert_eq!(classify(ERROR_LIMIT - 1, MAX_REBUILDS), ErrorAction::Ignore);
    }

    #[test]
    fn fehlerserie_baut_neu_auf_und_gibt_erst_danach_auf() {
        assert_eq!(classify(ERROR_LIMIT, 0), ErrorAction::Rebuild);
        assert_eq!(classify(ERROR_LIMIT, MAX_REBUILDS - 1), ErrorAction::Rebuild);
        assert_eq!(classify(ERROR_LIMIT, MAX_REBUILDS), ErrorAction::GiveUp);
    }

    /// Der eigentliche Befund vom 2026-08-06: ein Ersatz, der sich bewaehrt
    /// hat, darf nicht ewig gegen den Decoder zaehlen.
    #[test]
    fn bewaehrter_neuaufbau_zaehlt_nicht_mehr() {
        let t0 = Instant::now();
        let mut n = Neuaufbauten::default();
        n.gezaehlt(t0);
        // Kurz danach angenommene Pakete tragen die Bewaehrung noch nicht ab.
        n.erfolg(t0 + BEWAEHRUNG - Duration::from_millis(1));
        assert_eq!(n.anzahl(), 1, "vor Ablauf der Bewaehrung darf nichts fallen");
        n.erfolg(t0 + BEWAEHRUNG);
        assert_eq!(n.anzahl(), 0, "nach der Bewaehrung faellt der Zaehler");
    }

    /// Der Fall, den der Zaehler seit jeher abdecken soll, muss weiter greifen:
    /// ein Ersatz, der sofort wieder scheitert, verbraucht beide Versuche.
    #[test]
    fn sofort_wieder_kaputter_ersatz_fuehrt_weiter_zum_aufgeben() {
        let t0 = Instant::now();
        let mut n = Neuaufbauten::default();
        assert_eq!(n.gezaehlt(t0), 1);
        // Eine Sekunde spaeter — viel zu frueh fuer eine Bewaehrung.
        let t1 = t0 + Duration::from_secs(1);
        n.erfolg(t1);
        assert_eq!(n.gezaehlt(t1), 2);
        assert_eq!(classify(ERROR_LIMIT, n.anzahl()), ErrorAction::GiveUp);
    }

    /// Der gemessene Fall aus dem Pruefungslauf vom 2026-08-06: drei Serien im
    /// Abstand von 13,5 und 16,6 Sekunden auf einer Leitung mit Verlust. Mit
    /// der ersten Fassung (30 s Bewaehrung) endete die Sitzung dabei; sie darf
    /// es jetzt nicht mehr.
    #[test]
    fn serien_im_abstand_von_sekunden_beenden_die_sitzung_nicht() {
        let t0 = Instant::now();
        let mut n = Neuaufbauten::default();
        n.gezaehlt(t0);
        let t1 = t0 + Duration::from_millis(13_500);
        n.erfolg(t1); // dazwischen wurde 13,5 s lang dekodiert
        assert_eq!(n.anzahl(), 0, "nach 13,5 s Arbeit darf nichts mehr anhaengen");
        n.gezaehlt(t1);
        let t2 = t1 + Duration::from_millis(16_600);
        n.erfolg(t2);
        assert_eq!(classify(ERROR_LIMIT, n.anzahl()), ErrorAction::Rebuild);
    }

    /// Ein Decoder, der gar nichts mehr annimmt, bewaehrt sich nie — auch
    /// wenn viel Zeit vergeht. Sonst wuerde ausgerechnet der tote Decoder von
    /// der Bewaehrung profitieren.
    #[test]
    fn ohne_angenommenes_paket_keine_bewaehrung() {
        let t0 = Instant::now();
        let mut n = Neuaufbauten::default();
        n.gezaehlt(t0);
        n.gezaehlt(t0 + Duration::from_secs(1));
        // Keine `erfolg`-Meldung, egal wie lange.
        assert_eq!(n.anzahl(), 2);
        assert_eq!(classify(ERROR_LIMIT, n.anzahl()), ErrorAction::GiveUp);
    }
}
