//! Ausgabe-Takt: ein Bild dann zeigen, wann es beim Sender entstanden ist —
//! nicht dann, wann es hier angekommen ist.
//!
//! **Was vorher fehlte.** Der Player zeichnet bei `SessionEvent::Frame` sofort.
//! Damit ist der Abstand zwischen zwei ausgegebenen Bildern der Abstand ihrer
//! ANKUNFT, und der traegt jede Schwankung der Leitung, des Servers und des
//! Decoders. Der Jitter-Puffer davor gleicht das NICHT aus: sein Wert
//! (`JITTER_MS_VORGABE`) ist die Wartezeit bei einem FEHLENDEN Paket,
//! `jitter.rs::poll` gibt lueckenlose Pakete sofort frei. Es gab also im ganzen
//! Programm keine Stelle, an der ein Bild auf seinen Zeitpunkt gewartet haette.
//!
//! **Was hier passiert.** Jedes Bild bekommt aus seinem RTP-Zeitstempel einen
//! Zielzeitpunkt auf der lokalen Uhr: einmal wird ein Anker gesetzt
//! (`RTP-Zeitstempel X` = `jetzt + Vorhalt`), danach folgt jeder weitere
//! Zeitpunkt aus dem Abstand der Zeitstempel. Die Uhr des Senders gibt den Takt
//! vor, die Leitung nur noch, ob ein Bild rechtzeitig da ist.
//!
//! **Warum das Geld kostet und deshalb ein Schalter ist.** Der Vorhalt ist
//! zusaetzliche Verzoegerung, jede Millisekunde davon. Fuer Zuschauen ist das
//! ein guter Tausch (gleichmaessiges Bild gegen etwas Verzoegerung), fuer die
//! Fernsteuerung ist er falsch — dort zaehlt allein, wie schnell die eigene
//! Mausbewegung zurueckkommt.
//!
//! **Die Vorgabe ist AN, nicht aus** (`proto::AUSGABETAKT_MS_VORGABE`, in
//! `PlayerOptions::defaults` gesetzt) — der Takt laeuft, es sei denn, der
//! Aufrufer schickt ausdruecklich etwas anderes. Der Wert steht seit dem
//! 2026-08-07 auf **30 ms**; er war vom 2026-08-05 bis dahin 60, und hier
//! stand davor „Vorgabe ist deshalb AUS (`vorhalt = 0`)". Beide Male wurde die
//! Aenderung nur an der Konstanten nachgezogen, und diese Zeile war eine von
//! vier, die danach das Gegenteil behaupteten. Herleitung und Messwerte
//! stehen an [`crate::proto::PlayerOptions::ausgabetakt_ms`].
//!
//! Bei ausgeschaltetem Vorhalt — also nur noch auf ausdruecklichen Wunsch —
//! verhaelt sich der Player wie vor diesem Modul: [`Ausgabetakt::einreihen`]
//! setzt den Zielzeitpunkt auf „jetzt" und [`Ausgabetakt::faellig`] gibt das
//! Bild im selben Atemzug wieder heraus.
//!
//! **Was der Vorhalt NICHT ist:** eine Fehlerkorrektur. Ein Bild, das nach
//! seinem Zielzeitpunkt eintrifft, wird sofort gezeigt (und gezaehlt, s.
//! [`Ausgabetakt::verspaetet`]). Ist der Vorhalt kleiner als die Schwankung der
//! Strecke, passiert genau das dauernd — dann taktet nichts mehr, und der
//! Zaehler sagt es.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::decode::DecodedFrame;

/// Untergrenze der Warteschlange — auch ohne bekannten Bildabstand.
///
/// **Hier stand bis zum 2026-08-07 eine FESTE Grenze von 8 Bildern, begruendet
/// mit „Acht sind bei 60 fps ein Vorhalt von 133 ms — mehr als hier je sinnvoll
/// ist". Die Rechnung stimmt, ihre Annahme nicht:** sie geht von 60 fps aus.
/// Der Vorhalt braucht `Bildrate × Vorhalt` Plaetze, und das sind bei der
/// Vorgabe von 60 ms erst ab **133 fps** mehr als acht. Darueber lief die
/// Warteschlange dauerhaft ueber, und die Bilder wurden **vor ihrem
/// Zielzeitpunkt** wieder herausgeworfen — sie kamen also nie zur Anzeige.
///
/// Gemessen bei 720p — damit die Grafikeinheit als Ursache ausscheidet: von
/// 144 dekodierten Bildern kamen mit 60 ms Vorhalt nur 42 bis 58 je Sekunde
/// zur Anzeige, mit 40 ms alle 144. Alle Arme und die Rechnung:
/// `streaming/testbench/profiles/player-2026-08-07-ausgabetakt-warteschlange.json`.
const MIN_WARTEND: usize = 8;

