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
    /// Ruecklesen aus dem Grafikspeicher.
    ///
    /// **Hier stand „DER Verdaechtige: der einzige Abschnitt, der auf die GPU
    /// wartet". Das ist seit dem 2026-08-06, nachmittags, widerlegt.** Mit
    /// Zero-Copy laeuft gar kein Ruecklesen mehr (dieser Wert ist dann 0) — und
    /// die Stockungen bleiben, unveraendert bei 0,7 bis 2,5 Sekunden. Die Zeit
    /// steckt also woanders im Herausholen, und wo genau, trennt `bruecke`.
    pub ruecklesen: u64,
    /// Der Teil, der in der Zero-Copy-Bruecke steckt (`crate::zerocopy`) —
    /// im Wesentlichen das Warten auf den Zaun nach der GPU-internen Kopie.
    ///
    /// Getrennt von `ruecklesen` gefuehrt, weil die beiden einander
    /// ausschliessen: je Bild laeuft entweder der eine Weg oder der andere.
    /// Zusammen sind sie „hat auf die GPU gewartet", und genau danach
    /// entscheidet [`ist_grafikstockung`].
    pub bruecke: u64,
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
         {:.0} ms herausholen, davon {:.0} ms Ruecklesen aus dem Grafikspeicher \
         und {:.0} ms Zero-Copy-Bruecke), {bilder} Bilder",
        a.gesamt().as_secs_f64() * 1000.0,
        a.hineingeben as f64 / 1000.0,
        a.herausholen as f64 / 1000.0,
        a.ruecklesen as f64 / 1000.0,
        a.bruecke as f64 / 1000.0,
    );
}

/// Wie viele Stockungs-BUENDEL innerhalb von [`FENSTER`] den Hardware-Weg
/// aufgeben.
///
/// Drei, nicht eines: ein einzelnes Buendel kommt beim Anlauf und beim
/// Fenster-Vergroessern vor und ist folgenlos. Drei heissen, dass die
/// Grafikeinheit haengt und wieder haengen wird — gemessen am 2026-08-06
/// (s. Modulkopf) traten sie in Serien zu Dutzenden auf, nie vereinzelt.
const GENUG: u32 = 3;

/// Beobachtungsfenster fuer [`GENUG`].
///
/// **Von 10 s auf 60 s erhoeht (2026-08-16).** Zusammen mit [`BUENDEL`] zaehlt
/// der Waechter jetzt getrennte Zwischenfaelle statt Einzelstockungen, und drei
/// getrennte Zwischenfaelle in zehn Sekunden gibt es praktisch nicht — das
/// Fenster war damit zu eng, um noch etwas zu erkennen.
const FENSTER: Duration = Duration::from_secs(60);

/// Wie dicht zwei Stockungen liegen duerfen, um als EIN Zwischenfall zu gelten.
///
/// **Der Grund, aus dem es das gibt** (Befund 2026-08-16, belegt in `dmesg`):
/// ein haengender Videoring der Grafikeinheit kommt nie einzeln. Der Kernel
/// setzt ihn zurueck, der naechste Auftrag haengt sofort wieder, zurueck,
/// wieder — gemessen drei `vcn_unified_0 timeout`-Meldungen in vier Sekunden.
/// Der Waechter war damit exakt auf die Form EINES einzigen Treiberzwischen-
/// falls kalibriert: er las die Kaskade als „dreimal haengengeblieben, das
/// Geraet ist hin" und gab den Hardware-Weg fuer den Rest der Sitzung auf,
/// obwohl der Kernel den Ring erfolgreich zurueckgesetzt hatte und dieselbe
/// Maschine unmittelbar davor zwei Stroeme in 4,3 ms je Bild dekodierte.
///
/// Eine Sekunde: die Kaskade laeuft in Abstaenden von rund zwei Sekunden, die
/// Stockungen SELBST dauern aber schon gut zwei Sekunden — gezaehlt wird ab
/// dem Ende der vorigen, und dort liegen die Nachzuender dicht beieinander.
const BUENDEL: Duration = Duration::from_secs(1);

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
    /// Beginn der letzten Buendel, aeltestes zuerst.
    letzte: Vec<Instant>,
    /// Die zuletzt gemeldete Stockung — daran haengt die Buendelung.
    zuletzt: Option<Instant>,
}

