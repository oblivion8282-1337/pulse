//! Ende-zu-Ende-Latenz: die Uhrzeit aus dem Bild zurücklesen.
//!
//! Der Prüfstand malt mit `streaming/testbench/latency-pattern.py` einen Balken
//! aus schwarzen und weißen Klötzen auf den Bildschirm, der die Millisekunden
//! seit einer gemeinsamen Epoche kodiert. Hier wird er aus der Luma-Ebene des
//! dekodierten Bildes gelesen; die Differenz zur aktuellen Uhrzeit ist die
//! Latenz über die GANZE Kette — Aufnahme, Encoder, Netz, MediaMTX, Jitter,
//! Decoder, Fenster.
//!
//! Warum dieser Umweg und nicht ein Zeitstempel im Bitstrom: der Weg führt über
//! FLV, RTMP, MediaMTX und WebRTC. Jede Station schreibt Zeitstempel um. Was im
//! BILD steht, überlebt alle davon unverändert.
//!
//! Nur aktiv mit `PULSE_PLAYER_LATENCY_PROBE=1`; im Normalbetrieb kostet es
//! keinen Handschlag (die Sitzung legt gar keine Sonde an).
//!
//! Nicht offensichtlich: gemessen wird gegen die Uhr, die das MALENDE Programm
//! benutzt, also `SystemTime` (CLOCK_REALTIME) auf derselben Maschine — nicht
//! `Instant`. Ein Sprung der Systemuhr während der Messung würde sie verfälschen;
//! dafür ist sie überhaupt erst über Prozessgrenzen hinweg vergleichbar.
//!
//! ## Zwei Quellen, EINE Auswertung (seit 2026-08-07)
//!
//! Das Muster kommt auf zwei Wegen herein, und beide enden in derselben
//! Bit-Auswertung ([`zaehler_aus_kloetzen`]):
//!
//! * **Ebenen im Hauptspeicher** — der bisherige Weg ([`LatencyProbe::note`]).
//! * **Zeilen aus der eingehängten GPU-Textur** ([`LatencyProbe::note_gpu`]).
//!   Auf dem Zero-Copy-Weg (`crate::zerocopy`) gibt es die Ebenen nicht mehr;
//!   der Renderer kopiert deshalb die vier Musterzeilen der Luma-Textur in
//!   einen Abholpuffer (`render::musterprobe`) und reicht sie als
//!   [`Musterzeilen`] herein.
//!
//! **Zwei Fassungen derselben Bit-Auswertung wären der Fehler, der hier schon
//! einmal eine ganze Messreihe entwertet hat** (2026-08-01, falsches Byte bei
//! 10 bit: 32535 Bilder ohne Muster, während das Bild sichtbar lief). Deshalb
//! unterscheiden sich die beiden Wege nur noch darin, WOHER ein einzelner
//! Helligkeitswert kommt — ab dem ersten Bit ist es derselbe Code.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::decode::{DecodedFrame, PixelLayout};

// ── Musterformat — MUSS mit `latency-pattern.py` übereinstimmen ──────────────
pub(crate) const BLOCK: usize = 32;
const MARKER: [u8; 8] = [1, 0, 1, 1, 0, 0, 1, 0];
const COUNTER_BITS: usize = 16;
pub(crate) const POS_X: [usize; 3] = [64, 880, 1696];
pub(crate) const POS_Y: [usize; 4] = [64, 400, 800, 1200];

/// Wie viele Klötze ein Balken hat: Erkennungsmuster plus Zählerbits.
const BITS: usize = MARKER.len() + COUNTER_BITS;

/// Bis zu welcher Spalte ein Balken reichen kann — die Breite, die der
/// Renderer je Zeile kopieren muss, damit die letzte Kandidatenstelle
/// vollständig darin liegt.
pub(crate) const MUSTER_BREITE: usize = POS_X[2] + BITS * BLOCK;

/// Die Bildzeile, in der ein Balken an `y0` abgelesen wird.
///
/// Die Mitte des Klotzes, nicht sein Rand: die Ränder verwischt der Encoder.
/// Steht hier und nicht zweimal im Programm, weil der Renderer GENAU diese
/// Zeile kopieren muss — läge sie um einen Bildpunkt daneben, läse die Sonde
/// stumm nichts mehr.
pub(crate) const fn musterzeile(y0: usize) -> usize {
    y0 + BLOCK / 2
}

