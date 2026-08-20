//! Fehlende Bilder am fortlaufenden Zeitstempel erkennen.
//!
//! ## Warum es das braucht
//!
//! Geht auf dem Weg zum Server ein Paket verloren, verwirft MediaMTX das
//! betroffene Bild und reicht den Rest weiter — **mit neu vergebenen
//! Sequenznummern**. Beim Zuschauer sieht der Strom danach lueckenlos aus:
//! der Jitter-Puffer meldet nichts, der Zusammensetzer schoepft keinen
//! Verdacht, und `av1_cuvid` nimmt die referenzlosen Bilder an, ohne zu
//! klagen. Es gibt niemanden, der ein Vollbild anfordert.
//!
//! Gemessen am 2026-08-21 an der laufenden Produktion: **ein einziges
//! fehlendes Bild kostete 60 Sekunden Standbild.** Der Player meldete dabei
//! durchgehend 60 dekodierte und 60 gezeichnete Bilder je Sekunde, null
//! Paketverlust und null verspaetete Bilder — jede Kennzahl gesund. Beendet
//! hat es erst das naechste regulaere Vollbild.
//!
//! ## Was den Server ueberlebt
//!
//! Der **Zeitstempel** jedes Bildes. Ihn darf der Server nicht umschreiben, an
//! ihm haengen Bildtakt und Ton-Synchronitaet. Fehlt ein Bild, klafft dort eine
//! Luecke, wo die Sequenznummern glatt aussehen. Das ist die einzige
//! Nummerierung, die die Klebestelle des Servers uebersteht.
//!
//! **Was er NICHT ist: eine Bildnummer.** Der AV1-Standard kennt dafuer den
//! „Dependency Descriptor" — eine echte fortlaufende Zaehlung samt
//! Abhaengigkeitskette. Den spricht hier niemand: weder die Sidecars noch der
//! vendorierte webrtc-rs-Zweig. Solange das so bleibt, ist der Zeitstempel das
//! Beste, was zur Verfuegung steht — eine Uhr, kein Zaehler, und deshalb
//! braucht die Auswertung Vorsicht.
//!
//! ## Zwei Fallen, beide an der Leitung gemessen
//!
//! **Der Erwartungswert darf nicht das Kleinste sein.** Erster Anlauf: „der
//! kleinste je gesehene Abstand ist der Bildtakt". Ein einziger Ausreisser von
//! 8 Takten (89 Mikrosekunden, zwei Einheiten desselben Zeitpunkts gleich zu
//! Beginn) machte danach **jedes** normale Bild zum Sprung — 36 153
//! Falschmeldungen bei null Verlust. Deshalb der MEDIAN: er steht gegen
//! Ausreisser in beide Richtungen, und beide kommen vor (nach unten
//! Doppel-Einheiten, nach oben die Luecken, die gesucht werden).
//!
//! **Die Schwelle ist das ZWEIFACHE, nicht das Anderthalbfache.** Mit 1,5
//! meldete der Zaehler 553 Spruenge in 25 Sekunden, bei 3 verlorenen Paketen
//! von 151 132 — Abstaende von 842 bis 1145 Takten gegen einen Median von 625.
//! Das sind keine fehlenden Bilder, das ist die echte Ungleichmaessigkeit der
//! Bildschirm-Abtastung. Dieselbe Zahl steht aus demselben Grund in der
//! Luecken-Diagnose der Sidecars (`lueckenschwelle`, s. `CLAUDE.md`): die
//! Schwankung reicht bis 2,0, wenn Zielrate und Schirm-Wiederholrate dicht
//! beieinanderliegen. Sie war dort schon gemessen, und der Fehler ist trotzdem
//! ein zweites Mal gemacht worden.
//!
//! Mit dem Zweifachen: **eine** Meldung in 40 Sekunden ruhigen Betriebs, und
//! die traf ein tatsaechlich ausgelassenes Bild (Abstand exakt 1250 = 2 x 625).
//!
//! ## Was ein Fehlalarm kostet
//!
//! Eine Vollbild-Anforderung. Der Sender schickt ein zusaetzliches Vollbild,
//! der Zuschauer sieht nichts davon. Deshalb darf diese Erkennung grosszuegig
//! sein, waehrend der Decoder-Neuaufbau vorsichtig bleiben muss — die beiden
//! hingen bis 2026-08-21 an derselben Schwelle, und *deshalb* musste sie so
//! vorsichtig sein, dass sie nie ausloeste.

