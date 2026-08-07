//! Wie lange der Aufnahme-Rückruf den WGC-Faden belegt — **und wie viele Bilder
//! WGC dadurch höchstens verloren haben kann.**
//!
//! ## Warum es das gibt
//!
//! WGC meldet nicht, wenn es ein Bild verwirft. `capture_drops` in
//! [`super::wgc_hw`] zählt nur, was **auf unserer** Seite verlorengeht (Pool
//! erschöpft, Kanal voll, Größe geändert) — alles, was WGC schon vorher fallen
//! lässt, weil unser Rückruf den Faden besetzt hält, erscheint dort in keiner
//! Zahl. Solange der Rückruf nichts weiter tat als eine Kopie abzusetzen, war
//! das eine theoretische Lücke. Sobald dort gerechnet wird (Farbwandlung im
//! Rückruf, s. [`super::aufnahmeziel`]), ist sie es nicht mehr: dann tauschte
//! man messbare Last gegen unsichtbaren Bildverlust.
//!
//! ## Was gezählt wird — und warum es keine Schätzung ist
//!
//! WGC ruft `on_frame_arrived` **auf einem Faden und der Reihe nach** auf.
//! Daraus folgt eine Schranke, die man nicht messen muss, sondern hinschreiben
//! kann:
//!
//! > Ein Rückruf, der kürzer ist als der Abstand, in dem WGC überhaupt liefert,
//! > kann kein Bild kosten — der Faden ist rechtzeitig wieder frei.
//!
//! Also zählt diese Wacht nicht Verluste (die kennt niemand), sondern deren
//! **Obergrenze**: während ein Rückruf `d` dauert, sind `floor(d / abstand)`
//! Lieferzeitpunkte verstrichen, an denen der Faden besetzt war. Bei
//! `d < abstand` ist das null. **Eine Null ist damit ein Beweis und keine
//! Beobachtung** — genau das, was der Umbau als Vorbedingung braucht.
//!
//! ## Was sie NICHT sieht
//!
//! Verluste, die nicht an uns liegen (Treiber, Fenster-Wechsel, überlastete
//! Karte). Dagegen hilft nur die **Aufnahmerate** selbst, also `captured` je
//! Sekunde in der Spur — fällt die, ist etwas los, auch wenn hier null steht.
//! Und ist der Liefer-Deckel gar nicht in Kraft (Windows < 24H2, s.
//! [`super::min_interval_settings`]), liefert WGC mit der Wiederholrate des
//! Schirms; der Abstand unten ist dann zu großzügig und die Schranke zu
//! freundlich. Beides steht bewusst hier und nicht nur in einer Messakte.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Zähler des Aufnahme-Rückrufs. Vom WGC-Faden geschrieben, vom Taktfaden je
/// Tick gelesen — alles lock-frei, damit das Lesen den Aufnahmefaden nicht
/// anfassen kann.
pub struct RueckrufWacht {
    /// Kleinster Abstand, in dem WGC liefern kann, in Mikrosekunden. Alles
    /// darunter ist für die Schranke oben folgenlos.
    abstand_us: u64,
    anzahl: AtomicU64,
    summe_us: AtomicU64,
    max_us: AtomicU64,
    ueberlang: AtomicU64,
    verlust_obergrenze: AtomicU64,
}

/// Ein Abzug der Zähler. Kumulativ seit Start — Fensterwerte bildet der
/// Aufrufer als Differenz (so macht es `tick_monitor` mit `capture_drops` seit
/// jeher, und zwei Bauarten nebeneinander wären eine Fehlerquelle mehr).
#[derive(Debug, Clone, Copy, Default)]
pub struct RueckrufStand {
    pub anzahl: u64,
    pub summe_us: u64,
    /// Längster je gemessener Rückruf.
    pub max_us: u64,
    /// Rückrufe, die über den Lieferabstand hinausgingen.
    pub ueberlang: u64,
    /// **Obergrenze** der Bilder, die WGC deswegen verworfen haben kann.
    pub verlust_obergrenze: u64,
}

impl RueckrufStand {
    /// Was seit `vorher` passiert ist, als eine Zeile für die
    /// Zwei-Sekunden-Zusammenfassung.
    ///
    /// **Die letzte Zahl trägt ein „<=", und das ist keine Zierde:** sie ist
    /// eine Schranke, kein Zählwerk. Wer sie als gemessenen Verlust liest,
    /// behauptet mehr, als hier steht. Der Text wohnt deshalb hier und nicht im
    /// `tick_monitor` — die Vorsicht gehört zur Zahl, nicht zur Ausgabe.
    pub fn bericht_seit(&self, vorher: &RueckrufStand) -> String {
        let n = self.anzahl.saturating_sub(vorher.anzahl);
        if n == 0 {
            return "rueckruf n/a".into();
        }
        let sum = self.summe_us.saturating_sub(vorher.summe_us);
        format!(
            // `max_gesamt` und nicht `max`: der laengste Rueckruf ist ein
            // Hoechstwert seit Start, kein Fensterwert — und er ist im
            // Regelfall der ALLERERSTE (dort entstehen Pool, Shader und
            // Ansichten). Wer ihn als Fensterwert liest, sieht die
            // Einmalkosten in jeder Zeile wieder.
            "rueckruf avg={:.2}ms max_gesamt={:.2}ms ({n}), {} ueberlang, \
             <={} Bilder WGC-seitig verloren",
            sum as f64 / n as f64 / 1000.0,
            self.max_us as f64 / 1000.0,
            self.ueberlang.saturating_sub(vorher.ueberlang),
            self.verlust_obergrenze.saturating_sub(vorher.verlust_obergrenze),
        )
    }
}

