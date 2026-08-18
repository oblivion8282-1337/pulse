//! Kopiert die FFmpeg-DLLs aus `$FFMPEG_DIR/bin/` neben die gebaute `.exe`.
//!
//! **Warum das hier nachgezogen wurde** (2026-08-18): Windows sucht die DLLs
//! eines Prozesses zuerst im Verzeichnis der EIGENEN `.exe` — nicht in dem der
//! Anwendung, die ihn startet. Im ausgelieferten Paket faellt das nicht auf,
//! weil `electron-builder.yml` Sidecar und Player bewusst in dasselbe
//! `resources/hq-sidecar/` legt und die DLLs dort ohnehin liegen. Im Dev-Baum
//! haben beide ihr eigenes `target/release/`, und dort stand der Player ohne
//! seine Bibliotheken: er startete und war Millisekunden spaeter wieder tot,
//! Exit `0xC0000135` (STATUS_DLL_NOT_FOUND). Von aussen sah das aus wie „der
//! Player ist nicht verfuegbar" — die App fiel wortlos auf den `<video>`-Weg
//! zurueck, und bei 10 bit sogar auf eine Absage, die dem Browser die Schuld
//! gab. Der Sidecar hatte diese Datei laengst; der Player hatte gar keine.
//!
//! Bewusst dieselbe Bauart wie `streaming/win-hq-sidecar/build.rs` (bis hin zur
//! OUT_DIR-Walk-Up-Heuristik) — zwei Kopien derselben zwanzig Zeilen sind hier
//! billiger als eine geteilte Kiste zwischen zwei sonst unabhaengigen Crates,
//! und wer eine anfasst, findet die andere ueber diesen Absatz.
//!
//! **`FFMPEG_DIR` steht hier NICHT in einer `.cargo/config.toml`** wie beim
//! Sidecar, und das muss so bleiben: ein `[env]`-Block dort gaelte fuer JEDE
//! Plattform und zeigte den Linux-/Flatpak-Bau auf ein Windows-Verzeichnis, das
//! es dort nicht gibt (unter Linux kommt FFmpeg ueber pkg-config). Gesetzt wird
//! die Variable deshalb beim Aufruf — `win-build.yml` tut das, und wer von Hand
//! baut, ebenso. Fehlt sie unter Windows, wird nur gewarnt: der Bau soll daran
//! nicht scheitern, denn ohne FFmpeg-Dist kaeme er ohnehin nicht bis hierher.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // Nur Windows: unter Linux/macOS loest der Linker ueber pkg-config bzw.
    // `@rpath` auf, dort gibt es nichts zu kopieren.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let ffmpeg_dir = match env::var("FFMPEG_DIR") {
        Ok(v) if !v.is_empty() => v,
        _ => {
            println!(
                "cargo:warning=FFMPEG_DIR not set; skipping DLL copy. \
                 Set it to streaming/win-hq-sidecar/ffmpeg-dist/n8.1-lgpl-shared."
            );
            return;
        }
    };

    // Ein relativer Wert gilt gegen das Crate-Verzeichnis, nicht gegen das
    // Arbeitsverzeichnis des Aufrufers — sonst haengt das Ergebnis daran, von
    // wo aus `cargo build` gestartet wurde.
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

    // OUT_DIR = `<crate>/target/{profile}/build/{crate}-{hash}/out`.
    // Drei Schritte aufwaerts treffen `target/{profile}/`. Aendert Cargo sein
    // Layout, faellt das hier als Warnung auf statt still danebenzugreifen.
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");
    let Some(target_profile_dir) = Path::new(&out_dir).ancestors().nth(3).map(PathBuf::from) else {
        println!("cargo:warning=could not resolve target/{{profile}}/ from OUT_DIR={out_dir}");
        return;
    };

    let dlls: Vec<PathBuf> = fs::read_dir(&bin_dir)
        .unwrap_or_else(|e| panic!("read_dir({}): {e}", bin_dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("dll"))
        .collect();

    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");

    // Auch `examples/` und `deps/`: dort landen die Testtreiber bzw. die
    // Zwischenstufen, und beide starten mit derselben Suchreihenfolge.
    for target_dir in [
        target_profile_dir.clone(),
        target_profile_dir.join("examples"),
        target_profile_dir.join("deps"),
    ] {
        if !target_dir.exists() {
            continue;
        }
        for dll in &dlls {
            let dst = target_dir.join(dll.file_name().unwrap());
            // `copy` ueberschreibt — ein zweiter Lauf ist damit folgenlos, und
            // eine ausgetauschte Dist wird beim naechsten Bau nachgezogen.
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