/// Obergrenze der Warteschlange.
///
/// Hier begrenzt wirklich der Speicher, und zwar doppelt: ein Bild in 1440p mit
/// 10 bit sind rund 11 MB in den Ebenen-Puffern, und auf dem Zero-Copy-Weg
/// belegt **jedes wartende Bild einen Platz im Ring** der Bruecke.
///
/// **Diese Zahl haengt an der Ringgroesse und darf nicht allein geaendert
/// werden.** Der Ring hat 24 Plaetze, und sie sind vergeben: 12 hier, 8 im
/// Kanal zum Fenster-Faden, 4 fuer `pending`, das gezeichnete Bild, den
/// laufenden Durchgang und den Decoder. Der Haushalt steht ausgeschrieben an
/// `zerocopy::bruecke::ringgroesse`; wer hier erhoeht, muss dort mitgehen —
/// sonst wartet der Decoder auf einen freien Platz, und das sind Stockungen
/// von Sekunden.
///
/// Zwoelf tragen den Vorgabe-Vorhalt von 30 ms bis rund 360 Bilder je Sekunde
/// (bei den 60 ms, die bis zum 2026-08-07 Vorgabe waren, nur bis 180).
/// Darueber kuerzt [`Ausgabetakt::wirksamer_vorhalt`] den Vorhalt und meldet
/// es einmal im Klartext, statt still zu verwerfen.
const MAX_WARTEND_VORGABE: usize = 12;

/// Zur Messung umstellbar (`PULSE_PLAYER_TAKT_PLAETZE`). Die Vorgabe deckelt
/// den wirksamen Vorhalt bei 144 fps auf `10 × 6,94 ms = 69 ms` — weniger als
/// die gemessenen Ankunftsloecher. Genau das soll ein Arm pruefen koennen.
fn max_wartend() -> usize {
    static WERT: std::sync::LazyLock<usize> = std::sync::LazyLock::new(|| {
        std::env::var("PULSE_PLAYER_TAKT_PLAETZE")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|n| (4..=256).contains(n))
            .unwrap_or(MAX_WARTEND_VORGABE)
    });
    *WERT
}

/// Ab dieser Abweichung zwischen Ziel und Sollzeit wird der Anker neu gesetzt.
///
/// Noetig, weil die Zeitreihe reissen kann, ohne dass hier etwas davon erfaehrt:
/// ein neu gestarteter Sender, eine lange Luecke, eine Pause. Ohne Neuanker
/// laege der Zielzeitpunkt danach dauerhaft in der Vergangenheit (alles sofort,
/// also kein Takt) oder weit in der Zukunft (das Bild stuende).
///
/// 250 ms sind reichlich ueber jeder Schwankung, die ein Vorhalt ausgleichen
/// soll, und deutlich unter dem, was ein Bruch der Zeitreihe erzeugt.
const NEU_VERANKERN: Duration = Duration::from_millis(250);

/// Obergrenze des Vorhalts. Darueber ist es keine Glaettung mehr, sondern eine
/// Verzoegerung, die man als solche merkt.
pub const VORHALT_MAX_MS: u32 = 500;

/// `PULSE_PLAYER_AUSGABETAKT_MS` — der Schalter fuer den Pruefstand, der den
/// Player ohne Oberflaeche faehrt.
///
/// Ein unlesbarer Wert wird gemeldet und ignoriert, nicht als `0` gedeutet:
/// „aus, obwohl eingeschaltet gemeint war" ist genau der Messfehler, bei dem
/// zwei Varianten hinterher identisch aussehen und niemand weiss warum.
pub fn vorhalt_aus_umgebung() -> Option<u32> {
    let roh = std::env::var("PULSE_PLAYER_AUSGABETAKT_MS").ok()?;
    match roh.trim().parse::<u32>() {
        Ok(ms) => Some(ms.min(VORHALT_MAX_MS)),
        Err(_) => {
            eprintln!(
                "pulse-player: PULSE_PLAYER_AUSGABETAKT_MS={roh:?} ist keine Zahl — \
                 Ausgabe-Takt bleibt bei der Vorgabe"
            );
            None
        }
    }
}

struct Anker {
    rtp: u32,
    lokal: Instant,
    takt: u32,
}

pub struct Ausgabetakt {
    vorhalt: Duration,
    anker: Option<Anker>,
    warteschlange: VecDeque<(Instant, Box<DecodedFrame>)>,
    /// Bilder, die nach ihrem Zielzeitpunkt eintrafen. Die Kennzahl dafuer, ob
    /// der Vorhalt ueberhaupt reicht.
    verspaetet: u64,
    /// Wie oft die Zeitreihe neu verankert werden musste.
    neu_verankert: u64,
    /// Wie oft der Anker auf eine kuerzere Laufzeit nachgezogen wurde.
    nachgezogen: u64,
    /// Bilder, die die Warteschlange **vor ihrem Zielzeitpunkt** wieder
    /// verlassen mussten, weil kein Platz mehr war. Bis zum 2026-08-07 gab es
    /// den Zaehler nicht — der Kommentar an der Grenze behauptete „wird das
    /// aelteste verworfen und gezaehlt", und gezaehlt wurde es nie. Genau
    /// deshalb blieb der Fehler so lange unbemerkt.
    verdraengt: u64,
    /// Geschaetzter Abstand zweier Bilder auf der Senderuhr. Daraus folgt, wie
    /// viele Plaetze der eingestellte Vorhalt ueberhaupt braucht.
    ///
    /// **Aus den RTP-Zeitstempeln, NICHT aus den Zielzeitpunkten.** Die
    /// verschiebt [`Ausgabetakt::ziel`] selbst (Nachziehen, Neuverankern geben
    /// `soll` zurueck); der erste Anlauf am 2026-08-07 schaetzte darueber 45 us
    /// statt 6,9 ms und verlangte 1314 Plaetze statt zehn.
    bildabstand: Option<Duration>,
    /// Zeitstempel des zuletzt eingereihten Bildes — Bezugspunkt fuer den
    /// Bildabstand.
    letzter_rtp: Option<u32>,
    /// Damit die Warnung „Vorhalt passt nicht in die Warteschlange" einmal
    /// kommt und nicht je Bild.
    gewarnt: bool,
}

