//! Video-Decode ueber FFmpeg, Hardware zuerst.
//!
//! Hintergrund (gemessen 2026-07-26 auf der Dev-Maschine): Chromium nutzt auf
//! Linux/NVIDIA **kein** NVDEC — weder fuer H.264 noch fuer AV1, auch nicht mit
//! den ueblichen VA-API-Flags. `nvidia-smi dmon` zeigte durchgehend 0 % im
//! `dec`-Zaehler bei ~46 % CPU-Last eines Kerns. Dieser Player waehlt den
//! Decoder deshalb **explizit** statt zu hoffen.
//!
//! Vorgehen: erst einen hardwaregestuetzten Decoder ueber seinen Namen suchen
//! (`av1_cuvid`, `h264_cuvid`, `*_qsv`, `*_vaapi`), sonst Software. Die
//! cuvid-Decoder liefern ihre Frames in den Hauptspeicher; der Decode selbst
//! laeuft auf der GPU. Das ist noch nicht zero-copy — ein direkter Weg von
//! NVDEC in eine Vulkan-Textur waere die naechste Ausbaustufe, verlangt aber
//! `hw_frames_ctx` samt Interop und ist bewusst nicht Teil des ersten Wurfs.
//!
//! LIZENZ: FFmpeg muss in ausgelieferten Builds LGPL-konfiguriert und dynamisch
//! gelinkt sein — siehe Cargo.toml und THIRD-PARTY-NOTICES.md.

use anyhow::{anyhow, bail, Context, Result};
use ffmpeg_next as ffmpeg;

use crate::whep::Codec;

/// Erkennt am Decoder-Namen, ob er auf der GPU laeuft.
fn is_hardware(name: &str) -> bool {
    ["cuvid", "qsv", "vaapi"].iter().any(|tag| name.contains(tag))
}

/// Kandidaten in Reihenfolge der Bevorzugung. Am Ende stehen immer die
/// Software-Decoder; der jeweils letzte ist der generische Name, weil die
/// bevorzugte Bibliothek (z. B. `libdav1d`) nicht in jedem Build steckt.
fn candidates(codec: Codec, allow_hw: bool) -> Vec<&'static str> {
    let (hw, sw): (&[&str], &[&str]) = match codec {
        Codec::Av1 => (&["av1_cuvid", "av1_qsv", "av1_vaapi"], &["libdav1d", "av1"]),
        Codec::H264 => (&["h264_cuvid", "h264_qsv", "h264_vaapi"], &["h264"]),
        Codec::Opus => (&[], &["libopus", "opus"]),
    };
    let mut out = Vec::new();
    if allow_hw {
        out.extend_from_slice(hw);
    }
    out.extend_from_slice(sw);
    out
}

/// Ein dekodiertes Bild in der Form, die der Renderer erwartet.
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub format: PixelLayout,
    /// Ebenen als eigene Puffer (Y, U, V bzw. Y, UV).
    pub planes: Vec<Vec<u8>>,
    pub strides: Vec<usize>,
    /// Zehn Bit pro Komponente statt acht.
    pub ten_bit: bool,
    /// Voller Wertebereich (`pc`) statt begrenztem (`tv`).
    pub full_range: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelLayout {
    /// Drei Ebenen: Y, U, V.
    Planar420,
    /// Zwei Ebenen: Y und verschraenktes UV.
    BiPlanar420,
}

pub struct VideoDecoder {
    decoder: ffmpeg::decoder::Video,
    /// Name des tatsaechlich gewaehlten Decoders (fuer Diagnose und Statistik).
    pub name: String,
    pub hardware: bool,
}

impl VideoDecoder {
    /// Legt einen Decoder an. `allow_hw = None` bedeutet automatisch.
    pub fn new(codec: Codec, allow_hw: Option<bool>) -> Result<Self> {
        ffmpeg::init().context("FFmpeg-Initialisierung")?;
        if !codec.is_video() {
            bail!("{} ist kein Video-Codec", codec.as_str());
        }
        let allow = allow_hw.unwrap_or(true);

        let mut last_err = None;
        for name in candidates(codec, allow) {
            match Self::try_open(name) {
                Ok(decoder) => {
                    let hardware = is_hardware(name);
                    eprintln!(
                        "pulse-player: Decoder {name} ({})",
                        if hardware { "Hardware" } else { "Software" }
                    );
                    return Ok(Self { decoder, name: name.to_string(), hardware });
                }
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("kein Decoder fuer {}", codec.as_str())))
    }

