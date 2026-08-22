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

/// So viele gemessene Bilder braucht ein Fenster, bevor seine Reserve eine
/// Absenkung tragen darf.
///
/// Der Anker des Takts zieht sich in den ersten Sekunden noch auf die kuerzeste
/// Laufzeit; was er dabei als Reserve meldet, ist zu gut. 30 Bilder sind bei
/// 60 fps eine halbe Sekunde — genug, dass ein einzelner guter Augenblick die
/// Entscheidung nicht traegt, und wenig genug, dass ein 2-s-Fenster sie auch
/// bei 30 fps erreicht.
const MESS_MINDESTBILDER: u32 = 30;

/// Wie viel von der gemessenen Reserve ein Absenken hoechstens aufbraucht.
///
/// **Ein Verhaeltnis und keine Millisekundenzahl, und das ist Absicht.** Genau
/// an einer festen Zahl ist der Vorhalt zweimal gescheitert (Modulkopf von
/// [`super::fernsteuerung`]): sie stammte beide Male von genau einer Leitung.
/// Ein Verhaeltnis skaliert mit jeder Strecke von selbst — und es ist
/// selbstbremsend: jede Absenkung laesst die Haelfte stehen, naehert sich der
/// Kante also, ohne sie je zu erreichen.
const MESS_TEILER: u32 = 2;

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
    /// Die knappste Reserve im laufenden Fenster und wie viele Bilder sie
    /// getragen haben.
    ///
    /// **Eigene Buchfuehrung statt `reserve::Reserve` mitzulesen**, obwohl
    /// dieselbe Zahl dort schon steht: jenes Fenster gehoert der
    /// Zusammenfassung im Log und wird von ihr im Sekundentakt geleert. Ein
    /// Regler, dessen Entscheidung davon abhinge, ob und wann jemand ein Log
    /// abholt, waere nicht nachvollziehbar.
    knappste: Option<Duration>,
    gemessene_bilder: u32,
    /// Der Vorhalt, gegen den die laufende Messung gilt — wie in
    /// [`super::reserve`]: aendert er sich, wird verworfen statt
    /// weitergezaehlt.
    gemessen_bei: Duration,
}

impl Anpassung {
    pub(super) fn neu(basis: Duration) -> Self {
        Self {
            basis,
            fenster_start: None,
            verspaetet_start: 0,
            ruhige_fenster: 0,
            knappste: None,
            gemessene_bilder: 0,
            gemessen_bei: Duration::ZERO,
        }
    }

    /// Ein von Hand gesetzter Vorhalt ist die neue Untergrenze — und beendet
    /// die laufende Regelung, statt sie auf dem alten Fenster weiterrechnen zu
    /// lassen.
    pub(super) fn basis_setzen(&mut self, basis: Duration) {
        self.basis = basis;
        self.fenster_start = None;
        self.ruhige_fenster = 0;
        self.messung_zuruecksetzen();
    }

    fn messung_zuruecksetzen(&mut self) {
        self.knappste = None;
        self.gemessene_bilder = 0;
    }
}

