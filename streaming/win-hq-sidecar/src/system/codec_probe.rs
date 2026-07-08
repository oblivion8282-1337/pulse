//! NVIDIA-Codec-Capability-Probe: öffnet den NVENC-Encoder minimal und prüft,
//! ob der Open gelingt. Löst das Hardcode-Problem, das AV1 für JEDE NVIDIA-Karte
//! gemeldet hat — Turing (RTX 20) kann aber kein AV1-NVENC, erst Ada (RTX 40+).
//! Nur NVIDIA nutzt die Probe; AMD + Intel bleiben hartcodiert (siehe unten).
//!
//! Spiegelt das open+forget-Muster aus `examples/probe_d3d12_amf.rs`: Software-
//! NV12 ohne `hw_frames_ctx` — derselbe Input, den der CPU-Pfad
//! (`encode::encoder::FfmpegEncoder::create`) AMD/Intel zur Laufzeit füttert.
//!
//! **UAF-Sicherheit:** Droppen eines GEÖFFNETEN NVENC-Encoders triggert 0xC0000005
//! (treiber-interner Threadpool-Timer beim `nvEncodeAPI64.dll`-Unload). Darum
//! `mem::forget` auf `Ok(opened)` — der Sidecar ist ein Kurzzeitprozess, ExitProcess
//! räumt auf. Ein fehlgeschlagener Open hat nichts geöffnet; der Builder-Drop ist
//! sicher (kein NVENC-Teardown).
//!
//! **Vorwärtskompatibel:** die Probe fragt die Karte zur Laufzeit, keine Generations-
//! tabelle → RTX 5090 / Blackwell / jede künftige AV1-fähige Architektur wird ohne
//! Code-Änderung korrekt erkannt.
//!
//! **AMD + Intel: NICHT probe-gesteuert, sondern Hardcode `[h264, hevc, av1]`.** Die
//! AMF-/QSV-Open-Probe (Capability ≠ Stability — AMF/d3d12va und QSV liegen über
//! denselben HW-Encode-Engines) lieferte auf realer Hardware False Negative für HEVC
//! und AV1: `*_amf`/`*_qsv` öffnen zuverlässig nur für H.264, die HEVC/AV1-Opens sind
//! treiberseitig unzuverlässig schon vorm Encode. User sahen darum nur noch H.264,
//! obwohl die Runtime-Pfade beide Codecs encoden (AMD via d3d12va, Intel via QSV).
//! HEVC/AV1-Support ist generationsstabil (AMD Polaris+ HEVC / RDNA3+ AV1; Intel
//! Skylake+ HEVC / Arc+ AV1) → die Hardcode-Liste spiegelt, was die Encoder-Pfade
//! wirklich leisten. Restrisiko: ältere Intel-iGPUs ohne AV1-Engine sehen AV1 in der
//! UI — das Frontend bietet ohnehin nur H.264 + AV1 (HEVC nie), und der AV1→H.264-
//! Runtime-Fallback fängt es ab. NVIDIA bleibt probe-gesteuert (Turing-AV1-False-
//! Positive war NVIDIA-spezifisch).

use std::sync::OnceLock;

use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Rational, codec, format};

use crate::encode::VideoCodec;
use crate::system::dxgi::Adapter;

/// Ein Probe-Ergebnis pro Prozess (Sidecar = eine GPU / ein Vendor). Beide
/// Call-Sites (`health`, `gpu_info`) lesen den primären Adapter, darum kein
/// per-Adapter-Key nötig.
static PROBED: OnceLock<Vec<String>> = OnceLock::new();

/// Open-Dimension der Capability-Probe. NVENC lehnt unter 145×49 ab
/// (`InitializeEncoder: dimensions less than the minimum supported value`) →
/// kleinere Werte geben False Negative auf jeder NVIDIA-Karte (auch Ada, das
/// HEVC+AV1 kann). 256 ist mod-8 (HEVC/AV1-Alignment) und sicher über die
/// NVENC-Minima. Der Open allokiert keine Frames → die Größe ist gratis.
const PROBE_DIM: u32 = 256;

