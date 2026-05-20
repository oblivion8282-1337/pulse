//! Per-Tick-Instrumentierung des HQ-Pacing-Loops — Mikro-Stutter-Diagnose.
//!
//! Der Pacing-Loop in `pipeline_hw.rs` ist seriell: pro Tick wird gewartet,
//! der Capture-/Audio-Channel gedraint, encodet und (synchron) in den
//! RTMPS-Socket geschrieben. Ein kurzer Stall in *irgendeiner* Stufe lässt
//! den Loop einen Tick verpassen — da die PTS aus der Wanduhr kommt, wird der
//! betroffene Frame übersprungen statt nachgeholt → der Viewer sieht für ~2
//! Ticks dasselbe Bild = genau das sporadische „kurze Stottern".
//!
//! `TickMonitor` nimmt pro Tick ein `TickSample` und tut dreierlei:
//! - **Anomalie-Log**: dauert eine Iteration länger als `SLOW_FACTOR` ×
//!   Frame-Budget, ODER springt die PTS um >1 (= übersprungener Frame), wird
//!   ein `log`-Event mit Stage-Aufschlüsselung emittiert (sichtbar im
//!   StreamLog). Pro 2s-Fenster auf `MAX_SLOW_LOGS_PER_WINDOW` begrenzt, damit
//!   ein Dauer-Stall den Log nicht flutet.
//! - **2s-Zusammenfassung**: `flush_summary()` faltet Zähler + Maxima des
//!   Fensters in eine Log-Zeile — aber nur, wenn es etwas zu berichten gibt.
//! - **Trace**: `PULSE_HQ_TRACE=<pfad>` schreibt eine JSONL-Zeile pro Tick für
//!   die Offline-Analyse (Periodizität erkennen, mit Keyframes korrelieren).

use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::events;

/// Ein Tick gilt als „langsam", wenn die Iteration (ohne Pacing-Sleep) länger
/// als das Frame-Budget × diesen Faktor dauert.
const SLOW_FACTOR: f64 = 1.5;

/// Max. einzelne Anomalie-Log-Events pro 2s-Fenster. Darüber hinaus zählt der
/// Monitor nur noch — die Zusammenfassung zeigt die Gesamtzahl.
const MAX_SLOW_LOGS_PER_WINDOW: u64 = 5;

/// Warmup: die ersten paar Ticks nach `live` sind durch Encoder-/NVENC-Priming
/// regelmäßig langsam — die zählen nicht als Anomalie.
const WARMUP_TICKS: u64 = 8;

/// Per-Tick-Messung, vom Pacing-Loop befüllt. Alle Dauern ohne den
/// Pacing-Sleep — sie messen *Arbeit*, nicht Warten.
#[derive(Debug, Clone, Copy)]
pub struct TickSample {
    /// Wie spät der Loop gegenüber dem geplanten Tick-Zeitpunkt aufgewacht
    /// ist (Sleep-Überschuss + Rückstand aus dem vorigen Tick).
    pub wake_jitter: Duration,
    /// Dauer des Capture-Channel-Drains.
    pub capture_drain: Duration,
    /// Anzahl in diesem Tick frisch abgeholter Capture-Frames. 0 = der letzte
    /// Frame wird dupliziert (statisches Bild — normal, kein Fehler).
    pub captured: u32,
    /// Dauer des Audio-Channel-Drains (inkl. Audio-Encode + Mux).
    pub audio_drain: Duration,
    /// Pixel-Convert vor dem Encoder: CPU-swscale BGRA→NV12 + Frame-Copy
    /// (CPU-Pfad), GPU-Scaler (`VideoProcessorBlt`, NVIDIA-Downscale) oder 0
    /// (NVIDIA-native — NVENC macht den Convert selbst). Auf dem CPU-Pfad bei
    /// hoher Auflösung der wahrscheinlichste Stutter-Kandidat.
    pub convert: Duration,
    /// NVENC-/AMF-Submit des Video-Frames (`(avcodec_)send_frame`).
    pub send: Duration,
    /// Einreihen der Video-Packets in die `MuxWriter`-Queue. Seit dem
    /// Async-Mux-Umbau läuft `write_interleaved` auf einem eigenen Thread —
    /// dieser Wert ist normal ~0; ein Spike = Queue voll = Writer hängt am
    /// Socket.
    pub mux: Duration,
    /// Gesamte Iterationszeit ohne den Pacing-Sleep.
    pub iter: Duration,
    /// PTS dieses Ticks.
    pub pts: i64,
    /// PTS-Differenz zum vorigen Tick. Normalfall = 1; >1 = ein Frame wurde
    /// übersprungen = der sichtbare Ruckler.
    pub pts_delta: i64,
    /// Kumulativ verworfene Capture-Frames (Snapshot von `WgcHwCapture`).
    pub capture_drops: u64,
}

/// Fenster-Akkumulator — bei jedem `flush_summary` zurückgesetzt.
#[derive(Default)]
struct Window {
    ticks: u64,
    slow: u64,
    slow_logged: u64,
    pts_gaps: u64,
    dups: u64,
    max_iter: Duration,
    max_wake: Duration,
    max_capture: Duration,
    max_convert: Duration,
    max_send: Duration,
    max_mux: Duration,
    max_audio: Duration,
    sum_iter: Duration,
}

pub struct TickMonitor {
    start: Instant,
    budget: Duration,
    slow_threshold: Duration,
    trace: Option<BufWriter<File>>,
    tick_index: u64,
    win_start_drops: u64,
    cur_drops: u64,
    win: Window,
}

