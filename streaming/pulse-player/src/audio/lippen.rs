//! Lippen-Synchronisation: die Ton-Abspielposition gegen die Ton-RTP-Uhr
//! regeln — die „gemeinsame Uhr mit dem Videopfad", die es bis hierher nicht
//! gab (Kopf von [`crate::audio`], Historie in `WISSENSSTAND.md` Nr. 7).
//!
//! Warum das noetig ist: Bild und Ton liefen auf zwei getrennten Uhren — das
//! Bild folgt seinen RTP-Zeitstempeln (beim Sender wanduhr-echt), der Ton
//! seiner Ankunfts- und Geraeterate. Zwei Uhren weichen um Bruchteile pro
//! Sekunde voneinander ab, und NIEMAND verglich sie: der Versatz wuchs
//! unbegrenzt (47-Minuten-Stream 2026-09-23, Nutzermeldungen zu
//! Bild/Ton-Auseinanderlauf). Das Gegenstueck auf der Sender-Seite ist
//! `linux-hq-sidecar/encode/audio.rs::whip_dauer` — erst beide zusammen
//! stellen Bild und Ton auf dieselbe Uhr.
//!
//! Drei Schritte, bewusst einfach:
//!
//! 1. **VERMESSEN**: jedes Opus-Paket traegt seinen RTP-Zeitstempel (48 kHz)
//!    bis in die Tonausgabe. Dort wird gemerkt, wann welche RTP-Marke klingt
//!    (Ausgabezaehler) — daraus folgt die RTP-Position, die JETZT klingt.
//! 2. **VERANKERN**: die erste Ton-Marke wird auf die lokale Uhr gelegt, und
//!    kommt ein Paket frueher an, als der Anker erlaubt, wandert der Anker
//!    nach vorn (Mindest-Latenz — dasselbe Prinzip wie der Bild-Takt in
//!    `app::takt`). Verankerungsfehler sind KONSTANT, kein Drift.
//! 3. **NACHFUEHREN**: klingt der Ton spaeter als seine Uhr sagt, sinkt der
//!    Soll-Fuellstand des Rings (Zeitkonstante 60 s, Deckel ±150 ms). Den
//!    Rest setzt der bestehende Uhrenabgleich ueber die Abspielrate um —
//!    unhoerbar, statt Ton wegzuschneiden.
//!
//! **Bewusst nur der TON geregelt, nicht das Bild**: der Bild-Takt hat seine
//! eigene, bewaehrte Nachfuehrung (Mindest-Latenz-Anker, Neuverankerung).
//! Zwei Regler auf beiden Spuren wuerden gegeneinander arbeiten; einer
//! reicht, und der langsameren Spur (Ton, ±1000 ppm Nachfuehrung) gibt man
//! ihn.
//!
//! **Restfehler, ehrlich**: ein fester Versatz von wenigen Millisekunden bis
//! wenige Zehntel kann bleiben — Verankerung von Bild- und Tonuhr treffen
//! je fuer sich ein, und ihr Abstand ist die Differenz zweier Schaetzungen.
//! Dafuer gibt es den Nutz-Trim `av_offset_ms`. Der unbegrenzte DRIFT aber,
//! der das Problem war, ist weg.

use std::time::Instant;

/// Zeitkonstante der Nachfuehrung in Sekunden. Ein Fehler von 60 ms bewegt
/// den Sollwert um rund 1 ms pro Sekunde — langsam genug, dass der
/// Uhrenabgleich (±1000 ppm = 1 ms/s) folgen kann, ohne den Ring leer- oder
/// volllaufen zu lassen; schnell genug, dass eine sitzung lang andauernde
/// Abweichung sich loest.
pub const NACHFUEHR_S: f64 = 60.0;

/// Deckel des Regel-Eingriffs in Millisekunden. Mehr Versatz als so viel
/// ist kein Uhrenfehler mehr, sondern ein kaputter Zustand — dann lieber
/// ehrlich daneben liegen, als den Ring bis zur Stille lehrziehen.
pub const VERSATZ_MAX_MS: i32 = 150;

