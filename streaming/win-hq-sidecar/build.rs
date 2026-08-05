//! Kopiert die FFmpeg-DLLs aus `$FFMPEG_DIR/bin/` neben die gebaute `.exe`,
//! damit `cargo run` ohne PATH-Augmentation funktioniert.
//!
//! Windows-DLL-Suche schaut zuerst neben der `.exe` — wir legen sie also dort
//! ab. Quelle: `ffmpeg-dist/n8.1-lgpl-shared/bin/*.dll` (selbst gebaut, s.
//! `scripts/build-ffmpeg-patched.ps1`).
//!
//! **Das `cargo:rerun-if-changed` je Quell-DLL unten reicht als Auslöser nicht
//! verlässlich**, wenn das ganze Zielverzeichnis ausgetauscht wird — deshalb
//! stupst `build-ffmpeg-patched.ps1` diese Datei zusätzlich an. Beide
//! Mechanismen sind Absicht; wer einen davon entfernt, riskiert den Zustand,
//! der schon einmal eine halbe Stunde gekostet hat: `ffmpeg.exe -h` zeigt das
//! neue FFmpeg, das Programm läuft mit den alten DLLs daneben.
//!
//! Die OUT_DIR→target-Walk-Up-Heuristik ist die Standard-Methode in der
//! Rust-Welt (siehe z.B. `windows-targets`-Crate). Cargo selber hat keinen
//! Hook für "kopier was nach target/{profile}/", aber OUT_DIR ist
//! `target/{profile}/build/{crate}-{hash}/out/` → vier `.parent()`-Calls
//! treffen `target/{profile}/`. Wenn Cargo seine Layout-Konventionen
//! ändert, fällt das hier auf und wir kriegen ein `cargo:warning=`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // Nur auf Windows + nur wenn FFMPEG_DIR gesetzt ist (= ffmpeg-next-Build-Pfad).
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let ffmpeg_dir = match env::var("FFMPEG_DIR") {
        Ok(v) if !v.is_empty() => v,
        _ => {
            println!(
                "cargo:warning=FFMPEG_DIR not set; skipping DLL copy. \
                 Run `scripts/fetch-ffmpeg.ps1` first."
            );
            return;
        }
    };

    // FFMPEG_DIR ist relativ zum Workspace-Root (siehe .cargo/config.toml).
    // CARGO_MANIFEST_DIR ist absolut → daraus den absoluten FFmpeg-Pfad bauen.
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let ffmpeg_path = if Path::new(&ffmpeg_dir).is_absolute() {
        PathBuf::from(&ffmpeg_dir)
    } else {
        Path::new(&manifest_dir).join(&ffmpeg_dir)
    };
    let bin_dir = ffmpeg_path.join("bin");
    if !bin_dir.exists() {
        println!(
            "cargo:warning=FFmpeg bin/ not found at {}; skipping DLL copy.",
            bin_dir.display()
        );
        return;
    }

    // OUT_DIR = `<workspace>/target/{profile}/build/{crate}-{hash}/out`.
    // Vier `parent()`-Calls treffen `target/{profile}/`.
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");
    let target_profile_dir: Option<PathBuf> = Path::new(&out_dir)
        .ancestors()
        .nth(3)
        .map(|p| p.to_path_buf());
    let Some(target_profile_dir) = target_profile_dir else {
        println!("cargo:warning=could not resolve target/{{profile}}/ from OUT_DIR={out_dir}");
        return;
    };

    let dlls: Vec<PathBuf> = fs::read_dir(&bin_dir)
        .unwrap_or_else(|e| panic!("read_dir({}): {e}", bin_dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("dll"))
        .collect();

    // Kopier nach `target/{profile}/` UND `target/{profile}/examples/` (falls
    // existiert — examples werden in einem Subdir gebaut). Pro Aufruf rerun
    // wenn sich FFMPEG_DIR ändert oder eine Quell-DLL neu ist.
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");

    for target_dir in [
        target_profile_dir.clone(),
        target_profile_dir.join("examples"),
    ] {
        if !target_dir.exists() {
            continue;
        }
        for dll in &dlls {
            let dst = target_dir.join(dll.file_name().unwrap());
            // copy ist idempotent — überschreibt wenn neuer.
            if let Err(e) = fs::copy(dll, &dst) {
                println!(
                    "cargo:warning=failed to copy {} → {}: {e}",
                    dll.display(),
                    dst.display()
                );
            }
            println!("cargo:rerun-if-changed={}", dll.display());
        }
    }
}
