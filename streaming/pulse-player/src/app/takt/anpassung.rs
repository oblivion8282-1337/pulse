//! Der Vorhalt darf mitwachsen, wenn die Leitung es verlangt — und wieder
//! zurueckgehen, wenn sie sich beruhigt.
//!
//! Kindmodul von [`super`] wie [`super::fernsteuerung`]: es fasst `vorhalt` an,
//! und der ist privat.
//!
//! ## Warum nicht einfach ein groesserer fester Wert
//!
//! Der naheliegende Schluss war: der Vorhalt (30 ms) ist kleiner als eine
//! NACK-Nachlieferung (rund 61 ms, gemessen, s. `proto.rs`), also gehoert er
//! angehoben — ein per Nachlieferung GERETTETES Paket verpasst sonst trotzdem
//! seinen Anzeigetermin.
//!
//! **Die eigene Messreihe sagt etwas anderes** (2026-08-07, 1080p144, Akte
//! `player-2026-08-07-ausgabetakt-warteschlange.json`): 60 ms brachte gegenueber
//! 30 ms KEINE Verbesserung bei den zu spaeten Bildern (2-5 gegen 2-4 je
//! Sekunde), kostete aber die doppelte Verzoegerung. Ein fest angehobener Wert
//! waere also gegen die Messung — er zahlte Latenz fuer nichts.
//!
//! Beides passt zusammen, wenn man es zeitlich trennt: die 2-4 zu spaeten
//! Bilder je Sekunde im Normalbetrieb kommen NICHT vom Jitter (sonst haette
//! mehr Vorhalt sie gefangen), sondern sind der Bodensatz aus Decode- und
//! Ankunfts-Ausreissern. Nachlieferungen dagegen treten in Schueben auf, wenn
//! die Leitung gerade schlecht ist. Genau dafuer ist dieser Regler da: im
//! Normalfall bleibt der gemessene Bestwert stehen, und nur wenn es laengere
//! Zeit haeuft, wird der Vorrat groesser.
//!
//! ## Wo er NICHT greift
//!
//! Bei ausgeschaltetem Takt (`vorhalt == 0`): dort ist „aus" eine Ansage und
//! kein Startwert.
//!
//! ## Waehrend einer Fernsteuerung greift er — seit 2026-08-16
//!
//! **Hier stand das Gegenteil**, und zwar mit guter Begruendung, solange der
//! Fern-Vorhalt 5 ms betrug: ein Regler, der ihn bei Stoerung anhebt, machte
//! genau die Absenkung zunichte, auf die es beim Steuern ankommt.
//!
//! Mit [`super::fernsteuerung::FERN_VORHALT_MS`] = 30 ms kippt die Abwaegung.
//! Der Wert ist keine kuenstliche Absenkung mehr, sondern derselbe, den der
//! Regler beim Zusehen ohnehin als Ausgangspunkt nimmt — und auf der
//! gemessenen Strecke hat er sich von dort aus selbst auf 45 hochgeregelt. Ihn
//! ausgerechnet beim Steuern festzunageln hiesse, die Regelung dort
//! abzuschalten, wo eine unruhige Leitung am meisten stoert.
//!
//! Der Fern-Wert ist stattdessen die **Untergrenze**: angehoben werden darf,
//! unter 30 geht es waehrend des Steuerns nicht zurueck. Was der Regler dabei
//! anhebt, ist mit dem Ende der Fernsteuerung ohnehin vergessen —
//! `fernsteuerung(false)` stellt genau den Wert von davor wieder her.

use std::time::{Duration, Instant};

use super::Ausgabetakt;

/// Laenge eines Beobachtungsfensters.
///
/// Zwei Sekunden, weil der Regler auf ANHALTENDE Stoerung reagieren soll und
/// nicht auf einen einzelnen Ausreisser: bei 60 fps sind das 120 Bilder, genug
/// fuer eine belastbare Zahl, und kurz genug, dass eine schlechter werdende
/// Leitung nicht minutenlang ungefangen bleibt.
const FENSTER: Duration = Duration::from_secs(2);