impl Waechter {
    /// Eine Stockung melden. `true` = der Hardware-Weg ist aufzugeben.
    ///
    /// Sagt nur einmal `true`: danach ist der Zaehler leer, und der Aufrufer
    /// hat bereits umgestellt.
    ///
    /// Stockungen, die weniger als [`BUENDEL`] auseinanderliegen, zaehlen als
    /// ein Zwischenfall — Begruendung dort.
    pub fn stockung(&mut self, jetzt: Instant) -> bool {
        let nachzuender = self.zuletzt.is_some_and(|t| jetzt.duration_since(t) < BUENDEL);
        self.zuletzt = Some(jetzt);
        if nachzuender {
            return false;
        }
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

/// Wartet die Stockung auf die Grafikeinheit?
///
/// Nur dann hilft der Umstieg auf Software. Steckt die Zeit im Hineingeben,
/// ist es nicht dieser Fehler, und ein Umstieg waere blinder Aktionismus.
///
/// **Hier stand bis zum 2026-08-06, nachmittags, nur `a.ruecklesen`.** Mit
/// Zero-Copy ist der Wert immer 0, die Bedingung war also nie erfuellt — und
/// damit hatte der Weg am Hauptspeicher vorbei den Schutz stillschweigend
/// abgeschaltet, den es seit demselben Tag gibt. Beide Wartearten zaehlen, und
/// da je Bild nur eine von beiden laeuft, ist die Summe der richtige Wert.
pub fn ist_grafikstockung(a: Abschnitte) -> bool {
    a.gesamt() >= SCHWELLE && (a.ruecklesen + a.bruecke) * 2 >= a.herausholen
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein gesunder Durchgang darf keine Zeile erzeugen — sonst waere das Log
    /// bei 60 Bildern je Sekunde unlesbar.
    #[test]
    fn gesunder_durchgang_schweigt() {
        let a = Abschnitte { hineingeben: 500, herausholen: 6_000, ruecklesen: 1_400, bruecke: 0 };
        assert!(a.gesamt() < SCHWELLE, "6,5 ms duerfen nicht gemeldet werden");
    }

    /// Der beobachtete Fall (2,3 s) muss darueber liegen — der Test haelt die
    /// Schwelle gegen die Messung fest, die sie begruendet.
    #[test]
    fn die_beobachtete_stockung_liegt_ueber_der_schwelle() {
        let a = Abschnitte {
            hineingeben: 1_000,
            herausholen: 2_300_000,
            ruecklesen: 2_290_000,
            bruecke: 0,
        };
        assert!(a.gesamt() >= SCHWELLE);
    }

    /// `ruecklesen` ist ein TEIL von `herausholen`, kein zusaetzlicher
    /// Abschnitt — sonst zaehlte die Gesamtzeit ihn doppelt. Fuer `bruecke`
    /// gilt dasselbe.
    #[test]
    fn teilabschnitte_zaehlen_nicht_zur_gesamtzeit() {
        let a =
            Abschnitte { hineingeben: 0, herausholen: 400_000, ruecklesen: 399_000, bruecke: 0 };
        assert_eq!(a.gesamt(), Duration::from_micros(400_000));
        let b =
            Abschnitte { hineingeben: 0, herausholen: 400_000, ruecklesen: 0, bruecke: 399_000 };
        assert_eq!(b.gesamt(), Duration::from_micros(400_000));
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

    /// **Der gemessene Treiberzwischenfall** (2026-08-16): drei Ring-Resets in
    /// vier Sekunden, dazwischen je eine Stockung. Das ist EIN Zwischenfall und
    /// darf den Hardware-Weg nicht kosten — die Maschine dekodierte unmittelbar
    /// davor zwei Stroeme in 4,3 ms je Bild.
    #[test]
    fn eine_kernel_kaskade_ist_ein_zwischenfall() {
        let mut w = Waechter::default();
        let t = Instant::now();
        for ms in [0u64, 300, 700, 950] {
            assert!(!w.stockung(t + Duration::from_millis(ms)), "Nachzuender bei {ms} ms");
        }
        // Zwei WEITERE getrennte Zwischenfaelle sind noetig, erst dann ist
        // Schluss — der erste zaehlt als einer, nicht als vier.
        assert!(!w.stockung(t + Duration::from_secs(10)));
        assert!(w.stockung(t + Duration::from_secs(20)));
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

    /// Steckt die Zeit NICHT im Warten auf die Grafikeinheit, ist es nicht
    /// dieser Fehler — dann hilft der Umstieg auf Software nicht und darf nicht
    /// ausgeloest werden.
    #[test]
    fn nur_das_warten_auf_die_gpu_zaehlt_als_grafikstockung() {
        let grafik = Abschnitte {
            hineingeben: 0,
            herausholen: 2_300_000,
            ruecklesen: 2_290_000,
            bruecke: 0,
        };
        assert!(ist_grafikstockung(grafik));
        let anderswo =
            Abschnitte { hineingeben: 2_300_000, herausholen: 1_000, ruecklesen: 0, bruecke: 0 };
        assert!(!ist_grafikstockung(anderswo));
    }

    /// **Der Zero-Copy-Fall.** Dort ist `ruecklesen` immer 0, weil gar nichts
    /// zurueckgelesen wird — die Wartezeit steht in `bruecke`. Wuerde sie nicht
    /// mitzaehlen, gaebe es auf diesem Weg keinen Rueckfall mehr, und ein
    /// haengendes Geraet fuehrte wieder zum wortlosen Auseinanderfallen der
    /// Sitzung. Genau so lag es am 2026-08-06 im ersten Lauf.
    #[test]
    fn die_zero_copy_bruecke_zaehlt_genauso() {
        let a = Abschnitte {
            hineingeben: 0,
            herausholen: 2_500_000,
            ruecklesen: 0,
            bruecke: 2_480_000,
        };
        assert!(ist_grafikstockung(a), "Warten am Zaun ist dasselbe Warten");
    }
}
