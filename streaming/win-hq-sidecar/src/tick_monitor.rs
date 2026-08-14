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

use crate::capture::RueckrufStand;
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
    ///
    /// **Auf den GPU-Wegen ist das die Zeit des ABSENDENS, nicht die Arbeit.**
    /// Der Treiber reiht Befehle ein und kehrt zurück; gerechnet wird danach.
    /// Gemessen am 2026-08-06: 25 µs hier, während derselbe HDR-Shader auf der
    /// Grafikeinheit 1,79 ms braucht — Faktor 70. Wer die *Last* einer
    /// GPU-Stufe sucht, braucht die Windows-Leistungsindikatoren
    /// (`streaming/testbench/profiles/leistung-2026-08-06-fp16-kopie-gemessen.json`);
    /// dieser Wert beantwortet nur, ob der **Taktfaden** dort hängenbleibt.
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
    ///
    /// **Kennt nur die eigene Seite** (Pool erschöpft, Kanal voll, Größe
    /// geändert). Was WGC selbst verwirft, steht in `rueckruf`.
    pub capture_drops: u64,
    /// Abzug der Rückruf-Wacht (`capture::rueckruf`): Verweildauer im
    /// Aufnahme-Rückruf und die **Obergrenze** der Bilder, die WGC deswegen
    /// verworfen haben kann. Alle Werte kumulativ seit Start.
    ///
    /// Warum das hier steht, seit die Farbwandlung im Rückruf laufen kann:
    /// ohne diese Zahl tauschte man messbare GPU-Last gegen unsichtbaren
    /// Bildverlust. Eine Null in `verlust_obergrenze` ist ein Beweis, keine
    /// Beobachtung — Herleitung im Modul.
    pub rueckruf: RueckrufStand,
    /// Encode-Latenz der in DIESEM Tick herausgefallenen Pakete: (Summe,
    /// Maximum, Anzahl) in Mikrosekunden, aus `take_encode_latency()`.
    ///
    /// Das ist NICHT `send`: `send` ist die Dauer des Submit-Aufrufs, hier
    /// steht die Zeit vom Einschieben eines Bildes bis zu seinem Paket — also
    /// der Vorlauf der Encoder-Warteschlange. Genau den veraendern
    /// `zerolatency`/`delay` (NVENC) und `async_depth` (D3D12VA/AMF/QSV), und
    /// genau den sah der Monitor bisher nicht. Anzahl 0 = in diesem Tick wurde
    /// kein Paket zugeordnet (voellig normal bei Encoder-Vorlauf).
    pub enc_latency: (u64, u64, u64),
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
    enc_sum_us: u64,
    enc_max_us: u64,
    enc_count: u64,
}

