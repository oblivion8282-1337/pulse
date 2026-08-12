//! Abgleich zwischen Senderuhr und Soundkarte — **die Abspielrate wird
//! nachgeführt, statt Ton wegzuschneiden.**
//!
//! **Das Problem.** Der Sender taktet Opus mit 48 000 Hz, die Soundkarte läuft
//! mit ihrem eigenen Quarz. Zwei Quarze stimmen nie exakt überein; gemessen am
//! 2026-08-13 über vier Läufe lag die Abweichung zwischen −573 und +373
//! Millionstel. Ohne Gegenmaßnahme muss der Ausgabe-Ring deshalb langfristig
//! über- oder unterlaufen — es ist nur eine Frage der Laufzeit.
//!
//! **Was vorher an dieser Stelle stand** (`ringregelung`): ein Abbau, der nur
//! wegnehmen konnte. Er hat den Ring systematisch unter seinen eigenen Sollwert
//! gedrückt, weil er den Füllstand unmittelbar NACH dem Anhängen eines Pakets
//! maß, also im Hochpunkt der Sägezahnkurve. Die Sicherheitsreserve war damit
//! aufgezehrt, ein normaler Ankunftsjitter reichte zum Leerlaufen, und der
//! Unterlauf schob den Füllstand schlagartig wieder hoch — worauf der Abbau von
//! vorn begann. Gemessen: in einem Lauf von 307 s rund 0,8 s Stille in etwa
//! zwölf Stücken, dazu 70 390 verworfene Samples. Das war kein Überlauf,
//! sondern der Regelkreis, der gegen sich selbst arbeitete.
//!
//! **Warum es hier trotzdem lange als ausgeschlossen galt.** In
//! `ringregelung` stand: „Resampling scheidet aus — ihn laufend zu verstimmen
//! zieht hörbar die Tonhöhe." Das galt für die damals beobachtete
//! Größenordnung von SEKUNDEN Rückstand. Für die tatsächlich anliegenden
//! Hunderter-Millionstel ist es genau das richtige Mittel: 1000 Millionstel
//! sind 1,7 Cent Tonhöhenversatz, die Wahrnehmungsschwelle liegt bei 5 bis 10.
//!
//! **Die Regelung.** Der geglättete Füllstand wird gegen den Sollwert
//! verglichen, daraus eine Ratenkorrektur in Millionstel gebildet und dem
//! Umrechner mitgegeben (`swr_set_compensation`). Nichts wird geschnitten,
//! nichts eingefügt — der Ton läuft durchgehend, nur unmerklich schneller oder
//! langsamer, bis der Ring auf seinem Sollwert steht. Anders als der alte Abbau
//! deckt das **beide** Richtungen ab: zu wenig Ton war vorher gar nicht
//! korrigierbar, es gab dafür nur Stille.

/// Zeitkonstante der Regelung.
///
/// So lange braucht sie, um eine Abweichung auf etwa ein Drittel abzubauen,
/// wenn die Stellgröße nicht an die Grenze stößt. Bewusst träge: die Regelung
/// arbeitet gegen Quarztoleranz, und die ändert sich nicht. Schnell zu regeln
/// hieße, dem normalen Ankunftsjitter hinterherzulaufen — genau der Fehler, an
/// dem der Vorgänger scheiterte.
const ZEITKONSTANTE_S: f64 = 20.0;

/// Grenze der Stellgröße in Millionstel.
///
/// 1000 Millionstel = 0,1 % = 1,7 Cent Tonhöhenversatz. Die Wahrnehmungsschwelle
/// für Tonhöhenänderungen liegt bei 5 bis 10 Cent, und das gilt für einen
/// direkten Vergleich — hier ändert sich der Wert zudem nur langsam. Höher zu
/// gehen wäre schneller und begänne, hörbar zu werden.
const GRENZE_PPM: f64 = 1000.0;

/// Wie oft die Stellgröße neu gesetzt wird, in Millisekunden Ausgabe.
///
/// `swr_set_compensation` verteilt seine Korrektur über eine feste Strecke; sie
/// muss neu gesetzt werden, bevor die alte abgelaufen ist, sonst fällt die
/// Nachführung zwischendurch auf null zurück. Eine Sekunde ist kurz genug dafür
/// und lang genug, dass die Glättung greift.
const INTERVALL_MS: usize = 1000;

/// Glättungsfaktor des gleitenden Mittels je Beobachtung.
///
/// Der Füllstand wird nach jedem angehängten Paket beobachtet, also rund 50-mal
/// je Sekunde. 0,02 entspricht damit einer Mittelungszeit von etwa einer
/// Sekunde — lang genug, um die Sägezahnform je Paket herauszumitteln, und
/// genau das ist der Kern der Sache: **der Mittelwert wird geregelt, nicht die
/// Spitze.**
const GLAETTUNG: f64 = 0.02;