/// Läuft die Sonde? **Einmal aus der Umgebung gelesen**, nicht je Bild.
///
/// Gebraucht wird die Antwort nicht nur beim Anlegen der Sonde, sondern auch im
/// Renderer: ohne den Schalter darf dort **kein einziger zusätzlicher Befehl**
/// abgesetzt und keine zusätzliche Nutzungsart an der eingehängten Textur
/// angemeldet werden (s. `render::musterprobe`). Zwei getrennte Abfragen
/// derselben Variablen könnten auseinanderlaufen — dann kopierte der Renderer
/// Zeilen, die niemand liest, oder die Sonde suchte in Zeilen, die niemand
/// kopiert hat.
pub fn sonde_aktiv() -> bool {
    static AN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AN.get_or_init(|| std::env::var("PULSE_PLAYER_LATENCY_PROBE").as_deref() == Ok("1"))
}

/// Die vom Renderer kopierten Musterzeilen EINES Bildes.
///
/// **Der Zeitstempel gehört dazu, und das ist der entscheidende Punkt.** Die
/// Abholung von der GPU hinkt ein bis zwei Bilder hinterher (Begründung im Kopf
/// von `render::abdruck`). Würde die Uhr erst beim Abholen gelesen, steckten 16
/// bis 33 ms Messfehler darin — dieselbe Größenordnung wie der Gewinn, um den es
/// beim Zero-Copy-Weg überhaupt geht, und einseitig zu dessen Lasten. Gestempelt
/// wird deshalb beim AUFZEICHNEN, also in dem Durchgang, in dem das Bild
/// tatsächlich gezeichnet wird.
pub struct Musterzeilen {
    /// `SystemTime` beim Aufzeichnen, in Millisekunden seit der Unix-Epoche.
    pub stempel_ms: u64,
    /// Ob ein Texel zwei Byte trägt (P010-Lage, s. [`luma_in_zeile`]).
    pub zehn_bit: bool,
    /// Je Eintrag: der `POS_Y`-Wert der Stelle und die rohen Texel der Zeile.
    ///
    /// **Leer ist ein gültiger Fall** und heißt „kein Muster" — die Sonde zählt
    /// das als Fehlschlag, statt zu schweigen.
    pub zeilen: Vec<(usize, Vec<u8>)>,
}

/// Über dieser Latenz gilt ein Ablesen als Unsinn (verdeckter Balken, zufällig
/// passendes Bildschirmmuster, Umlauf des Zählers). 2 s ist weit jenseits allem,
/// was diese Kette je braucht, und weit unter den 65,5 s des Umlaufs.
const MAX_PLAUSIBLE_MS: u64 = 2_000;

#[derive(Default)]
pub struct LatencyProbe {
    epoch_ms: u64,
    /// Zuletzt erfolgreiche Stelle — beim nächsten Bild zuerst probiert. Ohne
    /// das würde jedes Bild alle zwölf Stellen durchgehen, obwohl sich der Ort
    /// praktisch nie ändert.
    hit: Option<(usize, usize)>,
    sum_us: u64,
    count: u64,
    max_us: u64,
    avg_us: u64,
    max_us_last: u64,
    /// Bilder, in denen kein gültiger Balken zu finden war. Gehört in die
    /// Ausgabe: eine Messung über zwei von hundert Bildern wäre keine.
    misses: u64,
    misses_last: u64,
}

