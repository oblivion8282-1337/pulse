//! Der **Bildplatz**: wann das nächste Bild hinaus darf.
//!
//! ## Warum es diese Datei gibt
//!
//! Im Fern-Weg gilt „höchstens ein Bild je Bildabstand". Diese eine Regel
//! stand bis zum 2026-08-22 an zwei Stellen, die nichts voneinander wussten —
//! die Warte-Frist in [`super::warten`] und die Bremse in [`super::run`].
//! Jede für sich war richtig; zusammen haben sie die Bildrate geteilt.
//!
//! **Der Fehler.** Die Frist wurde bei JEDEM Durchlauf auf „jetzt + ein
//! Bildabstand" gesetzt, auch bei einem, der das Bild nur gehalten hat. WGC
//! liefert aber dichter als die Zielrate (Deckel
//! [`crate::capture::DECKEL_ANTEIL`] = ein halber Bildabstand), die nächste
//! Ankunft kam also stets vor der verschobenen Frist, der Heartbeat feuerte
//! nie — und der Platz des gehaltenen Bildes verfiel ersatzlos. Hinaus ging
//! nur noch jede `ceil(Bildabstand / Ankunftsabstand)`-te Ankunft. Bei
//! eingestellten 60 fps kamen dadurch je nach Wiederholrate des Schirms 36
//! bis 52 Bilder an, nie 60; beim blossen Zusehen dagegen immer 60, weil der
//! Zweig dort gar nicht läuft. Gemeldet als „die 60 fps kommen nie an".
//!
//! **Die Lehre.** Eine Frist, die einen PLATZ bewacht, darf nicht am
//! Aufwachen hängen, sondern am zuletzt bedienten Platz — sonst schiebt jeder
//! Durchlauf, der nichts sendet, den Platz vor sich her. Der Latenz-Gewinn
//! des Fern-Wegs bleibt davon unberührt: er betrifft Ankünfte, die ohnehin
//! einen vollen Bildabstand nach dem letzten Senden liegen, und die gehen
//! weiterhin sofort hinaus statt erst zum nächsten Rasterpunkt.
//!
//! ## Wie er entstehen konnte — zwei Änderungen an einem Tag Abstand
//!
//! Die Bremse kam am **2026-08-13** (`46028bf5`, Senden bei Ankunft). Sie war
//! damals folgenlos, und zwar aus einem Grund, den niemand aufschrieb: die
//! Aufnahme war auf `0,9/fps` gedeckelt, und weil WGC nur zu den Zeitpunkten
//! des Schirms liefern KANN, lagen zwei Ankünfte damit faktisch immer
//! mindestens einen Bildabstand auseinander. Die Bremse konnte gar nicht
//! greifen — sie ist nie erprobt worden.
//!
//! Am **2026-08-14**, einen Tag später, wurde der Deckel auf `0,5/fps`
//! halbiert (`9c8422ba`, gegen genau die Wiederholbilder, die der zu
//! vorsichtige Deckel erzeugte). Ab da liefert WGC DICHTER als ein
//! Bildabstand — und die nie erprobte Bremse fing an, die Bildrate zu teilen.
//!
//! Die Kommentare an der Bremse rechneten danach noch monatelang mit
//! `0,9/fps` weiter (mitkorrigiert am 2026-08-22, hier und in
//! `capture/aufnahmeziel.rs`). Wer sie las, sah eine Obergrenze, die knapp
//! über der Zielrate greift — nicht eine, die jede zweite Ankunft verwirft.
//!
//! **Was daraus folgt:** eine Zahl zu ändern, die eine ANDERE Stelle als
//! Annahme trägt, ist keine lokale Änderung. `DECKEL_ANTEIL` ist genau so
//! eine Zahl — sie steht in `capture`, ihre Wirkung entfaltet sie hier.
//!
//! ## Warum die Grenze ein BILDABSTAND ist und kein Takt
//!
//! Im alten Raster fielen beide zusammen (ein Takt war ein Bildabstand); seit
//! der feineren Zeitbasis ist ein Takt 11 µs, und ein blosses
//! `pts <= last_pts` liesse praktisch jede Ankunft durch — die Bremse wäre
//! wortlos weg.
//!
//! Wozu es sie überhaupt braucht: ginge jede Ankunft sofort hinaus, liefen
//! die Zeitstempel dauerhaft schneller als die Echtzeit, und der Ausgabe-Takt
//! des Zuschauers verankerte sich laufend neu.
//!
//! ## Warum als eigene Datei
//!
//! Beide Regeln liegen jetzt hier, in einem Modul, das ausser der Zeitbasis
//! nichts kennt — kein Windows, kein Capture, kein Encoder. Damit ist die
//! **Kadenz prüfbar**, und genau daran hat es gefehlt: der Fehler sass im
//! Zusammenspiel zweier Dateien, die einzeln beide plausibel aussahen.
//! (Dasselbe Muster wie `web/src/lib/remote/zeigerbildPruefung.ts` — die
//! reine Rechnung in ein importfreies Modul ziehen, damit sie einen Test
//! bekommen kann.)