/// Ab wie viel Millisekunden Frueheintreffen gilt eine Ankunftszeit als neue
/// Mindest-Latenz und zieht den Anker nach vorn. Klein gegenueber Netzjitter,
/// gross gegenueher Paket-Takt-Gleichheit — sonst wuerde der Anker mit jedem
/// guten Paket tanzen.
const FRUEH_MS: i64 = 5;

/// Stand der Ton-Vermessung. Lebt in `Shared` unter der Audio-Sperre;
/// gepflegt vom Fuetterungs-Faden (`paket`), der Ausgabezaehler laeuft im
/// Geraete-Rueckruf weiter.
pub struct Tonuhr {
    /// Letzte rohe RTP-Marke — nur fuer die Wrap-Arithmetik.
    roh: u32,
    /// Verlaengerte RTP-Marke (48-k-Takte) des zuletzt angehaengten Pakets.
    rtp: i64,
    /// Ausgabezaehlerstand (verschraenkte Samples), bei DEM `rtp` klingt.
    klingt_bei: u64,
    /// Verankerung RTP-Marke ↔ lokale Uhr (Mindest-Latenz-nachgezogen).
    anker_rtp: i64,
    anker_lokal: Instant,
    /// Start-Vorhalt des Rings in Sekunden (Sollwert bei der ersten Messung):
    /// der Nulloffset des Fehlers. Ohne ihn misst der Ankunfts-Anker die
    /// eigene Pufferlaufzeit als konstanten Fehler, und der I-Regler
    /// integriert sie weg — bis der Ring auf dem Notboden steht und der Ton
    /// knackend dem Bild VORAUS laeuft (E2E-Lauf 2026-09-27: Eingriff
    /// -69 ms bei nur 60 ms Ring-Sollwert, Unterlauf-Serie).
    startvorhalt_s: f64,
}

impl Tonuhr {
    /// Erste Verankerung beim ersten Paket. `startvorhalt_s` = Ring-Sollwert
    /// in Sekunden bei der ersten Messung (s. Feld).
    pub fn neu(rtp_roh: u32, klingt_bei: u64, jetzt: Instant, startvorhalt_s: f64) -> Self {
        let rtp = i64::from(rtp_roh);
        Self {
            roh: rtp_roh,
            rtp,
            klingt_bei,
            anker_rtp: rtp,
            anker_lokal: jetzt,
            startvorhalt_s,
        }
    }

    /// Ein Paket wurde (nach dem Anhaengen) vermessen.
    ///
    /// `fill_nach_anhaengen` = Ringfuellstand NACH dem Anhaengen in
    /// verschraenkten Samples, `angehaengt` = Samples dieses Pakets — die
    /// Differenz ist der Vorrat, der noch vor dem Pakel klingt.
    /// `ausgabe` = Zaehlerstand des Geraete-Rueckrufs, `jetzt` = Empfang.
    pub fn paket(
        &mut self,
        rtp_roh: u32,
        fill_nach_anhaengen: usize,
        angehaengt: usize,
        ausgabe: u64,
        jetzt: Instant,
    ) {
        self.rtp += i64::from(rtp_roh.wrapping_sub(self.roh));
        self.roh = rtp_roh;
        self.klingt_bei = ausgabe + (fill_nach_anhaengen - angehaengt) as u64;
        // Mindest-Latenz: kam das Paket merklich FRUEHER, als der Anker
        // erlaubt, ist dessen Latenzschaetzung zu gross — nach vorn ziehen.
        // Rueckwaerts nie: eine kurzzeitig schnellere Zustellung ist kein
        // Grund, den Anker tanzen zu lassen.
        let soll = self.anker_lokal + dauer_aus_takten((self.rtp - self.anker_rtp) as f64);
        if jetzt + std::time::Duration::from_millis(FRUEH_MS as u64) < soll {
            self.anker_rtp = self.rtp;
            self.anker_lokal = jetzt;
        }
    }

