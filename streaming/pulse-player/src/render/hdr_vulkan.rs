//! Die erste der beiden HDR-Fragen auf dem Vulkan-Weg: **kann dieses Fenster
//! ueberhaupt in weitem Farbraum ausgeben?**
//!
//! **Warum das eine eigene Datei ist.** Unter Windows wird der Farbraum
//! ANGEMELDET (`IDXGISwapChain3::SetColorSpace1`, s. [`super::hdr_fenster`]) —
//! man sagt dem System etwas und bekommt ein Ja oder Nein zurueck. Auf dem
//! Vulkan-Weg gibt es nichts anzumelden: wgpu waehlt den Farbraum beim Anlegen
//! der Swapchain selbst, allein am Format
//! (`wgpu-hal-29.0.4/src/vulkan/swapchain/native.rs:168`:
//! `EXTENDED_SRGB_LINEAR_EXT` genau dann, wenn das Format `Rgba16Float` ist).
//! Es bleibt also nur die Gegenrichtung: **nachsehen**.
//!
//! **Hier stand bis zum 2026-08-07 im Modulkopf von [`super::hdr_fenster`], das
//! sei von aussen nicht pruefbar, und der Vulkan-Weg lieferte deshalb `false`.**
//! Das war die vorsichtige und damit richtige Seite des Irrtums, aber es war
//! ein Irrtum: pruefbar ist es, nur nicht an wgpu. Gefragt wird der Treiber
//! selbst.
//!
//! Zwei Dinge werden geprueft, und beide sind noetig:
//!
//! 1. **Traegt der Treiber das Paar?** `vkGetPhysicalDeviceSurfaceFormatsKHR`
//!    fuer genau diese Oberflaeche muss `R16G16B16A16_SFLOAT` zusammen mit
//!    `VK_COLOR_SPACE_EXTENDED_SRGB_LINEAR_EXT` melden. Das ist die Aussage des
//!    Treibers ueber diesen Compositor — auf einem, der keine Farbverwaltung
//!    kann, faellt das Paar aus der Liste.
//! 2. **Steht wirklich eine native Vulkan-Swapchain davor?** `raw_native_swapchain`
//!    liefert `None`, wenn keine konfiguriert ist. Nur wenn eine steht, ist die
//!    Regel aus `native.rs:168` auch angewandt worden.
//!
//! **Was damit NICHT belegt ist**, und das gehoert in jede Messakte dazu: dass
//! der Compositor die Werte am Ende auch als lineares scRGB auf den Schirm
//! bringt. Das ist die zweite Frage (`hdr_schirm`), und sie wird getrennt
//! gestellt.

use ash::vk;

/// Das Paar, an dem alles haengt — dieselben zwei Werte, die wgpu-hal fuer
/// `Rgba16Float` fest verdrahtet.
const FP16: vk::Format = vk::Format::R16G16B16A16_SFLOAT;
const SCRGB: vk::ColorSpaceKHR = vk::ColorSpaceKHR::EXTENDED_SRGB_LINEAR_EXT;

/// Meldet der Treiber fuer DIESE Oberflaeche scRGB-linear in fp16?
///
/// `None` heisst „nicht Vulkan" — dann ist die Frage hier nicht zu beantworten
/// und der Aufrufer bleibt beim Herunterrechnen. `Some(false)` heisst: gefragt,
/// und der Treiber sagt Nein.
///
/// **Einmal beim Aufbau, nicht je Bild.** Die Antwort haengt an Oberflaeche und
/// Karte, beide wechseln waehrend einer Sitzung nicht; die Abfrage selbst ist
/// ein Treiberaufruf mit Speicheranforderung.
pub fn weiter_farbraum_moeglich(
    adapter: &wgpu::Adapter,
    surface: &wgpu::Surface<'static>,
) -> Option<bool> {
    let formate = oberflaechenformate(adapter, surface)?;
    Some(formate.iter().any(|f| f.format == FP16 && f.color_space == SCRGB))
}

