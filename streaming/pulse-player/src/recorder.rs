//! Mitschnitt des ankommenden Bitstroms — **ohne Neukodierung**.
//!
//! Wir haben die fertigen Zugriffseinheiten ohnehin auf dem Weg zum Decoder;
//! sie zusaetzlich in eine Matroska-Datei zu muxen kostet fast nichts. Neu
//! encodieren waere teuer und wuerde Qualitaet kosten.
//!
//! Zwei Betriebsarten:
//! * **Laufende Aufnahme** (`start`/`stop`) — ab jetzt bis zum Stopp.
//! * **Clip** (`clip`) — die letzten N Sekunden aus einem Ringpuffer. Genau
//!   dafuer laeuft der Ring immer mit, auch wenn nicht aufgenommen wird.
//!
//! Zeitbasis ist bewusst 1/1000 (Millisekunden) fuer beide Spuren: die
//! RTP-Zeitstempel haben je Spur eine eigene Rate (90000 fuer Video, 48000 fuer
//! Opus), und eine gemeinsame Wanduhr-Basis ist einfacher richtig zu bekommen
//! als zwei umgerechnete.
//!
//! Ein Schnitt darf **nur auf einem Keyframe** beginnen, sonst zeigt der
//! Anfang Bildmuell, bis das naechste vollstaendige Bild kommt.

use std::collections::VecDeque;
use std::path::Path;

use anyhow::{anyhow, bail, Context as _, Result};
use ffmpeg_next as ffmpeg;

use crate::depacket::av1::read_leb128;
use crate::whep::Codec;

/// Wie viel Vergangenheit der Ring vorhaelt. Deckt die uebliche
/// "das haette ich gern gespeichert"-Spanne ab, ohne viel Speicher zu binden
/// (bei 4000 kbps sind 60 s rund 30 MB).
const RING_SECONDS: u64 = 60;

/// Zeitbasis beider Spuren: Millisekunden.
const TIME_BASE: (i32, i32) = (1, 1000);

#[derive(Clone)]
struct Unit {
    ts_ms: i64,
    codec: Codec,
    keyframe: bool,
    data: Vec<u8>,
}

/// Erkennt, ob eine Zugriffseinheit als Einstiegspunkt taugt.
///
/// AV1: enthaelt einen Sequence-Header (OBU-Typ 1).
/// H.264: enthaelt SPS (NAL 7) oder eine IDR-Einheit (NAL 5).
fn is_keyframe(codec: Codec, data: &[u8]) -> bool {
    match codec {
        Codec::Av1 => scan_av1_for_sequence_header(data),
        Codec::H264 => scan_annexb_for_idr(data),
        Codec::Opus => true,
    }
}

fn scan_av1_for_sequence_header(mut data: &[u8]) -> bool {
    // Der Strom traegt hier bereits Groessenfelder (siehe depacket::av1).
    while let Some((&header, rest)) = data.split_first() {
        let obu_type = (header & 0b0111_1000) >> 3;
        if obu_type == 1 {
            return true;
        }
        if header & 0b0000_0010 == 0 {
            return false; // ohne Groessenfeld nicht weiter zerlegbar
        }
        let has_ext = header & 0b0000_0100 != 0;
        let rest = if has_ext { rest.get(1..).unwrap_or(&[]) } else { rest };
        let Some((size, n)) = read_leb128(rest) else { return false };
        let skip = n + size as usize;
        if rest.len() < skip {
            return false;
        }
        data = &rest[skip..];
    }
    false
}

fn scan_annexb_for_idr(data: &[u8]) -> bool {
    // Startcodes suchen und den NAL-Typ direkt dahinter pruefen. Der Vierer-
    // Startcode `00 00 00 01` faellt mit ab: sein zweites Fenster ist wieder
    // `00 00 01 <nal>`.
    data.windows(4).any(|w| w[..3] == [0, 0, 1] && matches!(w[3] & 0x1F, 5 | 7))
}

/// Legt eine Matroska-Datei an und schreibt Einheiten hinein.
struct Writer {
    output: ffmpeg::format::context::Output,
    video_stream: Option<usize>,
    audio_stream: Option<usize>,
    /// Zeitpunkt der ersten geschriebenen Einheit — alles wird relativ dazu.
    origin_ms: Option<i64>,
    header_written: bool,
}

