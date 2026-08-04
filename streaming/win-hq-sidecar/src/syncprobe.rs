//! Diagnose-Sonde am ROHEN Ton-Eingang — nur mit `PULSE_HQ_SYNC_PROBE=1`.
//!
//! **Wofür.** Am Empfänger lässt sich der A/V-Versatz messen, aber nicht
//! zuordnen. Ein Versatz kann drei Ursachen haben, und sie sehen dort alle
//! gleich aus:
//!
//! 1. der Abspielweg auf dem Messrechner lieferte Bild und Ton schon versetzt
//!    (ein Player stellt das Bild gegen die Audio-Uhr, dazu der Endpunkt-Puffer),
//! 2. unsere Ton-Zeitrechnung verschiebt die Spur (die Stille-Auffüllung in
//!    `audio/wasapi.rs` fügt Samples ein oder verwirft welche),
//! 3. der Anker sitzt falsch (`encode/audio.rs::anchor_samples`).
//!
//! Fall 1 ist ein Artefakt des Messaufbaus und im echten Betrieb gar nicht da —
//! dort sind die Aufnahmezeitstempel die Wahrheit. Fall 2 und 3 sind Fehler.
//! Wer nur am Empfänger misst, kann sie nicht auseinanderhalten und schreibt am
//! Ende „Versatz X ms" hin, ohne sagen zu können, wessen X das ist.
//!
//! **Wie.** Das Referenzmaterial (`analyze.sh`) trägt alle 2 s einen 1-kHz-Piep,
//! sample-genau gleichzeitig mit einer Bildmarke. Die Sonde findet diese Pieps
//! im rohen Gerätestrom und meldet ihre **Sample-Position seit dem ersten
//! gelesenen Sample**. Dieselben Pieps am Empfänger tragen einen PTS. Die
//! Differenz beider Positionen ist genau das, was Stufe 2+3 hinzugefügt haben —
//! unabhängig davon, wie schief der Abspielweg war.
//!
//! **Zweiter Zweck: Herkunft von Tonaussetzern.** WASAPI liefert je Lesevorgang
//! den Geräte-Frame-Index mit. Klafft er gegenüber unserer eigenen Zählung, hat
//! das GERÄT nichts geliefert — der Aussetzer war schon da, bevor wir ihn
//! anfassen konnten. Ohne diese Unterscheidung sucht man den Fehler in der
//! eigenen Kette, während er im Eingang liegt.
//!
//! Die Sonde ist reine Diagnose: ohne den Schalter wird sie nie gebaut, und sie
//! greift nirgends in den Datenfluss ein.

use wasapi::BufferInfo;

/// Blocklänge der Auswertung. 2 ms ist fein genug, um die Piep-Flanke auf der
/// Größenordnung zu treffen, in der A/V-Versatz überhaupt beurteilt wird
/// (ab ~20 ms wird er wahrnehmbar), und grob genug, dass die Goertzel-Auswertung
/// nicht ins Gewicht fällt.
const BLOCK_MS: usize = 2;
/// Wie lange Pegel gesammelt werden, bevor Schwellen daraus abgeleitet werden.
/// Muss mindestens einen Piep-Abstand (2 s) abdecken, sonst ist der Spitzenwert
/// nicht der eines Pieps.
const WARMUP_S: f64 = 3.0;
/// Anteil des Piep-Spitzenwerts, ab dem ein Block als Piep gilt.
const BEEP_FRAC: f64 = 0.35;
/// Anteil des Trägerton-Pegels, unter dem ein Block als Loch gilt.
const GAP_FRAC: f64 = 0.25;

pub fn enabled() -> bool {
    crate::env::flag("PULSE_HQ_SYNC_PROBE")
}

/// Meldet den QPC-Ursprung der Videospur. Ohne ihn lassen sich die
/// Sample-Positionen der Sonde nicht auf dieselbe Zeitachse legen wie die
/// Video-PTS am Empfänger.
pub fn video_origin(qpc: i64) {
    if enabled() {
        eprintln!("[sp] video_origin_qpc={qpc} qpc_now={}", qpc_now());
    }
}