impl Ausgabetakt {
    /// Ein Fenster auswerten, falls eines voll ist. Wird aus `einreihen`
    /// gerufen — also genau dort, wo `verspaetet` hochgezaehlt wird, und ohne
    /// eigenen Zeitgeber.
    /// `reserve` ist die Reserve des eben eingereihten Bildes, wie
    /// [`super::reserve::Reserve::buchen`] sie verbucht hat — `None`, wenn
    /// nichts zu messen war.
    pub(super) fn anpassen(&mut self, jetzt: Instant, reserve: Option<Duration>) {
        // Ausgeschalteter Takt: nicht anfassen — „aus" ist eine Ansage und kein
        // Startwert (Modulkopf).
        if !self.aktiv() {
            self.anpassung.fenster_start = None;
            return;
        }
        self.reserve_merken(reserve);
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
        // Untergrenze des Reglers ist IMMER die Basis — der zuletzt von Hand
        // gesetzte Wert. Anheben ist eine Reaktion auf die Leitung, kein neuer
        // Wunsch; sinkt die Stoerung, gehoert genau dorthin zurueckgeregelt.
        //
        // **Auch waehrend einer Fernsteuerung, und das ist kein Sonderfall.**
        // Hier stand bis zum 2026-08-19 ein zweiter Zweig, der beim Steuern
        // `fernsteuerung::FERN_VORHALT_MS` als Boden nahm. Der war erst falsch
        // — er hob einen tiefer eingestellten Wert an
        // (`PULSE_PLAYER_AUSGABETAKT_MS=2`, Pruefstand) und tat damit genau
        // das, was `fernsteuerung()` ausschliesst („nur senken, nie anheben"):
        // nach drei ruhigen Fenstern rechnete `2.saturating_sub(15).max(30)`
        // den Vorhalt auf 30 hoch. Und mit der naheliegenden Reparatur
        // (`FERN_VORHALT_MS.min(basis)`) war er beweisbar wirkungslos: waehrend
        // einer Fernsteuerung ist die Basis ohnehin schon hoechstens der
        // Fern-Wert, weil BEIDE Wege dorthin ueber `setze_vorhalt` →
        // `basis_setzen` laufen — `fernsteuerung(true)` senkt sie, und
        // `setze_vorhalt_vom_nutzer` haelt die Senkung waehrenddessen ein.
        //
        // Die Untergrenze des Steuerns steht damit an der Stelle, an der sie
        // hergestellt wird, und nicht ein zweites Mal hier. Wer sie doch wieder
        // hier braucht, hat vorher einen Weg gebaut, der die Basis waehrend der
        // Fernsteuerung anhebt — und der gehoert dann dort geradegerueckt.
        let boden_ms = self.anpassung.basis.as_millis() as u32;

        // Ob die MESSUNG diesen Schritt bestimmt hat — nur dann darf die
        // Log-Zeile sie als Grund nennen.
        let mut gemessener_boden = None;
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
                gemessener_boden = self.senk_boden_ms(boden_ms, ist_ms);
                ist_ms.saturating_sub(STUFE_MS).max(gemessener_boden.unwrap_or(boden_ms))
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
            // **Der Grund gehoert in die Zeile.** Beim Senken ist
            // `zu spaete Bilder/s` immer 0,0 — das erklaert ein Anheben, aber
            // nicht das Gegenteil. Seit die Absenkung an der gemessenen
            // Reserve haengt (s. `senk_boden_ms`), steht sie hier daneben:
            // sonst laesst sich in einem Protokoll nicht mehr unterscheiden,
            // ob ein Schritt aus der Messung kam oder aus der alten
            // Stufen-Mechanik gegen die Basis.
            let grund = match (gemessener_boden, self.anpassung.knappste) {
                (Some(_), Some(k)) => format!("knappste Reserve {} ms", k.as_millis()),
                _ => format!("{je_sekunde:.1} zu spaete Bilder/s"),
            };
            eprintln!("[takt] Vorhalt {ist_ms} -> {ziel_ms} ms ({grund})");
        }