/// Haengt eine Spur an, die nur beschrieben und nie encodiert wird.
///
/// `fill` traegt die codec-eigenen Felder nach; Kennung und Zeitbasis setzt
/// diese Funktion, damit Kontext und Spur nicht auseinanderlaufen koennen.
fn add_stream(
    output: &mut ffmpeg::format::context::Output,
    id: ffmpeg::codec::Id,
    codec: ffmpeg::Codec,
    fill: impl FnOnce(*mut ffmpeg::ffi::AVCodecContext),
) -> Result<usize> {
    let mut ctx = ffmpeg::codec::context::Context::new_with_codec(codec);
    // Nur die Parameter, die der Muxer braucht — encodiert wird nichts.
    unsafe {
        let p = ctx.as_mut_ptr();
        (*p).codec_id = id.into();
        (*p).time_base = ffmpeg::ffi::AVRational { num: TIME_BASE.0, den: TIME_BASE.1 };
        fill(p);
    }
    let mut stream = output.add_stream_with(&ctx)?;
    stream.set_time_base(ffmpeg::Rational::new(TIME_BASE.0, TIME_BASE.1));
    Ok(stream.index())
}

impl Writer {
    fn create(path: &Path, video: Option<(Codec, u32, u32)>, audio: bool) -> Result<Self> {
        let mut output = ffmpeg::format::output(&path)
            .with_context(|| format!("Datei {} liess sich nicht anlegen", path.display()))?;

        let mut video_stream = None;
        if let Some((codec, width, height)) = video {
            let id = match codec {
                Codec::Av1 => ffmpeg::codec::Id::AV1,
                Codec::H264 => ffmpeg::codec::Id::H264,
                Codec::Opus => bail!("Opus ist keine Videospur"),
            };
            let enc = ffmpeg::encoder::find(id)
                .ok_or_else(|| anyhow!("Muxer kennt {id:?} nicht"))?;
            let index = add_stream(&mut output, id, enc, |p| unsafe {
                (*p).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
                (*p).width = width as i32;
                (*p).height = height as i32;
            })
            .context("Videospur")?;
            video_stream = Some(index);
        }

        let mut audio_stream = None;
        if audio {
            let id = ffmpeg::codec::Id::OPUS;
            let enc = ffmpeg::encoder::find(id)
                .ok_or_else(|| anyhow!("Muxer kennt Opus nicht"))?;
            let index = add_stream(&mut output, id, enc, |p| unsafe {
                (*p).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_AUDIO;
                (*p).sample_rate = 48_000;
                ffmpeg::ffi::av_channel_layout_default(&raw mut (*p).ch_layout, 2);
            })
            .context("Tonspur")?;
            audio_stream = Some(index);
        }

        if video_stream.is_none() && audio_stream.is_none() {
            bail!("weder Bild noch Ton zum Aufnehmen");
        }

        Ok(Self { output, video_stream, audio_stream, origin_ms: None, header_written: false })
    }

    fn write(&mut self, unit: &Unit) -> Result<()> {
        let stream = match unit.codec {
            Codec::Opus => self.audio_stream,
            _ => self.video_stream,
        };
        // Spur nicht angelegt — still verwerfen.
        let Some(index) = stream else { return Ok(()) };

        if !self.header_written {
            self.output.write_header().context("Dateikopf")?;
            self.header_written = true;
        }
        let origin = *self.origin_ms.get_or_insert(unit.ts_ms);
        let pts = (unit.ts_ms - origin).max(0);

        let mut packet = ffmpeg::codec::packet::Packet::copy(&unit.data);
        packet.set_stream(index);
        packet.set_pts(Some(pts));
        packet.set_dts(Some(pts));
        if unit.keyframe {
            packet.set_flags(ffmpeg::codec::packet::Flags::KEY);
        }
        packet.write_interleaved(&mut self.output).context("Paket schreiben")
    }

    fn finish(mut self) -> Result<()> {
        if !self.header_written {
            bail!("nichts aufgenommen");
        }
        self.output.write_trailer().context("Dateiende")
    }
}

/// Haelt den Ringpuffer und optional eine laufende Aufnahme.
#[derive(Default)]
pub struct Recorder {
    ring: VecDeque<Unit>,
    active: Option<Writer>,
    /// Bildgroesse, sobald bekannt — der Muxer braucht sie beim Anlegen.
    dimensions: Option<(u32, u32)>,
    video_codec: Option<Codec>,
    pub written_units: u64,
}

impl Recorder {
    /// Meldet die Bildgroesse aus dem ersten dekodierten Bild.
    pub fn note_dimensions(&mut self, width: u32, height: u32) {
        self.dimensions = Some((width, height));
    }

    pub fn is_recording(&self) -> bool {
        self.active.is_some()
    }

    pub fn buffered_seconds(&self) -> u64 {
        match (self.ring.front(), self.ring.back()) {
            (Some(a), Some(b)) => ((b.ts_ms - a.ts_ms).max(0) / 1000) as u64,
            _ => 0,
        }
    }