/// Der Leistungszähler in 100ns-Einheiten — dieselbe Einheit, in der WGC seine
/// `SystemRelativeTime` und WASAPI seine `QPCPosition` angeben.
///
/// Gebraucht wird er für genau eine Frage: liegen die beiden Zeitstempel
/// wirklich auf derselben Uhr? Beide sind als QPC-Werte dokumentiert; ein
/// Unterschied zwischen ihnen kann daher entweder ein echter zeitlicher Abstand
/// der Ereignisse sein oder ein Versatz der Stempel selbst. Wer das nicht
/// trennt, schreibt am Ende einem der beiden Wege einen Fehler zu, den er nicht
/// hat — und ändert Code, der richtig war.
pub fn qpc_now() -> i64 {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let (mut c, mut f) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
        let _ = QueryPerformanceFrequency(&mut f);
    }
    if f == 0 { 0 } else { (c as i128 * 10_000_000 / f as i128) as i64 }
}

/// Meldet, wie weit ein WGC-Bildzeitstempel beim Eintreffen in der Vergangenheit
/// liegt. Gegenstück zur selben Messung am Ton (`ts_check`).
pub fn video_frame_age(frame_qpc: i64) {
    if !enabled() {
        return;
    }
    static NEXT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    let now = qpc_now();
    if now < NEXT.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    NEXT.store(now + 50_000_000, std::sync::atomic::Ordering::Relaxed);
    eprintln!(
        "[sp] video_frame_age qpc={frame_qpc} now={now} age_ms={:.1}",
        (now - frame_qpc) as f64 / 10_000.0
    );
}

pub struct SyncProbe {
    rate: u32,
    channels: usize,
    block: usize,
    /// Mono-Rest, der beim letzten Aufruf keinen vollen Block mehr ergab.
    carry: Vec<f32>,
    /// Gelesene Frames seit Beginn — die Zählung, gegen die alles andere läuft.
    raw_frames: u64,
    /// Geräte-Frame-Index des ersten Lesevorgangs; `None` bis dahin.
    first_index: Option<u64>,
    first_qpc: u64,
    /// Blockzähler — nur für die Aufwärmphase.
    blocks: u64,
    /// Position des NÄCHSTEN auszuwertenden Blocks in der **Geräte**-Zählung.
    ///
    /// Die Blöcke allein durchzuzählen wäre falsch: liefert das Gerät eine Lücke
    /// (`device_gap`), springt die Geräteposition weiter, die Zahl der bei uns
    /// angekommenen Samples aber nicht. Wer beides gegeneinander stellt, schiebt
    /// jeden Zeitstempel um die Lücke — ein Fehler, der sich als sauberer,
    /// konstanter A/V-Versatz tarnt und deshalb besonders überzeugend aussieht.
    pos: i64,
    /// Geräte-Zeitstempel des laufenden Lesevorgangs und die Frame-Position, an
    /// der er begann. Damit bekommt jede gefundene Flanke einen **eigenen**
    /// QPC-Stempel statt einer aus dem Startwert hochgezählten Position — eine
    /// Zählung, die jede Lücke im Gerätestrom mitschleppt und dadurch genau da
    /// falsch wird, wo es interessant wird.
    read_ts: u64,
    read_start_frame: u64,
    /// Zum Prüfen, ob die Geräte-Zeitstempel überhaupt gleichmäßig laufen.
    ts_report: u64,
    silence_before: u64,
    first_real_logged: bool,
    /// Zuletzt gesehener Stand der AUSGEGEBENEN Frames. Das ist die Grösse, aus
    /// der der Ton-PTS entsteht — sie gegen die Geräteuhr zu stellen zeigt, wann
    /// ein Versatz entsteht, statt ihn am Ende nur festzustellen.
    last_emitted: u64,
    dropped_frames: u64,
    drops: u64,

    warm: bool,
    peak_1k: f64,
    bed_sum: f64,
    bed_n: u64,
    thr_beep: f64,
    thr_gap: f64,

