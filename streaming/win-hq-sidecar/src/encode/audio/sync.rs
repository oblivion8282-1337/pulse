//! A/V-Sync-Verankerung + Diagnose für [`AudioPipeline`](super::AudioPipeline)
//! — Geräte-Zeitstempel-Anker, Rückstands-Report, Prüfton-Sonde. Zweiter
//! `impl AudioPipeline`-Block, herausgezogen aus `audio/mod.rs` (s. dortige
//! Modul-Doku für die Begründung).
//!
//! Kind-Modul von `audio`, nicht Geschwister: die Methoden hier lesen/
//! schreiben private Felder von `AudioPipeline` (`pts_samples`,
//! `stream_origin_qpc`, `qpc_anchored`, …) — die sind nur für `audio` und
//! dessen Kind-Module sichtbar, nicht für Geschwister-Module.

use std::time::Instant;

use crate::audio::CapturedAudio;

use super::AudioPipeline;

impl AudioPipeline {
    /// Meldet, welchen PTS ein Prüfton-Piep beim EINTRITT in den Encoder bekommt
    /// (`PULSE_HQ_SYNC_PROBE=1`).
    ///
    /// Die Sonde am Geräte-Eingang (`syncprobe.rs`) sagt, wann der Piep
    /// aufgenommen wurde; der Empfänger sagt, wo er im Strom landet. Weichen
    /// beide ab, liegt der Verlust irgendwo dazwischen — und „dazwischen" ist
    /// genau diese Stufe. Ohne diesen Messpunkt bleibt nur Raten, auf welcher
    /// Seite der FIFO-Grenze der Versatz entsteht.
    pub(super) fn probe_beep_pts(&mut self, captured: &CapturedAudio) {
        if !crate::syncprobe::enabled() {
            return;
        }
        let step = 4 * self.channels as usize;
        if step == 0 || captured.bytes.len() < step {
            return;
        }
        let mono: Vec<f32> = captured
            .bytes
            .chunks_exact(step)
            .map(|f| f32::from_le_bytes([f[0], f[1], f[2], f[3]]))
            .collect();
        let amp = crate::syncprobe::goertzel(&mono, 1000.0, self.sample_rate as f64);
        let ist_piep = amp > 0.1;
        if ist_piep && !self.probe_in_beep {
            eprintln!(
                "[sp] enc_beep pts_samples={} pts_ms={:.1}",
                self.pts_samples,
                self.pts_samples as f64 * 1000.0 / self.sample_rate as f64
            );
        }
        self.probe_in_beep = ist_piep;
    }

    /// Zieht den PTS-Ursprung einmalig auf den **Geräte**-Zeitstempel nach.
    ///
    /// **Warum das nötig ist.** Der Anker wird beim ersten Chunk gesetzt. Der
    /// erste Chunk ist aber nicht zwingend echter Ton: liefert die Audio-Engine
    /// beim Start noch nichts (stiller Desktop, oder das Gerät braucht seinen
    /// Moment), schiebt `audio/wasapi.rs` eine Stille-Füllung ein. Die trägt
    /// keinen Geräte-Zeitstempel (`qpc == 0`) → `anchor_samples` fällt auf die
    /// Wanduhr zurück → verankert wird an `captured_at - stream_origin`.
    ///
    /// Der Aufnahme-Thread startet jedoch **vor** dem Video-Ursprung
    /// (`AudioCapture::start` steht in allen drei Pipelines lange vor dem ersten
    /// Bild), also ist dieser Anker um die Rüstzeit zu klein — und der ganze Ton
    /// läuft dem Bild dauerhaft um diesen Betrag voraus. Am 2026-07-30 gegen die
    /// Aufnahme-Zeitstempel gemessen: **175 ms Vorlauf**, über 19 Prüfmarken auf
    /// ±0,2 ms konstant (Verfahren: `syncprobe.rs`).
    ///
    /// **Warum nur vorwärts.** Ein PTS-Rückschritt ist im Muxer nicht erlaubt.
    /// Der Fehlerfall ist ohnehin einseitig — die Stille verankert immer zu
    /// früh, nie zu spät —, und ein Sprung nach vorn reißt lediglich eine Lücke
    /// in eine Stille, die es real nie gab.
    ///
    /// **Warum die Stille nicht einfach verworfen wird.** Sie hält die
    /// Opus-Spur am Leben; ohne sie hängt der 2-Spur-Muxer bei stillem Desktop
    /// und der Push läuft in den `rw_timeout` (Begründung in `wasapi.rs`).
    pub(super) fn reanchor_on_first_device_stamp(&mut self, captured: &CapturedAudio) {
        if self.qpc_anchored || captured.qpc == 0 {
            return;
        }
        let Some(origin_qpc) = self.stream_origin_qpc else {
            return;
        };
        self.qpc_anchored = true;
        let soll = self.qpc_to_samples(captured.qpc as i64, origin_qpc) + self.trim_samples;
        if soll <= self.pts_samples {
            return;
        }
        let sprung_ms = (soll - self.pts_samples) as f64 * 1000.0 / self.sample_rate as f64;
        self.pts_samples = soll;
        self.out_pts_samples = soll;
        eprintln!(
            "[audio] Ton-Anker auf den Geraete-Zeitstempel nachgezogen: +{sprung_ms:.1} ms \
             (davor stand er auf einer Stille-Fuellung)"
        );
    }

