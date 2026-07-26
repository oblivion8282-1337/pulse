//! Mitschnitt des ankommenden Bitstroms — **ohne Neukodierung**.
//!
//! Container ist **MPEG-TS**, nicht Matroska. Der Grund ist gemessen, nicht
//! gewaehlt: Matroska verlangt fuer H.264 `extradata` (SPS/PPS als `avcC`) und
//! Pakete im Laengen-Praefix-Format. Wir haben aber Annex B aus dem
//! Depacketizer und kein `extradata` — `write_header()` scheitert dort mit
//! "Invalid data found when processing input". MPEG-TS nimmt Annex B nativ.
//! Nachteil: kein Suchindex. Wer Matroska will, muss `extradata` aus SPS/PPS
//! bauen und die Pakete umformatieren.
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

/// Container je Codec — gemessen, nicht gewaehlt.
///
/// * **H.264 -> MPEG-TS.** Nimmt Annex B nativ ohne `extradata`. Matroska
///   verlangt dort `avcC` und Laengen-Praefix-Pakete und lehnt unseren Strom
///   mit "Invalid data found" ab.
/// * **AV1 -> Matroska.** MPEG-TS traegt AV1 nicht; der Strom landet dort als
///   `bin_data` und ist unlesbar. Matroska nimmt ihn mit dem
///   AV1CodecConfigurationRecord als `extradata`.
fn container_extension(codec: Codec) -> &'static str {
    match codec {
        Codec::Av1 => "mkv",
        _ => "ts",
    }
}

/// Setzt die zum Codec passende Endung. Der Aufrufer bekommt den tatsaechlich
/// benutzten Pfad zurueck, damit er nicht auf eine Datei zeigt, die es so nicht
/// gibt.
fn with_container(path: &Path, codec: Codec) -> std::path::PathBuf {
    path.with_extension(container_extension(codec))
}

/// Zeitbasis, in der WIR rechnen: Millisekunden.
///
/// Der Muxer setzt seine eigene durch (MPEG-TS erzwingt 1/90000). Die Pakete
/// muessen deshalb vor dem Schreiben umgerechnet werden — sonst werden
/// Millisekunden als 90-kHz-Ticks gelesen und die Aufnahme laeuft 90-fach zu
/// schnell. Gemessen: 90 Bilder landeten in 49 ms statt in 3 s.
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

/// Liefert den Sequence-Header-OBU (Typ 1) aus einer Zugriffseinheit, falls
/// enthalten. Er wird fuer die AV1-Konfiguration des Muxers gebraucht.
fn find_av1_sequence_header(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut offset = 0usize;
    while let Some((&header, rest)) = data.split_first() {
        let obu_type = (header & 0b0111_1000) >> 3;
        if header & 0b0000_0010 == 0 {
            return None;
        }
        let has_ext = header & 0b0000_0100 != 0;
        let after_header = if has_ext { rest.get(1..)? } else { rest };
        let (size, n) = read_leb128(after_header)?;
        let header_len = 1 + usize::from(has_ext);
        let total = header_len + n + size as usize;
        if offset + total > offset + data.len() {
            return None;
        }
        if obu_type == 1 {
            return Some(data[..total].to_vec());
        }
        if data.len() < total {
            return None;
        }
        data = &data[total..];
        offset += total;
    }
    None
}