/// Was dem Umrechner mitzugeben ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Stellgroesse {
    /// Wie viele Ausgabe-Frames über die Strecke zusätzlich (positiv) oder
    /// weniger (negativ) entstehen sollen.
    pub(super) delta: i32,
    /// Über wie viele Ausgabe-Frames das verteilt wird.
    pub(super) distanz: i32,
    /// Dieselbe Korrektur in Millionstel — nur fürs Protokoll.
    pub(super) ppm: i32,
}

/// Der Regler. Liegt in `Shared` und wird nur vom Fütter-Thread beschrieben.
#[derive(Default)]
pub(super) struct Uhrenabgleich {
    /// Geglätteter Füllstand in Samples über alle Kanäle. `None` bis zur ersten
    /// Beobachtung — ohne Vorgeschichte wäre jeder Startwert eine Erfindung.
    mittel: Option<f64>,
    /// Angehängte Samples seit der letzten Stellgröße.
    seit_stellgroesse: usize,
    /// Zuletzt gesetzte Stellgröße in Millionstel (fürs Protokoll).
    pub(super) letzte_ppm: i32,
    /// Wie oft nachgeführt wurde.
    pub(super) stellschritte: u64,
}

impl Uhrenabgleich {
    /// Einen frisch angehängten Block beobachten und, wenn das Intervall voll
    /// ist, die neue Stellgröße liefern.
    ///
    /// `fuellstand` und `soll` in Samples über alle Kanäle, `per_ms` ebenso —
    /// dieselbe Einheit wie im Ring, damit hier nichts umgerechnet werden muss,
    /// was anderswo schon stimmt.
    pub(super) fn beobachten(
        &mut self,
        fuellstand: usize,
        soll: usize,
        angehaengt: usize,
        per_ms: usize,
        kanaele: usize,
    ) -> Option<Stellgroesse> {
        if soll == 0 || per_ms == 0 || kanaele == 0 {
            return None;
        }
        let ist = fuellstand as f64;
        self.mittel = Some(match self.mittel {
            // Der erste Wert IST der Mittelwert — sonst zöge die Glättung ihn
            // langsam von einer erfundenen Null herauf, und die Regelung
            // beschleunigte in der ersten Sekunde grundlos.
            None => ist,
            Some(m) => m + GLAETTUNG * (ist - m),
        });
        self.seit_stellgroesse += angehaengt;
        if self.seit_stellgroesse < per_ms * INTERVALL_MS {
            return None;
        }
        self.seit_stellgroesse = 0;

        let mittel = self.mittel?;
        // Abweichung als ZEIT, nicht als Samplezahl: nur so ist die Korrektur
        // unabhängig von Rate und Kanalzahl des Geräts.
        let fehler_s = (mittel - soll as f64) / (per_ms as f64 * 1000.0);
        // Zu voll (Fehler positiv) heisst: weniger ausgeben. Deshalb das Minus.
        let ppm = (-fehler_s / ZEITKONSTANTE_S * 1_000_000.0).clamp(-GRENZE_PPM, GRENZE_PPM);
        // Die Strecke ist in FRAMES zu zählen, nicht in Samples: FFmpeg rechnet
        // `swr_set_compensation` je Kanal.
        let distanz = (per_ms * INTERVALL_MS / kanaele) as f64;
        let delta = (ppm * distanz / 1_000_000.0).round();
        self.letzte_ppm = ppm.round() as i32;
        self.stellschritte += 1;
        Some(Stellgroesse {
            delta: delta as i32,
            distanz: distanz as i32,
            ppm: self.letzte_ppm,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 48 kHz Stereo: 96 Samples je Millisekunde ueber beide Kanaele.
    const PER_MS: usize = 96;
    const KANAELE: usize = 2;
    const SOLL: usize = 60 * PER_MS;

    /// Einen ganzen Intervallwert in einem Stueck durchreichen und die
    /// Stellgroesse holen. `fuellstand` steht dabei konstant an.
    fn ein_intervall(u: &mut Uhrenabgleich, fuellstand: usize) -> Option<Stellgroesse> {
        let block = PER_MS * 20; // ein Opus-Paket zu 20 ms
        let mut letzte = None;
        for _ in 0..(INTERVALL_MS / 20) {
            letzte = u.beobachten(fuellstand, SOLL, block, PER_MS, KANAELE);
        }
        letzte
    }

    #[test]
    fn auf_dem_sollwert_wird_nicht_nachgefuehrt() {
        let mut u = Uhrenabgleich::default();
        let s = ein_intervall(&mut u, SOLL).expect("Intervall voll");
        assert_eq!(s.ppm, 0);
        assert_eq!(s.delta, 0);
    }

    #[test]
    fn zu_voll_laesst_langsamer_ausgeben() {
        // 20 ms zu viel: Korrektur negativ, damit der Ring abgebaut wird.
        let mut u = Uhrenabgleich::default();
        let s = ein_intervall(&mut u, SOLL + 20 * PER_MS).expect("Intervall voll");
        assert!(s.ppm < 0, "zu voll muss die Ausgabe drosseln, war {}", s.ppm);
        assert!(s.delta < 0);
    }

    #[test]
    fn zu_leer_laesst_schneller_ausgeben() {
        // Die Gegenrichtung gab es vorher gar nicht — der alte Abbau konnte nur
        // wegnehmen, ein Defizit wurde ausschliesslich durch Stille "behoben".
        let mut u = Uhrenabgleich::default();
        let s = ein_intervall(&mut u, SOLL - 20 * PER_MS).expect("Intervall voll");
        assert!(s.ppm > 0, "zu leer muss auffuellen, war {}", s.ppm);
        assert!(s.delta > 0);
    }

    #[test]
    fn die_stellgroesse_bleibt_unter_der_hoerschwelle() {
        // Ein absurder Rueckstand darf die Tonhoehe trotzdem nicht ziehen.
        let mut u = Uhrenabgleich::default();
        let s = ein_intervall(&mut u, SOLL * 50).expect("Intervall voll");
        assert_eq!(s.ppm, -(GRENZE_PPM as i32));
    }

    #[test]
    fn vor_dem_intervall_kommt_nichts() {
        let mut u = Uhrenabgleich::default();
        // Eine halbe Sekunde reicht nicht.
        for _ in 0..25 {
            assert!(u.beobachten(SOLL * 2, SOLL, PER_MS * 20, PER_MS, KANAELE).is_none());
        }
    }

    #[test]
    fn der_erste_wert_ist_der_mittelwert() {
        // Sonst zoege die Glaettung den Mittelwert von einer erfundenen Null
        // herauf, und die Regelung gaebe in der ersten Sekunde Vollgas nach oben.
        let mut u = Uhrenabgleich::default();
        u.beobachten(SOLL, SOLL, 1, PER_MS, KANAELE);
        assert_eq!(u.mittel, Some(SOLL as f64));
    }

    #[test]
    fn die_spitze_zieht_den_mittelwert_nicht_mit() {
        // **Der Kern der Sache.** Der Vorgaenger mass den Fuellstand unmittelbar
        // nach dem Anhaengen, also im Hochpunkt der Saegezahnkurve, und drueckte
        // den Ring dadurch dauerhaft unter den Sollwert. Ein symmetrischer
        // Saegezahn UM den Sollwert herum darf hier auf Dauer nichts ausloesen.
        //
        // Gemessen wird ueber mehrere Intervalle, nicht ueber eines: die
        // Glaettung startet auf dem ersten beobachteten Wert (bewusst, s.
        // `beobachten`), und der ist hier der Hochpunkt. Nach einer Sekunde
        // stecken davon noch rund 36 % im Mittelwert — das ist kein Fehler,
        // sondern die Zeitkonstante der Glaettung. Ein Test ueber genau ein
        // Intervall misst deshalb den Anfangswert, nicht die Regelung.
        let mut u = Uhrenabgleich::default();
        let block = PER_MS * 20;
        let mut letzte = None;
        for i in 0..(5 * INTERVALL_MS / 20) {
            // Wechselnd 20 ms ueber und unter dem Sollwert.
            let f = if i % 2 == 0 { SOLL + 20 * PER_MS } else { SOLL - 20 * PER_MS };
            if let Some(s) = u.beobachten(f, SOLL, block, PER_MS, KANAELE) {
                letzte = Some(s);
            }
        }
        let s = letzte.expect("Intervall voll");
        assert!(s.ppm.abs() <= 60, "Saegezahn darf auf Dauer kaum wirken, war {}", s.ppm);
    }

    /// Die Gegenprobe: ein DAUERHAFTER Rueckstand muss sehr wohl wirken —
    /// sonst waere der Test oben auch mit einer wirkungslosen Regelung gruen.
    #[test]
    fn ein_dauerhafter_ueberstand_wirkt_sehr_wohl() {
        let mut u = Uhrenabgleich::default();
        let block = PER_MS * 20;
        let mut letzte = None;
        for _ in 0..(5 * INTERVALL_MS / 20) {
            if let Some(s) = u.beobachten(SOLL + 20 * PER_MS, SOLL, block, PER_MS, KANAELE) {
                letzte = Some(s);
            }
        }
        let s = letzte.expect("Intervall voll");
        // 20 ms ueber 20 s Zeitkonstante = 1000 ppm, also an der Grenze.
        assert!(s.ppm <= -900, "dauerhafter Ueberstand muss voll wirken, war {}", s.ppm);
    }

    #[test]
    fn kanalzahl_geht_in_die_strecke_ein() {
        // `swr_set_compensation` rechnet je Kanal. Bei Stereo ist die Strecke
        // halb so lang wie die Samplezahl.
        let mut u = Uhrenabgleich::default();
        let s = ein_intervall(&mut u, SOLL + 20 * PER_MS).expect("Intervall voll");
        assert_eq!(s.distanz, (PER_MS * INTERVALL_MS / KANAELE) as i32);
    }
}