impl LatencyProbe {
    /// Sonde nur anlegen, wenn beide Umgebungsvariablen gesetzt sind. Ohne
    /// Epoche wäre jede Zahl erfunden — deshalb kein Standardwert.
    pub fn from_env() -> Option<Self> {
        // Ueber [`sonde_aktiv`] und nicht ueber eine zweite eigene Abfrage: es
        // ist dieselbe Frage, die auch der Renderer stellt, und zwei Abfragen
        // derselben Variablen koennten auseinanderlaufen (Begruendung dort).
        if !sonde_aktiv() {
            return None;
        }
        let epoch_ms = std::env::var("PULSE_PLAYER_LATENCY_EPOCH_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())?;
        eprintln!("pulse-player: Latenz-Sonde aktiv (Epoche {epoch_ms})");
        Some(Self { epoch_ms, ..Default::default() })
    }

    /// Eine Sonde mit gesetzter Epoche — **nur für Tests**, auch für die in
    /// `render::musterprobe`: dort wird der ganze Rückweg über echte Hardware
    /// geprüft und braucht am Ende jemanden, der die Zeilen auswertet.
    #[cfg(test)]
    pub fn fuer_test(epoch_ms: u64) -> Self {
        Self { epoch_ms, ..Default::default() }
    }

    /// Ein Bild auswerten. Wird unmittelbar vor dem Hochladen gerufen, weil die
    /// Ebenen danach dem Renderer gehören.
    pub fn note(&mut self, frame: &DecodedFrame) {
        // **Auf dem Zero-Copy-Weg gibt es hier nichts zu lesen** — das Bild
        // bleibt im Grafikspeicher, `planes` ist leer (s. `crate::zerocopy`).
        //
        // **Hier stand bis zum 2026-08-07 eine einmalige Meldung „Sonde AUS …
        // für eine Messung: PULSE_PLAYER_ZEROCOPY=0". Die ist überholt**: das
        // Muster wird seither aus der eingehängten Textur gelesen und kommt über
        // [`LatencyProbe::note_gpu`] herein. Stillschweigend übergangen wird das
        // Bild trotzdem nicht — bleibt der Weg über die Textur aus (fremde
        // Plattform, Textur nicht kopierbar), sagt `render::musterprobe` das
        // einmal und deutlich. Ein hier hochgezählter Fehlschlag wäre dagegen
        // falsch: gemessen wird dieses Bild ja, nur woanders.
        if frame.gpu.is_some() {
            return;
        }
        let Some(counter) = self.read_counter(frame) else {
            self.misses += 1;
            return;
        };
        self.werten(counter, jetzt_ms());
    }

    /// Dasselbe aus den vom Renderer kopierten Musterzeilen — der Zero-Copy-Weg.
    ///
    /// **Die Uhr wird NICHT hier gelesen**, sondern kommt aus
    /// [`Musterzeilen::stempel_ms`] mit (Begründung dort).
    pub fn note_gpu(&mut self, zeilen: &Musterzeilen) {
        let Some(counter) = self.zaehler_aus_zeilen(zeilen) else {
            self.misses += 1;
            return;
        };
        self.werten(counter, zeilen.stempel_ms);
    }

    /// Aus abgelesenem Zähler und Ablesezeitpunkt eine Latenz machen.
    ///
    /// Der gemeinsame Rumpf beider Wege: ab hier ist es gleichgültig, ob das
    /// Muster aus einer Ebene im Hauptspeicher oder aus einer GPU-Textur kam.
    fn werten(&mut self, counter: u16, jetzt_ms: u64) {
        // Beide Seiten rechnen in Millisekunden seit derselben Epoche; der
        // Zähler ist auf 16 bit beschnitten, die Differenz also modulo 65536.
        let elapsed = jetzt_ms.saturating_sub(self.epoch_ms) & 0xFFFF;
        let latency_ms = elapsed.wrapping_sub(counter as u64) & 0xFFFF;
        if latency_ms > MAX_PLAUSIBLE_MS {
            // Unglaubwürdig: entweder ein Fehltreffer im Bildinhalt oder der
            // Balken war verdeckt. Die Stelle verwerfen, damit das nächste Bild
            // neu sucht, statt dauerhaft Unsinn zu liefern.
            self.hit = None;
            self.misses += 1;
            return;
        }
        let us = latency_ms * 1000;
        self.sum_us += us;
        self.count += 1;
        self.max_us = self.max_us.max(us);
    }

    /// Fenster abschließen: Mittel bilden, Zähler leeren. Wird im selben
    /// Sekundenrhythmus gerufen wie die übrigen Messwerte.
    pub fn roll(&mut self) {
        if self.count > 0 {
            self.avg_us = self.sum_us / self.count;
            self.max_us_last = self.max_us;
        }
        self.misses_last = self.misses;
        self.sum_us = 0;
        self.count = 0;
        self.max_us = 0;
        self.misses = 0;
    }

    pub fn avg_us(&self) -> u64 {
        self.avg_us
    }
    pub fn max_us(&self) -> u64 {
        self.max_us_last
    }
    pub fn misses(&self) -> u64 {
        self.misses_last
    }

    /// Zähler an der gemerkten oder an einer der zwölf Stellen lesen.
    fn read_counter(&mut self, frame: &DecodedFrame) -> Option<u16> {
        if let Some((x, y)) = self.hit {
            if let Some(v) = read_bar(frame, x, y) {
                return Some(v);
            }
        }
        for y in POS_Y {
            for x in POS_X {
                if let Some(v) = read_bar(frame, x, y) {
                    self.hit = Some((x, y));
                    return Some(v);
                }
            }
        }
        None
    }

    /// Dasselbe in den kopierten Zeilen — gemerkte Stelle zuerst, dann alle.
    ///
    /// Die Suche hat hier weniger zu tun als über den Ebenen: der Renderer
    /// kopiert nur die vier Zeilen, in denen ein Balken überhaupt liegen kann,
    /// also bleiben je Bild dieselben zwölf Kandidatenstellen wie dort.
    fn zaehler_aus_zeilen(&mut self, z: &Musterzeilen) -> Option<u16> {
        if let Some((x, y)) = self.hit {
            let gemerkt = z.zeilen.iter().find(|(y0, _)| *y0 == y);
            if let Some(v) = gemerkt.and_then(|(_, d)| zaehler_in_zeile(d, z.zehn_bit, x)) {
                return Some(v);
            }
        }
        for (y0, daten) in &z.zeilen {
            for x in POS_X {
                if let Some(v) = zaehler_in_zeile(daten, z.zehn_bit, x) {
                    self.hit = Some((x, *y0));
                    return Some(v);
                }
            }
        }
        None
    }
}

/// Die Uhr, gegen die gemessen wird (s. Modulkopf: `SystemTime`, nicht
/// `Instant`).
///
/// **Crate-weit und nicht je Modul eine eigene Fassung**: `render::musterprobe`
/// stempelt seine Ringplaetze mit derselben Uhr, und die Zahlen beider Wege
/// werden hier gegeneinander verrechnet. Zwei Fassungen koennten irgendwann auf
/// zwei verschiedene Uhren zeigen, und der Unterschied saehe wie Latenz aus.
pub(crate) fn jetzt_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Luma eines Bildpunkts, 8 oder 10 bit, immer auf 0..=255 gebracht.
///
/// **Wo die zehn Bit im 16-bit-Wort sitzen, haengt vom Decoder ab** — und das
/// ist keine Feinheit, sondern der Unterschied zwischen Messung und Blindheit:
///
/// * `P010LE` (zwei Ebenen; `av1_cuvid`, VAAPI): die zehn Bit sitzen **oben**.
/// * `YUV420P10LE` (drei Ebenen; `libdav1d`, `libaom`): sie sitzen **unten**.
///
/// Bis 2026-08-01 wurde immer das obere Byte genommen. Beim Software-Decoder
/// stehen dort nur die obersten zwei Bit des Wertes (0..3) — also immer
/// "schwarz", der Balken wurde in JEDEM Bild verworfen und die Sonde meldete
/// stumm "ohne Muster". Aufgefallen an einer Messreihe, die 32535 Bilder ohne
/// Muster zaehlte, waehrend das Bild sichtbar lief.
fn luma_at(frame: &DecodedFrame, x: usize, y: usize) -> Option<u8> {
    let stride = *frame.strides.first()?;
    let plane = frame.planes.first()?;
    if frame.ten_bit {
        let off = y * stride + x * 2;
        let wort = u16::from_le_bytes([*plane.get(off)?, *plane.get(off + 1)?]);
        let zehn_bit = match frame.format {
            PixelLayout::BiPlanar420 => wort >> 6,
            PixelLayout::Planar420 => wort & 0x03FF,
        };
        Some((zehn_bit >> 2) as u8)
    } else {
        Some(*plane.get(y * stride + x)?)
    }
}

/// Luma eines Texels in einer kopierten Musterzeile.
///
/// **Dieselbe Bitlage wie bei `P010LE` oben, und das ist nachgesehen, nicht
/// angenommen**: die Linux-Brücke kopiert `data[0]` des dekodierten Bildes
/// unverändert in eine `R16Unorm`-Textur (`zerocopy::linux::ebene`), es steht
/// dort also das rohe P010-Wort mit den zehn Bit OBEN. Bei 8 bit ist es eine
/// `R8Unorm`-Textur und damit ein Byte je Texel.
fn luma_in_zeile(zeile: &[u8], zehn_bit: bool, x: usize) -> Option<u8> {
    if zehn_bit {
        let off = x * 2;
        let wort = u16::from_le_bytes([*zeile.get(off)?, *zeile.get(off + 1)?]);
        Some(((wort >> 6) >> 2) as u8)
    } else {
        Some(*zeile.get(x)?)
    }
}

/// Ein Klotz-Wert wird zu einem Bit — oder zu „das ist nicht unser Balken".
///
/// Grenzwerte statt einer Mitte bei 128: dazwischen liegt kein gültiger Wert,
/// und ein grauer Punkt heißt, dass hier gar kein Muster steht.
fn bit_wert(v: u8) -> Option<u8> {
    match v {
        0..=70 => Some(0),
        180..=255 => Some(1),
        _ => None,
    }
}

/// **Die eine Bit-Auswertung**, für beide Wege: erst das Erkennungsmuster
/// prüfen, dann die sechzehn Zählerbits. `None`, sobald etwas nicht passt.
///
/// `lies(i)` liefert die Helligkeit in der MITTE des i-ten Klotzes — die Ränder
/// verwischt der Encoder, die Mitte bleibt auch bei 4000 kbps eindeutig schwarz
/// oder weiß.
fn zaehler_aus_kloetzen(lies: impl Fn(usize) -> Option<u8>) -> Option<u16> {
    let bit_at = |i: usize| -> Option<u8> { bit_wert(lies(i)?) };
    for (i, want) in MARKER.iter().enumerate() {
        if bit_at(i)? != *want {
            return None;
        }
    }
    let mut counter: u16 = 0;
    for i in 0..COUNTER_BITS {
        counter = (counter << 1) | bit_at(MARKER.len() + i)? as u16;
    }
    Some(counter)
}

/// Mitte des i-ten Klotzes eines Balkens, der bei `x0` beginnt.
fn klotzmitte(x0: usize, i: usize) -> usize {
    x0 + i * BLOCK + BLOCK / 2
}

/// Die Bitfolge EINES Balkens: erst das Erkennungsmuster, dann die sechzehn
/// Zaehlerbits, hoechstwertiges zuerst — genau die Reihenfolge, die
/// `latency-pattern.py` malt und die [`zaehler_aus_kloetzen`] erwartet.
///
/// **Nur fuer Tests, aber crate-weit sichtbar**: gebraucht wird sie hier und in
/// `render::musterprobe`, wo derselbe Balken in eine echte GPU-Textur gemalt
/// wird. Drei wortgleiche Fassungen davon waeren im Kleinen genau die Doppelung,
/// die die Bit-Auswertung selbst ausdruecklich nicht haben darf — eine davon
/// koennte die Reihenfolge drehen, und dann prueften die Tests einander nicht
/// mehr gegen, sondern jeder nur noch sich selbst.
#[cfg(test)]
pub(crate) fn musterbits(counter: u16) -> Vec<u8> {
    MARKER
        .iter()
        .copied()
        .chain((0..COUNTER_BITS).map(|i| ((counter >> (COUNTER_BITS - 1 - i)) & 1) as u8))
        .collect()
}

/// Einen Balken an (x0, y0) in den Ebenen im Hauptspeicher lesen.
fn read_bar(frame: &DecodedFrame, x0: usize, y0: usize) -> Option<u16> {
    let cy = musterzeile(y0);
    if cy >= frame.height as usize || x0 + BITS * BLOCK > frame.width as usize {
        return None;
    }
    zaehler_aus_kloetzen(|i| luma_at(frame, klotzmitte(x0, i), cy))
}

/// Einen Balken ab `x0` in einer kopierten Musterzeile lesen.
///
/// Eine Zeile, die zu kurz ist, liefert `None` — `luma_in_zeile` greift über
/// `get`, ein abgeschnittener Balken kann also nicht als gültig durchgehen.
fn zaehler_in_zeile(zeile: &[u8], zehn_bit: bool, x0: usize) -> Option<u16> {
    zaehler_aus_kloetzen(|i| luma_in_zeile(zeile, zehn_bit, klotzmitte(x0, i)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Baut ein Bild, das an (x0, y0) genau den Balken des Musters traegt.
    fn frame_with_bar(x0: usize, y0: usize, counter: u16, ten_bit: bool) -> DecodedFrame {
        frame_with_bar_layout(x0, y0, counter, ten_bit, PixelLayout::BiPlanar420)
    }

    /// Wie [`frame_with_bar`], aber mit waehlbarer Ebenen-Form — die
    /// entscheidet bei 10 bit, WO im Wort der Wert steht (s. [`luma_at`]).
    fn frame_with_bar_layout(
        x0: usize,
        y0: usize,
        counter: u16,
        ten_bit: bool,
        format: PixelLayout,
    ) -> DecodedFrame {
        let (w, h) = (2560usize, 1440usize);
        let bpp = if ten_bit { 2 } else { 1 };
        let stride = w * bpp;
        let mut plane = vec![0u8; stride * h];
        for (i, bit) in musterbits(counter).iter().enumerate() {
            if *bit == 0 {
                continue;
            }
            for y in y0..y0 + BLOCK {
                for x in x0 + i * BLOCK..x0 + (i + 1) * BLOCK {
                    let off = y * stride + x * bpp;
                    if ten_bit {
                        // Weiss (1023) an der Stelle, an der die jeweilige Form
                        // es erwartet — genau der Unterschied, den `luma_at`
                        // beachten muss.
                        let wort: u16 = match format {
                            PixelLayout::BiPlanar420 => 1023 << 6, // P010: oben
                            PixelLayout::Planar420 => 1023,        // yuv420p10: unten
                        };
                        plane[off..off + 2].copy_from_slice(&wort.to_le_bytes());
                    } else {
                        plane[off] = 0xFF;
                    }
                }
            }
        }
        DecodedFrame::for_test(w as u32, h as u32, vec![plane], vec![stride], ten_bit, format)
    }

    #[test]
    fn liest_den_zaehler_an_jeder_vorgesehenen_stelle() {
        for y in POS_Y {
            for x in POS_X {
                let f = frame_with_bar(x, y, 40_000, false);
                assert_eq!(read_bar(&f, x, y), Some(40_000), "Stelle {x},{y}");
            }
        }
    }

    /// Beide 10-bit-Formen, weil beide vorkommen: `P010LE` liefert der
    /// Hardware-Decoder (cuvid, VAAPI), `YUV420P10LE` der Software-Decoder
    /// (libdav1d). Die zweite Form war bis 2026-08-01 unlesbar — die Sonde
    /// meldete dann kein Muster statt einer falschen Zahl, war aber blind.
    #[test]
    fn liest_auch_zehn_bit() {
        for form in [PixelLayout::BiPlanar420, PixelLayout::Planar420] {
            let f = frame_with_bar_layout(64, 64, 1234, true, form);
            assert_eq!(read_bar(&f, 64, 64), Some(1234), "Form {form:?}");
        }
    }

    #[test]
    fn schwarzes_bild_ist_kein_balken() {
        // Ein Bild ohne Muster darf NICHTS liefern — sonst meldete die Sonde
        // eine erfundene Latenz, was schlimmer waere als keine Zahl.
        let f = DecodedFrame::for_test(
            2560,
            1440,
            vec![vec![0u8; 2560 * 1440]],
            vec![2560],
            false,
            PixelLayout::Planar420,
        );
        assert_eq!(read_bar(&f, 64, 64), None);
    }

    #[test]
    fn grauer_punkt_gilt_nicht_als_bit() {
        let mut f = frame_with_bar(64, 64, 7, false);
        // Erstes Klotz-Zentrum auf Grau setzen: das Erkennungsmuster verlangt
        // dort eine 1, Grau ist keine.
        let stride = f.strides[0];
        f.planes[0][(64 + BLOCK / 2) * stride + 64 + BLOCK / 2] = 128;
        assert_eq!(read_bar(&f, 64, 64), None);
    }

    #[test]
    fn zaehler_ohne_muster_wird_nicht_geraten() {
        let f = frame_with_bar(64, 64, 999, false);
        // Daneben liegt kein Balken.
        assert_eq!(read_bar(&f, 880, 400), None);
    }

    #[test]
    fn unglaubwuerdige_latenz_verwirft_die_stelle() {
        let mut probe = LatencyProbe { hit: Some((64, 64)), ..Default::default() };
        // Zaehler 0 bei einer Epoche von 1970 ergibt eine absurde Differenz.
        probe.note(&frame_with_bar(64, 64, 0, false));
        assert_eq!(probe.count, 0, "darf nicht mitzaehlen");
        assert_eq!(probe.misses, 1);
        assert!(probe.hit.is_none(), "Stelle muss verworfen sein");
    }

    // ── Der Weg ueber die GPU-Textur ────────────────────────────────────────

    /// Eine einzelne kopierte Musterzeile bauen, so wie der Renderer sie aus
    /// der Luma-Textur holt: rohe Texel ab Spalte 0, ein bzw. zwei Byte breit.
    fn zeile_mit_balken(x0: usize, counter: u16, zehn_bit: bool) -> Vec<u8> {
        let bpp = if zehn_bit { 2 } else { 1 };
        let mut zeile = vec![0u8; MUSTER_BREITE * bpp];
        for (i, bit) in musterbits(counter).iter().enumerate() {
            if *bit == 0 {
                continue;
            }
            for x in x0 + i * BLOCK..x0 + (i + 1) * BLOCK {
                if zehn_bit {
                    // P010-Lage: die zehn Bit sitzen OBEN im Wort — genau der
                    // Unterschied, den `luma_in_zeile` beachten muss.
                    zeile[x * 2..x * 2 + 2].copy_from_slice(&(1023u16 << 6).to_le_bytes());
                } else {
                    zeile[x] = 0xFF;
                }
            }
        }
        zeile
    }

    /// **Die Kontrolle, dass die Messung ueberhaupt anschlagen kann.** Ohne sie
    /// waere „die Sonde meldet eine Zahl" nicht davon zu unterscheiden, dass sie
    /// irgendetwas meldet.
    #[test]
    fn kopierte_zeilen_liefern_den_gemalten_zaehler() {
        for zehn_bit in [false, true] {
            for x in POS_X {
                let z = zeile_mit_balken(x, 40_000, zehn_bit);
                assert_eq!(
                    zaehler_in_zeile(&z, zehn_bit, x),
                    Some(40_000),
                    "Stelle {x}, zehn_bit {zehn_bit}"
                );
            }
        }
    }

    /// Die Gegenprobe: ein verfaelschtes Byte muss abgelehnt werden. Ohne sie
    /// koennte die Auswertung alles Moegliche als Balken durchgehen lassen.
    #[test]
    fn eine_verfaelschte_zeile_wird_abgelehnt() {
        let x = POS_X[0];
        let sauber = zeile_mit_balken(x, 4711, false);
        assert_eq!(zaehler_in_zeile(&sauber, false, x), Some(4711));

        // Erster Klotz des Erkennungsmusters auf Grau: dort verlangt MARKER
        // eine 1, und Grau ist kein gueltiges Bit.
        let mut grau = sauber.clone();
        grau[klotzmitte(x, 0)] = 128;
        assert_eq!(zaehler_in_zeile(&grau, false, x), None, "Grau ist kein Bit");

        // Zweiter Klotz auf Weiss: MARKER verlangt dort eine 0.
        let mut falsch = sauber.clone();
        falsch[klotzmitte(x, 1)] = 0xFF;
        assert_eq!(zaehler_in_zeile(&falsch, false, x), None, "Muster passt nicht");

        // Und eine abgeschnittene Zeile darf nicht als gueltig durchgehen.
        let kurz = &sauber[..klotzmitte(x, BITS - 1)];
        assert_eq!(zaehler_in_zeile(kurz, false, x), None, "zu kurze Zeile");
    }

    /// Ein leerer Satz Zeilen (Bild zu klein, kein Ringplatz frei) muss als
    /// Fehlschlag GEZAEHLT werden — nicht stumm verschwinden.
    #[test]
    fn ohne_muster_zaehlt_die_sonde_einen_fehlschlag() {
        let mut probe = LatencyProbe { epoch_ms: 1_000, ..Default::default() };
        probe.note_gpu(&Musterzeilen { stempel_ms: 2_000, zehn_bit: false, zeilen: Vec::new() });
        probe.note_gpu(&Musterzeilen {
            stempel_ms: 2_000,
            zehn_bit: false,
            zeilen: vec![(64, vec![0u8; MUSTER_BREITE])],
        });
        assert_eq!(probe.count, 0, "nichts zu messen");
        assert_eq!(probe.misses, 2, "beide Faelle muessen sich melden");
    }

    /// **Der Zeitstempel des AUFZEICHNENS ist maßgeblich, nicht die Uhr beim
    /// Abholen.** Waere es andersherum, stiegen hier die Millisekunden seit der
    /// Unix-Epoche ein und die Latenz laege weit jenseits von
    /// [`MAX_PLAUSIBLE_MS`] — der Test bekaeme einen Fehlschlag statt der Zahl.
    #[test]
    fn die_latenz_kommt_aus_dem_mitgefuehrten_zeitstempel() {
        let mut probe = LatencyProbe { epoch_ms: 1_700_000_000_000, ..Default::default() };
        let x = POS_X[1];
        probe.note_gpu(&Musterzeilen {
            // 5000 ms nach der Epoche gestempelt, gemalt wurde bei 4880 ms.
            stempel_ms: 1_700_000_005_000,
            zehn_bit: false,
            zeilen: vec![(POS_Y[2], zeile_mit_balken(x, 4_880, false))],
        });
        probe.roll();
        assert_eq!(probe.misses(), 0, "der Balken muss gefunden werden");
        assert_eq!(probe.avg_us(), 120_000, "5000 - 4880 = 120 ms");
        assert_eq!(probe.hit, Some((x, POS_Y[2])), "die Stelle muss gemerkt werden");
    }

    /// Beide Wege muessen auf demselben Muster denselben Zaehler lesen — sonst
    /// waeren die Messungen der beiden Bildwege nicht vergleichbar, und genau
    /// dafuer gibt es die Sonde.
    #[test]
    fn hauptspeicher_und_gpu_zeile_lesen_dasselbe() {
        for zehn_bit in [false, true] {
            let f = frame_with_bar(64, 64, 12_345, zehn_bit);
            let z = zeile_mit_balken(64, 12_345, zehn_bit);
            assert_eq!(read_bar(&f, 64, 64), zaehler_in_zeile(&z, zehn_bit, 64));
            assert_eq!(read_bar(&f, 64, 64), Some(12_345));
        }
    }

    /// Die Formate der beiden Seiten muessen zusammenpassen; laeuft eine
    /// Konstante auseinander, liest die Sonde stumm nichts mehr.
    ///
    /// Zeigt auf `pattern_format.py`, seit die Konstanten dort gebuendelt sind
    /// (vorher standen sie in `latency-pattern.py` und drei weiteren Dateien
    /// wortgleich). Genau dieser Test hat den Umzug am 2026-07-28 bemerkt --
    /// er ist die einzige Klammer zwischen der Rust- und der Python-Seite des
    /// Musterformats, und ohne ihn waere die Sonde stumm ausgefallen, sobald
    /// eine Seite sich bewegt. Wandert die Datei erneut, ist DIESER Pfad
    /// nachzuziehen und nicht der Test abzuschalten.
    #[test]
    fn musterformat_stimmt_mit_dem_python_teil_ueberein() {
        let py = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../testbench/pattern_format.py"),
        )
        .expect("pattern_format.py");
        assert!(py.contains(&format!("BLOCK = {BLOCK}")), "BLOCK");
        assert!(py.contains(&format!("COUNTER_BITS = {COUNTER_BITS}")), "COUNTER_BITS");
        assert!(
            py.contains("MARKER = [1, 0, 1, 1, 0, 0, 1, 0]"),
            "MARKER"
        );
        assert!(py.contains("(64, 880, 1696)"), "Spalten");
        assert!(py.contains("(64, 400, 800, 1200)"), "Zeilen");
    }
}
