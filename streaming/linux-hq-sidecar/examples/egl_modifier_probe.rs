//! EGL-Modifier-Sonde: welche DRM-Modifier meldet der Grafiktreiber je Fourcc?
//!
//! **Wozu.** Wenn die PipeWire-Formatverhandlung ein Format nicht liefert, gibt
//! es zwei mögliche Schuldige: den Compositor (bietet es gar nicht an) oder uns
//! (bieten es mit leerer/ungültiger Modifier-Liste an, an der die Verhandlung
//! scheitern muss). Ohne diese Sonde ist beides von aussen nicht zu trennen —
//! genau die Verwechslung, die bei der 10-Bit-Frage schon einmal Zeit gekostet
//! hat.
//!
//! Läuft **ohne Portal-Dialog** und ohne Aufnahme; fragt nur `libEGL`.
//!
//! ```text
//! cargo run --release --example egl_modifier_probe
//! ```
//!
//! Fourccs: `XR24`/`AR24` (8 bit, der heutige Regelweg) und `XB30`/`AB30`
//! (10 bit, der Weg, den eine HDR- oder 10-Bit-Aufnahme brauchte).

use pulse_linux_hq_sidecar::capture::egl_modifiers;

fn main() {
    // Ein Fourcc ist nichts weiter als seine vier ASCII-Zeichen, little-endian
    // in ein u32 gelegt — genau so schreibt `drm_fourcc.h` seine Makros. Die
    // Werte stehen hier literal, damit die Sonde nicht an der drm-fourcc-Crate
    // haengt und auch dann laeuft, wenn die Format-Tabelle im Sidecar umgebaut
    // wird.
    let kandidaten: [(&str, u32); 4] = [
        ("XR24 (XRGB8888,  8 bit)", u32::from_le_bytes(*b"XR24")),
        ("AR24 (ARGB8888,  8 bit)", u32::from_le_bytes(*b"AR24")),
        ("XB30 (XBGR2101010, 10 bit)", u32::from_le_bytes(*b"XB30")),
        ("AB30 (ABGR2101010, 10 bit)", u32::from_le_bytes(*b"AB30")),
    ];

    let fourccs: Vec<u32> = kandidaten.iter().map(|&(_, fourcc)| fourcc).collect();
    let karte = egl_modifiers::query_dmabuf_modifiers(&fourccs);

    for (name, fourcc) in kandidaten {
        match karte.get(&fourcc) {
            Some(modifier) if !modifier.is_empty() => {
                println!("{name}: {} Modifier", modifier.len());
                for m in modifier {
                    println!("    {m:#018x}");
                }
            }
            _ => println!("{name}: KEINE Modifier (EGL meldet das Format nicht)"),
        }
    }
}
