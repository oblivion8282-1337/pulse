//! Bündelt alles, was mit einer fertigen Zugriffseinheit ausser dem Anzeigen
//! passiert: Ton ausgeben und mitschneiden.
//!
//! Eigenes Modul, damit `session.rs` die Ablaufsteuerung bleibt und nicht zur
//! Sammelstelle waechst.
//!
//! Beide Teile sind **fehlertolerant**: laesst sich kein Ausgabegeraet oeffnen
//! oder scheitert eine Aufnahme, laeuft die Wiedergabe weiter. Ein stummer
//! Player ist besser als gar keiner.

use std::path::Path;

use crate::audio::{AudioOutput, OpusDecoder};
use crate::proto::PlayerOptions;
use crate::recorder::Recorder;
use crate::whep::Codec;

#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct MediaStats {
    /// Wie oft dem Ausgabegeraet Daten fehlten.
    pub audio_underruns: u64,
    /// Verworfene Samples, weil der Ring uebergelaufen ist.
    pub audio_dropped: u64,
    /// Aktueller Fuellstand des Ausgabepuffers in Samples.
    pub audio_buffered: u64,
    /// Ob ueberhaupt eine Tonausgabe zustande kam.
    pub audio_active: bool,
    pub recording: bool,
    pub recorded_units: u64,
    /// Wie viele Sekunden Vergangenheit fuer einen Clip bereitstehen.
    pub clip_buffer_seconds: u64,
}

#[derive(Default)]
pub struct MediaSink {
    audio: Option<AudioOutput>,
    opus: Option<OpusDecoder>,
    /// Ton einmal gescheitert => nicht bei jedem Paket neu versuchen.
    audio_failed: bool,
    recorder: Recorder,
    volume: f32,
    offset_ms: i32,
}

impl MediaSink {
    pub fn new() -> Self {
        Self { volume: 1.0, ..Default::default() }
    }

    /// Bildgroesse aus dem ersten dekodierten Bild — der Muxer braucht sie,
    /// bevor eine Aufnahme starten kann.
    pub fn note_dimensions(&mut self, width: u32, height: u32) {
        // Vor dem ersten dekodierten Bild meldet die Sitzung 0x0. Wuerde das
        // durchgereicht, haette der Rekorder "Groesse bekannt" gespeichert und
        // beim Start eine 0x0-Videospur angelegt — die Schutzabfrage in
        // `Recorder::make_writer` liefe ins Leere.
        if width == 0 || height == 0 {
            return;
        }
        self.recorder.note_dimensions(width, height);
    }

    pub fn apply_options(&mut self, options: &PlayerOptions) {
        if let Some(v) = options.volume {
            self.volume = v;
            if let Some(a) = self.audio.as_ref() {
                a.set_volume(v);
            }
        }
        if let Some(ms) = options.av_offset_ms {
            self.offset_ms = ms;
            if let Some(a) = self.audio.as_ref() {
                a.set_offset_ms(ms);
            }
        }
    }

    /// Nimmt eine fertige Zugriffseinheit entgegen.
    pub fn handle_unit(&mut self, codec: Codec, data: &[u8], ts_ms: i64) {
        self.recorder.push(codec, data, ts_ms);
        if codec == Codec::Opus {
            self.play_audio(data);
        }
    }

    fn play_audio(&mut self, packet: &[u8]) {
        if self.audio_failed {
            return;
        }
        if self.audio.is_none() {
            match AudioOutput::new() {
                Ok(out) => {
                    out.set_volume(self.volume);
                    out.set_offset_ms(self.offset_ms);
                    match OpusDecoder::new(out.sample_rate, out.channels) {
                        Ok(dec) => {
                            eprintln!(
                                "pulse-player: Tonausgabe {} Hz, {} Kanaele",
                                out.sample_rate, out.channels
                            );
                            self.opus = Some(dec);
                            self.audio = Some(out);
                        }
                        Err(e) => {
                            eprintln!("pulse-player: Opus-Decoder: {e:#} — bleibt stumm");
                            self.audio_failed = true;
                            return;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("pulse-player: keine Tonausgabe: {e:#} — bleibt stumm");
                    self.audio_failed = true;
                    return;
                }
            }
        }

        let (Some(dec), Some(out)) = (self.opus.as_mut(), self.audio.as_ref()) else { return };
        match dec.decode(packet) {
            Ok(pcm) => out.push(pcm),
            Err(e) => eprintln!("pulse-player: Opus-Decode: {e:#}"),
        }
    }

    pub fn start_recording(&mut self, path: &str) -> Result<(), String> {
        self.recorder.start(Path::new(path)).map_err(|e| format!("{e:#}"))
    }

    pub fn stop_recording(&mut self) -> Result<(), String> {
        self.recorder.stop().map_err(|e| format!("{e:#}"))
    }

    pub fn save_clip(&mut self, path: &str, seconds: f64) -> Result<u64, String> {
        self.recorder.clip(Path::new(path), seconds).map_err(|e| format!("{e:#}"))
    }

    pub fn stats(&self) -> MediaStats {
        let (underruns, dropped, buffered) =
            self.audio.as_ref().map_or((0, 0, 0), AudioOutput::counters);
        MediaStats {
            audio_underruns: underruns,
            audio_dropped: dropped,
            audio_buffered: buffered as u64,
            audio_active: self.audio.is_some(),
            recording: self.recorder.is_recording(),
            recorded_units: self.recorder.written_units,
            clip_buffer_seconds: self.recorder.buffered_seconds(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optionen_werden_gemerkt_auch_ohne_geraet() {
        let mut m = MediaSink::new();
        m.apply_options(&PlayerOptions { volume: Some(2.0), ..Default::default() });
        assert!((m.volume - 2.0).abs() < f32::EPSILON);
        m.apply_options(&PlayerOptions { av_offset_ms: Some(-120), ..Default::default() });
        assert_eq!(m.offset_ms, -120);
        // Lautstaerke darf durch den zweiten Patch nicht verlorengehen.
        assert!((m.volume - 2.0).abs() < f32::EPSILON);
    }

    #[test]
    fn aufnahme_ohne_bild_meldet_fehler_statt_zu_panischen() {
        let mut m = MediaSink::new();
        assert!(m.start_recording("/tmp/pulse-player-nichts.mkv").is_err());
        assert!(m.stop_recording().is_err(), "Stopp ohne Start ist ein Fehler");
    }

    /// Regression: vor dem ersten Bild meldet die Sitzung 0x0. Wird das
    /// uebernommen, laesst sich eine Aufnahme starten, die eine 0x0-Spur
    /// anlegt statt sauber abzulehnen.
    #[test]
    fn nullgroesse_wird_nicht_als_bekannt_uebernommen() {
        let mut m = MediaSink::new();
        m.note_dimensions(0, 0);
        m.handle_unit(Codec::H264, &[0, 0, 1, 0x65, 0x11], 0);
        assert!(
            m.start_recording("/tmp/pulse-player-nullgroesse.mkv").is_err(),
            "ohne echte Bildgroesse darf keine Aufnahme starten"
        );
    }

    #[test]
    fn video_einheiten_landen_im_ring_ohne_ton_anzufassen() {
        let mut m = MediaSink::new();
        m.note_dimensions(1280, 720);
        m.handle_unit(Codec::H264, &[0, 0, 1, 0x65, 0x11], 0);
        let s = m.stats();
        assert!(!s.audio_active, "Video darf keine Tonausgabe oeffnen");
        assert!(!s.recording);
    }
}
