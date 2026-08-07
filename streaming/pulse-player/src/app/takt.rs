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
//! **HIER STAND BIS ZUM 2026-08-06 „Vorgabe ist deshalb AUS (`vorhalt = 0`)".
//! Das ist falsch, und zwar seit dem 2026-08-05:** die Vorgabe steht auf
//! **60 ms** (`proto::AUSGABETAKT_MS_VORGABE`, in `PlayerOptions::defaults`
//! gesetzt), der Takt ist also EINGESCHALTET, es sei denn, der Aufrufer
//! schickt ausdruecklich etwas anderes. Die Messung, die das begruendet, steht
//! an `proto.rs:142`; nachgezogen wurde sie damals nur dort, und diese Zeile
//! ist eine von vier, die deshalb das Gegenteil behaupteten.
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

/// Speicherbudget der Warteschlange in Byte.
///
/// **Hier stand bis zum 2026-08-07 eine feste Anzahl von acht Bildern, und das
/// war der schwerste Fehler in diesem Modul.** Die Begruendung dort lautete
/// „acht sind bei 60 fps ein Vorhalt von 133 ms — mehr als hier je sinnvoll
/// ist"; sie rechnet aber nur fuer 60 fps. Wie viele Bilder der Vorhalt
/// braucht, ist `Vorhalt * Bildrate`, und das sind bei 60 ms Vorhalt (der
/// Vorgabe seit dem 2026-08-05) **8,6 Bilder bei 144 fps** und **14,4 bei
/// 240 fps**. Ueber rund 133 fps war die Warteschlange damit dauerhaft zu
/// kurz — und weil das aelteste, also das als naechstes faellige Bild
/// herausgeworfen wurde, wurde **kein einziges Bild mehr faellig**.
///
/// Gemessen an der Simulation in diesem Modul
/// (`ausgabetakt_ueber_bildraten`, gleichmaessige Ankunft, fuenf Sekunden):
///
/// | Bildrate | ausgegeben, alt | ausgegeben, jetzt |
/// |---|---|---|
/// | 120 | 98,8 % | 98,8 % |
/// | 133 | 98,9 % | 98,9 % |
/// | 144 | **0 %** | 98,9 % |
/// | 240 | **0 %** | 98,8 % |
/// | 280 | **0 %** | 98,9 % |
///
/// (Der Rest von rund einem Prozent sind die Bilder, die am Ende der fuenf
/// Sekunden noch im Vorlauf liegen — genau `Vorhalt * Bildrate`.)
///
/// Gezaehlt wurde der Verlust nirgends: `MAX_WARTEND` warf still weg, und
/// `frames_never_drawn` zaehlt nur die Uebersprungenen aus [`Ausgabetakt::faellig`].
/// Deshalb hat dieses Modul jetzt einen eigenen Zaehler ([`Ausgabetakt::verworfen`]).
///
/// Begrenzt wird ab jetzt der **Speicher**, denn das war schon vorher der
/// eigentliche Grund: 192 MB tragen 1440p10 (10,5 MB je Bild) bis 240 fps und
/// 1080p8 (3 MB) bis weit darueber. Die Anzahl folgt daraus von selbst und
/// muss nicht mehr geraten werden.
const MAX_WARTEND_BYTES: usize = 192 * 1024 * 1024;

/// Harte Obergrenze der Anzahl — Notbremse fuer den Fall, dass die Bilder sehr
/// klein sind (kleine Aufloesung, sehr hohe Bildrate) und das Speicherbudget
/// deshalb nie greift. 64 Bilder sind bei 500 fps 128 ms Vorhalt.
const MAX_WARTEND_HART: usize = 64;

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
    /// Wie viele Bilder das Budget der Warteschlange weggenommen hat.
    verworfen: u64,
    /// Belegung der Warteschlange in Byte, mitgefuehrt statt bei jedem
    /// Einreihen ueber alle Ebenen aller wartenden Bilder summiert.
    bytes: usize,
}

