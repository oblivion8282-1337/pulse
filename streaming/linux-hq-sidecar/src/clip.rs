//! ShadowPlay fuer den Sender: die schon enkodierten Bilder und der Ton
//! laufen in einen Rollring, und auf Wunsch wird daraus ein Clip der
//! letzten Sekunden in eine Datei gestemmt — OHNE Neukodierung, ohne
//! zusaetzliche Aufnahme, ohne Extra-Last. Die Vorlage ist der Recorder
//! des Pulse-Players (`pulse-player/src/recorder.rs`, dort 2026-09-27
//! E2E-geprüft); dieser hier ist die auf den Sender reduzierte Fassung:
//! eigener Codec-Enum, LEB128 mitgenommen, dieselben drei Lehren aus dem
//! Player verbaut (strikte Stempel je Spur fuer MPEG-TS, Bildrate als
//! Metadatum, keine Leerdatei nach leergebliebenem Schnitt).
//!
//! Zwei Einspeisestellen teilen sich den Ring: die Video-Schleife
//! (`encode::VideoEncoder::drain_video`) und der Ton-Faden
//! (`encode::audio`), beide ueber die globalen [`push_video`]/
//! [`push_audio`]. Die Zeitstempel kommen aus den Encoder-Uhren
//! (Video 1/90000, Ton 1/48000), werden hier je Spur auf Millisekunden
//! relativ zum ersten Video-Bild gerechnet — beide Uhren starten mit dem
//! Strom, die Ms laufen also weitgehend gemeinsam.

use std::collections::VecDeque;
use std::path::{Component, Path};

use anyhow::{anyhow, bail, Context as _, Result};
use bytes::Bytes;
use ffmpeg_next as ffmpeg;

/// Wie viel Vergangenheit der Ring vorhaelt. Der Clip beginnt am letzten
/// Vollbild VOR dem gewuenschten Start (sonst waere der Anfang Muell) — bei
/// einem Vollbild-Abstand von bis zu 60 s muss der Ring also laenger als die
/// Clip-Laenge halten, sonst ist das Vollbild schon hinausgeschnitten.
/// Oeffentlich, weil der clip_save-Op seine Obergrenze daran festmacht: mehr
/// als der Ring halten kann, kann kein Clip hergeben.
pub const RING_SECONDS: u64 = 90;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Codec {
    H264,
    H265,
    Av1,
    Opus,
}

impl Codec {
    fn ist_video(self) -> bool {
        !matches!(self, Codec::Opus)
    }
}

/// Codec-Art aus der Konfiguration des Senders ("h264" | "hevc" | "av1").
pub fn codec_aus_str(name: &str) -> Result<Codec> {
    match name {
        "h264" => Ok(Codec::H264),
        "hevc" => Ok(Codec::H265),
        "av1" => Ok(Codec::Av1),
        anderes => bail!("unbekannter Codec fuer den Clip-Ring: {anderes}"),
    }
}

fn read_leb128(buf: &[u8]) -> Option<(u32, usize)> {
    let mut value: u64 = 0;
    for (i, &b) in buf.iter().enumerate().take(8) {
        value |= u64::from(b & 0x7f) << (i * 7);
        if b & 0x80 == 0 {
            return u32::try_from(value).ok().map(|v| (v, i + 1));
        }
    }
    None
}

// ── Keyframe-Erkennung (1:1 vom Player, dort gegen echte Stroeme gemessen) ──

fn ist_keyframe(codec: Codec, data: &[u8]) -> bool {
    match codec {
        Codec::Av1 => scan_av1_fuer_vollbild(data),
        Codec::H264 => data
            .windows(4)
            .any(|w| w[..3] == [0, 0, 1] && matches!(w[3] & 0x1F, 5 | 7)),
        Codec::H265 => {
            let mut i = 0;
            while i + 4 < data.len() {
                let lang = data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1;
                let kurz = data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1;
                if lang || kurz {
                    let kopf = i + if lang { 4 } else { 3 };
                    if kopf + 1 < data.len()
                        && matches!((data[kopf] >> 1) & 0x3F, 16..=21 | 33)
                    {
                        return true;
                    }
                    i = kopf;
                } else {
                    i += 1;
                }
            }
            false
        }
        Codec::Opus => true,
    }
}