impl Ausgabetakt {
    pub fn neu(vorhalt_ms: u32) -> Self {
        Self {
            vorhalt: Duration::from_millis(u64::from(vorhalt_ms.min(VORHALT_MAX_MS))),
            anker: None,
            warteschlange: VecDeque::new(),
            verspaetet: 0,
            neu_verankert: 0,
            nachgezogen: 0,
            verdraengt: 0,
            bildabstand: None,
            letzter_rtp: None,
            gewarnt: false,
        }
    }

    /// Wie viele Plaetze der eingestellte Vorhalt bei der aktuellen Bildrate
    /// braucht — plus zwei Reserve fuer Schwankung. `None`, solange kein
    /// Bildabstand bekannt ist (erstes Bild, Bilder ohne Zeitstempel).
    fn noetige_plaetze(&self) -> Option<usize> {
        let abstand = self.bildabstand.filter(|d| !d.is_zero())?;
        Some((self.vorhalt.as_nanos() / abstand.as_nanos()) as usize + 2)
    }

    /// Das Noetige, begrenzt auf das Moegliche.
    ///
    /// **Solange der Bildabstand unbekannt ist, gilt die OBERgrenze, nicht die
    /// untere.** Die ersten Bilder sind genau die, bei denen die Bildrate noch
    /// nicht feststeht — mit der Untergrenze zu beginnen hiesse, bei jedem
    /// Sitzungsstart einige Bilder zu verdraengen, nur weil noch niemand
    /// nachgesehen hat. Grosszuegig zu starten kostet nichts: der Ring ist
    /// ohnehin fuer [`max_wartend`] ausgelegt.
    fn kapazitaet(&self) -> usize {
        let max = max_wartend();
        self.noetige_plaetze().unwrap_or(max).clamp(MIN_WARTEND.min(max), max)
    }

    /// Der Vorhalt, den die Warteschlange bei dieser Bildrate wirklich tragen
    /// kann — hoechstens der eingestellte.
    ///
    /// **Warum gekuerzt und nicht verworfen wird.** Passt der gewuenschte
    /// Vorhalt nicht in die Plaetze, gab es bis zum 2026-08-07 nur eine
    /// Antwort: Bilder vor ihrem Zeitpunkt wegwerfen. Bei 240 fps und 60 ms
    /// waren das gemessen zwei Drittel des Stroms — von 240 dekodierten kamen
    /// 17 bis 162 an, im Mittel rund 70.
    ///
    /// Ein etwas kuerzerer Vorhalt ist in jeder Hinsicht das bessere Geschaeft:
    /// er kostet Glaettung im Millisekundenbereich, waehrend das Wegwerfen
    /// ganze Bilder kostet. Und er macht die Bildrate zu einer Zahl, die man
    /// frei waehlen kann — vorher gab es eine Klippe, die niemand sah.
    pub fn wirksamer_vorhalt(&self) -> Duration {
        let Some(abstand) = self.bildabstand.filter(|d| !d.is_zero()) else {
            return self.vorhalt;
        };
        // Zwei Plaetze bleiben Reserve fuer Schwankung — dieselben zwei, die
        // `noetige_plaetze` aufschlaegt.
        self.vorhalt.min(abstand * (max_wartend() as u32 - 2))
    }

    /// Laeuft der Takt ueberhaupt? Bei `0` ist alles hier ein Durchreichen.
    pub fn aktiv(&self) -> bool {
        !self.vorhalt.is_zero()
    }

    pub fn vorhalt_ms(&self) -> u64 {
        self.vorhalt.as_millis() as u64
    }

    pub fn verspaetet(&self) -> u64 {
        self.verspaetet
    }

    pub fn neu_verankert(&self) -> u64 {
        self.neu_verankert
    }

    pub fn nachgezogen(&self) -> u64 {
        self.nachgezogen
    }

    /// Bilder, die vor ihrem Zielzeitpunkt aus der Warteschlange fielen.
    /// **Muss im Betrieb 0 sein** — jeder andere Wert heisst, dass der Vorhalt
    /// mehr Plaetze braucht, als es gibt.
    pub fn verdraengt(&self) -> u64 {
        self.verdraengt
    }