impl RueckrufWacht {
    /// `max_fps` ist die Zielbildrate des Streams; daraus folgt der Deckel, mit
    /// dem [`super::min_interval_settings`] die Lieferung drosselt. **Dieselbe
    /// Zahl wie dort**, und deshalb steht sie hier nicht noch einmal als
    /// Literal: `0,9/fps` — der Zehntel Sicherheitsabstand ist dort begründet.
    pub fn neu(max_fps: u32) -> Self {
        let abstand_us = if max_fps == 0 {
            // Ohne Zielbildrate gibt es keinen Deckel; dann ist jede Dauer
            // erlaubt, und die Schranke sagt schlicht nichts aus. Besser als
            // eine erfundene Zahl, an der man sich später festhält.
            u64::MAX
        } else {
            (0.9 / max_fps as f64 * 1_000_000.0) as u64
        };
        Self {
            abstand_us,
            anzahl: AtomicU64::new(0),
            summe_us: AtomicU64::new(0),
            max_us: AtomicU64::new(0),
            ueberlang: AtomicU64::new(0),
            verlust_obergrenze: AtomicU64::new(0),
        }
    }

    /// Einen abgeschlossenen Rückruf verbuchen.
    pub fn verbuchen(&self, dauer: Duration) {
        let us = dauer.as_micros() as u64;
        self.anzahl.fetch_add(1, Ordering::Relaxed);
        self.summe_us.fetch_add(us, Ordering::Relaxed);
        self.max_us.fetch_max(us, Ordering::Relaxed);
        // Ganzzahlige Division ist hier die Aussage, nicht eine Sparsamkeit:
        // `floor` zählt die vollständig verstrichenen Lieferzeitpunkte. Ein
        // Rückruf von 1,5 Abständen hat genau EINEN sicher überdeckt.
        let verpasst = us / self.abstand_us;
        if verpasst > 0 {
            self.ueberlang.fetch_add(1, Ordering::Relaxed);
            self.verlust_obergrenze.fetch_add(verpasst, Ordering::Relaxed);
        }
    }

    pub fn stand(&self) -> RueckrufStand {
        RueckrufStand {
            anzahl: self.anzahl.load(Ordering::Relaxed),
            summe_us: self.summe_us.load(Ordering::Relaxed),
            max_us: self.max_us.load(Ordering::Relaxed),
            ueberlang: self.ueberlang.load(Ordering::Relaxed),
            verlust_obergrenze: self.verlust_obergrenze.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bei 60 Bildern je Sekunde liegt der Deckel bei 15,0 ms. Ein Rückruf
    /// darunter kostet nichts — das ist die ganze Aussage der Wacht, und sie
    /// gehört festgehalten, damit ein späteres „Vereinfachen" des Abstands
    /// nicht still eine andere Schranke einsetzt.
    #[test]
    fn kurze_rueckrufe_kosten_nichts() {
        let w = RueckrufWacht::neu(60);
        for us in [10u64, 900, 1_820, 5_000, 14_999] {
            w.verbuchen(Duration::from_micros(us));
        }
        let s = w.stand();
        assert_eq!(s.anzahl, 5);
        assert_eq!(s.ueberlang, 0);
        assert_eq!(s.verlust_obergrenze, 0);
        assert_eq!(s.max_us, 14_999);
    }

    /// Und darüber zählt sie vollständig verstrichene Lieferzeitpunkte, nicht
    /// Rückrufe: ein einziger langer Rückruf kann mehrere Bilder kosten.
    #[test]
    fn lange_rueckrufe_zaehlen_verstrichene_lieferzeitpunkte() {
        let w = RueckrufWacht::neu(60);
        w.verbuchen(Duration::from_micros(15_000)); // genau einer
        w.verbuchen(Duration::from_micros(46_000)); // drei
        let s = w.stand();
        assert_eq!(s.ueberlang, 2);
        assert_eq!(s.verlust_obergrenze, 4);
    }

    /// Ohne Zielbildrate gibt es keinen Deckel und damit keine Schranke —
    /// dann darf sie auch nichts behaupten (und vor allem nicht durch Null
    /// teilen).
    #[test]
    fn ohne_bildrate_keine_behauptung() {
        let w = RueckrufWacht::neu(0);
        w.verbuchen(Duration::from_secs(1));
        let s = w.stand();
        assert_eq!(s.verlust_obergrenze, 0);
        assert_eq!(s.max_us, 1_000_000);
    }
}