/// Die rohe Liste, wie der Treiber sie meldet — Format und Farbraum je Eintrag.
///
/// **Nicht dasselbe wie `surface.get_capabilities().formats`.** Die wgpu-Liste
/// ist durch eine Tabelle gegangen (`wgpu-hal/src/vulkan/conv.rs`), die alles
/// verwirft, was sie nicht kennt, und die den Farbraum gar nicht mehr fuehrt.
/// Fuer die Auskunft (`pulse-player --hdr-auskunft`) zaehlt aber genau der.
pub fn oberflaechenformate(
    adapter: &wgpu::Adapter,
    surface: &wgpu::Surface<'static>,
) -> Option<Vec<vk::SurfaceFormatKHR>> {
    // SAFETY: beide Leihen stammen aus lebenden wgpu-Objekten; die Abfrage
    // veraendert weder Oberflaeche noch Geraet, sie liest nur.
    unsafe {
        let ad = adapter.as_hal::<wgpu::hal::api::Vulkan>()?;
        let sf = surface.as_hal::<wgpu::hal::api::Vulkan>()?;
        let roh = sf.raw_native_handle()?;
        let geteilt = ad.shared_instance();
        let lader = ash::khr::surface::Instance::new(geteilt.entry(), geteilt.raw_instance());
        lader.get_physical_device_surface_formats(ad.raw_physical_device(), roh).ok()
    }
}

/// Steht gerade eine native Vulkan-Swapchain vor dieser Oberflaeche?
///
/// Zusammen mit [`weiter_farbraum_moeglich`] und dem Wissen, dass das
/// konfigurierte Format [`super::HDR_OBERFLAECHE`] ist, ergibt das die volle
/// Kette: der Treiber traegt das Paar, wgpu setzt es bei diesem Format fest ein,
/// und die Swapchain, die es benutzt, existiert.
pub fn swapchain_ist_nativ(surface: &wgpu::Surface<'static>) -> bool {
    // SAFETY: wie oben — reiner Lesezugriff auf ein lebendes wgpu-Objekt.
    unsafe {
        surface
            .as_hal::<wgpu::hal::api::Vulkan>()
            .is_some_and(|sf| sf.raw_native_swapchain().is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Die beiden Konstanten muessen die von wgpu-hal sein.** Sie stehen
    /// hier ein zweites Mal — die erste Fassung ist fest in
    /// `wgpu-hal/src/vulkan/swapchain/native.rs` verdrahtet und von aussen
    /// nicht auszulesen. Laufen sie auseinander, prueften wir ein Paar, das
    /// gar nicht benutzt wird, und der Player behauptete HDR, wo keins ist.
    ///
    /// Was der Test kann: festhalten, dass die Zahlen die aus der
    /// Vulkan-Spezifikation sind (1000104002 = `EXTENDED_SRGB_LINEAR_EXT`,
    /// 97 = `R16G16B16A16_SFLOAT`). Was er NICHT kann: bemerken, dass wgpu bei
    /// einem Versionssprung etwas anderes waehlt — dafuer gibt es nur das
    /// Nachlesen beim Anheben von wgpu.
    ///
    /// **Der Test hat schon einmal zugeschlagen** (2026-08-07, beim Schreiben):
    /// 1000104006 ist `EXTENDED_SRGB_NONLINEAR_EXT`, also der Nachbar. Ein
    /// vertippter Farbraum haette hier nichts gebrochen — der Code prueft ja
    /// gegen die Konstante, nicht gegen die Zahl —, sondern still das falsche
    /// Paar gesucht und HDR dort verweigert, wo es moeglich ist.
    #[test]
    fn das_gepruefte_paar_ist_das_von_wgpu_gesetzte() {
        assert_eq!(SCRGB.as_raw(), 1000104002);
        assert_eq!(FP16.as_raw(), 97);
    }
}