impl TickMonitor {
    /// `fps` = Ziel-Framerate des Streams; daraus leiten sich Frame-Budget und
    /// Slow-Tick-Schwelle ab. Liest `PULSE_HQ_TRACE` für den optionalen Trace.
    pub fn new(fps: u32) -> Self {
        let budget = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
        let trace = std::env::var("PULSE_HQ_TRACE")
            .ok()
            .filter(|p| !p.is_empty())
            .and_then(|path| match File::create(&path) {
                Ok(f) => {
                    eprintln!("[tick-monitor] Trace aktiv → {path}");
                    Some(BufWriter::new(f))
                }
                Err(e) => {
                    eprintln!("[tick-monitor] PULSE_HQ_TRACE={path} nicht öffenbar: {e}");
                    None
                }
            });
        Self {
            start: Instant::now(),
            budget,
            slow_threshold: budget.mul_f64(SLOW_FACTOR),
            trace,
            tick_index: 0,
            win_start_drops: 0,
            cur_drops: 0,
            win: Window::default(),
        }
    }

    /// Verbucht einen Tick. Emittiert bei einer Anomalie sofort ein `log`-Event
    /// und schreibt — wenn aktiv — eine Trace-Zeile.
    pub fn record(&mut self, s: &TickSample) {
        let idx = self.tick_index;
        self.tick_index += 1;
        self.cur_drops = s.capture_drops;

        {
            let w = &mut self.win;
            w.ticks += 1;
            w.max_iter = w.max_iter.max(s.iter);
            w.max_wake = w.max_wake.max(s.wake_jitter);
            w.max_capture = w.max_capture.max(s.capture_drain);
            w.max_convert = w.max_convert.max(s.convert);
            w.max_send = w.max_send.max(s.send);
            w.max_mux = w.max_mux.max(s.mux);
            w.max_audio = w.max_audio.max(s.audio_drain);
            w.sum_iter += s.iter;
            if s.captured == 0 {
                w.dups += 1;
            }
            if s.pts_delta > 1 {
                w.pts_gaps += 1;
            }
        }

        if let Some(trace) = self.trace.as_mut() {
            let line = json!({
                "idx": idx,
                "t_ms": self.start.elapsed().as_secs_f64() * 1000.0,
                "wake_us": s.wake_jitter.as_micros(),
                "cap_us": s.capture_drain.as_micros(),
                "captured": s.captured,
                "audio_us": s.audio_drain.as_micros(),
                "conv_us": s.convert.as_micros(),
                "send_us": s.send.as_micros(),
                "mux_us": s.mux.as_micros(),
                "iter_us": s.iter.as_micros(),
                "pts": s.pts,
                "pts_delta": s.pts_delta,
                "drops": s.capture_drops,
            });
            let _ = writeln!(trace, "{line}");
        }

        // Anomalie = langsame Iteration ODER übersprungener Frame (pts-gap).
        let anomaly = idx >= WARMUP_TICKS && (s.iter > self.slow_threshold || s.pts_delta > 1);
        if anomaly {
            self.win.slow += 1;
            if self.win.slow_logged < MAX_SLOW_LOGS_PER_WINDOW {
                self.win.slow_logged += 1;
                emit_log(format!(
                    "slow tick #{idx}: iter={} (budget {}) | wake={} cap={} conv={} send={} mux={} audio={} | pts+{}{}",
                    ms(s.iter),
                    ms(self.budget),
                    ms(s.wake_jitter),
                    ms(s.capture_drain),
                    ms(s.convert),
                    ms(s.send),
                    ms(s.mux),
                    ms(s.audio_drain),
                    s.pts_delta,
                    if s.captured == 0 { " dup" } else { "" },
                ));
            }
        }
    }

    /// Faltet das aktuelle Fenster in eine Log-Zeile (nur wenn auffällig) und
    /// startet ein neues. Im 2s-Takt parallel zum `fps`-Event aufgerufen.
    pub fn flush_summary(&mut self) {
        let drops = self.cur_drops.saturating_sub(self.win_start_drops);
        self.win_start_drops = self.cur_drops;
        if let Some(trace) = self.trace.as_mut() {
            let _ = trace.flush();
        }
        let w = std::mem::take(&mut self.win);
        // Sauberes Fenster → keine Zeile. Hält den Log ruhig, solange alles
        // flüssig läuft.
        if w.slow == 0 && w.pts_gaps == 0 && drops == 0 {
            return;
        }
        let avg = if w.ticks > 0 {
            w.sum_iter / w.ticks as u32
        } else {
            Duration::ZERO
        };
        emit_log(format!(
            "{} ticks: {} slow, {} pts-gaps, {} capture-drops, {} dup-frames | \
             iter avg={} max={} | max conv={} send={} mux={} audio={} wake={} cap={}",
            w.ticks,
            w.slow,
            w.pts_gaps,
            drops,
            w.dups,
            ms(avg),
            ms(w.max_iter),
            ms(w.max_convert),
            ms(w.max_send),
            ms(w.max_mux),
            ms(w.max_audio),
            ms(w.max_wake),
            ms(w.max_capture),
        ));
    }
}

fn ms(d: Duration) -> String {
    format!("{:.1}ms", d.as_secs_f64() * 1000.0)
}

fn emit_log(line: String) {
    events::emit(json!({"ev": "log", "line": format!("[diag] {line}")}));
}