    /// Wanduhr-Position dieses Batches in Samples seit dem Video-PTS-Ursprung.
    ///
    /// HW-Timestamp-Anker bevorzugt: echte Aufnahmezeit beider Spuren auf
    /// derselben QPC-Uhr -> exakter A/V-Offset, ohne Kalibrierung. Fallback
    /// (QPC-Sync aus ODER beim Start noch kein Read -> qpc==0): Instant-Anker.
    ///
    /// Der Instant-Fallback rechnet MIT Vorzeichen — `saturating_duration_since`
    /// waere genau das `.max(0)`, das beim Verankern verboten ist: Audio-Chunks
    /// von VOR dem Origin (WASAPI startet vor dem ersten Video-Frame und
    /// puffert) wuerden auf „gleichzeitig" gestaucht und die ganze Spur um den
    /// Setup-Versatz nach vorn geschoben.
    pub(super) fn anchor_samples(&self, captured: &CapturedAudio) -> Option<i64> {
        match (self.stream_origin_qpc, captured.qpc) {
            (Some(origin_qpc), q) if q != 0 => Some(self.qpc_to_samples(q as i64, origin_qpc)),
            _ => self.stream_origin.map(|origin| {
                let secs = if captured.captured_at >= origin {
                    captured.captured_at.duration_since(origin).as_secs_f64()
                } else {
                    -origin.duration_since(captured.captured_at).as_secs_f64()
                };
                (secs * self.sample_rate as f64) as i64
            }),
        }
    }

    /// QPC-Differenz (100ns-Einheiten) in Samples bei `self.sample_rate`.
    /// Zusammengezogen aus zwei wortgleichen Vorkommen (Verankerung + Nachzug
    /// auf den Geräte-Zeitstempel) — zwei Kopien derselben Umrechnung liefen
    /// sonst auseinander, sobald eine von beiden angepasst wird, ohne dass es
    /// auffiele.
    fn qpc_to_samples(&self, qpc: i64, origin_qpc: i64) -> i64 {
        ((qpc - origin_qpc) as f64 / 10_000_000.0 * self.sample_rate as f64) as i64
    }

    /// Meldet je Sekunde, wie weit die Ton-Zeitlinie hinter der Wanduhr
    /// herlaeuft (`PULSE_MUX_LATENCY_LOG=1`).
    ///
    /// **Warum diese Zahl zaehlt:** der FLV-Muxer haelt jedes BILD fest, bis Ton
    /// mit passendem Zeitstempel vorliegt — jede Millisekunde Rueckstand ist
    /// also Bild-Latenz (heute durch `max_interleave_delta` gedeckelt, s.
    /// `output.rs`), und der Ton laeuft dem Bild beim Zuschauer um denselben
    /// Betrag voraus.
    ///
    /// **Nur messen, nicht korrigieren — und das ist Absicht.** Der Linux-Zweig
    /// holt einen anhaltenden Rueckstand am Encoder ein
    /// (`PtsTimeline::align`), weil dort der PipeWire-Null-Sink einen festen
    /// Rueckstand von 27-29 ms einbrachte. Windows korrigiert an der QUELLE:
    /// `wasapi.rs` fuehrt ein Sample-Budget gegen die Wanduhr, schiebt fehlende
    /// Chunks als Stille ein und verwirft reale Chunks, die mehr als 100 ms
    /// vorauslaufen. Ob hier ueberhaupt ein Rueckstand entsteht, ist damit
    /// offen — und eine zweite Korrektur auf Verdacht einzubauen, waere genau
    /// die Aenderung, deren Wirkung man hinterher nicht mehr auseinanderhalten
    /// kann. Erst die Zahl, dann die Entscheidung.
    pub(super) fn report_lag(&mut self, anchored: Option<i64>) {
        let (Some(anchor), Some(seit)) = (anchored, self.lag_report) else {
            return;
        };
        if seit.elapsed() < std::time::Duration::from_secs(1) {
            return;
        }
        self.lag_report = Some(Instant::now());
        let rueckstand_ms = (anchor - self.pts_samples) as f64 * 1000.0 / self.sample_rate as f64;
        eprintln!(
            "[audio] Ton-Zeitlinie {rueckstand_ms:.1} ms hinter der Wanduhr \
             (jede ms davon haelt der Muxer als Bild-Latenz fest)"
        );
    }
}
