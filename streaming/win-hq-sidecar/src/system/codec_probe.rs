//! Echte Codec-Capability-Probe: öffnet je Vendor-Encoder minimal und prüft,
//! ob der Open gelingt. Ersetzt die frühere Hardcode-Tabelle in `dxgi.rs`, die
//! AV1 für JEDE NVIDIA-Karte gemeldet hat — Turing (RTX 20) kann aber kein
//! AV1-NVENC, erst Ada (RTX 40+) kann es.
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
//! **AMD: Probe via AMF, nicht d3d12va (Capability ≠ Stability).** Der AMD-Runtime-
//! Pfad nutzt den nativen `*_d3d12va`-Encoder — AMF crasht beim *Encoden*
//! (`SubmitInput`, Issue #455), darum umgeht d3d12va die AMF-Runtime. Die Probe
//! testet trotzdem `*_amf`, weil AMF und d3d12va **über denselben HW-Encode-Engines
//! liegen** und die Frage der Probe ist „hat die GPU den Engine für Codec X?"
//! (Capability), nicht „welches API crasht nicht?" (Stability). AMF-Open reflektiert
//! die HW-Capability (treiberseitige Engine-Enumeration) genauso wie NVENC: `av1_amf`
//! öffnet nur auf RDNA3+, `av1_nvenc` nur auf Ada+. Der d3d12va-Encoder braucht für
//! einen Open zwingend D3D12-Device + `hw_frames_ctx` (s. `encoder_d3d12.rs`) und
//! lässt sich nicht wie hier minimal proben. Restrisiko: bricht die AMF-Runtime schon
//! beim Open (schwerer Treiberdefekt), fällt die Probe konservativ auf `["h264"]`.

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
/// NVENC/AMF/QSV-Minima. Der Open allokiert keine Frames → die Größe ist gratis.
const PROBE_DIM: u32 = 256;

/// Codecs die diese GPU wirklich hardware-seitig encoden kann. Unbekannter
/// Vendor → leer. Jeder Probe-Misserfolg liefert mindestens `["h264"]` (sichere
/// Baseline) — der User bekommt immer einen funktionierenden Default, und die
/// AV1-Option verschwindet aus dem UI.
pub fn supported_video_codecs(adapter: &Adapter) -> Vec<String> {
    let vendor = adapter.vendor();
    if vendor == "other" {
        return Vec::new();
    }
    PROBED
        .get_or_init(|| {
            probe_inner(vendor).unwrap_or_else(|e| {
                eprintln!("[codec-probe] Probing fehlgeschlagen ({e:#}) → nur h264");
                vec!["h264".to_string()]
            })
        })
        .clone()
}

fn probe_inner(vendor: &str) -> anyhow::Result<Vec<String>> {
    ffmpeg::init()?;
    // H.264 ist NVENC/AMF/QSV-Baseline bei jedem erkannten Vendor (Kepler+/GCN+/
    // Intel-HD) → nicht probeben, spart eine geleckte NVENC-Session.
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