    /// Vorhalt zur Laufzeit aendern (`set_option`).
    ///
    /// Der Anker faellt dabei weg: ein geaenderter Vorhalt verschiebt jeden
    /// Zielzeitpunkt, und die wartenden Bilder haetten sonst Zeitpunkte aus der
    /// alten Rechnung. Sie werden mit ausgegeben statt verworfen — ein
    /// sichtbarer Sprung ist besser als eine Luecke.
    pub fn setze_vorhalt(&mut self, ms: u32) {
        let neu = Duration::from_millis(u64::from(ms.min(VORHALT_MAX_MS)));
        if neu == self.vorhalt {
            return;
        }
        self.vorhalt = neu;
        self.anker = None;
        // Ein anderer Vorhalt braucht eine andere Zahl Plaetze — die Warnung
        // darf danach wieder kommen, sonst bleibt der neue Wert stumm falsch.
        self.gewarnt = false;
        let jetzt = Instant::now();
        for (ziel, _) in self.warteschlange.iter_mut() {
            *ziel = jetzt;
        }
    }

    /// Nichts unterwegs? Der Schnellweg fuer die Fenster-Schleife: solange das
    /// gilt, braucht sie keinen Weckruf zu stellen.
    pub fn leer(&self) -> bool {
        self.warteschlange.is_empty()
    }

    /// Wann das naechste wartende Bild faellig wird. `None` = keins wartet.
    pub fn naechster_termin(&self) -> Option<Instant> {
        self.warteschlange.front().map(|(t, _)| *t)
    }

    /// Den Bildabstand aus der Senderuhr fortschreiben.
    ///
    /// Geglaettet, weil ein einzelner Ausreisser die Kapazitaet sonst je Bild
    /// springen liesse. Unplausible Spruenge — rueckwaerts oder ueber eine
    /// Sekunde — gehen gar nicht erst ein: das ist ein Bruch der Zeitreihe, den
    /// [`Ausgabetakt::ziel`] ueber `NEU_VERANKERN` abfaengt.
    fn bildabstand_fortschreiben(&mut self, frame: &DecodedFrame) {
        let (Some(rtp), takt) = (frame.rtp_ts, frame.clock_rate) else { return };
        if takt == 0 {
            return;
        }
        let vorher = self.letzter_rtp.replace(rtp);
        let Some(vorher) = vorher else { return };
        // Derselbe vorzeichenbehaftete Weg wie in `ziel` — der Zaehler laeuft
        // bei 90 kHz nach gut 13 Stunden ueber.
        let abstand = rtp.wrapping_sub(vorher) as i32;
        if abstand <= 0 {
            return;
        }
        let us = i64::from(abstand) * 1_000_000 / i64::from(takt);
        if us <= 0 || us > 1_000_000 {
            return;
        }
        let roh = Duration::from_micros(us as u64);
        self.bildabstand = Some(match self.bildabstand {
            Some(alt) => (alt * 7 + roh) / 8,
            None => roh,
        });
    }

    /// Ein frisch dekodiertes Bild aufnehmen.
    pub fn einreihen(&mut self, frame: Box<DecodedFrame>, jetzt: Instant) {
        let ziel = self.ziel(&frame, jetzt);
        if ziel <= jetzt && self.aktiv() {
            self.verspaetet += 1;
        }
        // Die Reihenfolge muss monoton bleiben, sonst zeigt `faellig` ein Bild
        // vor seinem Vorgaenger. Bei gleichem oder kleinerem Zeitstempel (Sender
        // hat B-Bilder oder wiederholt einen Stempel) wird auf den Vorgaenger
        // gesetzt, nicht sortiert: umsortieren hiesse eine Umordnung im Bild
        // hinnehmen, die es hier gar nicht geben darf.
        let ziel = match self.warteschlange.back() {
            Some((letztes, _)) if *letztes > ziel => *letztes,
            _ => ziel,
        };
        self.bildabstand_fortschreiben(&frame);
        self.warteschlange.push_back((ziel, frame));

        let kapazitaet = self.kapazitaet();
        // Reicht selbst die Obergrenze nicht, ist der eingestellte Vorhalt bei
        // dieser Bildrate nicht zu halten. Das EINMAL sagen — sonst verwirft
        // der Player wieder still, nur mit anderen Zahlen.
        if !self.gewarnt && self.aktiv() {
            let max = max_wartend();
            if let Some(noetig) = self.noetige_plaetze().filter(|n| *n > max) {
                self.gewarnt = true;
                eprintln!(
                    "pulse-player: Ausgabe-Takt {} ms braucht {noetig} Plaetze, es gibt \
                     {max} — Vorhalt auf {} ms gekuerzt. Das kostet etwas \
                     Glaettung und ist billiger als weggeworfene Bilder.",
                    self.vorhalt_ms(),
                    self.wirksamer_vorhalt().as_millis(),
                );
            }
        }
        while self.warteschlange.len() > kapazitaet {
            self.warteschlange.pop_front();
            self.verdraengt += 1;
        }
    }