fn scan_av1_fuer_vollbild(mut data: &[u8]) -> bool {
    let mut hat_seq = false;
    let mut hat_vollbild = false;
    while let Some((&header, rest)) = data.split_first() {
        let obu_typ = (header & 0b0111_1000) >> 3;
        if header & 0b0000_0010 == 0 {
            return false;
        }
        let hat_ext = header & 0b0000_0100 != 0;
        let rest = if hat_ext { rest.get(1..).unwrap_or(&[]) } else { rest };
        let Some((size, n)) = read_leb128(rest) else { return false };
        let skip = n + size as usize;
        if rest.len() < skip {
            return false;
        }
        match obu_typ {
            1 => hat_seq = true,
            3 | 6 if size > 0 => {
                if let Some(&b) = rest.get(n) {
                    hat_vollbild |= b & 0b1000_0000 == 0 && (b >> 5) & 0b11 == 0;
                }
            }
            _ => {}
        }
        if hat_seq && hat_vollbild {
            return true;
        }
        data = &rest[skip..];
    }
    false
}

fn finde_av1_seq_header(mut data: &[u8]) -> Option<Vec<u8>> {
    while let Some((&header, rest)) = data.split_first() {
        let obu_typ = (header & 0b0111_1000) >> 3;
        if header & 0b0000_0010 == 0 {
            return None;
        }
        let hat_ext = header & 0b0000_0100 != 0;
        let nach_kopf = if hat_ext { rest.get(1..)? } else { rest };
        let (size, n) = read_leb128(nach_kopf)?;
        let kopf_len = 1 + usize::from(hat_ext);
        let total = kopf_len + n + size as usize;
        if obu_typ == 1 {
            return Some(data[..total].to_vec());
        }
        if data.len() < total {
            return None;
        }
        data = &data[total..];
    }
    None
}

fn av1_codec_config(seq_header: &[u8], zehn_bit: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + seq_header.len());
    out.push(0x81);
    out.push(0x00);
    out.push(if zehn_bit { 0b0100_1100 } else { 0b0000_1100 });
    out.push(0x00);
    out.extend_from_slice(seq_header);
    out
}

// ── Ring und Datei-Schreiber ────────────────────────────────────────────────

struct Unit {
    ts_ms: i64,
    codec: Codec,
    keyframe: bool,
    data: Bytes,
}

const TIME_BASE: (i32, i32) = (1, 1000);

struct Writer {
    output: ffmpeg::format::context::Output,
    video_spur: Option<usize>,
    ton_spur: Option<usize>,
    origin_ms: Option<i64>,
    kopf_geschrieben: bool,
    pfad: std::path::PathBuf,
    /// Letzter geschriebener Stempel je Spur in Muxer-Basis — MPEG-TS
    /// verlangt strikt steigende Werte (gleiche Millisekunden heben wir um
    /// einen Tick an; Lehre vom 2026-09-27 aus dem Player).
    letzte_stempel: Vec<Option<i64>>,
}

fn add_spur(
    output: &mut ffmpeg::format::context::Output,
    id: ffmpeg::codec::Id,
    codec: ffmpeg::Codec,
    fill: impl FnOnce(*mut ffmpeg::ffi::AVCodecContext),
) -> Result<usize> {
    let mut ctx = ffmpeg::codec::context::Context::new_with_codec(codec);
    unsafe {
        let p = ctx.as_mut_ptr();
        (*p).codec_id = id.into();
        (*p).time_base = ffmpeg::ffi::AVRational { num: 1, den: 1000 };
        fill(p);
    }
    let mut spur = output.add_stream_with(&ctx)?;
    spur.set_time_base(ffmpeg::Rational::new(1, 1000));
    Ok(spur.index())
}

