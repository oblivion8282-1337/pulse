//! Der Uebergabepunkt: aus dem fremden `VkImage` wird eine `wgpu::Texture`.
//!
//! **Hier sitzt der begruendete Verdacht dieser Probe.** wgpu-core 29.0.4 traegt
//! eine so eingehaengte Textur mit dem Zustand `UNINITIALIZED` in seine
//! Nachverfolgung ein (`device/resource.rs:1253`), und der Vulkan-Unterbau
//! bildet diesen Zustand auf `VK_IMAGE_LAYOUT_UNDEFINED` ab
//! (`vulkan/conv.rs:218`). Der erste Zugriff erzeugt damit eine Sperre
//! `UNDEFINED -> SHADER_READ_ONLY_OPTIMAL`, und ein Uebergang aus `UNDEFINED`
//! **darf** den Inhalt laut Spezifikation verwerfen. Ob er es auf dieser Karte
//! und diesem Treiber TUT, ist genau die Messung — „darf" ist kein Beleg fuer
//! „tut", und auf der Windows-Seite ist dieselbe Erklaerung schon einmal
//! widerlegt worden.
//!
//! wgpu 30 hat dafuer einen `initial_state`-Parameter bekommen. Das ist der
//! einzige einschlaegige Neuzugang — und sein Nutzen ist unbelegt, weil die
//! Windows-Messreihe alle drei Anfangszustaende geprueft und keinen
//! Unterschied gefunden hat. Deshalb wird hier zuerst 29 gemessen.
//!
//! Zwei Dinge, die beim Nachbauen leicht falsch gemacht werden:
//!
//! * **Der `drop_callback` MUSS gesetzt sein.** Ohne ihn nimmt wgpu-hal das
//!   `VkImage` in Besitz und zerstoert es beim Fallenlassen — der Speicher
//!   gehoert aber uns (und CUDA haelt ihn noch eingehaengt). Ein doppeltes
//!   Zerstoeren faellt erst viel spaeter auf.
//! * **`TextureMemory::External`.** Andernfalls uebernaehme wgpu-hal auch die
//!   Speicherverwaltung.

use anyhow::{anyhow, Result};

use crate::ebene::Ebene;
use crate::vkseite::Bild;

/// Das `VkImage` an wgpu uebergeben.
///
/// # Safety
/// `bild` muss auf demselben Geraet angelegt worden sein, das `device` fuehrt,
/// und mindestens so lange leben wie die zurueckgegebene Textur.
pub unsafe fn uebernehmen(
    device: &wgpu::Device,
    bild: &Bild,
    e: &Ebene,
) -> Result<wgpu::Texture> {
    let masse = wgpu::Extent3d {
        width: e.breite,
        height: e.hoehe,
        depth_or_array_layers: 1,
    };
    let hal_desc = wgpu::hal::TextureDescriptor {
        label: Some("cuda-bild"),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: e.wgpu_format,
        usage: wgpu::TextureUses::RESOURCE,
        memory_flags: wgpu::hal::MemoryFlags::empty(),
        // Leer, weil das Bild ohne `MUTABLE_FORMAT` angelegt ist — wgpu-hal
        // verlangt das ausdruecklich in der Sicherheitsauflage von
        // `texture_from_raw`.
        view_formats: vec![],
    };
    let beschreibung = wgpu::TextureDescriptor {
        label: Some("cuda-bild"),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: e.wgpu_format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    };

    let hal_tex = {
        let hal_device = device
            .as_hal::<wgpu::hal::api::Vulkan>()
            .ok_or_else(|| anyhow!("das wgpu-Geraet ist kein Vulkan-Geraet"))?;
        hal_device.texture_from_raw(
            bild.image,
            &hal_desc,
            // Leerer Rueckruf: er sagt wgpu-hal nur „du besitzt das Bild
            // nicht", tun muss er nichts.
            Some(Box::new(|| {})),
            wgpu::hal::vulkan::TextureMemory::External,
        )
    };
    Ok(device.create_texture_from_hal::<wgpu::hal::api::Vulkan>(hal_tex, &beschreibung))
}
