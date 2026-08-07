//! **Frage 2**: nimmt wgpu 29 ein SELBST angelegtes `VkDevice` entgegen, auf
//! dem `VK_KHR_external_semaphore_fd` eingeschaltet ist?
//!
//! Warum die Frage ueberhaupt gestellt wird: wgpu-hal 29 fordert diese
//! Erweiterung von sich aus NICHT an (im Quelltext steht bei den Semaphoren nur
//! `VK_KHR_timeline_semaphore`), obwohl die Karte sie anbietet — belegt von der
//! Nachbarkiste `../wgpu-cuda-import`, die es am laufenden Geraet nachsieht.
//! Ohne sie faellt kein Dateideskriptor aus `vkGetSemaphoreFdKHR`, und damit
//! gibt es nichts, was `cuImportExternalSemaphore` importieren koennte.
//!
//! Der Ausweg ist `wgpu::hal::vulkan::Adapter::device_from_raw`. Diese Datei
//! geht dabei GENAU den Weg, den wgpu-hal intern in `open_with_callback`
//! nimmt (`adapter.rs:2834`) — dieselben Hilfsfunktionen, dieselbe Reihenfolge,
//! nur mit einem Eintrag mehr in der Erweiterungsliste. Das ist Absicht: waeren
//! es zwei verschiedene Wege, koennte ein Fehlschlag auch daran liegen, dass
//! wir das Geraet anders bauen als wgpu es erwartet, und die Frage waere nicht
//! beantwortet.

use std::ffi::{c_char, CStr};

use anyhow::{bail, Context, Result};
use ash::vk;

/// Die Erweiterung, um die es geht. Einmal benannt, damit die Zeile, die sie
/// anfordert, und die Zeile, die sie nachher nachweist, nicht auseinanderlaufen
/// koennen.
pub const SEMAPHOR_FD: &CStr = c"VK_KHR_external_semaphore_fd";

/// Die rohen Vulkan-Griffe des fertigen wgpu-Geraets, plus das, was fuer die
/// Kopfzeile berichtet werden muss.
pub struct Geraet {
    /// **Haelt das Geraet am Leben, wird sonst nicht gelesen.** Alle rohen
    /// Griffe darunter gehoeren diesem `wgpu::Device`; faellt es, zerstoert
    /// wgpu das `VkDevice`, und `ash_device`/`queue` zeigen ins Leere. Das
    /// Feld deshalb NICHT entfernen, auch wenn der Compiler es fuer ungenutzt
    /// haelt.
    #[allow(dead_code)]
    pub device: wgpu::Device,
    pub ash_device: ash::Device,
    pub instance: ash::Instance,
    pub phys: vk::PhysicalDevice,
    pub queue: vk::Queue,
    pub familie: u32,
    /// **Die Groesse, die sich aendern MUSS, wenn der Schalter greift.** Die
    /// Zahl der am Geraet eingeschalteten Erweiterungen steigt beim eigenen
    /// Geraet um genau eins gegenueber dem wgpu-Weg. Sie wird mitprotokolliert,
    /// weil ein nicht greifender Schalter in diesem Labor schon dreimal
    /// Matrixzeilen entwertet hat.
    pub erweiterungen_am_geraet: usize,
    pub semaphor_fd_am_geraet: bool,
    pub name: String,
}

/// Adapter waehlen und ausgeben, was die Karte kann.
fn adapter(pruefschicht: bool) -> Result<(wgpu::Instance, wgpu::Adapter)> {
    let mut beschreibung = wgpu::InstanceDescriptor::new_without_display_handle();
    beschreibung.backends = wgpu::Backends::VULKAN;
    if pruefschicht {
        beschreibung.flags |= wgpu::InstanceFlags::VALIDATION | wgpu::InstanceFlags::DEBUG;
    }
    let instance = wgpu::Instance::new(beschreibung);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))
    .context("kein Vulkan-Adapter")?;
    Ok((instance, adapter))
}