/// Speicherbedarf eines Bildes in den Ebenen-Puffern.
fn bildgroesse(frame: &DecodedFrame) -> usize {
    frame.planes.iter().map(Vec::len).sum()
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
            verworfen: 0,
            bytes: 0,
        }
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

    /// Vom Budget der Warteschlange weggenommene Bilder. Steht die Zahl nicht
    /// auf Null, reicht der Speicher fuer Vorhalt mal Bildrate nicht — genau
    /// das war bis zum 2026-08-07 der stille Totalausfall ueber 133 fps.
    pub fn verworfen(&self) -> u64 {
        self.verworfen
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
        self.bytes += bildgroesse(&frame);
        self.warteschlange.push_back((ziel, frame));
        self.budget_einhalten(jetzt);
    }

    /// Das Budget durchsetzen — **ohne das faellige Bild wegzuwerfen.**
    ///
    /// Reicht der Platz nicht fuer `Vorhalt * Bildrate`, ist die richtige
    /// Antwort ein **kuerzerer Vorhalt**, nicht ein verlorenes Bild: das
    /// vorderste Bild wird auf „jetzt faellig" gezogen, der Aufrufer holt es im
    /// selben Zug ab (`App::abliefern` ruft [`Ausgabetakt::faellig`] direkt nach
    /// [`Ausgabetakt::einreihen`]). Der Takt bleibt dabei erhalten, er laeuft
    /// nur mit weniger Vorlauf.
    ///
    /// Verworfen wird erst, wenn der Aufrufer gar nicht abholt (dann waechst
    /// die Schlange trotz Faelligkeit weiter) — dafuer die doppelte Schwelle
    /// und die harte Anzahl. Nur dieser Fall zaehlt in [`Ausgabetakt::verworfen`].
    fn budget_einhalten(&mut self, jetzt: Instant) {
        while self.bytes > 2 * MAX_WARTEND_BYTES || self.warteschlange.len() > MAX_WARTEND_HART {
            if self.vorne_entnehmen().is_none() {
                break;
            }
            self.verworfen += 1;
        }
        if self.bytes <= MAX_WARTEND_BYTES {
            return;
        }
        // Vorlauf kuerzen: so viele der vordersten Bilder sofort faellig
        // machen, bis der Rest wieder ins Budget passt.
        let mut rest = self.bytes;
        for (ziel, frame) in self.warteschlange.iter_mut() {
            if rest <= MAX_WARTEND_BYTES {
                break;
            }
            rest -= bildgroesse(frame);
            if *ziel > jetzt {
                *ziel = jetzt;
            }
        }
    }

    /// Das vorderste Bild entnehmen und die Speicher-Buchhaltung nachziehen.
    /// Der einzige Weg aus der Warteschlange heraus — sonst driftet `bytes`.
    fn vorne_entnehmen(&mut self) -> Option<Box<DecodedFrame>> {
        let (_, frame) = self.warteschlange.pop_front()?;
        self.bytes = self.bytes.saturating_sub(bildgroesse(&frame));
        Some(frame)
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
            letztes = self.vorne_entnehmen();
        }
        (letztes, uebersprungen)
    }

    /// Alles verwerfen (Sitzungsende, Codec-Wechsel).
    #[cfg(test)]
    pub fn leeren(&mut self) {
        self.warteschlange.clear();
        self.bytes = 0;
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
        let soll = jetzt + self.vorhalt;
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
        if vorlauf > self.vorhalt {
            let zuviel = vorlauf - self.vorhalt;
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

    /// Die Warteschlange darf nicht wachsen — ein Bild sind Megabyte. Wer gar
    /// nichts abholt, laeuft in die harte Anzahl.
    #[test]
    fn die_warteschlange_ist_gedeckelt() {
        let mut t = Ausgabetakt::neu(500);
        let t0 = Instant::now();
        for k in 0..(MAX_WARTEND_HART as u32 * 2) {
            t.einreihen(bild(k * 1500), t0);
        }
        assert_eq!(t.warteschlange.len(), MAX_WARTEND_HART);
        assert!(t.verworfen() > 0, "der Verlust muss gezaehlt sein");
    }

    /// Was ein Lauf ueber mehrere Sekunden ergeben hat.
    struct Lauf {
        takt: Ausgabetakt,
        /// Eingereihte Bilder.
        hinein: u32,
        /// Ausgegebene Bilder.
        heraus: u64,
        /// Von [`Ausgabetakt::faellig`] uebersprungene Bilder.
        uebersprungen: u64,
    }

    impl Lauf {
        fn anteil_heraus(&self) -> f64 {
            100.0 * self.heraus as f64 / f64::from(self.hinein)
        }
    }

    /// Gleichmaessige Ankunft simulieren: `sekunden` lang `fps` Bilder je
    /// Sekunde einreihen und dabei so abholen, wie es die Fensterschleife tut —
    /// bei jeder Ankunft, und zusaetzlich zum Termin des naechsten wartenden
    /// Bildes, solange der noch vor der naechsten Ankunft liegt.
    fn simulieren(fps: u32, vorhalt_ms: u32, sekunden: u32) -> Lauf {
        let mut takt = Ausgabetakt::neu(vorhalt_ms);
        let t0 = Instant::now();
        let schritt_us = 1_000_000f64 / f64::from(fps);
        let takt_schritt = 90_000f64 / f64::from(fps);
        let ankunft = |k: u32| t0 + Duration::from_micros((f64::from(k) * schritt_us) as u64);
        let mut heraus = 0u64;
        let mut uebersprungen = 0u64;
        let hinein = fps * sekunden;
        for k in 0..hinein {
            let jetzt = ankunft(k);
            takt.einreihen(bild((f64::from(k) * takt_schritt) as u32), jetzt);
            let (f, weg) = takt.faellig(jetzt);
            heraus += u64::from(f.is_some());
            uebersprungen += weg;
            while let Some(termin) = takt.naechster_termin().filter(|x| *x < ankunft(k + 1)) {
                let (f, weg) = takt.faellig(termin);
                heraus += u64::from(f.is_some());
                uebersprungen += weg;
            }
        }
        Lauf { takt, hinein, heraus, uebersprungen }
    }

    /// **Der Fall, an dem der Player ueber 133 fps gestorben ist.**
    ///
    /// Bei 60 ms Vorhalt und 144 fps braucht die Warteschlange 8,6 Bilder. Die
    /// alte feste Deckelung auf acht warf dafuer das **vorderste** Bild weg,
    /// also genau das, das als naechstes faellig geworden waere — Ergebnis:
    /// null ausgegebene Bilder, ohne einen einzigen Zaehler, der es sagte.
    #[test]
    fn hohe_bildrate_gibt_bilder_heraus() {
        for fps in [144u32, 240] {
            let lauf = simulieren(fps, 60, 2);
            let anteil = lauf.anteil_heraus();
            assert!(
                anteil > 95.0,
                "bei {fps} fps muessen die Bilder herauskommen, waren {anteil:.1} %"
            );
            assert_eq!(lauf.takt.verworfen(), 0, "nichts darf dabei verworfen werden");
        }
    }

    /// **Messung, kein Verhaltenstest.** Faehrt den Takt ueber mehrere
    /// Bildraten und schreibt auf, wie viele Bilder herauskommen und wie viele
    /// die Deckelung ([`MAX_WARTEND_BYTES`] bzw. [`MAX_WARTEND_HART`]) vorher
    /// wegnimmt. Ausgabe mit
    /// `cargo test -- --nocapture ausgabetakt_ueber_bildraten`.
    #[test]
    #[ignore = "Messung, nicht Teil der Regression"]
    fn ausgabetakt_ueber_bildraten() {
        for fps in [60u32, 100, 120, 133, 144, 165, 240, 280] {
            for vorhalt in [0u32, 60] {
                let lauf = simulieren(fps, vorhalt, 5);
                let verloren = u64::from(lauf.hinein) - lauf.heraus;
                println!(
                    "fps {fps:3} vorhalt {vorhalt:3} ms: hinein {:4}, heraus {:4} \
                     ({:5.1} %), uebersprungen {:4}, verloren {verloren:4}, \
                     verspaetet {}, verworfen {}",
                    lauf.hinein,
                    lauf.heraus,
                    lauf.anteil_heraus(),
                    lauf.uebersprungen,
                    lauf.takt.verspaetet(),
                    lauf.takt.verworfen(),
                );
            }
        }
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