/// Baut den AV1CodecConfigurationRecord, den Matroska als `CodecPrivate`
/// erwartet.
///
/// Ohne ihn lehnt der Muxer den Dateikopf mit "Invalid data found" ab (gemessen)
/// — und MPEG-TS traegt AV1 gar nicht, dort landet der Strom als `bin_data`.
///
/// Profil und Chroma sind hier NICHT aus dem Sequence-Header geparst, sondern
/// abgeleitet: der Player unterstuetzt ausschliesslich 4:2:0 in 8 oder 10 Bit
/// (siehe `decode::PixelLayout`), und das ist genau Profil 0. Die Bittiefe
/// kommt aus dem dekodierten Bild. Ein Strom in 4:4:4 oder 12 Bit wuerde hier
/// falsch beschrieben — den kann der Player aber ohnehin nicht anzeigen.
fn av1_codec_config(seq_header: &[u8], ten_bit: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + seq_header.len());
    out.push(0x81); // marker=1, version=1
    out.push(0x00); // seq_profile=0, seq_level_idx_0=0
    // seq_tier=0, high_bitdepth, twelve_bit=0, monochrome=0,
    // chroma_subsampling_x=1, chroma_subsampling_y=1, chroma_sample_position=0
    out.push(if ten_bit { 0b0100_1100 } else { 0b0000_1100 });
    out.push(0x00); // kein initial_presentation_delay
    out.extend_from_slice(seq_header);
    out
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
    fn create(
        path: &Path,
        video: Option<(Codec, u32, u32)>,
        extradata: Option<&[u8]>,
        audio: bool,
    ) -> Result<Self> {
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
                // AV1 braucht den Konfigurationsdatensatz als `extradata`,
                // sonst kann Matroska die Spur nicht beschreiben. Der Puffer
                // muss von FFmpegs Allokator kommen — `avcodec` gibt ihn frei.
                if let Some(extra) = extradata {
                    let size = extra.len();
                    let padding = ffmpeg::ffi::AV_INPUT_BUFFER_PADDING_SIZE as usize;
                    let buf = ffmpeg::ffi::av_mallocz(size + padding).cast::<u8>();
                    if !buf.is_null() {
                        std::ptr::copy_nonoverlapping(extra.as_ptr(), buf, size);
                        (*p).extradata = buf;
                        (*p).extradata_size = size as i32;
                    }
                }
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
        // Erst NACH `write_header()` steht die endgueltige Zeitbasis der Spur
        // fest; der Muxer darf sie aendern. Ohne diese Umrechnung wuerden
        // unsere Millisekunden in der Muxer-Basis gelesen.
        let target = self
            .output
            .stream(index)
            .map_or(ffmpeg::Rational::new(TIME_BASE.0, TIME_BASE.1), |s| s.time_base());
        packet.rescale_ts(ffmpeg::Rational::new(TIME_BASE.0, TIME_BASE.1), target);
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
    /// Eine Aufnahme ist unterwegs gescheitert. Wird nach vorne gemeldet,
    /// damit es nicht so aussieht, als haette nie jemand gestartet.
    pub failed: bool,
    /// AV1-Sequence-Header aus dem Strom — Grundlage der Muxer-Konfiguration.
    av1_seq_header: Option<Vec<u8>>,
    /// Bittiefe des Bildes, fuer denselben Zweck.
    ten_bit: bool,
}

impl Recorder {
    /// Meldet die Bildgroesse aus dem ersten dekodierten Bild.
    pub fn note_dimensions(&mut self, width: u32, height: u32) {
        self.dimensions = Some((width, height));
    }