/// Wie viele Abstaende in den Median eingehen.
///
/// Ungerade, damit der Median ein tatsaechlich beobachteter Wert ist und nicht
/// ein gemitteltes Zwischending. 31 sind bei 60 Bildern je Sekunde eine halbe
/// Sekunde Gedaechtnis — lang genug, dass einzelne Ausreisser untergehen, kurz
/// genug, dass ein Wechsel der Bildrate schnell nachgezogen wird.
const FENSTER: usize = 31;

/// Ab dem Wievielfachen des erwarteten Abstands ein Bild als ausgefallen gilt.
/// Begruendung samt Messwerten im Modulkopf.
const SCHWELLE: u32 = 2;

/// Erkennt Luecken in der Bildfolge am Zeitstempel.
#[derive(Default)]
pub struct Bildluecken {
    letzter_ts: Option<u32>,
    fenster: [u32; FENSTER],
    platz: usize,
    gesehen: usize,
}

impl Bildluecken {
    pub fn neu() -> Self {
        Self::default()
    }

    /// Einen Bild-Zeitstempel einordnen.
    ///
    /// `takt` ist die Taktrate der Zeitstempel (90 000 bei Video). Rueckgabe:
    /// die Zahl der ausgefallenen Bilder, oder `None`, wenn alles in Ordnung
    /// ist — oder wenn noch zu wenig beobachtet wurde, um zu urteilen.
    ///
    /// **Erst urteilen, wenn das Fenster voll ist.** Eine Schaetzung aus drei
    /// Werten ist keine; und der Anfang einer Sitzung ist genau die Phase, in
    /// der Sonderabstaende auftreten (Sequenzkopf und erstes Bild mit demselben
    /// Stempel).
    pub fn pruefen(&mut self, ts: u32, takt: u32) -> Option<u32> {
        let vorher = self.letzter_ts.replace(ts)?;
        // `wrapping_sub`, weil der Zeitstempel umlaeuft — bei 90 kHz nach gut
        // 13 Stunden, also im Betrieb durchaus.
        let abstand = ts.wrapping_sub(vorher);
        // Rueckwaerts (0) oder ueber eine Sekunde: die Zeitreihe ist gebrochen,
        // nicht bloss lueckenhaft. Ein solcher Sprung geht gar nicht erst in
        // die Schaetzung ein, sonst verdirbt er den Median fuer die naechste
        // halbe Sekunde.
        if abstand == 0 || abstand >= takt.max(1) {
            return None;
        }
        let urteil = self.urteilen(abstand);
        self.fenster[self.platz] = abstand;
        self.platz = (self.platz + 1) % FENSTER;
        self.gesehen = self.gesehen.saturating_add(1);
        urteil
    }

    /// Der erwartete Bildabstand — der Median des Fensters, sobald es voll ist.
    pub fn erwartet(&self) -> Option<u32> {
        if self.gesehen < FENSTER {
            return None;
        }
        let mut sortiert = self.fenster;
        sortiert.sort_unstable();
        Some(sortiert[FENSTER / 2]).filter(|m| *m > 0)
    }