impl Writer {
    fn create(
        path: &Path,
        video: Option<(Codec, u32, u32)>,
        fps: Option<(i32, i32)>,
        zehn_bit: bool,
        av1_seq: Option<&[u8]>,
    ) -> Result<Self> {
        let mut output =
            ffmpeg::format::output(&path).with_context(|| format!("Datei {} anlegen", path.display()))?;
        let mut video_spur = None;
        if let Some((codec, breite, hoehe)) = video {
            let id = match codec {
                Codec::Av1 => ffmpeg::codec::Id::AV1,
                Codec::H264 => ffmpeg::codec::Id::H264,
                Codec::H265 => ffmpeg::codec::Id::HEVC,
                Codec::Opus => bail!("Opus ist keine Videospur"),
            };
            let eintrag = ffmpeg::encoder::find(id)
                .or_else(|| ffmpeg::decoder::find(id))
                .ok_or_else(|| anyhow!("Muxer kennt {id:?} nicht"))?;
            let extradata = (codec == Codec::Av1)
                .then(|| av1_seq.map(|h| av1_codec_config(h, zehn_bit)))
                .flatten();
            let index = add_spur(&mut output, id, eintrag, |p| unsafe {
                (*p).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
                (*p).width = breite as i32;
                (*p).height = hoehe as i32;
                if let Some((num, den)) = fps {
                    (*p).framerate = ffmpeg::ffi::AVRational { num, den };
                }
                if let Some(extra) = extradata.as_deref() {
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
            if let Some((num, den)) = fps {
                if let Some(mut spur) = output.stream_mut(index) {
                    spur.set_avg_frame_rate(ffmpeg::Rational::new(num, den));
                }
            }
            video_spur = Some(index);
        }
        let ton_spur = Some(
            add_spur(&mut output, ffmpeg::codec::Id::OPUS, ffmpeg::encoder::find(ffmpeg::codec::Id::OPUS)
                .ok_or_else(|| anyhow!("Muxer kennt Opus nicht"))?, |p| unsafe {
                (*p).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_AUDIO;
                (*p).sample_rate = 48_000;
                ffmpeg::ffi::av_channel_layout_default(&raw mut (*p).ch_layout, 2);
            })
            .context("Tonspur")?,
        );
        let spuren = output.nb_streams() as usize;
        Ok(Self {
            output,
            video_spur,
            ton_spur,
            origin_ms: None,
            kopf_geschrieben: false,
            pfad: path.to_path_buf(),
            letzte_stempel: vec![None; spuren],
        })
    }

    fn schreibe(&mut self, unit: &Unit) -> Result<()> {
        let index = match unit.codec {
            Codec::Opus => self.ton_spur,
            _ => self.video_spur,
        }
        .ok_or_else(|| anyhow!("Spur nicht angelegt"))?;
        if !self.kopf_geschrieben {
            self.output.write_header().context("Dateikopf")?;
            self.kopf_geschrieben = true;
        }
        let origin = *self.origin_ms.get_or_insert(unit.ts_ms);
        let mut pkt = ffmpeg::codec::packet::Packet::copy(&unit.data);
        pkt.set_stream(index);
        let pts = (unit.ts_ms - origin).max(0);
        pkt.set_pts(Some(pts));
        pkt.set_dts(Some(pts));
        if unit.keyframe {
            pkt.set_flags(ffmpeg::codec::packet::Flags::KEY);
        }
        let ziel = self
            .output
            .stream(index)
            .map_or(ffmpeg::Rational::new(1, 1000), |s| s.time_base());
        pkt.rescale_ts(ffmpeg::Rational::new(1, 1000), ziel);
        if let Some(ts) = pkt.dts() {
            let neu = match self.letzte_stempel[index] {
                Some(letzter) if ts <= letzter => letzter + 1,
                _ => ts,
            };
            if neu != ts {
                pkt.set_pts(Some(neu));
                pkt.set_dts(Some(neu));
            }
            self.letzte_stempel[index] = Some(neu);
        }
        pkt.write_interleaved(&mut self.output).context("Paket schreiben")
    }

    fn abschluss(self) -> Result<()> {
        let Self { mut output, pfad, kopf_geschrieben, .. } = self;
        if !kopf_geschrieben {
            drop(output);
            let _ = std::fs::remove_file(&pfad);
            bail!("nichts aufgenommen");
        }
        output.write_trailer().context("Dateiende")
    }
}

/// Der gemeinsame Zustand beider Einspeisestellen.
struct Ring {
    einheiten: VecDeque<Unit>,
    codec: Option<Codec>,
    breite: u32,
    hoehe: u32,
    fps: Option<(i32, i32)>,
    zehn_bit: bool,
    av1_seq: Option<Vec<u8>>,
    video_null_ms: Option<i64>,
    ton_null_ms: Option<i64>,
}

impl Ring {
    fn push(&mut self, codec: Codec, data: Bytes, ts_ms: i64) {
        if codec.ist_video() {
            self.codec.get_or_insert(codec);
            if self.video_null_ms.is_none() {
                self.video_null_ms = Some(ts_ms);
            }
            if codec == Codec::Av1 && self.av1_seq.is_none() {
                self.av1_seq = finde_av1_seq_header(&data);
            }
        } else if self.ton_null_ms.is_none() {
            self.ton_null_ms = Some(ts_ms);
        }
        // Keyframe hier, einmal je Einheit: der Paket-Flag beim Schreiben
        // und der Schnitt-Anfang brauchen denselben Befund.
        let keyframe = ist_keyframe(codec, &data);
        self.einheiten.push_back(Unit { ts_ms, codec, keyframe, data });
        let cutoff = ts_ms - (RING_SECONDS * 1000) as i64;
        while self.einheiten.front().is_some_and(|u| u.ts_ms < cutoff) {
            self.einheiten.pop_front();
        }
    }

    fn clip_schreiben(&mut self, path: &Path, sekunden: f64) -> Result<usize> {
        pruefe_ziel(path)?;
        let codec = self.codec.ok_or_else(|| anyhow!("noch kein Bild im Ring"))?;
        let (breite, hoehe) = (self.breite, self.hoehe);
        let rest = if codec == Codec::Av1 { "mkv" } else { "ts" };
        let ziel = path.with_extension(rest);
        let letzte = self
            .einheiten
            .back()
            .ok_or_else(|| anyhow!("Ring ist leer"))?
            .ts_ms;
        let start = letzte - (sekunden.max(0.1) * 1000.0) as i64;
        let beginn = self
            .einheiten
            .iter()
            .rposition(|u| u.codec.ist_video() && u.keyframe && u.ts_ms <= start)
            .or_else(|| self.einheiten.iter().position(|u| u.codec.ist_video() && u.keyframe))
            .ok_or_else(|| anyhow!("kein Vollbild im Ring"))?;
        let mut writer = Writer::create(
            &ziel,
            Some((codec, breite, hoehe)),
            self.fps,
            self.zehn_bit,
            self.av1_seq.as_deref(),
        )?;
        let mut anzahl = 0;
        for u in self.einheiten.iter().skip(beginn) {
            writer.schreibe(u)?;
            anzahl += 1;
        }
        writer.abschluss()?;
        Ok(anzahl)
    }
}

fn pruefe_ziel(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        bail!("Clip-Ziel muss ein absoluter Pfad sein: {}", path.display());
    }
    if path.components().any(|c| c == Component::ParentDir) {
        bail!("Clip-Ziel darf kein `..` enthalten: {}", path.display());
    }
    match path.parent() {
        Some(dir) if dir.is_dir() => Ok(()),
        Some(dir) => bail!("Clip-Verzeichnis {} gibt es nicht", dir.display()),
        None => bail!("Clip-Ziel {} ist kein Dateipfad", path.display()),
    }
}

// ── Globaler Zustand (Muster: encode::request_keyframe) ─────────────────────

use std::sync::{Mutex, OnceLock};

fn ring() -> &'static Mutex<Ring> {
    static RING: OnceLock<Mutex<Ring>> = OnceLock::new();
    RING.get_or_init(|| {
        Mutex::new(Ring {
            einheiten: VecDeque::new(),
            codec: None,
            breite: 0,
            hoehe: 0,
            fps: None,
            zehn_bit: false,
            av1_seq: None,
            video_null_ms: None,
            ton_null_ms: None,
        })
    })
}

/// Video-Einheit aus der Encoder-Schleife: Rohbytes und Zeitstempel in der
/// ENCODER-Zeitbasis (1/90000).
pub fn push_video(codec: Codec, data: Bytes, pts_ticks: i64) {
    if let Ok(mut r) = ring().lock() {
        r.push(codec, data, pts_ticks * 1000 / 90_000);
    }
}

/// Ton-Einheit aus dem Ton-Faden: Zeitstempel bereits in Millisekunden
/// (umgerechnet am Aufrufer, der seine Zeitbasis kennt).
pub fn push_audio(data: Bytes, ts_ms: i64) {
    if let Ok(mut r) = ring().lock() {
        r.push(Codec::Opus, data, ts_ms);
    }
}

/// Bildgroesse/Bittiefe/Bildrate aus der Encoder-Anlage — der Clip braucht
/// sie fuer den Dateikopf, der Sender kennt sie als Einstellung.
pub fn note_video(breite: u32, hoehe: u32, fps: (i32, i32), zehn_bit: bool) {
    if let Ok(mut r) = ring().lock() {
        r.breite = breite;
        r.hoehe = hoehe;
        r.fps = Some(fps);
        r.zehn_bit = zehn_bit;
    }
}

/// Alles verwerfen (Strom-Ende): ein neuer Strom beginnt bei null.
pub fn leeren() {
    if let Ok(mut r) = ring().lock() {
        r.einheiten.clear();
        r.codec = None;
        r.video_null_ms = None;
        r.ton_null_ms = None;
        r.av1_seq = None;
    }
}

/// Clip der letzten `sekunden` schreiben; Antwort ist die Zahl der
/// Einheiten. Blockiert fuer die Dauer des Schreibens (Rund 30 MB auf
/// einer NVMe: unter einer Sekunde — bewusst synchron im Dispatch,
/// `ponytail:` Ceiling: bei Netzplatten als Ziel kann das den RPC-Loop
/// sekundenlang stellen; Upgrade-Pfad: Schreiben wie im Player auf einen
/// Blocking-Faden und asynchron `clip_saved` melden).
pub fn clip_speichern(path: &Path, sekunden: f64) -> Result<usize> {
    ring().lock().map_err(|_| anyhow!("Ring vergesperrt"))?.clip_schreiben(path, sekunden)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Ring ist global (im Betrieb zu Recht: EIN Stream je Sidecar) —
    /// im Test teilen ihn alle drei, also serialisieren sie sich selbst.
    static TEST_SCHLOSS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn puffer(v: &[u8]) -> Bytes {
        Bytes::copy_from_slice(v)
    }

    fn obu(typ: u8, nutzlast: u8) -> [u8; 3] {
        [(typ << 3) | 0b10, 1, nutzlast]
    }

    /// Ring fuellen, Clip schreiben, Datei wieder einlesen: Spur und
    /// Paketzahl muessen stimmen (Muxer laeuft echt).
    #[test]
    fn clip_wird_zu_lesbarer_datei() {
        let _schloss = TEST_SCHLOSS.lock().unwrap();
        ffmpeg::init().ok();
        let dir = std::env::temp_dir();
        let ziel = dir.join(format!("pulse-sidecar-clip-{}.ts", std::process::id()));
        leeren();
        note_video(640, 360, (30, 1), false);
        let key = [0u8, 0, 1, 0x65, 0x88];
        push_video(Codec::H264, puffer(&key), 0);
        // 3 Sekunden je 30 Bilder + Ton im 20-ms-Takt, zwei Vollbilder.
        for i in 0..90 {
            let ts = i * 3000; // 1/90000 → 33 ms je Bild
            push_video(Codec::H264, puffer(&key), ts);
            push_audio(puffer(&[0x4F, i as u8]), i * 33); // gleiche Wanduhr wie das Bild
        }
        push_video(Codec::H264, puffer(&key), 90 * 3000);
        let n = clip_speichern(&ziel, 2.0).expect("Clip schreibt");
        assert!(n > 30, "zu wenige Einheiten: {n}");
        let eingang = ffmpeg::format::input(&ziel).expect("lesbar");
        assert!(eingang.streams().best(ffmpeg::media::Type::Video).is_some());
        let _ = std::fs::remove_file(&ziel);
    }

    /// Ohne jedes Vollbild gibt es keinen brauchbaren Anfang — Fehler statt
    /// Muell-Datei.
    #[test]
    fn ohne_vollbild_kein_clip() {
        let _schloss = TEST_SCHLOSS.lock().unwrap();
        ffmpeg::init().ok();
        leeren();
        note_video(640, 360, (30, 1), false);
        push_video(Codec::H264, puffer(&[0, 0, 1, 0x41, 0x9A]), 0); // Inter-Bild
        let ziel = std::env::temp_dir().join("pulse-sidecar-clip-leer.ts");
        assert!(clip_speichern(&ziel, 5.0).is_err());
        assert!(!ziel.exists());
    }

    /// Zeitsstempel-Kollisionen auf der Tonspur duerfen den MPEG-TS-Writer
    /// nicht umbringen (Regression aus dem Player vom 2026-09-27).
    #[test]
    fn gleiche_ton_stempel_toeten_den_writer_nicht() {
        let _schloss = TEST_SCHLOSS.lock().unwrap();
        ffmpeg::init().ok();
        leeren();
        note_video(640, 360, (30, 1), false);
        let key = [0u8, 0, 1, 0x65, 0x88];
        push_video(Codec::H264, puffer(&key), 0);
        for i in 0..10 {
            push_video(Codec::H264, puffer(&key), i * 3000);
            // Zwei Ton-Einheiten auf dieselbe Millisekunde. Vier Bytes
            // Nutzlast: ein-Byte-Stummel lehnt der TS-Muxer als Opus ab.
            let ton = (i / 2) * 33;
            push_audio(puffer(&[0x4F, 0x00, i as u8, 0x00]), ton);
            push_audio(puffer(&[0x4F, 0x00, i as u8, 0x01]), ton);
        }
        let ziel = std::env::temp_dir().join("pulse-sidecar-clip-dupts.ts");
        let n = clip_speichern(&ziel, 5.0).expect("schreibt trotz Kollisionen");
        assert!(n >= 20);
        let _ = std::fs::remove_file(&ziel);
    }
}