/// Bietet die KARTE die Erweiterung an — unabhaengig davon, ob wgpu sie
/// angefordert hat?
///
/// Ohne diese Unterscheidung waeren „die Karte kann es nicht" und „wgpu laesst
/// es liegen" dieselbe Fehlanzeige, und nur der zweite Fall hat einen Ausweg.
fn karte_bietet(instance: &ash::Instance, phys: vk::PhysicalDevice, name: &CStr) -> bool {
    let liste = unsafe { instance.enumerate_device_extension_properties(phys) };
    liste
        .into_iter()
        .flatten()
        .any(|p| p.extension_name_as_c_str().map(|c| c == name).unwrap_or(false))
}

/// Das Geraet aufbauen — entweder selbst (`eigenes = true`) oder von wgpu.
///
/// Beide Wege muenden in dieselbe Struktur, damit die Probe dahinter
/// buchstaeblich derselbe Code ist. Nur so ist ein Unterschied im Ergebnis dem
/// Geraet zuzuordnen und nicht dem Pruefweg.
pub fn aufbauen(eigenes: bool, pruefschicht: bool) -> Result<Geraet> {
    let (_instance, adapter) = adapter(pruefschicht)?;
    let info = adapter.get_info();
    println!("  GPU {} ({:?}, Treiber {})", info.name, info.backend, info.driver);

    // 10 bit braucht `R16Unorm`/`Rg16Unorm` — hier nicht noetig, aber die
    // Merkmalsmenge soll dieselbe sein wie in der Nachbarkiste, damit die
    // Erweiterungsliste vergleichbar bleibt.
    let merkmale = wgpu::Features::TEXTURE_FORMAT_16BIT_NORM;
    if !adapter.features().contains(merkmale) {
        bail!("dem Adapter fehlt TEXTURE_FORMAT_16BIT_NORM");
    }

    let (device, _queue) = if eigenes {
        eigenes_geraet(&adapter, merkmale)?
    } else {
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("semaphor-kopplung (wgpu-Weg)"),
            required_features: merkmale,
            ..Default::default()
        }))
        .context("Geraet liess sich nicht oeffnen")?
    };

    // SAFETY: alle Griffe stammen aus demselben, lebenden wgpu-Geraet; die
    // geklonten ash-Griffe zerstoeren beim Fallenlassen nichts.
    let g = unsafe {
        let hal = device
            .as_hal::<wgpu::hal::api::Vulkan>()
            .context("das wgpu-Geraet ist kein Vulkan-Geraet")?;
        let liste = hal.enabled_device_extensions();
        Geraet {
            ash_device: hal.raw_device().clone(),
            instance: hal.shared_instance().raw_instance().clone(),
            phys: hal.raw_physical_device(),
            queue: hal.raw_queue(),
            familie: hal.queue_family_index(),
            erweiterungen_am_geraet: liste.len(),
            semaphor_fd_am_geraet: liste.contains(&SEMAPHOR_FD),
            name: info.name.clone(),
            device: device.clone(),
        }
    };
    println!(
        "  Erweiterungen am Geraet: {} · {} ist {}",
        g.erweiterungen_am_geraet,
        SEMAPHOR_FD.to_string_lossy(),
        if g.semaphor_fd_am_geraet { "AN" } else { "NICHT an" }
    );
    if !g.semaphor_fd_am_geraet && !karte_bietet(&g.instance, g.phys, SEMAPHOR_FD) {
        println!(
            "  Die KARTE bietet sie ebenfalls nicht an — hier hilft kein eigenes Geraet, \
             der Weg waere auf dieser Karte grundsaetzlich zu."
        );
    }
    Ok(g)
}