    fn urteilen(&self, abstand: u32) -> Option<u32> {
        let erwartet = self.erwartet()?;
        if abstand < erwartet * SCHWELLE {
            return None;
        }
        // Ganzzahlig abgerundet und mindestens eins: bei 2,7-fachem Abstand
        // fehlt sicher eines, ob es zwei waren, ist nicht entscheidbar.
        Some((abstand / erwartet).saturating_sub(1).max(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAKT: u32 = 90_000;
    /// 144 Bilder je Sekunde bei 90-kHz-Uhr — die Rate der Messmaschine.
    const BILD: u32 = 625;

    /// Fuellt das Fenster mit gleichmaessigen Abstaenden und gibt den letzten
    /// Zeitstempel zurueck.
    fn einlaufen(b: &mut Bildluecken, schritt: u32) -> u32 {
        let mut ts = 1_000_000u32;
        b.pruefen(ts, TAKT);
        for _ in 0..FENSTER {
            ts = ts.wrapping_add(schritt);
            assert_eq!(b.pruefen(ts, TAKT), None, "gleichmaessiger Lauf meldet nichts");
        }
        ts
    }

    #[test]
    fn gleichmaessiger_lauf_meldet_nichts() {
        let mut b = Bildluecken::neu();
        einlaufen(&mut b, BILD);
        assert_eq!(b.erwartet(), Some(BILD));
    }

    #[test]
    fn doppelter_abstand_ist_ein_fehlendes_bild() {
        let mut b = Bildluecken::neu();
        let ts = einlaufen(&mut b, BILD);
        assert_eq!(b.pruefen(ts.wrapping_add(BILD * 2), TAKT), Some(1));
    }

    /// **Der Fall, an dem der erste Anlauf gescheitert ist.** Ein einzelner
    /// winziger Abstand (zwei Einheiten desselben Zeitpunkts) darf den
    /// Erwartungswert nicht kapern — mit „kleinstes Gesehenes" galt danach
    /// jedes normale Bild als Sprung (36 153 Falschmeldungen bei null Verlust).
    #[test]
    fn ein_winziger_ausreisser_kapert_den_erwartungswert_nicht() {
        let mut b = Bildluecken::neu();
        let mut ts = einlaufen(&mut b, BILD);
        ts = ts.wrapping_add(8);
        b.pruefen(ts, TAKT);
        assert_eq!(b.erwartet(), Some(BILD), "der Median bleibt beim echten Takt");
        ts = ts.wrapping_add(BILD);
        assert_eq!(b.pruefen(ts, TAKT), None, "und ein normales Bild bleibt normal");
    }

    /// **Der zweite Messfehler, als Test festgehalten.** Die echte Abtastung
    /// schwankt bis knapp unter das Doppelte; mit einer Schwelle von 1,5 kamen
    /// 553 Meldungen in 25 Sekunden bei praktisch null Verlust. Die hier
    /// verwendeten Werte sind gemessene (842 bis 1145 Takte gegen 625).
    #[test]
    fn echte_abtast_schwankung_meldet_nichts() {
        let mut b = Bildluecken::neu();
        let mut ts = einlaufen(&mut b, BILD);
        for schwankung in [842u32, 997, 1145, 989, 1012, 1249] {
            ts = ts.wrapping_add(schwankung);
            assert_eq!(
                b.pruefen(ts, TAKT),
                None,
                "Abstand {schwankung} liegt unter dem Doppelten und ist kein Ausfall"
            );
        }
    }

    /// Vor einem vollen Fenster wird NICHT geurteilt: am Sitzungsanfang treten
    /// Sonderabstaende auf (Sequenzkopf und erstes Bild teilen sich einen
    /// Stempel), und aus drei Werten laesst sich kein Takt schaetzen.
    #[test]
    fn ohne_volles_fenster_kein_urteil() {
        let mut b = Bildluecken::neu();
        let mut ts = 1_000_000u32;
        b.pruefen(ts, TAKT);
        for _ in 0..5 {
            ts = ts.wrapping_add(BILD);
            b.pruefen(ts, TAKT);
        }
        assert_eq!(b.erwartet(), None);
        ts = ts.wrapping_add(BILD * 10);
        assert_eq!(b.pruefen(ts, TAKT), None, "ohne Erwartungswert kein Ausfall");
    }

    /// Ein Sprung ueber eine Sekunde ist ein Bruch der Zeitreihe (Neuanfang,
    /// Umschaltung), keine Luecke — und er darf den Median nicht verderben.
    #[test]
    fn bruch_der_zeitreihe_ist_keine_luecke() {
        let mut b = Bildluecken::neu();
        let ts = einlaufen(&mut b, BILD);
        assert_eq!(b.pruefen(ts.wrapping_add(TAKT * 2), TAKT), None);
        assert_eq!(b.erwartet(), Some(BILD), "der Erwartungswert bleibt unberuehrt");
    }

    /// Der Zeitstempel laeuft bei 2^32 um — bei 90 kHz nach gut 13 Stunden.
    /// Wuerde das als Rueckwaertssprung gelten, riefe der Player dort eine
    /// Vollbild-Anforderung aus dem Nichts hervor.
    #[test]
    fn umlauf_des_zeitstempels_ist_keine_luecke() {
        let mut b = Bildluecken::neu();
        let mut ts = u32::MAX - BILD * 20;
        b.pruefen(ts, TAKT);
        for _ in 0..FENSTER + 5 {
            ts = ts.wrapping_add(BILD);
            assert_eq!(b.pruefen(ts, TAKT), None, "der Umlauf ist ein normaler Schritt");
        }
    }
}