    /// Alles faellige herausholen.
    ///
    /// Gibt hoechstens EIN Bild zurueck — das juengste faellige — und daneben,
    /// wie viele dabei uebersprungen wurden. Mehrere faellige gibt es nur, wenn
    /// die Fenster-Schleife zu spaet aufgewacht ist; dann ist das juengste das
    /// richtige und die anderen sind Vergangenheit.
    pub fn faellig(&mut self, jetzt: Instant) -> (Option<Box<DecodedFrame>>, u64) {
        let mut letztes = None;
        let mut uebersprungen = 0u64;
        while self.warteschlange.front().is_some_and(|(t, _)| *t <= jetzt) {
            if letztes.is_some() {
                uebersprungen += 1;
            }
            letztes = self.warteschlange.pop_front().map(|(_, f)| f);
        }
        (letztes, uebersprungen)
    }

    /// Alles verwerfen (Sitzungsende, Codec-Wechsel).
    #[cfg(test)]
    pub fn leeren(&mut self) {
        self.warteschlange.clear();
        self.anker = None;
    }

    /// Zielzeitpunkt eines Bildes auf der lokalen Uhr.
    fn ziel(&mut self, frame: &DecodedFrame, jetzt: Instant) -> Instant {
        if !self.aktiv() {
            return jetzt;
        }
        // Ohne Zeitstempel gibt es nichts zu takten. Kommt bei Bildern vor, die
        // nicht aus dem Netz stammen (Tests) und solange noch kein Videopaket
        // gesehen wurde (`clock_rate == 0`).
        let (Some(rtp), takt) = (frame.rtp_ts, frame.clock_rate) else {
            return jetzt;
        };
        if takt == 0 {
            return jetzt;
        }
        // **Der WIRKSAME Vorhalt, nicht der eingestellte** — sonst bekaemen die
        // Bilder Zielzeitpunkte, fuer die es keine Plaetze gibt, und faellt
        // genau der Fehler wieder an, den `wirksamer_vorhalt` abwendet.
        let vorhalt = self.wirksamer_vorhalt();
        let soll = jetzt + vorhalt;
        let Some(anker) = self.anker.as_ref().filter(|a| a.takt == takt) else {
            self.anker = Some(Anker { rtp, lokal: soll, takt });
            return soll;
        };
        let anker_lokal = anker.lokal;
        let anker_rtp = anker.rtp;
        // **Vorzeichenbehaftet ueber den 32-bit-Ueberlauf hinweg.** Der
        // RTP-Zeitstempel laeuft bei 90 kHz nach gut 13 Stunden ueber; ein
        // schlichtes `rtp - anker.rtp` waere danach eine Zahl in der Groesse von
        // vier Milliarden und das Bild stuende. `wrapping_sub` mit `as i32`
        // liefert den kurzen Weg — richtig, solange der Abstand unter etwa
        // 6,6 Stunden liegt, und das ist er hier immer.
        let abstand = rtp.wrapping_sub(anker_rtp) as i32;
        let versatz_us = i64::from(abstand) * 1_000_000 / i64::from(takt);
        let versatz = Duration::from_micros(versatz_us.unsigned_abs());
        let ziel = if versatz_us >= 0 {
            anker_lokal.checked_add(versatz)
        } else {
            anker_lokal.checked_sub(versatz)
        };
        // Weit daneben heisst: die Zeitreihe ist gerissen (neuer Sender, lange
        // Luecke, Pause). Dann neu einhaengen, statt einer Rechnung zu folgen,
        // die nichts mehr beschreibt.
        let Some(z) = ziel.filter(|z| {
            z.saturating_duration_since(soll) < NEU_VERANKERN
                && soll.saturating_duration_since(*z) < NEU_VERANKERN
        }) else {
            self.neu_verankert += 1;
            self.anker = Some(Anker { rtp, lokal: soll, takt });
            return soll;
        };
        // **Der Anker wandert auf die kuerzeste Laufzeit, die die Strecke
        // hergibt.**
        //
        // Ohne das haengt der ganze Vorhalt an EINEM Messwert — dem ersten
        // Bild. Und ausgerechnet das ist das schlechteste: es ist das
        // Vollbild, also 25 bis 35 Pakete statt zwei bis drei, und es gilt
        // erst als angekommen, wenn das letzte davon da ist. Der Anker liegt
        // damit systematisch zu spaet, und jedes folgende Bild wartet die
        // Differenz zusaetzlich ab.
        //
        // **Am 2026-08-05 gegen die Produktion gemessen:** mit 60 ms
        // eingestelltem Vorhalt lag „Netz-bis-Schirm" bei 119 ms statt bei den
        // erwarteten rund 65. Der Einstieg allein kostete also fast eine
        // weitere Bildfolge, dauerhaft, ohne dass etwas darauf hinwies.
        //
        // Kommt ein Bild frueher, als der Anker erlaubt, wird der Anker um
        // genau diese Spanne nach vorn gezogen. Danach ist der Vorhalt das,
        // was eingestellt wurde, plus die AKTUELLE Abweichung von der besten
        // Laufzeit — und das ist genau die Groesse, die er ausgleichen soll.
        // Nach oben korrigiert er sich nicht (eine dauerhaft langsamer
        // gewordene Strecke faengt `NEU_VERANKERN` ab); ein Anker, der
        // Ausreissern nach oben folgte, waere wieder der Fehler von eben.
        let vorlauf = z.saturating_duration_since(jetzt);
        if vorlauf > vorhalt {
            let zuviel = vorlauf - vorhalt;
            self.nachgezogen += 1;
            if let Some(a) = self.anker.as_mut() {
                if let Some(frueher) = a.lokal.checked_sub(zuviel) {
                    a.lokal = frueher;
                }
            }
            return soll;
        }
        z
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::{DecodedFrame, PixelLayout};

    fn bild(rtp: u32) -> Box<DecodedFrame> {
        let mut f =
            DecodedFrame::for_test(2, 2, vec![vec![0; 4], vec![0; 1], vec![0; 1]], vec![2, 1, 1], false, PixelLayout::Planar420);
        f.rtp_ts = Some(rtp);
        f.clock_rate = 90_000;
        Box::new(f)
    }

    /// **Der Vorgabefall: aus.** Dann darf sich nichts aendern — ein Bild geht
    /// im selben Zug wieder heraus, und die Fernsteuerung zahlt keine
    /// Millisekunde.
    #[test]
    fn ohne_vorhalt_geht_alles_sofort_durch() {
        let mut t = Ausgabetakt::neu(0);
        assert!(!t.aktiv());
        let jetzt = Instant::now();
        t.einreihen(bild(0), jetzt);
        let (f, weg) = t.faellig(jetzt);
        assert!(f.is_some(), "ohne Takt muss das Bild sofort heraus");
        assert_eq!(weg, 0);
        assert!(t.leer());
        assert_eq!(t.verspaetet(), 0, "ohne Takt gibt es keine Verspaetung");
    }

    /// Das erste Bild setzt den Anker, jedes weitere folgt dem Abstand seiner
    /// Zeitstempel — unabhaengig davon, wann es ANKAM.
    #[test]
    fn die_senderuhr_gibt_den_takt_vor() {
        let mut t = Ausgabetakt::neu(50);
        let t0 = Instant::now();
        t.einreihen(bild(0), t0);
        // Zweites Bild: 1500 Takte = 16,67 ms spaeter beim Sender — aber es
        // kommt 40 ms spaeter an (verspaetet). Der Zielzeitpunkt darf davon
        // NICHT beruehrt werden.
        t.einreihen(bild(1500), t0 + Duration::from_millis(40));
        let termine: Vec<Instant> = t.warteschlange.iter().map(|(z, _)| *z).collect();
        let abstand = termine[1].duration_since(termine[0]);
        assert!(
            (16..=17).contains(&abstand.as_millis()),
            "Abstand muss der Senderuhr folgen, war {abstand:?}"
        );
    }

    /// Vor seinem Zeitpunkt darf ein Bild nicht heraus — sonst waere der Takt
    /// nur Zierde.
    #[test]
    fn zu_frueh_bleibt_liegen() {
        let mut t = Ausgabetakt::neu(50);
        let t0 = Instant::now();
        t.einreihen(bild(0), t0);
        assert!(t.faellig(t0).0.is_none(), "noch nicht faellig");
        assert!(t.faellig(t0 + Duration::from_millis(49)).0.is_none());
        assert!(t.faellig(t0 + Duration::from_millis(51)).0.is_some(), "jetzt faellig");
    }

    /// Wacht die Schleife zu spaet auf, gewinnt das juengste faellige Bild und
    /// die anderen werden gezaehlt statt still verschluckt.
    #[test]
    fn verspaetetes_aufwachen_zeigt_das_juengste() {
        let mut t = Ausgabetakt::neu(50);
        let t0 = Instant::now();
        for k in 0..4 {
            t.einreihen(bild(k * 1500), t0);
        }
        let (f, weg) = t.faellig(t0 + Duration::from_millis(500));
        assert!(f.is_some());
        assert_eq!(weg, 3, "drei uebersprungene muessen gezaehlt sein");
        assert!(t.leer());
    }

    /// **Der Anker darf nicht an EINEM Messwert haengen.**
    ///
    /// Das erste Bild ist das Vollbild — 25 bis 35 Pakete statt zwei bis drei,
    /// und es gilt erst als da, wenn das letzte davon eintraf. Ohne
    /// Nachziehen zahlte jedes folgende Bild diese Verzoegerung dauerhaft mit
    /// (2026-08-05 gegen die Produktion: 119 ms Netz-bis-Schirm bei 60 ms
    /// eingestelltem Vorhalt).
    #[test]
    fn der_anker_wandert_auf_die_kuerzeste_laufzeit() {
        let mut t = Ausgabetakt::neu(60);
        let t0 = Instant::now();
        // Erstes Bild: kommt 50 ms „zu spaet" gegenueber allen folgenden.
        t.einreihen(bild(0), t0);
        // Jedes weitere Bild kommt 50 ms frueher, als der Anker erlaubt.
        let mut jetzt = t0;
        for k in 1..=20 {
            jetzt = t0 + Duration::from_millis(k * 50 / 3) - Duration::from_millis(50);
            t.einreihen(bild((k * 1500) as u32), jetzt);
            let _ = t.faellig(jetzt);
        }
        let termin = t.naechster_termin().or(Some(jetzt)).unwrap();
        let vorlauf = termin.saturating_duration_since(jetzt);
        assert!(
            vorlauf <= Duration::from_millis(61),
            "nach dem Nachziehen darf nur noch der eingestellte Vorhalt uebrig sein, war {vorlauf:?}"
        );
        assert!(t.nachgezogen() > 0, "das Nachziehen muss auch gezaehlt werden");
    }

    /// Ein Bruch der Zeitreihe (neuer Sender, lange Pause) haengt den Takt neu
    /// ein, statt einer Rechnung zu folgen, die nichts mehr beschreibt.
    #[test]
    fn bruch_der_zeitreihe_verankert_neu() {
        let mut t = Ausgabetakt::neu(50);
        let t0 = Instant::now();
        t.einreihen(bild(0), t0);
        let _ = t.faellig(t0 + Duration::from_millis(60));
        // Zeitstempel springt um 10 Sekunden nach vorn, die Wanduhr nicht.
        t.einreihen(bild(900_000), t0 + Duration::from_millis(70));
        let ziel = t.naechster_termin().expect("wartet");
        let versatz = ziel.duration_since(t0 + Duration::from_millis(70));
        assert!(
            versatz < Duration::from_millis(60),
            "nach einem Bruch muss der Vorhalt wieder gelten, war {versatz:?}"
        );
        assert_eq!(t.neu_verankert(), 1);
    }

    /// Der Ueberlauf des 32-bit-Zeitstempels (alle ~13 h bei 90 kHz) darf das
    /// Bild nicht fuer Stunden stehenlassen.
    #[test]
    fn ueberlauf_des_zeitstempels_bleibt_ein_bildabstand() {
        let mut t = Ausgabetakt::neu(50);
        let t0 = Instant::now();
        t.einreihen(bild(u32::MAX - 700), t0);
        let _ = t.faellig(t0 + Duration::from_millis(60));
        // 1500 Takte weiter, dabei laeuft der Zaehler ueber.
        t.einreihen(bild(799), t0 + Duration::from_millis(70));
        let ziel = t.naechster_termin().expect("wartet");
        let versatz = ziel.duration_since(t0);
        assert!(
            (60..=80).contains(&versatz.as_millis()),
            "ueber den Ueberlauf hinweg muss es ein Bildabstand bleiben, war {versatz:?}"
        );
        assert_eq!(t.neu_verankert(), 0, "ein Ueberlauf ist KEIN Bruch der Zeitreihe");
    }

    /// Ohne Zeitstempel (Bilder aus Tests, oder bevor ein Videopaket gesehen
    /// wurde) gibt es nichts zu takten.
    #[test]
    fn ohne_zeitstempel_sofort() {
        let mut t = Ausgabetakt::neu(50);
        let jetzt = Instant::now();
        let f = Box::new(DecodedFrame::for_test(
            2, 2, vec![vec![0; 4], vec![0; 1], vec![0; 1]], vec![2, 1, 1], false, PixelLayout::Planar420,
        ));
        t.einreihen(f, jetzt);
        assert!(t.faellig(jetzt).0.is_some(), "ohne Zeitstempel sofort");
    }

    /// Die Warteschlange darf nicht wachsen — ein Bild sind Megabyte, und auf
    /// dem Zero-Copy-Weg ausserdem ein Ringplatz.
    #[test]
    fn die_warteschlange_ist_gedeckelt() {
        let mut t = Ausgabetakt::neu(500);
        let t0 = Instant::now();
        for k in 0..40 {
            t.einreihen(bild(k * 1500), t0);
        }
        // Alle 40 zur SELBEN Uhrzeit: dann zieht `ziel` den Anker bei jedem
        // Bild nach und gibt denselben Zeitpunkt zurueck, es gibt also gar
        // keinen Bildabstand zu schaetzen. Die Kapazitaet bleibt deshalb bei
        // der Untergrenze — geprueft wird hier die Deckelung als solche, nicht
        // ihre Hoehe (die hat `bei_144_fps_und_60_ms_vorhalt_...`).
        assert!(
            t.warteschlange.len() <= max_wartend(),
            "die Warteschlange darf nie ueber die Obergrenze wachsen, war {}",
            t.warteschlange.len()
        );
        assert!(t.verdraengt() > 0, "das Verdraengen muss gezaehlt werden");
    }

    /// **Der Fehler vom 2026-08-07.** Bei 144 fps und 60 ms Vorhalt braucht der
    /// Takt 8,6 Plaetze. Mit der alten festen Grenze von acht fielen die Bilder
    /// VOR ihrem Zielzeitpunkt wieder heraus — gemessen kamen von 144 nur 42
    /// bis 58 je Sekunde zur Anzeige.
    #[test]
    fn bei_144_fps_und_60_ms_vorhalt_faellt_nichts_vorzeitig_heraus() {
        let mut t = Ausgabetakt::neu(60);
        let t0 = Instant::now();
        // 625 RTP-Takte bei 90 kHz = 6,94 ms = 144 Bilder je Sekunde.
        let schritt = Duration::from_micros(6_944);
        let mut jetzt = t0;
        for k in 0..200u32 {
            jetzt = t0 + schritt * k;
            t.einreihen(bild(k * 625), jetzt);
            let _ = t.faellig(jetzt);
        }
        assert_eq!(
            t.verdraengt(),
            0,
            "kein Bild darf vor seinem Zeitpunkt herausfallen (Kapazitaet {})",
            t.kapazitaet()
        );
        assert!(
            t.kapazitaet() > MIN_WARTEND,
            "60 ms bei 144 fps brauchen mehr als {MIN_WARTEND} Plaetze, gerechnet wurden {}",
            t.kapazitaet()
        );
    }

    /// **Die Bildrate darf keine Klippe mehr haben.** Bei 240 fps passt der
    /// eingestellte Vorhalt von 60 ms nicht in die Plaetze (16 noetig, 12 da).
    /// Statt Bilder wegzuwerfen — gemessen kamen von 240 nur 17 bis 162 an —
    /// wird der Vorhalt gekuerzt.
    #[test]
    fn sehr_hohe_bildrate_kuerzt_den_vorhalt_statt_bilder_zu_verwerfen() {
        let mut t = Ausgabetakt::neu(60);
        let t0 = Instant::now();
        // 375 RTP-Takte bei 90 kHz = 4,17 ms = 240 Bilder je Sekunde.
        let schritt = Duration::from_micros(4_167);
        let mut jetzt = t0;
        for k in 0..50u32 {
            jetzt = t0 + schritt * k;
            t.einreihen(bild(k * 375), jetzt);
            let _ = t.faellig(jetzt);
        }
        // Beim Einstieg steht die Bildrate noch nicht fest und der Anker liegt
        // auf dem vollen Vorhalt; ein paar Bilder gehen dabei verloren. Das ist
        // hinzunehmen und wird deshalb nur gedeckelt, nicht wegdefiniert.
        let nach_dem_anlauf = t.verdraengt();
        assert!(nach_dem_anlauf <= 8, "der Anlauf darf nicht teuer sein, war {nach_dem_anlauf}");
        // **Das ist die eigentliche Zusicherung:** im Dauerbetrieb faellt nichts
        // mehr heraus, egal wie hoch die Bildrate ist.
        for k in 50..300u32 {
            jetzt = t0 + schritt * k;
            t.einreihen(bild(k * 375), jetzt);
            let _ = t.faellig(jetzt);
        }
        assert_eq!(
            t.verdraengt(),
            nach_dem_anlauf,
            "im Dauerbetrieb darf kein Bild mehr vorzeitig herausfallen"
        );
        assert!(
            t.wirksamer_vorhalt() < Duration::from_millis(60),
            "der Vorhalt muss gekuerzt worden sein, war {:?}",
            t.wirksamer_vorhalt()
        );
        assert!(
            t.wirksamer_vorhalt() >= Duration::from_millis(35),
            "aber nicht mehr als noetig, war {:?}",
            t.wirksamer_vorhalt()
        );
    }

    /// Die Gegenprobe: bei 60 fps genuegen acht Plaetze weiterhin, es wird also
    /// kein Speicher verschenkt.
    #[test]
    fn bei_60_fps_bleibt_es_bei_der_untergrenze() {
        let mut t = Ausgabetakt::neu(60);
        let t0 = Instant::now();
        let schritt = Duration::from_micros(16_667);
        let mut jetzt = t0;
        for k in 0..60u32 {
            jetzt = t0 + schritt * k;
            t.einreihen(bild(k * 1500), jetzt);
            let _ = t.faellig(jetzt);
        }
        assert_eq!(t.kapazitaet(), MIN_WARTEND);
        assert_eq!(t.verdraengt(), 0);
    }

    /// Ein geaenderter Vorhalt darf keine Bilder mit Zeitpunkten aus der alten
    /// Rechnung stehenlassen.
    #[test]
    fn vorhalt_umstellen_haelt_nichts_fest() {
        let mut t = Ausgabetakt::neu(200);
        let t0 = Instant::now();
        t.einreihen(bild(0), t0);
        t.setze_vorhalt(0);
        assert!(!t.aktiv());
        assert!(t.faellig(Instant::now()).0.is_some(), "wartende Bilder muessen heraus");
        t.leeren();
        assert!(t.leer());
    }
}