use std::time::{Duration, Instant};

use crate::zeitbasis;

/// Der nächste Bildplatz — Fälligkeit und die Frage, ob ein Zeitstempel ihn
/// schon trägt.
pub(super) struct Bildplatz {
    faellig: Instant,
    frame_dur: Duration,
    takte_je_bild: i64,
}

impl Bildplatz {
    pub(super) fn neu(start: Instant, fps: u32) -> Self {
        Self {
            faellig: start,
            frame_dur: Duration::from_secs_f64(1.0 / f64::from(fps.max(1))),
            takte_je_bild: zeitbasis::takte_je_bild(fps),
        }
    }

    /// Wann der nächste Platz fällig ist — im Fern-Weg zugleich die Grenze,
    /// bis zu der auf eine Ankunft gewartet werden darf.
    pub(super) fn faellig(&self) -> Instant {
        self.faellig
    }

    /// Ein Bildabstand in Takten der Video-Zeitbasis.
    ///
    /// Hier heraus statt an der Aufrufstelle erneut aus `fps` gerechnet: die
    /// Bremse [`Self::traegt`] und der Zeitstempel eines Duplikats müssen
    /// **dieselbe** Zahl benutzen, sonst schiebt sich ein Duplikat um einen
    /// Takt gegen die Schwelle, die es gleich darauf passieren muss.
    pub(super) fn takte_je_bild(&self) -> i64 {
        self.takte_je_bild
    }

    /// Trägt der Platz ein Bild mit diesem Zeitstempel schon?
    ///
    /// `false` heisst: das Bild ist zu früh und wird gehalten. Es geht
    /// spätestens zur Fälligkeit als Heartbeat hinaus — der Platz darf dafür
    /// **nicht** verschoben werden.
    pub(super) fn traegt(&self, pts: i64, last_pts: i64) -> bool {
        pts >= last_pts + self.takte_je_bild
    }

    /// Ein Bild ist hinausgegangen: der nächste Platz wird einen Bildabstand
    /// nach DIESEM Bild fällig.
    ///
    /// `um` ist der Beginn der Iteration (das Aufwachen), nicht das Ende der
    /// Encode-Arbeit — sonst verlöre der Takt je Bild die Encode-Zeit und die
    /// Rate bliebe dauerhaft unter der eingestellten.
    pub(super) fn vergeben(&mut self, um: Instant) {
        self.faellig = um + self.frame_dur;
    }