    in_beep: bool,
    in_gap: bool,
    gap_start_frame: i64,
    beeps: u64,
    gaps: u64,
    gap_frames: u64,
    device_lost_frames: u64,
    discontinuities: u64,
}

impl SyncProbe {
    pub fn new(rate: u32, channels: u16) -> Self {
        let block = rate as usize * BLOCK_MS / 1000;
        Self {
            rate,
            channels: channels.max(1) as usize,
            block,
            carry: Vec::with_capacity(block * 2),
            raw_frames: 0,
            first_index: None,
            first_qpc: 0,
            blocks: 0,
            pos: 0,
            read_ts: 0,
            read_start_frame: 0,
            ts_report: 0,
            silence_before: 0,
            first_real_logged: false,
            last_emitted: 0,
            dropped_frames: 0,
            drops: 0,
            warm: false,
            peak_1k: 0.0,
            bed_sum: 0.0,
            bed_n: 0,
            thr_beep: 0.0,
            thr_gap: 0.0,
            in_beep: false,
            in_gap: false,
            gap_start_frame: 0,
            beeps: 0,
            gaps: 0,
            gap_frames: 0,
            device_lost_frames: 0,
            discontinuities: 0,
        }
    }

    /// Ein Lesevorgang vom Gerät: `info` wie von WASAPI geliefert, `pcm` die
    /// dabei angehängten Rohbytes (32-bit Float, interleaved).
    pub fn on_read(&mut self, info: &BufferInfo, pcm: &[u8]) {
        if self.first_index.is_none() {
            self.first_index = Some(info.index);
            self.first_qpc = info.timestamp;
            eprintln!(
                "[sp] audio_first_qpc={} device_index={} rate={} ch={}",
                info.timestamp, info.index, self.rate, self.channels
            );
        }
        // Geräteseitige Lücke: der Geräte-Index ist weiter gesprungen als wir
        // Frames gezählt haben. Diese Samples hat NIEMAND bekommen — sie fehlen
        // vor unserer Kette, nicht in ihr.
        let erwartet = self.first_index.unwrap_or(0) + self.raw_frames;
        if info.index > erwartet {
            let fehlend = info.index - erwartet;
            self.device_lost_frames += fehlend;
            self.raw_frames += fehlend;
            eprintln!(
                "[sp] device_gap at_frame={} frames={} ms={:.1}",
                self.raw_frames,
                fehlend,
                fehlend as f64 * 1000.0 / self.rate as f64
            );
        }
        if info.flags.data_discontinuity {
            self.discontinuities += 1;
            eprintln!("[sp] discontinuity at_frame={}", self.raw_frames);
        }

        // Zeitbezug dieses Lesevorgangs merken, BEVOR die Frames gezählt werden.
        self.read_ts = info.timestamp;
        self.read_start_frame = self.raw_frames;
        // Läuft die Geräteuhr gleichmäßig? Weicht sie von der Samplezählung ab,
        // taugt der Stempel als Zeitbezug nicht — dann muss man es wissen.
        if self.first_qpc != 0 && self.raw_frames >= self.ts_report {
            self.ts_report = self.raw_frames + self.rate as u64 * 5;
            let erwartet_ns = self.raw_frames as i128 * 10_000_000 / self.rate as i128;
            let ist_ns = info.timestamp as i128 - self.first_qpc as i128;
            let ausgegeben_ms = self.last_emitted as f64 * 1000.0 / self.rate as f64;
            eprintln!(
                "[sp] audio_stamp_age_ms={:.1}",
                (qpc_now() - info.timestamp as i64) as f64 / 10_000.0
            );
            eprintln!(
                "[sp] ts_check frame={} device_ms={:.1} counted_ms={:.1} diff_ms={:.1} emitted_ms={:.1} emit_minus_device_ms={:.1}",
                self.raw_frames,
                ist_ns as f64 / 10_000.0,
                erwartet_ns as f64 / 10_000.0,
                (ist_ns - erwartet_ns) as f64 / 10_000.0,
                ausgegeben_ms,
                ausgegeben_ms - ist_ns as f64 / 10_000.0
            );
        }

        // Der noch nicht ausgewertete Rest gehört zum VORIGEN Lesevorgang, liegt
        // also vor dessen Ende — deshalb der Abzug.
        self.pos = self.read_start_frame as i64 - self.carry.len() as i64;
        self.push_mono(pcm);
        while self.carry.len() >= self.block {
            let blk: Vec<f32> = self.carry.drain(..self.block).collect();
            self.on_block(&blk);
            self.pos += self.block as i64;
        }
    }

