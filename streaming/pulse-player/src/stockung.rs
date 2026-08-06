//! Wo ein einzelner Dekodierdurchgang die Zeit gelassen hat.
//!
//! **Warum es das gibt.** Die Statistikzeile meldet „dekodieren 105/2200 ms" —
//! also dass ein Bild zwei Sekunden gebraucht hat. Sie sagt nicht, WORIN. Am
//! 2026-08-06 war genau das die offene Frage: der Player lief unter Bewegung
//! rund zwei Minuten mit 60 Bildern je Sekunde und brach dann schlagartig auf
//! 2-8 ein, mit Einzelwerten zwischen 2,1 und 2,4 Sekunden. Ein Wert, der so
//! eng um zwei Sekunden liegt, ist keine Last — er ist eine Zeitschranke, und
//! welche es ist, entscheidet sich daran, ob die Zeit im Hineingeben, im
//! Herausholen oder im Ruecklesen aus dem Grafikspeicher liegt.
//!
//! Die Meldung steht deshalb **nicht** hinter einem Schalter: sie erscheint nur
//! oberhalb von [`SCHWELLE`] und ist dort die einzige Spur, die es gibt. Im
//! gesunden Betrieb (5-7 ms je Bild) schweigt sie vollstaendig.

use std::time::{Duration, Instant};

/// Ab wann ein Durchgang gemeldet wird.
///
/// 300 ms sind rund das Fuenfzigfache eines gesunden Durchgangs (gemessen 5-7 ms
/// bei 1080p60 in 10 bit) und liegen weit ueber jedem Ausreisser, den ein
/// Vollbild oder ein Neuanlauf des Decoders erzeugt. Niedriger angesetzt
/// verschwaende die Zeile ihre Aussagekraft in Rauschen; hoeher angesetzt
/// entginge sie dem Fall, um den es geht.
const SCHWELLE: Duration = Duration::from_millis(300);

/// Die drei Abschnitte eines Durchgangs, in Mikrosekunden.
#[derive(Default, Clone, Copy)]
pub struct Abschnitte {
    /// `send_packet` — das Paket in den Decoder geben.
    pub hineingeben: u64,
    /// `receive_frame` samt Umwandlung — alles Fertige herausholen.
    pub herausholen: u64,
    /// Der Teil davon, der im `av_hwframe_transfer_data` steckt, also im
    /// Ruecklesen aus dem Grafikspeicher. **Der Verdaechtige**: es ist der
    /// einzige Abschnitt, der auf die GPU wartet.
    pub ruecklesen: u64,
}

impl Abschnitte {
    fn gesamt(&self) -> Duration {
        Duration::from_micros(self.hineingeben + self.herausholen)
    }
}

/// Meldet einen auffaellig langen Durchgang — und nur einen solchen.
///
/// `bilder` = wie viele Bilder dabei herauskamen; null heisst, der Decoder hat
/// die Zeit verbraucht, ohne etwas zu liefern.
pub fn melden(a: Abschnitte, bilder: usize) {
    if a.gesamt() < SCHWELLE {
        return;
    }
    eprintln!(
        "pulse-player: Stockung im Decoder — {:.0} ms gesamt ({:.0} ms hineingeben, \
         {:.0} ms herausholen, davon {:.0} ms Ruecklesen aus dem Grafikspeicher), \
         {bilder} Bilder",
        a.gesamt().as_secs_f64() * 1000.0,
        a.hineingeben as f64 / 1000.0,
        a.herausholen as f64 / 1000.0,
        a.ruecklesen as f64 / 1000.0,
    );
}

/// Wie viele Stockungen innerhalb von [`FENSTER`] den Hardware-Weg aufgeben.
///
/// Drei, nicht eine: eine einzelne Stockung kommt beim Anlauf und beim
/// Fenster-Vergroessern vor und ist folgenlos. Drei innerhalb von zehn Sekunden
/// heissen, dass die Grafikeinheit haengt und wieder haengen wird — gemessen am
/// 2026-08-06 (s. Modulkopf) traten sie in Serien zu Dutzenden auf, nie
/// vereinzelt.
const GENUG: u32 = 3;

/// Beobachtungsfenster fuer [`GENUG`].
const FENSTER: Duration = Duration::from_secs(10);

/// Zaehlt Stockungen und sagt, wann der Hardware-Decoder aufzugeben ist.
///
/// **Warum es diesen Weg ueberhaupt braucht.** Eine Stockung ist kein Fehler:
/// `av_hwframe_transfer_data` kehrt erfolgreich zurueck, nur eben nach zwei
/// Sekunden. Der bestehende Schutz in [`crate::decode`] haengt an
/// ABGELEHNTEN Paketen (`classify`) und greift hier nie. Damit gab es fuer
/// diesen Fall gar keine Abhilfe — der Player lief weiter, zeigte zwei bis
/// acht Bilder je Sekunde, die Verbindung fiel nach ein bis drei Minuten
/// auseinander und das Fenster ging zu. Von aussen sieht das aus wie ein
/// Absturz, und im Log stand nichts.
#[derive(Default)]
pub struct Waechter {
    /// Zeitpunkte der letzten Stockungen, aelteste zuerst.
    letzte: Vec<Instant>,
}

