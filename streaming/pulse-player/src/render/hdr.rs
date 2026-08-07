//! Die Plattform-Weiche der HDR-Fragen — **eine Stelle, nicht vier `cfg`
//! verstreut im Zeichenablauf.**
//!
//! Dahinter liegen drei Module, jedes fuer genau eine Sache zustaendig:
//!
//! | Modul | beantwortet |
//! |---|---|
//! | [`super::hdr_fenster`] | Anmeldung und Zwischenspeicher (beide Plattformen) |
//! | [`super::hdr_vulkan`] | Frage 1 auf Linux: traegt die Oberflaeche scRGB-linear? |
//! | [`super::hdr_schirm`] | Frage 2 auf Linux: hat der Ausgang Spielraum ueber Weiss? |
//!
//! Warum die Weiche hier steht und nicht bei den Aufrufern: `render::mod` und
//! `render::setup` sind beide an der harten Groessengrenze
//! (`PLAN.md` §12.1), und beide muessten sonst dieselben `cfg`-Klammern noch
//! einmal fuehren.

use anyhow::Result;

/// Traegt diese Oberflaeche laut **Treiber** scRGB-linear?
///
/// **Ein `false` auf Windows ist kein Nein**, sondern ein „hier nicht gefragt":
/// dort wird der Farbraum angemeldet statt nachgesehen, und
/// [`super::hdr_fenster::farbraum_anmelden`] uebergeht den Wert deshalb.
pub fn weiter_farbraum(adapter: &wgpu::Adapter, surface: &wgpu::Surface<'static>) -> bool {
    #[cfg(target_os = "linux")]
    {
        let antwort = super::hdr_vulkan::weiter_farbraum_moeglich(adapter, surface);
        eprintln!(
            "pulse-player: weiter Farbraum (scRGB-linear, fp16) laut Treiber: {}",
            match antwort {
                Some(true) => "ja",
                Some(false) => "nein",
                None => "nicht gefragt (kein Vulkan)",
            }
        );
        antwort.unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (adapter, surface);
        false
    }
}

/// `pulse-player --hdr-auskunft`: beide HDR-Fragen mit ihren Zahlen.
pub fn auskunft() -> Result<()> {
    #[cfg(target_os = "linux")]
    return super::hdr_auskunft::ausfuehren();
    #[cfg(not(target_os = "linux"))]
    {
        // Unter Windows beantwortet der Player die beiden Fragen ueber DXGI und
        // schreibt es ins Log; ein eigener Auskunftspfad ist dort nie gebaut
        // worden. Das hier sagt es, statt eine leere Ausgabe zu liefern.
        println!("--hdr-auskunft gibt es bisher nur unter Linux/Wayland");
        Ok(())
    }
}
