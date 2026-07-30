//! Vendor-Encoder-Optionen — was welchem Encoder beim Oeffnen mitgegeben wird.
//!
//! Gegenstueck zu `streaming/linux-hq-sidecar/src/encode/opts.rs`, und der Ort,
//! an dem die AMD-Arbeit ansetzt (`async_depth`, `usage`). Herausgezogen aus
//! `encoder.rs`, das mit den Begruendungen ueber die harte Groessen-Grenze von
//! 500 Zeilen gewachsen war (`PLAN.md` §12.1).
//!
//! **Jeder Wert traegt seine Begruendung an sich selbst.** Wer eine Zahl aendert,
//! aendert den Kommentar mit oder misst neu — geerbte Zahlen ohne Herleitung
//! sind in diesem Projekt schon zweimal teuer geworden.

use ffmpeg_next as ffmpeg;
use ffmpeg::Dictionary;

use super::encoder::VideoCodec;
use super::output::apply_encoder_opts_override;

/// Vendor-spezifische Encoder-Optionen. Defaults sind „streaming-tauglich"
/// (Low-Latency, CBR) — pro Encoder mehr durchstimmen wenn die echten
/// Quality-Tradeoffs sichtbar sind.
///
/// `codec` wird für die eine Option gebraucht, die es nicht bei jedem Codec
/// desselben Vendors gibt (Begründung an der Stelle selbst). Jeder gesetzte
/// Schlüssel wird vor dem Open gegen die Optionstabelle des Encoders geprüft
/// (`output::warn_unknown_opts`) — ein Schlüssel, den der Encoder nicht kennt,
/// wird von ffmpeg still verworfen.
pub(crate) fn vendor_encoder_opts(vendor: &str, codec: VideoCodec) -> Dictionary<'static> {
    let mut opts = Dictionary::new();
    match vendor {
        "nvidia" => {
            // NVENC-Presets: p1 (fastest) … p7 (slowest+best). Für Live-Stream
            // ist Throughput wichtiger als Last-bit-Quality → `p2` ist der
            // sweet-spot, sehr schnell und kaum schlechter als p4 im Screen-
            // Content. `tune=ull` (ultra-low-latency) statt nur `ll` damit
            // B-Frames und VBV-Lookahead komplett aus sind.
            opts.set("preset", "p2");
            opts.set("tune", "ull");
            opts.set("rc", "cbr");
            opts.set("zerolatency", "1");
            opts.set("delay", "0");
        }
        "amd" => {
            opts.set("usage", "transcoding");
            opts.set("quality", "balanced");
            opts.set("rc", "cbr");
        }
        "intel" => {
            opts.set("preset", "medium");
            // Lookahead aus (Latenz). Die Option gibt es bei `h264_qsv` und
            // `hevc_qsv` — bei `av1_qsv` NICHT (2026-07-30 gegen die
            // Optionstabellen des mitgelieferten FFmpeg n8.1 geprüft). Bis dahin
            // stand sie unbedingt hier und wurde bei jedem AV1-QSV-Stream still
            // verworfen; folgenlos (der Default ist ohnehin `false`), aber es
            // war eine Anweisung ohne Wirkung — und sie hätte die neue
            // Unbekannt-Warnung bei jedem gesunden AV1-Stream feuern lassen.
            // Eine Warnung, die im gesunden Fall feuert, erzieht dazu,
            // Warnungen zu überlesen.
            if !matches!(codec, VideoCodec::Av1) {
                opts.set("look_ahead", "0");
            }
        }
        _ => {}
    }
    apply_encoder_opts_override(&mut opts);
    opts
}