    /// Kanäle zu Mono mitteln — der Prüfton liegt auf beiden gleich.
    fn push_mono(&mut self, pcm: &[u8]) {
        let step = 4 * self.channels;
        let frames = pcm.len() / step;
        for f in 0..frames {
            let base = f * step;
            let mut sum = 0.0f32;
            for c in 0..self.channels {
                let o = base + c * 4;
                sum += f32::from_le_bytes([pcm[o], pcm[o + 1], pcm[o + 2], pcm[o + 3]]);
            }
            self.carry.push(sum / self.channels as f32);
        }
        self.raw_frames += frames as u64;
    }

    fn on_block(&mut self, blk: &[f32]) {
        let amp_1k = goertzel(blk, 1000.0, self.rate as f64);
        let rms = (blk.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / blk.len() as f64)
            .sqrt();
        let frame_pos = self.pos;
        self.blocks += 1;

        if !self.warm {
            if amp_1k > self.peak_1k {
                self.peak_1k = amp_1k;
            }
            self.bed_sum += rms;
            self.bed_n += 1;
            if self.blocks as f64 * BLOCK_MS as f64 / 1000.0 >= WARMUP_S {
                let bed = self.bed_sum / self.bed_n.max(1) as f64;
                self.thr_beep = self.peak_1k * BEEP_FRAC;
                self.thr_gap = bed * GAP_FRAC;
                self.warm = true;
                eprintln!(
                    "[sp] armed peak_1k={:.5} bed_rms={:.5} thr_beep={:.5} thr_gap={:.5}",
                    self.peak_1k, bed, self.thr_beep, self.thr_gap
                );
                if self.peak_1k < 1e-4 {
                    eprintln!(
                        "[sp] WARNUNG kein Prueftonpegel — laeuft das Referenzmaterial mit Ton?"
                    );
                }
            }
            return;
        }

        let ist_piep = amp_1k > self.thr_beep;
        if ist_piep && !self.in_beep {
            self.beeps += 1;
            // Eigener QPC-Stempel aus dem Zeitbezug des Lesevorgangs. Beide
            // Positionen zählen in der Gerätezählung, sonst geht die Lücke ein.
            let versatz = frame_pos as i128 - self.read_start_frame as i128;
            let qpc = self.read_ts as i128 + versatz * 10_000_000 / self.rate as i128;
            eprintln!(
                "[sp] beep n={} raw_frame={} qpc={} t_ms={:.1}",
                self.beeps,
                frame_pos,
                qpc,
                frame_pos as f64 * 1000.0 / self.rate as f64
            );
        }
        self.in_beep = ist_piep;

        let ist_loch = rms < self.thr_gap;
        if ist_loch && !self.in_gap {
            self.gap_start_frame = frame_pos;
        } else if !ist_loch && self.in_gap {
            let len = (frame_pos - self.gap_start_frame).max(0) as u64;
            self.gaps += 1;
            self.gap_frames += len;
            eprintln!(
                "[sp] input_gap at_ms={:.1} len_ms={:.1}",
                self.gap_start_frame as f64 * 1000.0 / self.rate as f64,
                len as f64 * 1000.0 / self.rate as f64
            );
        }
        self.in_gap = ist_loch;
    }

