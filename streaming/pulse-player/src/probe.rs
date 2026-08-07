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

use std::time::{SystemTime, UNIX_EPOCH};

use crate::decode::{DecodedFrame, PixelLayout};

// ── Musterformat — MUSS mit `latency-pattern.py` übereinstimmen ──────────────
const BLOCK: usize = 32;
const MARKER: [u8; 8] = [1, 0, 1, 1, 0, 0, 1, 0];
const COUNTER_BITS: usize = 16;
const POS_X: [usize; 3] = [64, 880, 1696];
const POS_Y: [usize; 4] = [64, 400, 800, 1200];

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
        if std::env::var("PULSE_PLAYER_LATENCY_PROBE").as_deref() != Ok("1") {
            return None;
        }
        let epoch_ms = std::env::var("PULSE_PLAYER_LATENCY_EPOCH_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())?;
        eprintln!("pulse-player: Latenz-Sonde aktiv (Epoche {epoch_ms})");
        Some(Self { epoch_ms, ..Default::default() })
    }

    /// Ein Bild auswerten. Wird unmittelbar vor dem Hochladen gerufen, weil die
    /// Ebenen danach dem Renderer gehören.
    pub fn note(&mut self, frame: &DecodedFrame) {
        // **Auf dem Zero-Copy-Weg gibt es nichts zu lesen** — das Bild bleibt
        // im Grafikspeicher, `planes` ist leer (s. `crate::zerocopy`). Die
        // Sonde darf das: sie ist ein Messwerkzeug, kein Betriebsteil.
        //
        // Aber sie muss es SAGEN. Ohne diese Zeile zählte sie stumm jedes Bild
        // als "ohne Muster" und meldete am Ende einen Mittelwert über null
        // Bilder — eine Sonde, die wortlos nichts misst, ist schlimmer als
        // keine. Genau dieser Fehler ist am 2026-08-01 schon einmal aufgetreten
        // (32535 Bilder ohne Muster, weil das falsche Byte gelesen wurde), nur
        // fiel er dort erst nach einer ganzen Messreihe auf.
        if frame.gpu.is_some() {
            static EINMAL: std::sync::Once = std::sync::Once::new();
            EINMAL.call_once(|| {
                eprintln!(
                    "pulse-player: Latenz-Sonde AUS — das Bild bleibt im Grafikspeicher \
                     (Zero-Copy), das gemalte Muster ist hier nicht lesbar. \
                     Für eine Messung: PULSE_PLAYER_ZEROCOPY=0"
                );
            });
            return;
        }
        let Some(counter) = self.read_counter(frame) else {
            self.misses += 1;
            return;
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        // Beide Seiten rechnen in Millisekunden seit derselben Epoche; der
        // Zähler ist auf 16 bit beschnitten, die Differenz also modulo 65536.
        let elapsed = now_ms.saturating_sub(self.epoch_ms) & 0xFFFF;
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

/// Einen Balken an (x0, y0) lesen: erst das Erkennungsmuster prüfen, dann die
/// sechzehn Zählerbits. `None`, sobald etwas nicht passt.
fn read_bar(frame: &DecodedFrame, x0: usize, y0: usize) -> Option<u16> {
    let cy = y0 + BLOCK / 2;
    if cy >= frame.height as usize {
        return None;
    }
    let bits = MARKER.len() + COUNTER_BITS;
    if x0 + bits * BLOCK > frame.width as usize {
        return None;
    }
    // Mitte des Klotzes ablesen: die Ränder verwischt der Encoder, die Mitte
    // bleibt auch bei 4000 kbps eindeutig schwarz oder weiß.
    let bit_at = |i: usize| -> Option<u8> {
        let v = luma_at(frame, x0 + i * BLOCK + BLOCK / 2, cy)?;
        // Grenzwerte statt einer Mitte bei 128: dazwischen liegt kein gültiger
        // Wert, und ein grauer Punkt bedeutet "das ist nicht unser Balken".
        match v {
            0..=70 => Some(0),
            180..=255 => Some(1),
            _ => None,
        }
    };
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
        let bits: Vec<u8> = MARKER
            .iter()
            .copied()
            .chain((0..COUNTER_BITS).map(|i| ((counter >> (COUNTER_BITS - 1 - i)) & 1) as u8))
            .collect();
        for (i, bit) in bits.iter().enumerate() {
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