/// Der eigentliche Nachweis fuer Frage 2: `VkDevice` selbst anlegen, mit der
/// Erweiterung, und an wgpu uebergeben.
fn eigenes_geraet(
    adapter: &wgpu::Adapter,
    merkmale: wgpu::Features,
) -> Result<(wgpu::Device, wgpu::Queue)> {
    // SAFETY: der Adapter lebt waehrend des ganzen Aufrufs; das erzeugte
    // `ash::Device` wird ausschliesslich an `device_from_raw` weitergereicht,
    // das die Eigentuemerschaft uebernimmt (`drop_callback: None`).
    let (offen, familie) = unsafe {
        let hal = adapter
            .as_hal::<wgpu::hal::api::Vulkan>()
            .context("der Adapter ist kein Vulkan-Adapter")?;
        let instance = hal.shared_instance().raw_instance().clone();
        let phys = hal.raw_physical_device();

        if !karte_bietet(&instance, phys, SEMAPHOR_FD) {
            bail!(
                "die Karte bietet {} nicht an — ein eigenes Geraet damit anzulegen \
                 muesste scheitern, und der Fehlschlag haette mit wgpu nichts zu tun",
                SEMAPHOR_FD.to_string_lossy()
            );
        }

        // Genau die Liste, die wgpu-hal selbst anfordern wuerde, plus die eine
        // fehlende. Die Vorschrift von `device_from_raw` lautet: die Liste MUSS
        // eine Obermenge von `required_device_extensions()` sein — mehr ist
        // ausdruecklich erlaubt („it's fine to add more extensions to the
        // list", adapter.rs:2413).
        let mut ext = hal.required_device_extensions(merkmale);
        let vorher = ext.len();
        if !ext.contains(&SEMAPHOR_FD) {
            ext.push(SEMAPHOR_FD);
        }
        println!(
            "  eigenes VkDevice: wgpu wuerde {vorher} Erweiterungen anfordern, wir fordern {} an",
            ext.len()
        );

        // Ebenfalls von wgpu-hal berechnet und nicht selbst zusammengestellt:
        // die Merkmalskette muss zu dem passen, was `device_from_raw` spaeter
        // als eingeschaltet VORAUSSETZT. Ein selbst gebauter
        // `PhysicalDeviceFeatures2`-Baum waere die naheliegende Stelle, an der
        // sich beides unbemerkt auseinanderentwickelt.
        let mut phd = hal.physical_device_features(&ext, merkmale);

        // Familie 0 wie in `open_with_callback` (dort steht dazu `//TODO`).
        // Uebernommen statt verbessert: die Probe soll den ausgelieferten Weg
        // messen, nicht einen besseren.
        let familie = 0u32;
        let prio = [1.0f32];
        let qinfo =
            [vk::DeviceQueueCreateInfo::default().queue_family_index(familie).queue_priorities(&prio)];
        let zeiger: Vec<*const c_char> = ext.iter().map(|s| s.as_ptr()).collect();
        let vorinfo = vk::DeviceCreateInfo::default()
            .queue_create_infos(&qinfo)
            .enabled_extension_names(&zeiger);
        let info = phd.add_to_device_create(vorinfo);
        let roh = instance
            .create_device(phys, &info, None)
            .context("vkCreateDevice mit VK_KHR_external_semaphore_fd")?;

        let offen = hal
            .device_from_raw(
                roh,
                None,
                &ext,
                merkmale,
                &wgpu::Limits::default(),
                &wgpu::MemoryHints::default(),
                familie,
                0,
            )
            .map_err(|e| anyhow::anyhow!("device_from_raw: {e}"))?;
        (offen, familie)
    };
    let _ = familie;

    // SAFETY: `offen` stammt aus genau diesem Adapter, und die Merkmale sind
    // dieselben, mit denen es geoeffnet wurde.
    let (device, queue) = unsafe {
        adapter.create_device_from_hal(
            offen,
            &wgpu::DeviceDescriptor {
                label: Some("semaphor-kopplung (eigenes VkDevice)"),
                required_features: merkmale,
                ..Default::default()
            },
        )
    }
    .context("create_device_from_hal — wgpu 29 nimmt das eigene VkDevice nicht an")?;
    Ok((device, queue))
}