    /// Was der Aufnahme-Loop ausgibt, bevor echter Ton fliesst.
    ///
    /// Die Ton-Zeitlinie entsteht durch **Zählen ausgegebener Blöcke**, nicht
    /// durch Zeitstempel: jeder Block schiebt den PTS um seine Länge weiter.
    /// Wird vor dem ersten echten Block Stille ausgegeben, landet der echte Ton
    /// genau um diese Stille zu spät — und zwar dauerhaft, weil der Anker nur
    /// einmal gesetzt wird. Diese Zeile macht den Betrag sichtbar, statt ihn
    /// aus dem Endergebnis zurückrechnen zu müssen.
    pub fn on_emit(&mut self, stille: bool, emitted_frames: u64) {
        self.last_emitted = emitted_frames;
        if stille {
            self.silence_before += 1;
            return;
        }
        if self.first_real_logged {
            return;
        }
        self.first_real_logged = true;
        eprintln!(
            "[sp] first_real_emit silence_chunks_before={} emitted_frames_before={} emitted_ms_before={:.1}",
            self.silence_before,
            emitted_frames,
            emitted_frames as f64 * 1000.0 / self.rate as f64
        );
    }

    /// Ein von der Drift-Korrektur verworfener ECHTER Tonblock.
    ///
    /// Verwerfen entfernt Inhalt, ohne die Zeitlinie weiterzudrehen — alles
    /// danach rutscht um denselben Betrag nach vorn. Genau deshalb wird hier
    /// mitgezählt: die Summe muss dem gemessenen A/V-Versatz entsprechen, sonst
    /// ist die Erklärung falsch.
    pub fn on_drop(&mut self, frames: u64) {
        self.dropped_frames += frames;
        if self.drops < 3 {
            eprintln!(
                "[sp] drift_drop at_frame={} frames={} summe_ms={:.1}",
                self.raw_frames,
                frames,
                self.dropped_frames as f64 * 1000.0 / self.rate as f64
            );
        }
        self.drops += 1;
    }

    /// Abschlusszeilen — die Bilanz, die in den Bericht geht.
    pub fn summary(&self) {
        eprintln!(
            "[sp] summary raw_frames={} raw_s={:.2} beeps={} input_gaps={} input_gap_ms={:.1} device_lost_frames={} device_lost_ms={:.1} discontinuities={} drift_drops={} drift_dropped_ms={:.1}",
            self.raw_frames,
            self.raw_frames as f64 / self.rate as f64,
            self.beeps,
            self.gaps,
            self.gap_frames as f64 * 1000.0 / self.rate as f64,
            self.device_lost_frames,
            self.device_lost_frames as f64 * 1000.0 / self.rate as f64,
            self.discontinuities,
            self.drops,
            self.dropped_frames as f64 * 1000.0 / self.rate as f64
        );
    }
}

/// Amplitude einer Frequenz im Block (Goertzel). Billiger als eine FFT und
/// genau das, was hier gebraucht wird: EIN Ton, bekannte Frequenz.
pub(crate) fn goertzel(blk: &[f32], freq: f64, rate: f64) -> f64 {
    let n = blk.len() as f64;
    let coeff = 2.0 * (2.0 * std::f64::consts::PI * freq / rate).cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for x in blk {
        let s = *x as f64 + coeff * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    let power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    if power <= 0.0 { 0.0 } else { power.sqrt() * 2.0 / n }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Die Sonde steht und faellt damit, dass Goertzel den Prueftonpegel
    /// wiedergibt — ein falscher Faktor hier verschoebe jede Schwelle.
    #[test]
    fn goertzel_findet_die_amplitude() {
        let rate = 48_000.0;
        let n = 96;
        let blk: Vec<f32> = (0..n)
            .map(|i| (0.4 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / rate).sin()) as f32)
            .collect();
        let amp = goertzel(&blk, 1000.0, rate);
        assert!((amp - 0.4).abs() < 0.02, "amp={amp}");
    }

    /// Und dass eine andere Frequenz NICHT anschlaegt — sonst meldete der
    /// Traegerton dauerhaft „Piep".
    #[test]
    fn goertzel_ignoriert_den_traegerton() {
        let rate = 48_000.0;
        let n = 96;
        let blk: Vec<f32> = (0..n)
            .map(|i| (0.4 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / rate).sin()) as f32)
            .collect();
        assert!(goertzel(&blk, 1000.0, rate) < 0.1);
    }
}