    /// Nimmt eine Zugriffseinheit entgegen: in den Ring und, falls aktiv, in
    /// die laufende Aufnahme.
    pub fn push(&mut self, codec: Codec, data: &[u8], ts_ms: i64) {
        if codec.is_video() {
            self.video_codec = Some(codec);
        }
        let unit = Unit { ts_ms, codec, keyframe: is_keyframe(codec, data), data: data.to_vec() };

        if let Some(writer) = self.active.as_mut() {
            if let Err(e) = writer.write(&unit) {
                eprintln!("pulse-player: Aufnahme abgebrochen: {e:#}");
                self.active = None;
            } else {
                self.written_units += 1;
            }
        }

        self.ring.push_back(unit);
        let cutoff = ts_ms - (RING_SECONDS * 1000) as i64;
        while self.ring.front().is_some_and(|u| u.ts_ms < cutoff) {
            self.ring.pop_front();
        }
    }

    pub fn start(&mut self, path: &Path) -> Result<()> {
        if self.active.is_some() {
            bail!("es laeuft bereits eine Aufnahme");
        }
        self.active = Some(self.make_writer(path)?);
        self.written_units = 0;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<()> {
        let writer = self.active.take().ok_or_else(|| anyhow!("es laeuft keine Aufnahme"))?;
        writer.finish()
    }

    /// Schreibt die letzten `seconds` Sekunden aus dem Ring.
    ///
    /// Beginnt beim letzten Keyframe **vor** dem gewuenschten Startpunkt —
    /// sonst waere der Anfang unbrauchbar. Der Clip wird dadurch etwas
    /// laenger als angefordert.
    pub fn clip(&mut self, path: &Path, seconds: f64) -> Result<u64> {
        let Some(last) = self.ring.back() else { bail!("nichts im Puffer") };
        let start_ms = last.ts_ms - (seconds.max(0.1) * 1000.0) as i64;

        let begin = self
            .ring
            .iter()
            .rposition(|u| u.codec.is_video() && u.keyframe && u.ts_ms <= start_ms)
            .or_else(|| self.ring.iter().position(|u| u.codec.is_video() && u.keyframe))
            .ok_or_else(|| anyhow!("kein Keyframe im Puffer — noch zu frueh"))?;

        let mut writer = self.make_writer(path)?;
        let mut count = 0u64;
        for unit in self.ring.iter().skip(begin) {
            writer.write(unit)?;
            count += 1;
        }
        writer.finish()?;
        Ok(count)
    }

    fn make_writer(&self, path: &Path) -> Result<Writer> {
        let (Some(codec), Some((width, height))) = (self.video_codec, self.dimensions) else {
            bail!("noch kein Bild empfangen — Aufnahme erst nach dem ersten Frame moeglich");
        };
        Writer::create(path, Some((codec, width, height)), true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn av1_sequence_header_gilt_als_keyframe() {
        // OBU-Typ 1 (SEQUENCE_HEADER) mit Groessenfeld
        let seq = [(1u8 << 3) | 0b10, 1, 0xAA];
        assert!(is_keyframe(Codec::Av1, &seq));

        // OBU-Typ 6 (FRAME) allein ist keiner
        let frame = [(6u8 << 3) | 0b10, 1, 0xAA];
        assert!(!is_keyframe(Codec::Av1, &frame));
    }

    #[test]
    fn h264_idr_und_sps_gelten_als_keyframe() {
        let idr = [0, 0, 1, 0x65, 0x88];
        assert!(is_keyframe(Codec::H264, &idr), "IDR (NAL 5)");
        let sps = [0, 0, 1, 0x67, 0x42];
        assert!(is_keyframe(Codec::H264, &sps), "SPS (NAL 7)");
        let inter = [0, 0, 1, 0x41, 0x9A];
        assert!(!is_keyframe(Codec::H264, &inter), "NAL 1 ist keiner");
    }

    #[test]
    fn ring_verwirft_alte_einheiten() {
        let mut r = Recorder::default();
        r.note_dimensions(1920, 1080);
        for i in 0..200 {
            r.push(Codec::H264, &[0, 0, 1, 0x65], i * 1000);
        }
        // Ring haelt nur RING_SECONDS vor.
        assert!(r.buffered_seconds() <= RING_SECONDS, "Ring: {}", r.buffered_seconds());
        assert!(!r.ring.is_empty());
    }

    #[test]
    fn aufnahme_ohne_bild_wird_abgelehnt() {
        let mut r = Recorder::default();
        let err = r.start(Path::new("/tmp/pulse-player-test.mkv"));
        assert!(err.is_err(), "ohne bekannte Bildgroesse darf nicht gestartet werden");
    }

    #[test]
    fn clip_ohne_puffer_wird_abgelehnt() {
        let mut r = Recorder::default();
        r.note_dimensions(1920, 1080);
        assert!(r.clip(Path::new("/tmp/pulse-player-test.mkv"), 5.0).is_err());
    }
}
