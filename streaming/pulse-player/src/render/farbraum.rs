//! **Welchen Farbraum das Fenster ausgibt** — die Wahl, die es vor wgpu 30
//! nicht gab.
//!
//! Bis wgpu 29 hatte [`wgpu::SurfaceConfiguration`] gar kein Farbraum-Feld. Der
//! Wert war im Backend fest verdrahtet: `wgpu-hal-29.0.4`,
//! `vulkan/swapchain/native.rs:168-174` machte aus `Rgba16Float`
//! `EXTENDED_SRGB_LINEAR_EXT` und aus allem anderen `SRGB_NONLINEAR`. Kein
//! Format ergab `HDR10_ST2084_EXT`.
//!
//! **Das heisst NICHT, dass wgpu 29 kein HDR konnte.** Es konnte HDR — ueber
//! scRGB-linear, genau wie der Windows-Weg dieses Players (`hdr_fenster`,
//! `SetColorSpace1` mit `RGB_FULL_G10_NONE_P709`). Es konnte nur kein **PQ**.
//! Wo im Baum die Formulierung „kann kein HDR" steht, ist sie falsch.
//!
//! wgpu 30 macht daraus eine Wahl: [`wgpu::SurfaceConfiguration::color_space`]
//! nimmt unter anderem `Bt2100Pq` und `Bt2100Hlg`
//! (`wgpu-hal-30.0.0/src/vulkan/conv.rs:199-204` bildet sie auf
//! `HDR10_ST2084_EXT` bzw. `HDR10_HLG_EXT` ab), und
//! [`wgpu::SurfaceCapabilities::color_spaces`] sagt, was die Oberflaeche fuer
//! ein Format traegt.

/// Der Farbraum, in dem das Fenster ausgibt.
///
/// **`Auto`, und das ist die verhaltensgleiche Uebersetzung von wgpu 29, nicht
/// bloss die bequemste.** `wgpu-core-30.0.0/src/device/surface_config.rs:24-40`
/// loest `Auto` fuer `Rgba16Float` auf `ExtendedSrgbLinear` auf, wenn die
/// Oberflaeche das traegt, und sonst auf `Srgb` — Zeile fuer Zeile dieselbe
/// Regel, die vorher im Backend stand. Ein HDR-Farbraum kommt bei `Auto`
/// ausdruecklich nie heraus (ebenda, Zeilen 12-16).
///
/// **Was hier spaeter stehen koennte, aber heute nicht darf:**
/// [`wgpu::SurfaceColorSpace::Bt2100Pq`]. Das waere der Weg, den dekodierten
/// PQ-Strom durchzureichen, statt ihn wie heute nach scRGB-linear zu wandeln.
/// Umzuschalten ist eine eigene Entscheidung mit eigener Messung: es aendert,
/// wie der Shader seine Zahlen kodieren muss (PQ ist nichtlinear, scRGB
/// linear), und ein falsch kodiertes PQ-Bild sieht man sofort am ganzen Schirm.
/// Was die Karte anbietet, schreibt [`berichten`] beim Start ins Log.
pub const AUSGABE_FARBRAUM: wgpu::SurfaceColorSpace = wgpu::SurfaceColorSpace::Auto;

/// Ins Log schreiben, welche Farbraeume die Oberflaeche fuer welches Format
/// traegt.
///
/// **Nur eine Auskunft, sie entscheidet nichts** — aber sie ist die
/// Vorarbeit fuer eine spaetere Umstellung auf PQ, und ohne sie muesste man
/// die Frage jedes Mal von Hand mit `vulkaninfo` stellen. Berichtet werden das
/// gewaehlte Format und [`super::HDR_OBERFLAECHE`], weil nur diese beiden je
/// in der Swapchain landen.
pub fn berichten(caps: &wgpu::SurfaceCapabilities, gewaehlt: wgpu::TextureFormat) {
    let mut formate = vec![gewaehlt];
    if gewaehlt != super::HDR_OBERFLAECHE {
        formate.push(super::HDR_OBERFLAECHE);
    }
    for f in formate {
        let raeume = caps.color_spaces(f);
        eprintln!(
            "pulse-player: Farbraeume fuer {f:?}: {raeume:?}{}",
            if raeume.contains(wgpu::SurfaceColorSpaces::BT2100_PQ) {
                " — PQ waere moeglich (heute nicht genutzt, s. render::farbraum)"
            } else {
                ""
            }
        );
    }
}
