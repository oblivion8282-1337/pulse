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
            // `usage` ist bei AMF kein Etikett, sondern ein Bündel: es stellt
            // Vorlauf, Voranalyse und Referenzstruktur auf einen Schlag ein.
            // `transcoding` heißt „Generic Transcoding" und ist das Bündel für
            // Offline-Umkodierung — es stand hier, seit der Zweig existiert,
            // ohne dass je gemessen wurde, was es kostet.
            //
            // Am 2026-07-30 auf einer Radeon 780M gemessen (1080p60, 4000 kbps,
            // Bildschirminhalt, Eingang auf Echtzeit gedrosselt; GPU-Wert =
            // mittlere Auslastung der Video-Engine über den Prozess):
            //
            //                                 GPU-Video    VMAF
            //   AV1  usage=transcoding          23,9 %     82,85
            //   AV1  usage=ultralowlatency       9,4 %     82,86
            //   H264 usage=transcoding          26,6 %     82,00
            //   H264 usage=ultralowlatency      10,3 %     81,60
            //
            // Im laufenden Sidecar bestätigt (`av1_amf`, 1440p→1080p60):
            // Video-Engine 22,1 % → 9,8 %.
            //
            // Bei AV1 — dem Codec, der über diesen Zweig läuft — kostet der
            // Wechsel also NICHTS an Bildqualität und senkt die Last der
            // Video-Engine auf gut ein Drittel. Auf einer iGPU, die sich die
            // Leistungsaufnahme mit der CPU teilt, ist das der größte Posten
            // überhaupt. Bei H.264 kostet er 0,4 VMAF; dieser Zweig ist für
            // H.264 aber ohnehin nur der Notausgang (`PULSE_HQ_DISABLE_ZERO_COPY`),
            // der Regelweg ist `h264_d3d12va`.
            opts.set("usage", "ultralowlatency");
            // Unter `ultralowlatency` ist `quality` wirkungslos — `balanced` und
            // `speed` lieferten byte-identische Bitströme (SHA-256 über 720
            // Bilder). Der Wert bleibt stehen, damit er greift, wenn jemand
            // `usage` über `PULSE_ENCODER_OPTS` zurückdreht.
            opts.set("quality", "balanced");
            opts.set("rc", "cbr");
            // AMFs Default ist **16** — bis zu 15 Bilder Vorlauf, und FFmpeg
            // schreibt die Latenzwirkung selbst in den Hilfetext.
            //
            // **Auf dieser Hardware ändert der Wert allerdings nichts**, und das
            // gehört dazugesagt, damit niemand ihn später für einen gemessenen
            // Gewinn hält: `av1_amf` lieferte im Sidecar bei `async_depth=1` wie
            // bei `16` dieselbe Encode-Latenz (17,2 ms, = ein Bildabstand) und
            // dieselbe Video-Engine-Last. Anders als auf dem d3d12va-Zweig, wo
            // jede Stufe messbar einen Bildabstand kostet
            // (s. `encoder_d3d12.rs::d3d12va_opts`), scheint AMF hier ohnehin
            // nur ein Bild zu halten.
            //
            // Der Wert bleibt trotzdem gesetzt: er kostet nachweislich nichts,
            // FFmpeg dokumentiert ihn als Latenzschraube, und auf einer anderen
            // AMD-Generation kann der Default 16 sehr wohl durchschlagen. Ein
            // Nachmessen dort ist billig — `PULSE_ENCODER_OPTS=async_depth=16`.
            opts.set("async_depth", "1");
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
