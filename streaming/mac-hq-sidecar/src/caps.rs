//! Encoder capability probe — which video codecs THIS machine can actually
//! hardware-encode via VideoToolbox in the linked FFmpeg.
//!
//! Drives the `health` report, off which the renderer filters its codec picker
//! so it only ever offers what the hardware supports. The point is to gate by
//! *capability*, never by model name: Apple-Silicon always has h264 + hevc; AV1
//! lights up only when both (a) the linked FFmpeg ships an `av1_videotoolbox`
//! encoder and (b) a real VideoToolbox session opens for it on this silicon
//! (M3+). FFmpeg 8.0.1 has no `av1_videotoolbox`, so AV1 is hidden today —
//! correctly, because we genuinely cannot encode it, not because "it's a Mac".
//! An M3/M4 + an FFmpeg that adds the encoder will surface AV1 automatically,
//! no code change.
//!
//! This mirrors the cross-platform intent (Linux GSR / Windows sidecar gate the
//! same way against the actual GPU's NVENC/VA-API/AMF codec set).

use std::sync::OnceLock;

use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Rational, codec, format};

/// VideoToolbox encoder name for a Pulse codec id, if we have a mapping.
pub fn vt_encoder_name(codec_id: &str) -> Option<&'static str> {
    match codec_id {
        "h264" => Some("h264_videotoolbox"),
        "hevc" | "h265" => Some("hevc_videotoolbox"),
        "av1" => Some("av1_videotoolbox"),
        _ => None,
    }
}

/// Open a throwaway VideoToolbox session to confirm the hardware really encodes
/// this codec (not just that the encoder is compiled into FFmpeg). Opening an
/// `av1_videotoolbox` session fails on pre-M3 silicon, which is exactly the gate
/// we want.
fn opens_on_hardware(name: &str) -> bool {
    let Some(codec) = codec::encoder::find_by_name(name) else {
        return false;
    };
    (|| -> Option<()> {
        let mut enc = codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .ok()?;
        enc.set_width(320);
        enc.set_height(240);
        enc.set_format(format::Pixel::NV12);
        enc.set_time_base(Rational::new(1, 30));
        enc.open_with(Dictionary::new()).ok()?;
        Some(())
    })()
    .is_some()
}

/// Is this codec id hardware-encodable on this machine?
fn can_encode(codec_id: &str) -> bool {
    let Some(name) = vt_encoder_name(codec_id) else {
        return false;
    };
    match codec_id {
        // h264/hevc are the Apple-Silicon (and Intel-T2) baseline — present on
        // every Mac we target. find_by_name is enough; skip the session probe so
        // a transient open failure can never hide the baseline (which would drop
        // every profile and ungate nothing).
        "h264" | "hevc" | "h265" => codec::encoder::find_by_name(name).is_some(),
        // AV1 (and anything else) must prove it on real hardware.
        _ => opens_on_hardware(name),
    }
}

/// Hardware-encodable video codecs on this machine, in preference order.
/// Cached — the AV1 probe opens a VideoToolbox session, so we do it once.
pub fn available_video_codecs() -> &'static [&'static str] {
    static CACHE: OnceLock<Vec<&'static str>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let _ = ffmpeg::init();
        ["h264", "hevc", "av1"]
            .into_iter()
            .filter(|c| can_encode(c))
            .collect()
    })
}

/// Does this machine support the given Pulse codec id (h264/hevc/av1)?
pub fn supports_codec(codec_id: &str) -> bool {
    let want = if codec_id == "h265" { "hevc" } else { codec_id };
    available_video_codecs().contains(&want)
}