    /// Zusehen: das feste Raster läuft weiter, unabhängig davon, ob etwas
    /// angekommen ist — es ist genau die Glättung, für die es da ist.
    ///
    /// Der Rückstand wird nicht angehäuft (sonst Bilder-Schwall nach einem
    /// Stocken).
    pub(super) fn weiter_im_raster(&mut self, jetzt: Instant) {
        self.faellig += self.frame_dur;
        if self.faellig < jetzt {
            self.faellig = jetzt;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fährt die Zeit-Entscheidungen des Fern-Wegs trocken durch, in
    /// derselben Reihenfolge wie [`super::super::warten::warten_und_abholen`]
    /// und [`super::super::run`]: bis zur Fälligkeit auf die nächste Ankunft
    /// warten, den Zeitstempel gegen den Platz halten, bei Erfolg den Platz
    /// vergeben.
    ///
    /// `ankunftsabstand` ist der Abstand, in dem WGC liefert — er ist die
    /// Wiederholrate des Schirms, gedeckelt auf
    /// [`crate::capture::DECKEL_ANTEIL`]`/fps`, und liegt damit im Regelfall
    /// UNTER einem Bildabstand. Genau dieser Fall war der Fehler.
    fn gesendet_je_sekunde(fps: u32, ankunftsabstand: Duration, dauer: Duration) -> f64 {
        let start = Instant::now();
        let mut platz = Bildplatz::neu(start, fps);
        let mut last_pts: i64 = -1;
        let mut jetzt = start;
        let mut naechste_ankunft = start;
        let mut neuestes = start;
        let mut gesendet = 0u32;

        while jetzt < start + dauer {
            let mut captured = 0u32;
            let faellig = platz.faellig();
            if faellig > jetzt {
                if naechste_ankunft <= faellig {
                    jetzt = naechste_ankunft;
                    neuestes = naechste_ankunft;
                    naechste_ankunft += ankunftsabstand;
                    captured = 1;
                } else {
                    // Heartbeat: nichts angekommen, das gehaltene Bild geht.
                    jetzt = faellig;
                }
            }
            let pts = if captured > 0 {
                zeitbasis::pts_aus_sekunden((neuestes - start).as_secs_f64())
            } else {
                last_pts + platz.takte_je_bild()
            };
            if captured > 0 && !platz.traegt(pts, last_pts) {
                // Gehalten — und der Platz bleibt ausdrücklich stehen.
                continue;
            }
            last_pts = pts;
            platz.vergeben(jetzt);
            gesendet += 1;
        }
        f64::from(gesendet) / dauer.as_secs_f64()
    }

    /// **Der Fehler vom 2026-08-22.** Bei 60 fps und einem WGC-Deckel von
    /// einem halben Bildabstand liefert der Schirm dichter als die Zielrate —
    /// und trotzdem müssen 60 Bilder je Sekunde hinausgehen.
    ///
    /// Die Abstände sind die echten: der erste Rasterpunkt der jeweiligen
    /// Wiederholrate, der den Deckel (8,33 ms bei 60 fps) erreicht.
    #[test]
    fn dichte_ankuenfte_kosten_keine_bildplaetze() {
        let dauer = Duration::from_secs(10);
        for (schirm, abstand_us) in [
            ("60 Hz", 16_667u64),
            ("75 Hz", 13_333),
            ("120 Hz", 8_333),
            ("144 Hz", 13_889),
            ("165 Hz", 12_121),
            ("240 Hz", 8_333),
            ("280 Hz", 10_714),
        ] {
            let rate = gesendet_je_sekunde(60, Duration::from_micros(abstand_us), dauer);
            assert!(
                (rate - 60.0).abs() <= 1.0,
                "{schirm}: {rate:.1} Bilder/s statt 60 — ein Bildplatz ist verfallen",
            );
        }
    }

    /// Die Gegenrichtung: liefert der Schirm LANGSAMER als die Zielrate, darf
    /// der Takt nichts erfinden — mehr als angekommen ist, kann nicht hinaus,
    /// aber der Heartbeat hält den Strom auf der eingestellten Rate (stehendes
    /// Bild = Duplikat, sonst stirbt der Push am MediaMTX-readTimeout).
    #[test]
    fn stehendes_bild_haelt_die_rate_ueber_duplikate() {
        let rate = gesendet_je_sekunde(60, Duration::from_secs(3600), Duration::from_secs(10));
        assert!((rate - 60.0).abs() <= 1.0, "Heartbeat liefert {rate:.1} statt 60");
    }

    /// Das Raster beim Zusehen bleibt, was es war: ein Tick je Bildabstand,
    /// unabhängig von den Ankünften.
    #[test]
    fn raster_laeuft_unabhaengig_von_ankuenften() {
        let start = Instant::now();
        let mut platz = Bildplatz::neu(start, 60);
        let frame_dur = Duration::from_secs_f64(1.0 / 60.0);
        for i in 1..=600u32 {
            platz.weiter_im_raster(start);
            assert_eq!(platz.faellig(), start + frame_dur * i);
        }
    }

    /// Ein Rückstand (langsamer Encode-Durchlauf) wird nicht nachgeholt —
    /// sonst folgte ein Schwall.
    #[test]
    fn raster_holt_rueckstand_nicht_nach() {
        let start = Instant::now();
        let mut platz = Bildplatz::neu(start, 60);
        let spaet = start + Duration::from_millis(500);
        platz.weiter_im_raster(spaet);
        assert_eq!(platz.faellig(), spaet);
    }
}