/// Codecs die diese GPU wirklich hardware-seitig encoden kann. Unbekannter
/// Vendor → leer. Jeder Probe-Misserfolg liefert mindestens `["h264"]` (sichere
/// Baseline) — der User bekommt immer einen funktionierenden Default, und die
/// AV1-Option verschwindet aus dem UI.
pub fn supported_video_codecs(adapter: &Adapter) -> Vec<String> {
    let vendor = adapter.vendor();
    match vendor {
        // NVIDIA: echte Open-Probe (selbstkorrigierend, vorwärtskompatibel) — der
        // Turing-AV1-False-Positive (RTX 20 meldet AV1, kann's aber nicht) war
        // NVIDIA-spezifisch, darum bleibt NVIDIA als einziger Vendor auf der Probe.
        "nvidia" => PROBED
            .get_or_init(|| {
                probe_inner(vendor).unwrap_or_else(|e| {
                    eprintln!("[codec-probe] Probing fehlgeschlagen ({e:#}) → nur h264");
                    vec!["h264".to_string()]
                })
            })
            .clone(),
        // AMD + Intel: Hardcode wie vor der Probe-Einführung (Rationale s. Modul-
        // Docstring). HEVC taucht in der UI nicht auf (Frontend bietet nur H.264 +
        // AV1); die AV1→H.264-Runtime-Fallback fängt ältere Intel-iGPUs ohne AV1 ab.
        "amd" | "intel" => vec![
            "h264".to_string(),
            "hevc".to_string(),
            "av1".to_string(),
        ],
        _ => Vec::new(),
    }
}

fn probe_inner(vendor: &str) -> anyhow::Result<Vec<String>> {
    ffmpeg::init()?;
    // H.264 ist NVENC-Baseline auf jeder NVIDIA-Karte (Kepler+) → nicht probeben,
    // spart eine geleckte NVENC-Session.
    let mut codecs = vec!["h264".to_string()];
    for (codec, label) in [(VideoCodec::Hevc, "hevc"), (VideoCodec::Av1, "av1")] {
        if try_open(vendor, codec)? {
            codecs.push(label.to_string());
        } else {
            eprintln!("[codec-probe] {label} auf {vendor} nicht verfügbar");
        }
    }
    Ok(codecs)
}

/// Öffnet `<vendor>_<codec>` minimal (quadratisch `PROBE_DIM`, NV12, leere
/// Options). `Ok(true)` = Encoder öffnet → Codec hardware-seitig unterstützt;
/// der geöffnete Encoder wird ge-forget-t (s. Modul-Docstring). `Ok(false)` =
/// Encoder fehlt im gelinkten FFmpeg oder öffnet nicht → Codec nicht unterstützen.
fn try_open(vendor: &str, codec: VideoCodec) -> anyhow::Result<bool> {
    let name = codec.ffmpeg_name(vendor)?;
    let Some(desc) = codec::encoder::find_by_name(name) else {
        eprintln!("[codec-probe] Encoder '{name}' nicht im gelinkten FFmpeg");
        return Ok(false);
    };
    let mut encoder = codec::context::Context::new_with_codec(desc)
        .encoder()
        .video()?;
    encoder.set_width(PROBE_DIM);
    encoder.set_height(PROBE_DIM);
    encoder.set_format(format::Pixel::NV12);
    encoder.set_time_base(Rational::new(1, 30));
    encoder.set_frame_rate(Some(Rational::new(30, 1)));
    encoder.set_bit_rate(500_000);
    encoder.set_max_bit_rate(500_000);
    encoder.set_gop(60);
    match encoder.open_with(Dictionary::new()) {
        Ok(opened) => {
            // KEIN Drop — der öffnet sonst den NVENC-Teardown-Pfad (UAF).
            std::mem::forget(opened);
            Ok(true)
        }
        Err(e) => {
            eprintln!("[codec-probe] open '{name}' fehlgeschlagen: {e}");
            Ok(false)
        }
    }
}