impl Waechter {
    /// Eine Stockung melden. `true` = der Hardware-Weg ist aufzugeben.
    ///
    /// Sagt nur einmal `true`: danach ist der Zaehler leer, und der Aufrufer
    /// hat bereits umgestellt.
    pub fn stockung(&mut self, jetzt: Instant) -> bool {
        self.letzte.retain(|t| jetzt.duration_since(*t) < FENSTER);
        self.letzte.push(jetzt);
        if self.letzte.len() < GENUG as usize {
            return false;
        }
        self.letzte.clear();
        true
    }
}

/// Darf bei anhaltenden Stockungen auf Software umgestellt werden?
///
/// `PULSE_PLAYER_STOCKUNGS_RUECKFALL=0` haelt den Hardware-Weg fest. Kein
/// Betriebsschalter, sondern ein Messinstrument: ohne ihn liesse sich nicht
/// mehr zeigen, dass es die Grafikeinheit ist, die haengt — der Rueckfall
/// verdeckt genau das Verhalten, das man vermessen will.
pub fn rueckfall_erlaubt() -> bool {
    !matches!(std::env::var("PULSE_PLAYER_STOCKUNGS_RUECKFALL").as_deref(), Ok("0"))
}

/// Liegt die Stockung im Ruecklesen aus dem Grafikspeicher?
///
/// Nur dann hilft der Umstieg auf Software. Steckt die Zeit im Hineingeben,
/// ist es nicht dieser Fehler, und ein Umstieg waere blinder Aktionismus.
pub fn ist_grafikstockung(a: Abschnitte) -> bool {
    a.gesamt() >= SCHWELLE && a.ruecklesen * 2 >= a.herausholen
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein gesunder Durchgang darf keine Zeile erzeugen — sonst waere das Log
    /// bei 60 Bildern je Sekunde unlesbar.
    #[test]
    fn gesunder_durchgang_schweigt() {
        let a = Abschnitte { hineingeben: 500, herausholen: 6_000, ruecklesen: 1_400 };
        assert!(a.gesamt() < SCHWELLE, "6,5 ms duerfen nicht gemeldet werden");
    }

    /// Der beobachtete Fall (2,3 s) muss darueber liegen — der Test haelt die
    /// Schwelle gegen die Messung fest, die sie begruendet.
    #[test]
    fn die_beobachtete_stockung_liegt_ueber_der_schwelle() {
        let a = Abschnitte { hineingeben: 1_000, herausholen: 2_300_000, ruecklesen: 2_290_000 };
        assert!(a.gesamt() >= SCHWELLE);
    }

    /// `ruecklesen` ist ein TEIL von `herausholen`, kein zusaetzlicher
    /// Abschnitt — sonst zaehlte die Gesamtzeit ihn doppelt.
    #[test]
    fn ruecklesen_zaehlt_nicht_zur_gesamtzeit() {
        let a = Abschnitte { hineingeben: 0, herausholen: 400_000, ruecklesen: 399_000 };
        assert_eq!(a.gesamt(), Duration::from_micros(400_000));
    }

    /// Eine einzelne Stockung gibt den Hardware-Weg NICHT auf — beim Anlauf
    /// und beim Fenster-Vergroessern kommt sie vor und ist folgenlos.
    #[test]
    fn eine_einzelne_stockung_reicht_nicht() {
        let mut w = Waechter::default();
        let t = Instant::now();
        assert!(!w.stockung(t));
        assert!(!w.stockung(t + Duration::from_millis(100)));
    }

    /// Der gemessene Fall: Stockungen in Serie. Beim dritten innerhalb des
    /// Fensters ist Schluss.
    #[test]
    fn eine_serie_gibt_den_hardware_weg_auf() {
        let mut w = Waechter::default();
        let t = Instant::now();
        assert!(!w.stockung(t));
        assert!(!w.stockung(t + Duration::from_secs(1)));
        assert!(w.stockung(t + Duration::from_secs(2)), "drei in zehn Sekunden sind genug");
        // Danach faengt die Zaehlung von vorn an — der Aufrufer hat umgestellt.
        assert!(!w.stockung(t + Duration::from_secs(3)));
    }

    /// Weit auseinanderliegende Einzelfaelle duerfen sich nicht aufsummieren:
    /// eine Stockung je Minute ist kein haengendes Geraet.
    #[test]
    fn vereinzelte_stockungen_summieren_sich_nicht() {
        let mut w = Waechter::default();
        let mut t = Instant::now();
        for _ in 0..10 {
            assert!(!w.stockung(t), "eine je Minute darf nie ausloesen");
            t += Duration::from_secs(60);
        }
    }

    /// Steckt die Zeit NICHT im Ruecklesen, ist es nicht dieser Fehler — dann
    /// hilft der Umstieg auf Software nicht und darf nicht ausgeloest werden.
    #[test]
    fn nur_das_ruecklesen_zaehlt_als_grafikstockung() {
        let grafik = Abschnitte { hineingeben: 0, herausholen: 2_300_000, ruecklesen: 2_290_000 };
        assert!(ist_grafikstockung(grafik));
        let anderswo = Abschnitte { hineingeben: 2_300_000, herausholen: 1_000, ruecklesen: 0 };
        assert!(!ist_grafikstockung(anderswo));
    }
}