    /// RTP-Position (verlaengert, 48-k-Takte), die JETZT klingt.
    ///
    /// `ausgabe`zaehler minus Klingel-Merkpunkt: laeuft das Geraet vor dem
    /// Merkpunkt, klingt schon Stille — auch das ist verstrichene Zeit und
    /// zaehlt mit; laeuft es hinter ihm her, klingt noch aelterer Vorrat.
    pub fn position(&self, ausgabe: u64, sample_rate: u32, channels: u16) -> f64 {
        let interleaved = ausgabe as f64 - self.klingt_bei as f64;
        self.rtp as f64 + interleaved / f64::from(channels) * 48_000.0 / f64::from(sample_rate)
    }

    /// Lippenfehler in Millisekunden: positiv = der Ton klingt SPAETER, als
    /// seine RTP-Uhr sagt (= Ton haengt hinterher), negativ = er eilt.
    ///
    /// Abzueglich des Start-Vorhalts: der Ring haelt den Ton bewusst um den
    /// Sollwert zurueck — das ist Latenz nach Bauart, kein Fehler (s.
    /// [`Self::startvorhalt_s`]). In Takten gerechnet, nicht als Duration:
    /// `pos - anker_rtp` ist beim Start NEGATIV (der Geraetezaehler hinkt
    /// dem Anker hinterher, weil der Ring sich zuerst fuellt), und
    /// `Duration::from_secs_f64` panikt auf negative Werte — gemessen im
    /// E2E-Lauf vom 2026-09-27: der Ton-Thread starb beim ersten Paket, die
    /// Sitzung blieb stumm.
    pub fn fehler_ms(&self, ausgabe: u64, sample_rate: u32, channels: u16, jetzt: Instant) -> f64 {
        let pos = self.position(ausgabe, sample_rate, channels);
        let delta_s = (pos - self.anker_rtp as f64) / 48_000.0;
        ((jetzt - self.anker_lokal).as_secs_f64() - delta_s - self.startvorhalt_s) * 1000.0
    }
}

/// Takte (48 kHz) in eine Dauer umrechnen. Nur fuer NICHT-negative Takte
/// (`paket`: `rtp` waechst monoton, der Anker wird nie vor `rtp` gelegt);
/// vorzeichenbehaftete Stellen rechnen in `fehler_ms` in Takten statt dessen.
fn dauer_aus_takten(takte: f64) -> std::time::Duration {
    std::time::Duration::from_secs_f64(takte / 48_000.0)
}

