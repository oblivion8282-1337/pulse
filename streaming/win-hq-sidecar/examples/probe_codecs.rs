//! Diagnose: welche Codecs meldet die echte Open-Probe für den primären Adapter?
//!
//! Verifiziert den Fix für die frühere Hardcode-Tabelle (`dxgi.rs`), die AV1 für
//! JEDE NVIDIA-Karte gemeldet hat — Turing (RTX 20) kann aber kein AV1-NVENC.
//! Auf einer Turing-Karte (z. B. 2080 Super) muss hier AV1 fehlen; auf Ada
//! (RTX 40/50) muss es drinstehen.
//!
//! `cargo run --release --example probe_codecs`
//!
//! Ruft denselben Pfad auf wie die `gpu_info`/`health`-Ops. Stdern zeigt die
//! `[codec-probe]`-Zeilen (pro Codec, ob der Open gelang).

use pulse_win_hq_sidecar::system::{codec_probe, dxgi};

fn main() {
    let adapters = dxgi::list_adapters().expect("dxgi::list_adapters");
    println!("=== DXGI-Adapter ===");
    for (i, a) in adapters.iter().enumerate() {
        println!(
            "  [{i}] {} (vendor={}, 0x{:04X}:0x{:04X}, {} MiB)",
            a.description,
            a.vendor(),
            a.vendor_id,
            a.device_id,
            a.vram_mb
        );
    }

    let Some(primary) = adapters.first() else {
        eprintln!("kein Adapter gefunden");
        return;
    };
    println!(
        "\n=== Codec-Probe für primären Adapter ({}) ===",
        primary.description
    );
    let codecs = codec_probe::supported_video_codecs(primary);
    println!("video_codecs = {:?}", codecs);
    println!(
        "AV1 gemeldet: {}",
        codecs.iter().any(|c| c.eq_ignore_ascii_case("av1"))
    );
}