    /// Bittiefe aus dem dekodierten Bild — geht in die AV1-Konfiguration ein.
    pub fn note_ten_bit(&mut self, ten_bit: bool) {
        self.ten_bit = ten_bit;
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
        if codec == Codec::Av1 && self.av1_seq_header.is_none() {
            self.av1_seq_header = find_av1_sequence_header(data);
        }
        let unit = Unit { ts_ms, codec, keyframe: is_keyframe(codec, data), data: data.to_vec() };

        if let Some(writer) = self.active.as_mut() {
            if let Err(e) = writer.write(&unit) {
                eprintln!("pulse-player: Aufnahme abgebrochen: {e:#}");
                // Datei trotzdem ordentlich abschliessen. Wuerde der Writer
                // nur gedroppt, faehrt ffmpeg-next zwar `avio_close`, aber
                // KEIN `av_write_trailer` — ohne Trailer fehlen Index und
                // Segmentgroesse, und die Pakete in der Interleave-Queue von
                // libavformat gehen verloren. Das bereits Aufgenommene bleibt
                // so wenigstens abspielbar.
                if let Some(writer) = self.active.take() {
                    if let Err(e) = writer.finish() {
                        eprintln!("pulse-player: Abschluss nach Fehler: {e:#}");
                    }
                }
                self.failed = true;
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

    /// Startet eine Aufnahme und liefert den tatsaechlich benutzten Pfad —
    /// die Endung richtet sich nach dem Codec.
    pub fn start(&mut self, path: &Path) -> Result<std::path::PathBuf> {
        if self.active.is_some() {
            bail!("es laeuft bereits eine Aufnahme");
        }
        let (codec, _, _) = self.video_info()?;
        let target = with_container(path, codec);
        self.active = Some(self.make_writer(&target)?);
        self.written_units = 0;
        self.failed = false;
        Ok(target)
    }

    pub fn stop(&mut self) -> Result<()> {
        let writer = self.active.take().ok_or_else(|| anyhow!("es laeuft keine Aufnahme"))?;
        writer.finish()
    }

    /// Sammelt die letzten `seconds` Sekunden aus dem Ring ein, **ohne zu
    /// schreiben**.
    ///
    /// Bewusst getrennt vom Schreiben: das Schreiben laeuft synchron gegen die
    /// Platte und dauerte bei 60 s Bitstrom lange genug, dass die
    /// Sitzungsschleife stillstand — der RTP-Kanal (1024 Pakete, bei rund
    /// 1000 Paketen/s also etwa eine Sekunde Reserve) lief voll und der Strom
    /// bekam einen sichtbaren Aussetzer. Das Einsammeln hier ist ein
    /// Speicherkopiervorgang, das Schreiben passiert danach ausserhalb.
    ///
    /// Beginnt beim letzten Keyframe **vor** dem gewuenschten Startpunkt —
    /// sonst waere der Anfang unbrauchbar. Der Clip wird dadurch etwas
    /// laenger als angefordert.
    pub fn clip_snapshot(&self, seconds: f64) -> Result<ClipData> {
        let Some(last) = self.ring.back() else { bail!("nichts im Puffer") };
        let start_ms = last.ts_ms - (seconds.max(0.1) * 1000.0) as i64;

        let begin = self
            .ring
            .iter()
            .rposition(|u| u.codec.is_video() && u.keyframe && u.ts_ms <= start_ms)
            .or_else(|| self.ring.iter().position(|u| u.codec.is_video() && u.keyframe))
            .ok_or_else(|| anyhow!("kein Keyframe im Puffer — noch zu frueh"))?;

        let video = self.video_info()?;
        Ok(ClipData {
            units: self.ring.iter().skip(begin).cloned().collect(),
            video,
            extradata: self.extradata(),
        })
    }

    fn video_info(&self) -> Result<(Codec, u32, u32)> {
        let (Some(codec), Some((width, height))) = (self.video_codec, self.dimensions) else {
            bail!("noch kein Bild empfangen — erst nach dem ersten Frame moeglich");
        };
        Ok((codec, width, height))
    }

    fn make_writer(&self, path: &Path) -> Result<Writer> {
        Writer::create(path, Some(self.video_info()?), self.extradata().as_deref(), true)
    }

    /// Konfigurationsdatensatz fuer den Muxer, falls der Codec einen braucht.
    /// H.264 kommt als Annex B und braucht in MPEG-TS keinen.
    fn extradata(&self) -> Option<Vec<u8>> {
        match self.video_codec {
            Some(Codec::Av1) => self
                .av1_seq_header
                .as_ref()
                .map(|h| av1_codec_config(h, self.ten_bit)),
            _ => None,
        }
    }
}

/// Eingesammelter Clip, bereit zum Schreiben ausserhalb der Sitzungsschleife.
pub struct ClipData {
    units: Vec<Unit>,
    video: (Codec, u32, u32),
    extradata: Option<Vec<u8>>,
}

/// Schreibt einen zuvor eingesammelten Clip. Blockiert — gehoert deshalb auf
/// einen Blocking-Thread, nicht in die Sitzungsschleife.
pub fn write_clip(path: &Path, data: &ClipData) -> Result<(u64, std::path::PathBuf)> {
    let target = with_container(path, data.video.0);
    let mut writer =
        Writer::create(&target, Some(data.video), data.extradata.as_deref(), true)?;
    let mut count = 0u64;
    for unit in &data.units {
        writer.write(unit)?;
        count += 1;
    }
    writer.finish()?;
    Ok((count, target))
}

/// Auffangnetz: eine laufende Aufnahme wird auch dann sauber abgeschlossen,
/// wenn die Sitzung ohne ausdrueckliches `stop_record` endet — Kanalwechsel,
/// geschlossene Kachel, beendete App. Ohne den Trailer fehlt der Datei die
/// Index-/Abschlussinformation, und je nach Abspieler ist sie unbrauchbar.
impl Drop for Recorder {
    fn drop(&mut self) {
        let Some(writer) = self.active.take() else { return };
        match writer.finish() {
            Ok(()) => eprintln!("pulse-player: Aufnahme beim Beenden abgeschlossen"),
            Err(e) => eprintln!("pulse-player: Aufnahme konnte nicht abgeschlossen werden: {e:#}"),
        }
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

    /// Zerlegt einen Annex-B-Strom in Zugriffseinheiten: jede beginnt mit dem
    /// ersten Nicht-Slice-NAL vor einem Slice (SPS/PPS/SEI) und endet vor dem
    /// naechsten Slice.
    fn split_annexb(data: &[u8]) -> Vec<Vec<u8>> {
        let mut starts = Vec::new();
        let mut i = 0;
        while i + 4 < data.len() {
            let (nal_at, next) = if data[i..i + 3] == [0, 0, 1] {
                (i + 3, i + 3)
            } else if data[i..i + 4] == [0, 0, 0, 1] {
                (i + 4, i + 4)
            } else {
                i += 1;
                continue;
            };
            starts.push((i, data[nal_at] & 0x1F));
            i = next;
        }
        // Einheitsgrenze vor jedem Slice-NAL (1 oder 5), aber SPS/PPS/SEI
        // davor gehoeren dazu.
        let mut units: Vec<Vec<u8>> = Vec::new();
        let mut unit_start: Option<usize> = None;
        let mut seen_slice = false;
        for (idx, (offset, nal)) in starts.iter().enumerate() {
            let is_slice = matches!(nal, 1 | 5);
            if is_slice && seen_slice {
                let end = *offset;
                if let Some(st) = unit_start {
                    units.push(data[st..end].to_vec());
                }
                unit_start = Some(*offset);
                seen_slice = true;
            } else {
                if unit_start.is_none() {
                    unit_start = Some(*offset);
                }
                if is_slice {
                    seen_slice = true;
                }
            }
            if idx + 1 == starts.len() {
                if let Some(st) = unit_start {
                    units.push(data[st..].to_vec());
                }
            }
        }
        units
    }

    /// Ende-zu-Ende: echter H.264-Annex-B-Strom durch den Rekorder in eine
    /// Matroska-Datei. Laeuft nur, wenn `PULSE_PLAYER_H264_FIXTURE` auf eine
    /// Rohdatei zeigt — die Crate bringt bewusst keine Mediendatei mit.
    ///
    /// Erzeugen:
    /// `ffmpeg -f lavfi -i testsrc2=s=640x360:r=30:d=3 -c:v libx264 \
    ///    -bsf:v h264_mp4toannexb -f h264 fixture.h264`
    #[test]
    fn h264_annexb_wird_zu_abspielbarer_datei() {
        let Ok(fixture) = std::env::var("PULSE_PLAYER_H264_FIXTURE") else {
            eprintln!("uebersprungen: PULSE_PLAYER_H264_FIXTURE nicht gesetzt");
            return;
        };
        // FFmpegs eigene Diagnose sichtbar machen — der AVERROR-Text allein
        // ist bei Muxer-Ablehnungen oft leer.
        ffmpeg::init().ok();
        ffmpeg::util::log::set_level(ffmpeg::util::log::Level::Verbose);
        let data = std::fs::read(&fixture).expect("Fixture lesbar");
        let units = split_annexb(&data);
        assert!(units.len() > 10, "zu wenige Zugriffseinheiten: {}", units.len());

        let out = std::env::var("PULSE_PLAYER_MUX_OUT")
            .unwrap_or_else(|_| "/tmp/pulse-player-muxtest.mkv".into());

        let mut r = Recorder::default();
        r.note_dimensions(640, 360);
        // Erst eine Einheit einspeisen, damit der Codec bekannt ist.
        r.push(Codec::H264, &units[0], 0);
        let used = r.start(Path::new(&out)).expect("Aufnahme startet");
        for (i, u) in units.iter().enumerate() {
            r.push(Codec::H264, u, (i as i64) * 33);
        }
        r.stop().expect("Aufnahme schliesst ab");

        let out = used.to_string_lossy().into_owned();
        let size = std::fs::metadata(&out).expect("Datei existiert").len();
        assert!(size > 10_000, "Datei zu klein: {size} Bytes");

        // Wieder einlesen: die Datei muss nicht nur existieren, sondern auch
        // die richtige LAENGE haben. Vor der Zeitbasis-Umrechnung landeten die
        // 90 Bilder in 49 ms statt in knapp 3 s — die Datei war "vorhanden",
        // aber ein 60-facher Schnelldurchlauf.
        let input = ffmpeg::format::input(&out).expect("Datei lesbar");
        let seconds = input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE);
        let erwartet = units.len() as f64 / 30.0;
        assert!(
            (seconds - erwartet).abs() < 0.2,
            "Dauer {seconds:.3} s weicht von erwarteten {erwartet:.3} s ab"
        );
        assert!(
            input.streams().best(ffmpeg::media::Type::Video).is_some(),
            "keine Videospur in der Datei"
        );
        eprintln!("geschrieben: {out} ({size} Bytes, {seconds:.3} s, {} Einheiten)", units.len());
    }

    /// Zerlegt einen AV1-OBU-Strom in Zugriffseinheiten: Grenze ist jeweils
    /// ein Temporal-Delimiter (OBU-Typ 2). Der Delimiter selbst wird
    /// weggelassen — genau so liefert der Depacketizer die Einheiten.
    fn split_obu(data: &[u8]) -> Vec<Vec<u8>> {
        let mut units: Vec<Vec<u8>> = Vec::new();
        let mut current: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < data.len() {
            let header = data[i];
            let obu_type = (header & 0b0111_1000) >> 3;
            let has_ext = header & 0b0000_0100 != 0;
            let has_size = header & 0b0000_0010 != 0;
            if !has_size {
                break; // ohne Groessenfeld nicht zerlegbar
            }
            let mut pos = i + 1 + usize::from(has_ext);
            let Some((size, n)) = read_leb128(&data[pos..]) else { break };
            pos += n;
            let end = pos + size as usize;
            if end > data.len() {
                break;
            }
            if obu_type == 2 {
                if !current.is_empty() {
                    units.push(std::mem::take(&mut current));
                }
            } else {
                current.extend_from_slice(&data[i..end]);
            }
            i = end;
        }
        if !current.is_empty() {
            units.push(current);
        }
        units
    }

    /// Ende-zu-Ende fuer AV1 — der Standard-Codec. Laeuft nur mit
    /// `PULSE_PLAYER_AV1_FIXTURE` (roher OBU-Strom).
    ///
    /// Erzeugen:
    /// `ffmpeg -f lavfi -i testsrc2=s=320x180:r=30:d=2 -c:v libsvtav1 \
    ///    -preset 12 -f obu fixture.obu`
    #[test]
    fn av1_obus_werden_zu_abspielbarer_datei() {
        let Ok(fixture) = std::env::var("PULSE_PLAYER_AV1_FIXTURE") else {
            eprintln!("uebersprungen: PULSE_PLAYER_AV1_FIXTURE nicht gesetzt");
            return;
        };
        ffmpeg::init().ok();
        ffmpeg::util::log::set_level(ffmpeg::util::log::Level::Verbose);
        let data = std::fs::read(&fixture).expect("Fixture lesbar");
        let units = split_obu(&data);
        assert!(units.len() > 10, "zu wenige Zugriffseinheiten: {}", units.len());

        let out = std::env::var("PULSE_PLAYER_AV1_OUT")
            .unwrap_or_else(|_| "/tmp/pulse-player-av1test.ts".into());

        let mut r = Recorder::default();
        r.note_dimensions(320, 180);
        r.push(Codec::Av1, &units[0], 0);
        let used = r.start(Path::new(&out)).expect("Aufnahme startet");
        for (i, u) in units.iter().enumerate() {
            r.push(Codec::Av1, u, (i as i64) * 33);
        }
        r.stop().expect("Aufnahme schliesst ab");

        let out = used.to_string_lossy().into_owned();
        let input = ffmpeg::format::input(&out).expect("Datei lesbar");
        assert!(
            input.streams().best(ffmpeg::media::Type::Video).is_some(),
            "keine Videospur in der Datei"
        );
        let seconds = input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE);
        eprintln!("AV1 geschrieben: {out} ({seconds:.3} s, {} Einheiten)", units.len());
    }

    #[test]
    fn clip_ohne_puffer_wird_abgelehnt() {
        let mut r = Recorder::default();
        r.note_dimensions(1920, 1080);
        assert!(r.clip_snapshot(5.0).is_err());
    }
}