/// Ein Nachfuehrschritt des Regel-Eingriffs.
///
/// `versatz_ms` = bisheriger Eingriff (addiert auf den Ring-Sollwert),
/// `fehler_ms` = gemessener Lippenfehler (positiv = Ton zu spaet),
/// `dt_s` = Sekunden seit dem letzten Schritt. Positiver Fehler verkleinert
/// den Eingriff — weniger Soll-Puffer heisst frueherer Ton.
///
/// **Fliesskomma, keine ganze Zahl:** der Schritt laeuft JE PAKET (dt = 20 ms)
/// und betraegt dabei Bruchteile eines ms — als `i32` wuerde jeder Schritt zu
/// null trunciert, und der Eingriff bliebe fuer immer stehen. Gemessen im
/// E2E-Lauf vom 2026-09-27: 8 Minuten +68 ms Fehler, Eingriff reglos bei +0
/// (der Test dazu nannte dt = 1 s und traf den Betriebsfall nicht).
pub fn nachfuehren(versatz_ms: f32, fehler_ms: f64, dt_s: f64) -> f32 {
    let neu = f64::from(versatz_ms) - fehler_ms * (dt_s / NACHFUEHR_S);
    neu.clamp(-(VERSATZ_MAX_MS as f64), VERSATZ_MAX_MS as f64) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Der Fehler hat ein Vorzeichen, das man verspricht: klingt der Ton
    /// spaeter als seine Uhr sagt, muss er positiv sein (und der Eingriff
    /// sinkt). Vorzeichenfehler hier waeren eine Lippen-Synchronisation, die
    /// den Versatz VERGROESSERT.
    #[test]
    fn fehler_zeigt_in_die_richtige_richtung() {
        let jetzt = Instant::now();
        let uhr = Tonuhr::neu(48_000, 0, jetzt, 0.0);
        // 1000 ms nach dem Anker klingt Position +1000 ms — und das Geraet
        // hat sie auch schon gespielt: Fehler null.
        let ausgabe = 48_000 * 2; // interleaved, 2 Kanaele, 48000 Rate
        assert!(
            uhr.fehler_ms(ausgabe, 48_000, 2, jetzt + Duration::from_millis(1000)).abs() < 0.1,
            "gemeinstaktischer Lauf hat keinen Fehler"
        );
        // Dasselbe nach 1250 ms: der Ton haengt 250 ms hinterher.
        let e = uhr.fehler_ms(ausgabe, 48_000, 2, jetzt + Duration::from_millis(1250));
        assert!((249.0..=251.0).contains(&e), "erwartet +250 ms, gemessen {e}");
    }

    /// Der Ring-Sollwert ist Latenz nach Bauart, kein Fehler: mit 60 ms
    /// Start-Vorhalt ist der gemeintaktische Lauf bei Fehler null — ohne den
    /// Abzug integriert der I-Regler die eigene Pufferlaufzeit weg und
    /// leerzieht den Ring (E2E-Lauf 2026-09-27).
    #[test]
    fn start_vorhalt_ist_kein_fehler() {
        let jetzt = Instant::now();
        // Anker: Paket mit Marke 48 000 klingt laut Ring erst 60 ms nach der
        // Ankunft (Sollwert). 1 s spaeter hat das Geraet 940 ms des Inhalts
        // gespielt (1000 ms minus die 60 ms Vorhalt).
        let uhr = Tonuhr::neu(48_000, 0, jetzt, 0.060);
        let ausgabe = 48_000 * 2 * 940 / 1000; // 940 ms interleaved Stereo
        let e = uhr.fehler_ms(ausgabe, 48_000, 2, jetzt + Duration::from_millis(1000));
        assert!(e.abs() < 0.1, "gemeintaktischer Lauf mit Vorhalt: {e} statt ~0");
    }

    /// Und was der Fehler stattdessen anzeigt: Marken-Drift. Laeuft die
    /// Ton-Marke um D hinter der Wanduhr her (der Fall, fuer den die Regelung
    /// existiert), klingt der Ton um D SPAETER, als seine Uhr sagt — und der
    /// Regler zieht ihn nach vorn.
    #[test]
    fn marken_drift_erscheint_als_fehler() {
        let jetzt = Instant::now();
        let uhr = Tonuhr::neu(48_000, 0, jetzt, 0.060);
        // 940 ms Inhalt gespielt, aber die Marken sagen 890 ms (50 ms Drift):
        // pos = Anker + 890 ms, lokal +1000 ms.
        let ausgabe = 48_000 * 2 * 940 / 1000;
        let e = uhr.fehler_ms(ausgabe - 48_000 * 2 * 50 / 1000, 48_000, 2, jetzt + Duration::from_millis(1000));
        assert!((49.0..=51.0).contains(&e), "erwartet ~+50 ms, gemessen {e}");
    }

    /// Der 32-Bit-Wrap der RTP-Marke darf die verlaengerte Position nicht
    /// zurueckwerfen — Ton laeuft Stunden, der Wrap kommt alle ~24,8 h, aber
    /// der Clip-Recorder-Testfall deckt ihn heute, nicht morgen.
    #[test]
    fn wrap_der_rtp_marke_traegt() {
        let jetzt = Instant::now();
        let mut uhr = Tonuhr::neu(u32::MAX - 10, 0, jetzt, 0.0);
        uhr.paket(20, 960, 960, 0, jetzt + Duration::from_millis(10));
        // 20 - (u32::MAX - 10) = 31 Takte weiter, nicht -4294967265.
        assert_eq!(uhr.rtp, i64::from(u32::MAX - 10) + 31);
    }

    /// Nachfuehrung: 60 ms Fehler bewegen den Eingriff um 1 ms je Sekunde,
    /// der Deckel haelt, dt null bewegt nichts.
    #[test]
    fn nachfuehrung_ist_langsam_und_gedeckelt() {
        assert_eq!(nachfuehren(0.0, 60.0, 1.0), -1.0);
        assert_eq!(nachfuehren(-149.0, 60.0, 1.0), -150.0, "Deckel unten");
        assert_eq!(nachfuehren(149.0, -60.0, 1.0), 150.0, "Deckel oben");
        assert_eq!(nachfuehren(42.0, 1000.0, 0.0), 42.0, "keine Zeit, kein Schritt");
    }

    /// Der Betriebsfall aus dem E2E-Lauf vom 2026-09-27: der Schritt laeuft
    /// JE PAKET mit dt = 20 ms — 68 ms Fehler geben 0,023 ms. Als `i32`
    /// trunciert zu 0 blieb der Eingriff 8 Minuten lang bei +0 stehen,
    /// obwohl die Regelung lauft. Der Schritt muss von null VERSCHIEDEN und
    /// in der Groessenordnung fehler_ms * dt / 60 sein.
    #[test]
    fn schritt_je_paket_ist_nicht_null() {
        let schritt = nachfuehren(0.0, 68.0, 0.02);
        assert!((-0.024..=-0.021).contains(&schritt), "gemessen {schritt}");
        // Und aufkumuliert ueber eine Sekunde (50 Pakete) ergibt das wieder
        // den Satz aus dem Test oben.
        let mut eingriff = 0.0;
        for _ in 0..50 {
            eingriff = nachfuehren(eingriff, 68.0, 0.02);
        }
        assert!((-1.2..=-1.0).contains(&eingriff), "gemessen {eingriff}");
    }

    /// Ein frueh angekommendes Paket zieht den Anker nach vorn — aber nur
    /// ueber der Frueh-Schwelle, und nie zurueck.
    #[test]
    fn anker_zieht_bei_fruetzung_nach_vorn() {
        let jetzt = Instant::now();
        let mut uhr = Tonuhr::neu(0, 0, jetzt, 0.0);
        // 1 s Inhalt in 500 ms ankommend: 500 ms zu frueh → Anker vor.
        uhr.paket(48_000, 960, 960, 0, jetzt + Duration::from_millis(500));
        assert_eq!(uhr.anker_rtp, 48_000);
        // Danach 10 ms Inhalt, 3 ms frueher als der NEUE Anker erlaubt:
        // unter der Schwelle, Anker bleibt stehen.
        uhr.paket(48_480, 960, 960, 0, jetzt + Duration::from_millis(507));
        assert_eq!(uhr.anker_rtp, 48_000, "3 ms Fruehe liegen unter der Schwelle");
    }

    /// Der Startfall vom 2026-09-27 (E2E-Lauf): der Ring fuellt sich mit
    /// 1000 ms Vorrat, der Geraetezaehler steht noch auf null — die Position
    /// liegt UNTER dem Anker. `Duration::from_secs_f64` panikte auf die
    /// negativen Takte und riss den Ton-Thread mit; dieser Test rueckt den
    /// Panik-Fall unter die Tests, statt auf den naechsten Live-Lauf zu warten.
    #[test]
    fn geraet_hinter_dem_anker_kein_panik() {
        let jetzt = Instant::now();
        // klingt_bei = ausgabe(0) + 1000 ms Vorrat (interleaved Stereo 48 kHz)
        let uhr = Tonuhr::neu(48_000, 96_000, jetzt, 0.0);
        let e = uhr.fehler_ms(0, 48_000, 2, jetzt);
        assert!((999.0..=1001.0).contains(&e), "erwartet ~+1000 ms, gemessen {e}");
    }
}