    fn try_open(name: &str) -> Result<ffmpeg::decoder::Video> {
        let codec = ffmpeg::decoder::find_by_name(name)
            .ok_or_else(|| anyhow!("Decoder {name} nicht vorhanden"))?;
        ffmpeg::codec::context::Context::new_with_codec(codec)
            .decoder()
            .video()
            .with_context(|| format!("Decoder {name} liess sich nicht oeffnen"))
    }

    /// Schiebt eine Zugriffseinheit hinein und holt alle fertigen Bilder ab.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<DecodedFrame>> {
        let packet = ffmpeg::codec::packet::Packet::copy(data);
        // Ein Fehler beim Einspeisen ist meist ein kaputter Frame nach einer
        // Luecke — das darf die Sitzung nicht beenden.
        if let Err(e) = self.decoder.send_packet(&packet) {
            eprintln!("pulse-player: send_packet: {e}");
            return Ok(Vec::new());
        }
        Ok(self.drain())
    }

    fn drain(&mut self) -> Vec<DecodedFrame> {
        let mut out = Vec::new();
        let mut frame = ffmpeg::util::frame::video::Video::empty();
        while self.decoder.receive_frame(&mut frame).is_ok() {
            if let Some(f) = convert(&frame) {
                out.push(f);
            }
        }
        out
    }
}

/// Uebersetzt ein FFmpeg-Bild in unsere schlanke Form. Nicht unterstuetzte
/// Pixelformate liefern `None`, statt still etwas Falsches zu zeigen.
fn convert(frame: &ffmpeg::util::frame::video::Video) -> Option<DecodedFrame> {
    use ffmpeg::format::Pixel;

    let (layout, ten_bit, planes_n) = match frame.format() {
        Pixel::YUV420P => (PixelLayout::Planar420, false, 3),
        Pixel::YUV420P10LE => (PixelLayout::Planar420, true, 3),
        Pixel::NV12 => (PixelLayout::BiPlanar420, false, 2),
        Pixel::P010LE => (PixelLayout::BiPlanar420, true, 2),
        other => {
            eprintln!("pulse-player: Pixelformat {other:?} wird nicht unterstuetzt");
            return None;
        }
    };

    let width = frame.width();
    let height = frame.height();
    let mut planes = Vec::with_capacity(planes_n);
    let mut strides = Vec::with_capacity(planes_n);
    for i in 0..planes_n {
        let stride = frame.stride(i);
        // Chroma-Ebenen sind bei 4:2:0 halb so hoch.
        let rows = if i == 0 { height } else { height.div_ceil(2) } as usize;
        let data = frame.data(i);
        let needed = stride * rows;
        if data.len() < needed {
            eprintln!("pulse-player: Ebene {i} zu kurz ({} < {needed})", data.len());
            return None;
        }
        planes.push(data[..needed].to_vec());
        strides.push(stride);
    }

    Some(DecodedFrame {
        width,
        height,
        format: layout,
        planes,
        strides,
        ten_bit,
        full_range: matches!(frame.color_range(), ffmpeg::color::Range::JPEG),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kandidaten_enden_immer_auf_software() {
        let av1 = candidates(Codec::Av1, true);
        assert!(av1.first().unwrap().contains("cuvid"), "Hardware zuerst: {av1:?}");
        assert!(av1.contains(&"libdav1d"), "Software-Rueckfall fehlt: {av1:?}");

        let h264 = candidates(Codec::H264, true);
        assert!(h264.contains(&"h264"), "Software-Rueckfall fehlt: {h264:?}");
    }

    #[test]
    fn ohne_hardware_nur_software() {
        let list = candidates(Codec::Av1, false);
        assert!(
            !list.iter().any(|n| n.contains("cuvid") || n.contains("vaapi")),
            "Hardware darf abschaltbar sein: {list:?}"
        );
    }

    /// Der Software-Weg muss auf jeder Maschine funktionieren — ohne den
    /// waere der Player auf fremder Hardware wertlos.
    #[test]
    fn software_decoder_laesst_sich_oeffnen() {
        let d = VideoDecoder::new(Codec::H264, Some(false));
        assert!(d.is_ok(), "H.264-Software-Decoder fehlt: {:?}", d.err());
        assert!(!d.unwrap().hardware);
    }
}
