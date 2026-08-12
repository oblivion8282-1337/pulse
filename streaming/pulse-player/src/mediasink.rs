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

use bytes::Bytes;

use crate::audio::AudioOutput;
use crate::proto::PlayerOptions;
use crate::recorder::Recorder;
use crate::whep::Codec;

#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct MediaStats {
    /// Wie oft dem Ausgabegeraet Daten fehlten.
    pub audio_underruns: u64,
    /// Verworfene Samples, weil der Ring uebergelaufen ist.
    pub audio_dropped: u64,
    /// Wie oft der Ton-Ring grob auf den Sollwert zurueckgeschnitten wurde.
    /// Sichtbar, weil der Schnitt hoerbar ist — ein Eingriff, den niemand
    /// sieht, war genau der alte Fehler (s. `audio.rs::RING_SOLL_MS`).
    pub audio_resyncs: u64,
    /// Aktueller Fuellstand des Ausgabepuffers in Samples.
    pub audio_buffered: u64,
    /// Nachfuehrung der Abspielrate in Millionstel (s. `audio::uhrenabgleich`).
    /// Gehoert ins Protokoll: eine stille Regelung, die niemand sieht, war
    /// genau der Fehler, der hier behoben wurde.
    pub audio_abgleich_ppm: i32,
    /// Ob ueberhaupt eine Tonausgabe zustande kam.
    pub audio_active: bool,
    pub recording: bool,
    pub recorded_units: u64,
    /// Eine Aufnahme ist unterwegs gescheitert (Schreibfehler). Ohne das
    /// saehe es aus, als haette nie jemand gestartet.
    pub recording_failed: bool,
    /// Wie viele Sekunden Vergangenheit fuer einen Clip bereitstehen.
    pub clip_buffer_seconds: u64,
}

#[derive(Default)]
pub struct MediaSink {
    audio: Option<AudioOutput>,
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
    ///
    /// Bewusst [`Bytes`] statt `&[u8]`: der Ringpuffer im Rekorder haelt die
    /// Einheit 60 Sekunden fest. Ueber ein Slice muesste er sie dafuer
    /// kopieren; referenzgezaehlt teilt er sich den Speicher mit dem
    /// Depacketizer, aus dem sie ohnehin schon als `Bytes` kommt.
    pub fn handle_unit(&mut self, codec: Codec, data: Bytes, ts_ms: i64) {
        self.recorder.push(codec, data.clone(), ts_ms);
        if codec == Codec::Opus {
            self.play_audio(&data);
        }
    }

    /// Tonpaket weitergeben — OHNE es hier zu dekodieren.
    ///
    /// Der Aufrufer ist die Sitzungsschleife, die auch RTP abholt,
    /// depacketisiert und Bilder dekodiert. Opus hier zu dekodieren und
    /// umzurechnen hielt sie alle 20 ms an: gemessen 42-44 Aussetzer je Sekunde
    /// mit Luecken bis 24 ms, waehrend derselbe Stream ohne Ton auf maximal
    /// 11 ms Abstand und NULL Aussetzer kam. Jetzt macht das der Ton-Thread
    /// (s. `AudioCommand::Packet`).
    fn play_audio(&mut self, packet: &[u8]) {
        if !self.ensure_audio() {
            return;
        }
        if let Some(out) = self.audio.as_ref() {
            out.push_packet(packet);
        }
    }

    /// Oeffnet Geraet und Decoder beim ersten Tonpaket. `false` heisst: der
    /// Player bleibt stumm — einmal gescheitert wird nicht erneut versucht.
    fn ensure_audio(&mut self) -> bool {
        if self.audio_failed {
            return false;
        }
        if self.audio.is_some() {
            return true;
        }

        let out = match AudioOutput::new() {
            Ok(out) => out,
            Err(e) => {
                eprintln!("pulse-player: keine Tonausgabe: {e:#} — bleibt stumm");
                self.audio_failed = true;
                return false;
            }
        };
        out.set_volume(self.volume);
        out.set_offset_ms(self.offset_ms);

        eprintln!("pulse-player: Tonausgabe {} Hz, {} Kanaele", out.sample_rate, out.channels);
        self.audio = Some(out);
        true
    }

    pub fn note_ten_bit(&mut self, ten_bit: bool) {
        self.recorder.note_ten_bit(ten_bit);
    }

    /// Liefert den tatsaechlich benutzten Pfad — die Endung haengt am Codec.
    pub fn start_recording(&mut self, path: &str) -> Result<String, String> {
        self.recorder
            .start(Path::new(path))
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| format!("{e:#}"))
    }

    pub fn is_recording(&self) -> bool {
        self.recorder.is_recording()
    }

    pub fn stop_recording(&mut self) -> Result<(), String> {
        self.recorder.stop().map_err(|e| format!("{e:#}"))
    }

    /// Sammelt den Clip ein. Geschrieben wird er ausserhalb der
    /// Sitzungsschleife (s. `recorder::write_clip`).
    pub fn clip_snapshot(&self, seconds: f64) -> Result<crate::recorder::ClipData, String> {
        self.recorder.clip_snapshot(seconds).map_err(|e| format!("{e:#}"))
    }

    pub fn stats(&self) -> MediaStats {
        let ton = self.audio.as_ref().map(AudioOutput::counters).unwrap_or_default();
        MediaStats {
            audio_underruns: ton.underruns,
            audio_dropped: ton.dropped,
            audio_buffered: ton.buffered as u64,
            audio_abgleich_ppm: ton.abgleich_ppm,
            audio_resyncs: ton.resyncs,
            // Nicht `is_some()`: der Griff bleibt bestehen, auch wenn der
            // Ausgabe-Thread laengst weg ist.
            audio_active: ton.alive,
            recording: self.recorder.is_recording(),
            recorded_units: self.recorder.written_units,
            recording_failed: self.recorder.failed,
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
        assert!(m.start_recording(&crate::ablage::temp_str("pulse-player-nichts.mkv")).is_err());
        assert!(m.stop_recording().is_err(), "Stopp ohne Start ist ein Fehler");
    }

    /// Regression: vor dem ersten Bild meldet die Sitzung 0x0. Wird das
    /// uebernommen, laesst sich eine Aufnahme starten, die eine 0x0-Spur
    /// anlegt statt sauber abzulehnen.
    #[test]
    fn nullgroesse_wird_nicht_als_bekannt_uebernommen() {
        let mut m = MediaSink::new();
        m.note_dimensions(0, 0);
        m.handle_unit(Codec::H264, Bytes::from_static(&[0, 0, 1, 0x65, 0x11]), 0);
        assert!(
            m.start_recording(&crate::ablage::temp_str("pulse-player-nullgroesse.mkv")).is_err(),
            "ohne echte Bildgroesse darf keine Aufnahme starten"
        );
    }

    #[test]
    fn video_einheiten_landen_im_ring_ohne_ton_anzufassen() {
        let mut m = MediaSink::new();
        m.note_dimensions(1280, 720);
        m.handle_unit(Codec::H264, Bytes::from_static(&[0, 0, 1, 0x65, 0x11]), 0);
        let s = m.stats();
        assert!(!s.audio_active, "Video darf keine Tonausgabe oeffnen");
        assert!(!s.recording);
    }
}