/// Ab so vielen zu spaeten Bildern JE SEKUNDE im Fenster wird angehoben.
///
/// Fuenf liegt ueber dem gemessenen Bodensatz des Normalbetriebs (2-4 je
/// Sekunde, s. Modulkopf) — sonst regelte der Regler gegen ein Rauschen an, das
/// mehr Vorhalt gar nicht beseitigt, und liefe immer bis zur Obergrenze.
const HOCH_AB: u64 = 5;

/// So viele ruhige Fenster in Folge, bevor wieder gesenkt wird.
///
/// Absenken ist die riskantere Richtung: sie kann das Ruckeln zurueckholen, das
/// gerade behoben wurde. Deshalb traege — erst nach drei ruhigen Fenstern (rund
/// sechs Sekunden), und dann nur eine Stufe.
const RUHIG_BIS_RUNTER: u32 = 3;

/// Schrittweite je Anpassung.
const STUFE_MS: u32 = 15;

/// Obergrenze der Anpassung.
///
/// 105 ms deckt die gemessene NACK-Umlaufzeit (rund 61 ms) mit Reserve ab, und
/// darueber hinaus hilft mehr Vorrat nicht mehr gegen Jitter — was dann noch zu
/// spaet kommt, ist verloren und nicht bloss verspaetet. Bleibt zugleich weit
/// unter [`VORHALT_MAX_MS`] (500), das die harte Grenze fuer von Hand gesetzte
/// Werte ist.
const OBERGRENZE_MS: u32 = 105;

/// Zustand des Reglers. Liegt im [`Ausgabetakt`], damit er dessen privaten
/// Vorhalt anfassen kann.
pub(super) struct Anpassung {
    /// Der eingestellte Wert — die UNTERgrenze der Regelung. Ein Anheben ist
    /// eine Reaktion auf die Leitung, kein neuer Wunsch des Nutzers; sinkt die
    /// Stoerung, gehoert genau hierher zurueckgeregelt.
    basis: Duration,
    fenster_start: Option<Instant>,
    /// Stand des `verspaetet`-Zaehlers zu Fensterbeginn.
    verspaetet_start: u64,
    ruhige_fenster: u32,
}

impl Anpassung {
    pub(super) fn neu(basis: Duration) -> Self {
        Self { basis, fenster_start: None, verspaetet_start: 0, ruhige_fenster: 0 }
    }

    /// Ein von Hand gesetzter Vorhalt ist die neue Untergrenze — und beendet
    /// die laufende Regelung, statt sie auf dem alten Fenster weiterrechnen zu
    /// lassen.
    pub(super) fn basis_setzen(&mut self, basis: Duration) {
        self.basis = basis;
        self.fenster_start = None;
        self.ruhige_fenster = 0;
    }
}

