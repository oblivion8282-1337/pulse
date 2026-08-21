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
//! **AMD + Intel: die D3D12-Fähigkeitsabfrage** (`super::encode_caps`), seit dem
//! 2026-08-21. Davor stand hier ein Hardcode `[h264, hevc, av1]`, und der war für
//! AMD falsch: AV1 kodiert dort erst RDNA 3. Eine Radeon RX 570 (Polaris) bekam
//! AV1 angeboten, konnte es nicht, und der Start endete in einer Meldung über
//! Sendewege statt über Codecs — der ganze Vorgang steht im Kopf von
//! `encode_caps`.
//!
//! **Der Hardcode war selbst schon ein Rückbau**, und diese Begründung bleibt
//! stehen, damit niemand im Kreis läuft: die Open-Probe unten lieferte auf
//! AMD/Intel False Negatives für HEVC und AV1 (`*_amf`/`*_qsv` öffnen
//! zuverlässig nur für H.264, die HEVC/AV1-Opens sind treiberseitig unzuverlässig
//! schon vorm Encode), Nutzer sahen daraufhin nur noch H.264. Die Abfrage in
//! `encode_caps` öffnet nichts und ist von genau diesem Problem nicht betroffen —
//! sie ist kein zweiter Anlauf derselben Idee.
//!
//! NVIDIA bleibt probe-gesteuert: dort ist die Probe an Hardware belegt
//! (Turing-AV1-False-Positive war NVIDIA-spezifisch), und ein Wechsel wäre eine
//! Änderung ohne Beschwerde dahinter.

use std::sync::OnceLock;

use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Rational, codec, format};

use crate::encode::VideoCodec;
use crate::system::dxgi::Adapter;

/// Ein Ergebnis pro Prozess (Sidecar = eine GPU / ein Vendor). Beide
/// Call-Sites (`health`, `gpu_info`) lesen den primären Adapter, darum kein
/// per-Adapter-Key nötig. Gilt für beide Wege — die NVENC-Probe wie die
/// D3D12-Abfrage; welcher gelaufen ist, entscheidet der Hersteller, und der
/// wechselt innerhalb eines Prozesses nicht.
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
        // AMD + Intel: Treiber fragen, nicht raten (Rationale s. Modul-Docstring
        // und `encode_caps`). HEVC taucht in der UI nicht auf (Frontend bietet nur
        // H.264 + AV1) und wird trotzdem mitgeführt — `health` meldet die Liste
        // roh weiter, und eine Liste, die weniger sagt als der Treiber weiß, ist
        // im Diagnose-Log irreführend.
        //
        // **Scheitert die Abfrage, fällt AV1 weg statt hinzuzukommen.** Die
        // Abfrage scheitert nur ohne D3D12-Video im Treiber, und ein Treiber ohne
        // D3D12-Video sitzt auf Hardware, die AV1 sicher nicht kodiert — das Nein
        // ist dort die wahrscheinlichere Antwort, nicht die vorsichtigere. Teuer
        // ist ein Irrtum in keine Richtung mehr: seit 2026-08-21 nimmt
        // `encode::bildencoder::baue_mit_rueckfall` einen AV1-Wunsch, den die
        // Karte nicht erfüllt, auf H.264 zurück, statt den Stream abzubrechen.
        "amd" | "intel" => PROBED
            .get_or_init(|| {
                super::encode_caps::kodierbare_codecs(adapter).unwrap_or_else(|e| {
                    eprintln!(
                        "[codec-probe] D3D12-Faehigkeitsabfrage fehlgeschlagen ({e:#}) → \
                         h264+hevc, kein AV1"
                    );
                    vec!["h264".to_string(), "hevc".to_string()]
                })
            })
            .clone(),
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