        // Fensterschnitt IMMER am Ende — auch nach einer Aenderung.
        self.anpassung.fenster_start = Some(jetzt);
        self.anpassung.verspaetet_start = self.verspaetet;
        self.anpassung.messung_zuruecksetzen();
    }

    /// Wie tief dieses Absenken gehen darf.
    ///
    /// **Das ist die Stelle, an der die Messung den geratenen Wert abloest.**
    /// Ohne sie ist die Untergrenze die Basis — und die ist waehrend einer
    /// Fernsteuerung nicht der Wunsch des Nutzers, sondern
    /// [`super::fernsteuerung::FERN_VORHALT_MS`], also eine Zahl, die von genau
    /// einer Leitung abgelesen wurde. Zweimal wurde sie so gesetzt und beim
    /// naechsten Netz widerlegt (Herleitung dort).
    ///
    /// **Warum der Regler die Kante ohne Messung nicht finden kann.** Nach oben
    /// reagiert er auf Schaden (`HOCH_AB`), nach unten auf Schweigen — er hat
    /// bis hierher keinen Wert dafuer, wie viel Luft NOCH da ist. Er sucht die
    /// Untergrenze also, indem er sie ueberschreitet, und jede Abwaertsbewegung
    /// wird mit Ruckeln bezahlt. Die Basis war das Netz darunter. Mit der
    /// gemessenen Reserve gibt es einen Wert davor, und erst damit darf das Netz
    /// tiefer haengen.
    ///
    /// Drei Bedingungen, alle drei fail-closed auf den alten Weg:
    ///
    /// * **Nur beim Steuern.** Sonst ist die Basis ein Wunsch des Nutzers, und
    ///   ein Wunsch wird nicht wegmessen.
    /// * **Nur mit genug Bildern** ([`MESS_MINDESTBILDER`]).
    /// * **Nur gegen den geltenden Vorhalt** — eine Reserve, die gegen 30 ms
    ///   gemessen wurde, sagt ueber 16 ms nichts.
    /// `None` heisst „die Messung traegt hier nichts bei" — dann gilt die Basis
    /// wie bisher. **Ein `Option` und kein Rueckfall auf `basis_ms` im Innern**,
    /// damit die Log-Zeile den Grund nicht raten muss: sonst stuende dort
    /// „knappste Reserve X ms" auch unter einem Schritt, den die alte
    /// Stufen-Mechanik gemacht hat, und ein Protokoll waere nicht mehr
    /// auswertbar.
    fn senk_boden_ms(&self, basis_ms: u32, ist_ms: u32) -> Option<u32> {
        if self.vorhalt_vor_fern.is_none()
            || self.anpassung.gemessene_bilder < MESS_MINDESTBILDER
            || self.anpassung.gemessen_bei != self.vorhalt
        {
            return None;
        }
        let knappste = self.anpassung.knappste?;
        // Die knappste Reserve ist der schlechteste Fall, der noch rechtzeitig
        // war — um so viel LIESSE sich senken. Aufgebraucht wird nur die
        // Haelfte davon (s. `MESS_TEILER`).
        let erlaubt_ms = (knappste.as_millis() as u32) / MESS_TEILER;
        // Der Nutzerwunsch bleibt erreichbar, falls er tiefer liegt als die
        // harte Grenze — sie gilt dem Regler, nicht ihm.
        let hart_ms = basis_ms.min(super::fernsteuerung::FERN_VORHALT_MIN_MS);
        Some(ist_ms.saturating_sub(erlaubt_ms).max(hart_ms))
    }

    /// Die Reserve eines Bildes in das laufende Fenster aufnehmen.
    fn reserve_merken(&mut self, reserve: Option<Duration>) {
        let Some(reserve) = reserve else {
            return;
        };
        if self.vorhalt != self.anpassung.gemessen_bei {
            self.anpassung.messung_zuruecksetzen();
            self.anpassung.gemessen_bei = self.vorhalt;
        }
        let reserve = reserve.min(self.vorhalt);
        self.anpassung.knappste =
            Some(self.anpassung.knappste.map_or(reserve, |bisher| bisher.min(reserve)));
        self.anpassung.gemessene_bilder += 1;
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
        takt.anpassen(*jetzt, None);
    }

    /// Wie [`fenster`], aber mit einer gemessenen Reserve je Bild — so viele
    /// Bilder, dass die Messung als belastbar gilt.
    fn fenster_mit_reserve(
        takt: &mut Ausgabetakt,
        jetzt: &mut Instant,
        zu_spaet: u64,
        reserve_ms: u64,
    ) {
        takt.verspaetet += zu_spaet;
        let reserve = Some(Duration::from_millis(reserve_ms));
        for _ in 0..MESS_MINDESTBILDER {
            takt.anpassen(*jetzt, reserve);
        }
        *jetzt += FENSTER + Duration::from_millis(1);
        takt.anpassen(*jetzt, reserve);
    }

    fn neu_mit_fenster(ms: u32) -> (Ausgabetakt, Instant) {
        let mut takt = Ausgabetakt::neu(ms);
        let jetzt = Instant::now();
        takt.anpassen(jetzt, None); // erstes Fenster oeffnen
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
    ///
    /// **Was dieser Test seit dem 2026-08-19 wirklich festhaelt.** Der Regler
    /// hat dafuer keinen eigenen Zweig mehr (s. `anpassen`) — die Untergrenze
    /// kommt daher, dass `fernsteuerung(true)` die BASIS auf den Fern-Wert
    /// senkt. Genau das prueft er: liesse jemand `fernsteuerung()` den Vorhalt
    /// absenken, ohne die Basis mitzuziehen, regelte der Takt hier von 30 auf
    /// die 90 des Nutzers zurueck — mitten im Steuern und ohne Anlass.
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

    /// Der Weg ueber den REGLER darf die Zusage von `fernsteuerung()` nicht
    /// aushebeln: wer selbst tiefer eingestellt hat, behaelt seinen Wert auch
    /// nach ruhigen Fenstern. Bis zum 2026-08-19 rechnete der ruhige Zweig
    /// `2.saturating_sub(15).max(30)` und hob auf 30 an — der direkte Aufruf
    /// hatte dafuer einen Test, der Weg ueber den Regler nicht.
    #[test]
    fn der_regler_hebt_einen_tieferen_nutzerwert_beim_steuern_nicht_an() {
        let mut takt = Ausgabetakt::neu(2);
        takt.fernsteuerung(true);
        assert_eq!(takt.vorhalt_ms(), 2, "die Fernsteuerung senkt nur, sie hebt nicht");
        // Erst NACH `fernsteuerung()` das Fenster oeffnen: `setze_vorhalt`
        // beendet die laufende Regelung.
        let mut jetzt = Instant::now();
        takt.anpassen(jetzt, None);
        for _ in 0..(RUHIG_BIS_RUNTER * 2) {
            fenster(&mut takt, &mut jetzt, 0);
        }
        assert_eq!(takt.vorhalt_ms(), 2, "ruhige Fenster duerfen nicht auf den Fern-Wert heben");
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

    /// **Der Kern der Messkopplung.** Zeigt die Messung reichlich Luft, darf
    /// der Regler beim Steuern unter den Fern-Wert — dorthin kam er bisher
    /// nie, weil die Basis ihn dort festhielt.
    #[test]
    fn gemessene_reserve_senkt_beim_steuern_unter_den_fern_wert() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        takt.fernsteuerung(true);
        // `fernsteuerung` setzt die Basis und beendet damit das laufende
        // Fenster — hier wieder eines oeffnen.
        takt.anpassen(jetzt, None);
        for _ in 0..(RUHIG_BIS_RUNTER * 6) {
            fenster_mit_reserve(&mut takt, &mut jetzt, 0, 28);
        }
        assert_eq!(
            takt.vorhalt_ms(),
            u64::from(super::super::fernsteuerung::FERN_VORHALT_MIN_MS),
            "reichlich gemessene Reserve fuehrt bis an die harte Untergrenze"
        );
    }

    /// Und nicht weiter: die harte Untergrenze haelt auch, wenn die Messung
    /// eine absurd grosse Reserve meldet.
    #[test]
    fn die_harte_untergrenze_haelt_auch_bei_riesiger_reserve() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        takt.fernsteuerung(true);
        takt.anpassen(jetzt, None);
        for _ in 0..(RUHIG_BIS_RUNTER * 10) {
            fenster_mit_reserve(&mut takt, &mut jetzt, 0, 5_000);
        }
        assert_eq!(
            takt.vorhalt_ms(),
            u64::from(super::super::fernsteuerung::FERN_VORHALT_MIN_MS),
            "nie unter die harte Untergrenze"
        );
    }

    /// **Die Zusage, die das Ganze erst tragfaehig macht.** Ist die Reserve
    /// knapp, darf der Schritt nicht die volle Stufe sein — sonst tastet sich
    /// der Regler wie bisher ueber die Kante, nur von tiefer aus.
    ///
    /// 4 ms Reserve bei 30 ms Vorhalt: erlaubt ist die Haelfte, also 2 ms.
    #[test]
    fn knappe_reserve_erlaubt_nur_einen_kleinen_schritt() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        takt.fernsteuerung(true);
        takt.anpassen(jetzt, None);
        for _ in 0..RUHIG_BIS_RUNTER {
            fenster_mit_reserve(&mut takt, &mut jetzt, 0, 4);
        }
        assert_eq!(takt.vorhalt_ms(), 28, "hoechstens die halbe gemessene Reserve");
    }

    /// Ohne Fernsteuerung bleibt die Basis die Untergrenze, auch mit Messung —
    /// dort ist der eingestellte Wert ein Wunsch und keine geratene Konstante.
    #[test]
    fn ohne_fernsteuerung_bleibt_die_basis_die_untergrenze() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        for _ in 0..(RUHIG_BIS_RUNTER * 6) {
            fenster_mit_reserve(&mut takt, &mut jetzt, 0, 28);
        }
        assert_eq!(takt.vorhalt_ms(), 30, "der Wunsch des Nutzers bindet weiter");
    }

    /// Eine duenne Messung traegt keine Entscheidung: der Anker zieht sich in
    /// den ersten Sekunden noch auf die Bestzeit, und was er dabei meldet, ist
    /// zu gut. Unter der Mindestzahl bleibt es beim alten Weg.
    #[test]
    fn eine_duenne_messung_senkt_nicht_unter_den_fern_wert() {
        let (mut takt, mut jetzt) = neu_mit_fenster(30);
        takt.fernsteuerung(true);
        takt.anpassen(jetzt, None);
        let reserve = Some(Duration::from_millis(28));
        for _ in 0..(RUHIG_BIS_RUNTER * 4) {
            takt.anpassen(jetzt, reserve);
            jetzt += FENSTER + Duration::from_millis(1);
            takt.anpassen(jetzt, reserve);
        }
        assert_eq!(takt.vorhalt_ms(), 30, "zwei Bilder je Fenster sind keine Messung");
    }

    /// Wer selbst tiefer eingestellt hat, kommt mit Messung auch dorthin — die
    /// harte Untergrenze ist eine Grenze fuer den Regler, kein Mindestwert
    /// gegen den Nutzer.
    #[test]
    fn ein_tieferer_nutzerwert_bleibt_auch_mit_messung_erreichbar() {
        let mut takt = Ausgabetakt::neu(2);
        takt.fernsteuerung(true);
        let mut jetzt = Instant::now();
        takt.anpassen(jetzt, None);
        for _ in 0..(RUHIG_BIS_RUNTER * 6) {
            fenster_mit_reserve(&mut takt, &mut jetzt, 0, 2);
        }
        assert_eq!(takt.vorhalt_ms(), 2, "der eingestellte Wert bleibt erreichbar");
    }
}