impl Ausgabetakt {
    /// Ein Fenster auswerten, falls eines voll ist. Wird aus `einreihen`
    /// gerufen — also genau dort, wo `verspaetet` hochgezaehlt wird, und ohne
    /// eigenen Zeitgeber.
    pub(super) fn anpassen(&mut self, jetzt: Instant) {
        // Ausgeschalteter Takt: nicht anfassen — „aus" ist eine Ansage und kein
        // Startwert (Modulkopf).
        if !self.aktiv() {
            self.anpassung.fenster_start = None;
            return;
        }
        let fern = self.vorhalt_vor_fern.is_some();
        let Some(start) = self.anpassung.fenster_start else {
            self.anpassung.fenster_start = Some(jetzt);
            self.anpassung.verspaetet_start = self.verspaetet;
            return;
        };
        let dauer = jetzt.saturating_duration_since(start);
        if dauer < FENSTER {
            return;
        }

        let zu_spaet = self.verspaetet.saturating_sub(self.anpassung.verspaetet_start);
        let je_sekunde = zu_spaet as f64 / dauer.as_secs_f64();
        let ist_ms = self.vorhalt.as_millis() as u32;
        // Untergrenze des Reglers. Waehrend einer Fernsteuerung ist das der
        // Fern-Wert und nicht die Basis des Nutzers: der Regler soll bei
        // Stoerung anheben duerfen, aber danach wieder auf den Wert
        // zurueckfinden, der fuer das Steuern gedacht ist — und nicht auf eine
        // Basis, die der Nutzer fuers Zusehen gewaehlt hat.
        let boden_ms = if fern {
            super::fernsteuerung::FERN_VORHALT_MS
        } else {
            self.anpassung.basis.as_millis() as u32
        };

        let ziel_ms = if je_sekunde >= HOCH_AB as f64 {
            self.anpassung.ruhige_fenster = 0;
            let ziel = (ist_ms + STUFE_MS).min(OBERGRENZE_MS);
            // Die Warteschlange traegt nicht beliebig viel; ueber ihre Kapazitaet
            // hinaus anzuheben brachte nur verdraengte Bilder statt Glaettung —
            // der Regler regelte gegen eine Wand und meldete Erfolg.
            //
            // Solange die Bildrate unbekannt ist, gibt es keine Grenze zu
            // ziehen. NICHT `wirksamer_vorhalt` nehmen: das liefert dann den
            // AKTUELLEN Wert, und jedes Anheben waere still blockiert — genau
            // das ist beim Bau passiert.
            match self.tragbarer_vorhalt() {
                Some(tragbar) => ziel.min((tragbar.as_millis() as u32).max(ist_ms)),
                None => ziel,
            }
        } else if zu_spaet == 0 {
            self.anpassung.ruhige_fenster += 1;
            if self.anpassung.ruhige_fenster >= RUHIG_BIS_RUNTER {
                self.anpassung.ruhige_fenster = 0;
                ist_ms.saturating_sub(STUFE_MS).max(boden_ms)
            } else {
                ist_ms
            }
        } else {
            // Dazwischen: weder Stoerung noch Ruhe — halten. Sonst pendelte der
            // Wert im Bodensatz-Bereich staendig auf und ab.
            self.anpassung.ruhige_fenster = 0;
            ist_ms
        };

        if ziel_ms != ist_ms {
            // `vorhalt_anwenden` und NICHT `setze_vorhalt`: letzteres setzt die
            // Untergrenze neu (dort begruendet) — das ist der Weg des Nutzers,
            // nicht der der Regelung.
            self.vorhalt_anwenden(ziel_ms);
            eprintln!(
                "[takt] Vorhalt {ist_ms} -> {ziel_ms} ms ({je_sekunde:.1} zu spaete Bilder/s)"
            );
        }

        // Fensterschnitt IMMER am Ende — auch nach einer Aenderung.
        self.anpassung.fenster_start = Some(jetzt);
        self.anpassung.verspaetet_start = self.verspaetet;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Fenster mit `n` zu spaeten Bildern simulieren, ohne echte Bilder zu
    /// bauen: der Regler liest nur den Zaehler und die Uhr.
    fn fenster(takt: &mut Ausgabetakt, jetzt: &mut Instant, zu_spaet: u64) {
        takt.verspaetet += zu_spaet;
        *jetzt += FENSTER + Duration::from_millis(1);
        takt.anpassen(*jetzt);
    }

    fn neu_mit_fenster(ms: u32) -> (Ausgabetakt, Instant) {
        let mut takt = Ausgabetakt::neu(ms);
        let jetzt = Instant::now();
        takt.anpassen(jetzt); // erstes Fenster oeffnen
        (takt, jetzt)
    }

    #[test]
    fn anhaltende_verspaetung_hebt_stufenweise_an() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        fenster(&mut takt, &mut jetzt, 20); // 10/s — deutlich ueber HOCH_AB
        assert_eq!(takt.vorhalt_ms(), 45);
        fenster(&mut takt, &mut jetzt, 20);
        assert_eq!(takt.vorhalt_ms(), 60);
    }

