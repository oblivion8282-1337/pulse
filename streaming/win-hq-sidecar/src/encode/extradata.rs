//! Parameter-Set-Extraktion aus einem Annex-B-Bitstream.
//!
//! Der native `h264_d3d12va`/`hevc_d3d12va`-Encoder liefert — anders als
//! NVENC/AMF — KEINE Encoder-`extradata` (FFmpegs CLI fügt dafür intern den
//! `extract_extradata`-BSF ein; den binden die ffmpeg-sys-Bindings hier aber
//! nicht). Ohne avcC/hvcC-Sequence-Header lehnt MediaMTX den FLV-Stream mit
//! „unable to parse H264 config" ab.
//!
//! Lösung: aus dem ersten Keyframe-Packet die Parameter-Set-NALs ziehen und
//! als `extradata` an die AVCodecContext hängen (s. `encoder_d3d12.rs`). Der
//! FLV-Muxer baut daraus via `ff_isom_write_avcc`/`hvcc` den Sequence-Header —
//! Annex-B-Input (Start-Codes) wird dabei akzeptiert und konvertiert.

use super::codec::VideoCodec;

/// Zieht die Parameter-Set-NALs (H.264: SPS+PPS · HEVC: VPS+SPS+PPS) aus einem
/// Annex-B-Bitstream und gibt sie start-code-präfixiert zurück — fertig als
/// `extradata`. `None`, wenn keine gefunden werden (oder Codec = AV1: dort sind
/// es OBUs, nicht NALs — über d3d12va in Phase 1 nicht unterstützt).
pub fn param_set_extradata(codec: VideoCodec, annexb: &[u8]) -> Option<Vec<u8>> {
    let wanted: &[u8] = match codec {
        VideoCodec::H264 => &[7, 8],       // SPS, PPS
        VideoCodec::Hevc => &[32, 33, 34], // VPS, SPS, PPS
        VideoCodec::Av1 => return None,
    };
    let mut out = Vec::new();
    for (start, end) in nal_payloads(annexb) {
        let nal = &annexb[start..end];
        let nal_type = match codec {
            VideoCodec::H264 => nal[0] & 0x1F,
            VideoCodec::Hevc => (nal[0] >> 1) & 0x3F,
            VideoCodec::Av1 => return None,
        };
        if wanted.contains(&nal_type) {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(nal);
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Zerlegt einen Annex-B-Stream in NAL-Payload-Ranges `(start, end)` — `start`
/// zeigt aufs erste Byte NACH dem Start-Code (= NAL-Header), `end` aufs Ende
/// der NAL-Nutzlast. Start-Code: `00 00 01` (3 B) oder `00 00 00 01` (4 B) —
/// gesucht wird das `00 00 01`-Muster, das führende Extra-`00` des 4-Byte-
/// Codes wird beim Vorgänger-NAL abgeschnitten.
fn nal_payloads(data: &[u8]) -> Vec<(usize, usize)> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (k, &start) in starts.iter().enumerate() {
        let mut end = if k + 1 < starts.len() {
            starts[k + 1] - 3
        } else {
            data.len()
        };
        // Trailing-Zeros des nächsten Start-Codes abschneiden. Annex-B erlaubt
        // VOR einem 4-Byte-Start-Code (`00 00 00 01`) beliebig viele Padding-
        // Nullen zusätzlich zum führenden Extra-`00` — eine einzelne Null zu
        // stripen reicht also nicht immer. SPS/PPS/VPS enden mit dem
        // rbsp_stop_one_bit, also nie auf 0x00 — die Schleife kann hier sicher
        // bis zum Nutzdaten-Ende durchlaufen. Nur vor einem folgenden Start-Code
        // (`k + 1 < starts.len()`) relevant — am Ende des Buffers sind
        // Trailing-Nullen echte Nutzdaten, keine Padding-Artefakte.
        if k + 1 < starts.len() {
            while end > start && data[end - 1] == 0 {
                end -= 1;
            }
        }
        if end > start {
            out.push((start, end));
        }
    }
    out
}