pub struct TickMonitor {
    start: Instant,
    budget: Duration,
    slow_threshold: Duration,
    trace: Option<BufWriter<File>>,
    tick_index: u64,
    win_start_drops: u64,
    cur_drops: u64,
    /// Stand der Rückruf-Wacht zu Beginn des Fensters und jetzt — die
    /// Zusammenfassung meldet die Differenz, wie bei `drops`.
    win_start_rueckruf: RueckrufStand,
    cur_rueckruf: RueckrufStand,
    win: Window,
    /// Ab welchem pts-Sprung eine LUECKE gemeldet wird. Kommt aus
    /// `zeitbasis::lueckenschwelle` — mit ehrlichen Zeitstempeln ist ein
    /// Sprung ueber einen Bildabstand der Normalfall und keine Luecke mehr
    /// (Begruendung dort).
    lueckenschwelle: i64,
    /// `PULSE_ENC_LATENCY_LOG=1`: die 2s-Zusammenfassung auch dann ausgeben,
    /// wenn das Fenster sauber war. Fuer Messlaeufe — die Encode-Latenz ist
    /// gerade dann interessant, wenn NICHTS auffaellig ist, und die
    /// Ruhe-Regel unten haette sie sonst verschluckt.
    enc_log: bool,
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
            win_start_rueckruf: Default::default(),
            cur_rueckruf: Default::default(),
            win: Window::default(),
            lueckenschwelle: crate::zeitbasis::lueckenschwelle(fps),
            enc_log: crate::env::flag("PULSE_ENC_LATENCY_LOG"),
        }
    }

    /// Verbucht einen Tick. Emittiert bei einer Anomalie sofort ein `log`-Event
    /// und schreibt — wenn aktiv — eine Trace-Zeile.
    pub fn record(&mut self, s: &TickSample) {
        let idx = self.tick_index;
        self.tick_index += 1;
        self.cur_drops = s.capture_drops;
        self.cur_rueckruf = s.rueckruf;

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
            if s.pts_delta > self.lueckenschwelle {
                w.pts_gaps += 1;
            }
            let (enc_sum, enc_max, enc_n) = s.enc_latency;
            w.enc_sum_us += enc_sum;
            w.enc_max_us = w.enc_max_us.max(enc_max);
            w.enc_count += enc_n;
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
                // Die Rückruf-Wacht, kumulativ. `cb_n`/`cb_sum_us` erlauben
                // den Mittelwert über ein beliebiges Fenster (Differenz durch
                // Differenz), `cb_max_us` ist der grösste je gesehene Rückruf,
                // `cb_verlust` die Obergrenze WGC-seitig verworfener Bilder.
                "cb_n": s.rueckruf.anzahl,
                "cb_sum_us": s.rueckruf.summe_us,
                "cb_max_us": s.rueckruf.max_us,
                "cb_lang": s.rueckruf.ueberlang,
                "cb_verlust": s.rueckruf.verlust_obergrenze,
                "enc_sum_us": s.enc_latency.0,
                "enc_max_us": s.enc_latency.1,
                "enc_n": s.enc_latency.2,
            });
            let _ = writeln!(trace, "{line}");
        }

        // Anomalie = langsame Iteration ODER übersprungener Frame (pts-gap).
        let anomaly =
            idx >= WARMUP_TICKS && (s.iter > self.slow_threshold || s.pts_delta > self.lueckenschwelle);
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
        let cb = self.cur_rueckruf.bericht_seit(&self.win_start_rueckruf);
        let cb_verlust = self
            .cur_rueckruf
            .verlust_obergrenze
            .saturating_sub(self.win_start_rueckruf.verlust_obergrenze);
        self.win_start_rueckruf = self.cur_rueckruf;
        if let Some(trace) = self.trace.as_mut() {
            let _ = trace.flush();
        }
        let w = std::mem::take(&mut self.win);
        let enc = enc_text(&w);
        // Sauberes Fenster → keine Zeile. Hält den Log ruhig, solange alles
        // flüssig läuft. Ausnahme: Messlauf (s. `enc_log`).
        //
        // **`cb_verlust` gehört in diese Bedingung**, nicht nur in die Zeile
        // darunter: ein Fenster, in dem WGC Bilder verloren haben kann, ist
        // nicht sauber — und ohne diesen Term stünde die einzige Zahl, die das
        // zeigt, ausgerechnet in den Fenstern nicht da, in denen sonst nichts
        // auffällt.
        if w.slow == 0 && w.pts_gaps == 0 && drops == 0 && cb_verlust == 0 {
            if self.enc_log {
                emit_log(format!("{} ticks, sauber | {enc} | {cb}", w.ticks));
            }
            return;
        }
        let avg = if w.ticks > 0 {
            w.sum_iter / w.ticks as u32
        } else {
            Duration::ZERO
        };
        emit_log(format!(
            "{} ticks: {} slow, {} pts-gaps, {} capture-drops, {} dup-frames | \
             iter avg={} max={} | {} | {} | max conv={} send={} mux={} audio={} wake={} cap={}",
            w.ticks,
            w.slow,
            w.pts_gaps,
            drops,
            w.dups,
            ms(avg),
            ms(w.max_iter),
            enc,
            cb,
            ms(w.max_convert),
            ms(w.max_send),
            ms(w.max_mux),
            ms(w.max_audio),
            ms(w.max_wake),
            ms(w.max_capture),
        ));
    }
}

/// Encode-Latenz des Fensters als Text. Mittel ueber die tatsaechlich
/// zugeordneten Pakete — nicht ueber die Ticks, weil je Tick auch null oder
/// zwei Pakete herausfallen koennen.
fn enc_text(w: &Window) -> String {
    if w.enc_count == 0 {
        return "enc n/a".into();
    }
    format!(
        "enc avg={:.1}ms max={:.1}ms ({})",
        w.enc_sum_us as f64 / w.enc_count as f64 / 1000.0,
        w.enc_max_us as f64 / 1000.0,
        w.enc_count,
    )
}

fn ms(d: Duration) -> String {
    format!("{:.1}ms", d.as_secs_f64() * 1000.0)
}

fn emit_log(line: String) {
    events::emit(json!({"ev": "log", "line": format!("[diag] {line}")}));
}