    #[test]
    fn der_gemessene_bodensatz_loest_nichts_aus() {
        // 2-4 zu spaete Bilder je Sekunde sind der Normalbetrieb (Modulkopf) —
        // genau dagegen half mehr Vorhalt in der Messung NICHT. Der Regler muss
        // hier stillhalten, sonst laeuft er immer bis zur Obergrenze.
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        for _ in 0..5 {
            fenster(&mut takt, &mut jetzt, 8); // 4/s
        }
        assert_eq!(takt.vorhalt_ms(), 30, "Bodensatz darf nicht regeln");
    }

    #[test]
    fn ruhe_senkt_wieder_bis_zur_basis_und_nicht_darunter() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        fenster(&mut takt, &mut jetzt, 20);
        assert_eq!(takt.vorhalt_ms(), 45);
        for _ in 0..RUHIG_BIS_RUNTER {
            fenster(&mut takt, &mut jetzt, 0);
        }
        assert_eq!(takt.vorhalt_ms(), 30, "eine Stufe zurueck");
        for _ in 0..(RUHIG_BIS_RUNTER * 3) {
            fenster(&mut takt, &mut jetzt, 0);
        }
        assert_eq!(takt.vorhalt_ms(), 30, "nie unter den eingestellten Wert");
    }

    #[test]
    fn die_obergrenze_haelt() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        for _ in 0..20 {
            fenster(&mut takt, &mut jetzt, 40);
        }
        assert_eq!(takt.vorhalt_ms(), u64::from(OBERGRENZE_MS));
    }

    /// **Die wichtigste Zusage dieses Moduls.** Waehrend einer Fernsteuerung
    /// darf der Regler nicht anheben — und schlechte Leitung ist genau der
    /// Fall, in dem er es sonst taete.
    #[test]
    fn waehrend_der_fernsteuerung_wird_bei_stoerung_angehoben() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        takt.fernsteuerung(true);
        let fern_ms = takt.vorhalt_ms();
        for _ in 0..5 {
            fenster(&mut takt, &mut jetzt, 40);
        }
        assert!(
            takt.vorhalt_ms() > fern_ms,
            "eine gestoerte Leitung muss auch beim Steuern mehr Vorhalt bekommen"
        );
        // Und alles Angehobene ist mit dem Ende der Fernsteuerung vergessen.
        takt.fernsteuerung(false);
        assert_eq!(takt.vorhalt_ms(), 30, "danach wieder der Wert von vorher");
    }

    /// Die Gegenrichtung: unter den Fern-Wert darf der Regler waehrend des
    /// Steuerns nicht zurueck, auch wenn die Leitung ruhig ist.
    #[test]
    fn waehrend_der_fernsteuerung_bleibt_der_fern_wert_die_untergrenze() {
        let (mut takt, mut jetzt) = neu_mit_fenster(90);
        takt.fernsteuerung(true);
        for _ in 0..30 {
            fenster(&mut takt, &mut jetzt, 0);
        }
        assert_eq!(
            takt.vorhalt_ms(),
            u64::from(super::super::fernsteuerung::FERN_VORHALT_MS),
            "bis zum Fern-Wert herunter, aber nicht darunter"
        );
    }

    #[test]
    fn ausgeschalteter_takt_bleibt_aus() {
        let (mut takt, mut jetzt) = neu_mit_fenster(0);
        for _ in 0..5 {
            fenster(&mut takt, &mut jetzt, 40);
        }
        assert_eq!(takt.vorhalt_ms(), 0, "„aus\" ist eine Ansage, kein Startwert");
    }

    /// Ein von Hand gesetzter Wert ist die neue Untergrenze — der Regler darf
    /// danach nicht auf den alten zurueckfallen.
    #[test]
    fn handbedienung_setzt_die_untergrenze_neu() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        fenster(&mut takt, &mut jetzt, 20);
        assert_eq!(takt.vorhalt_ms(), 45);
        takt.setze_vorhalt(50);
        for _ in 0..(RUHIG_BIS_RUNTER * 2) {
            fenster(&mut takt, &mut jetzt, 0);
        }
        assert_eq!(takt.vorhalt_ms(), 50);
    }
}
