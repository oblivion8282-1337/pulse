//! Aufbau: wgpu hochfahren, die rohen Vulkan-Griffe entnehmen, CUDA daneben
//! stellen — und dabei drei Dinge belegen, die sonst stillschweigend
//! vorausgesetzt wuerden: dass die noetige Erweiterung wirklich am Geraet ist,
//! dass wgpu und CUDA dieselbe Karte meinen, und wie es um die Erweiterung
//! steht, die der naechste Schritt braucht.

use anyhow::{bail, Context, Result};

use crate::cuda::{self, Cuda};
use crate::vkseite::Vkseite;

/// Die Erweiterung, ohne die kein Dateideskriptor herausfaellt.
const SPEICHER_FD: &str = "VK_KHR_external_memory_fd";

/// Die Erweiterung, an der der **naechste** Schritt haengt. Sie wird an zwei
/// verschiedenen Stellen nachgesehen — am Geraet, das wgpu aufgebaut hat, und
/// an der Karte darunter — und genau die Differenz der beiden Antworten ist der
/// Befund. Einmal benannt, damit die beiden Zeilen nicht auseinanderlaufen
/// koennen: zwei getippte Zeichenketten, von denen eine sich verschreibt,
/// ergaeben eine Differenz, die keine ist.
const SEMAPHOR_FD: &str = "VK_KHR_external_semaphore_fd";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// wgpu aufbauen und die rohen Vulkan-Griffe daraus entnehmen.
///
/// Hier faellt bereits eine Vorentscheidung: **hat wgpus Geraet
/// `VK_KHR_external_memory_fd` an?** wgpu-hal 29 fordert sie an, wenn die Karte
/// sie anbietet (`vulkan/adapter.rs:1296`) — aber „fordert an, wenn" ist keine
/// Zusage. Ohne sie gaebe es keinen Dateideskriptor und der Weg waere bei
/// wgpu 29 zu, ganz unabhaengig von jeder Zustandsfrage.
pub fn wgpu_aufbauen(pruefschicht: bool) -> Result<(wgpu::Device, wgpu::Queue, Vkseite)> {
    let mut beschreibung = wgpu::InstanceDescriptor::new_without_display_handle();
    beschreibung.backends = wgpu::Backends::VULKAN;
    // Die Pruefschicht nur auf Anforderung: sie ist das Einzige, was einen
    // regelwidrigen Import selbst benennt, kostet aber Zeit.
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
    let info = adapter.get_info();
    println!("\n  GPU {} ({:?}, Treiber {})", info.name, info.backend, info.driver);

    // 10 bit braucht `R16Unorm`/`Rg16Unorm`, und die haengen an diesem Merkmal.
    // Fehlt es, waere der P010-Teil nicht „gescheitert", sondern gar nicht
    // durchgefuehrt — ein Unterschied, der im Ergebnis stehen muss.
    let noetig = wgpu::Features::TEXTURE_FORMAT_16BIT_NORM;
    if !adapter.features().contains(noetig) {
        bail!("dem Adapter fehlt TEXTURE_FORMAT_16BIT_NORM — P010 waere nicht pruefbar");
    }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wgpu-cuda-import"),
        required_features: noetig,
        ..Default::default()
    }))
    .context("Geraet liess sich nicht oeffnen")?;

    // SAFETY: alle Griffe stammen aus demselben, lebenden wgpu-Geraet; die
    // geklonten ash-Griffe zerstoeren beim Fallenlassen nichts.
    let v = unsafe {
        let hal = device
            .as_hal::<wgpu::hal::api::Vulkan>()
            .context("das wgpu-Geraet ist kein Vulkan-Geraet")?;
        let erweiterungen = hal.enabled_device_extensions();
        let am_geraet = |name: &str| erweiterungen.iter().any(|e| e.to_string_lossy() == name);
        if !am_geraet(SPEICHER_FD) {
            bail!(
                "wgpus Geraet hat {SPEICHER_FD} NICHT an — ohne sie laesst sich kein \
                 Speicher an CUDA weiterreichen. Der Weg ist bei wgpu 29 damit zu, \
                 und zwar aus einem anderen Grund als der Zustandsfrage."
            );
        }
        println!("  {SPEICHER_FD} am wgpu-Geraet: an");
        // **Vorgriff auf den naechsten Schritt, und er faellt negativ aus.**
        // Die Synchronisierung im Betrieb (Decoder schreibt, waehrend
        // gezeichnet wird) braucht `VK_KHR_external_semaphore_fd` gegen
        // `cuImportExternalSemaphore`. Anders als beim Speicher fordert
        // wgpu-hal 29 diese Erweiterung NICHT an — im Quelltext steht bei den
        // Semaphoren nur `VK_KHR_timeline_semaphore` (adapter.rs:1232). Hier
        // wird es am laufenden Geraet nachgesehen statt aus dem Quelltext
        // geschlossen, weil beides auseinandergehen kann.
        //
        // Es ist kein Abbruchgrund fuer DIESE Probe (sie synchronisiert ueber
        // `queue_wait_idle`), aber es entscheidet den naechsten Schritt: ohne
        // die Erweiterung muss der Player sein VkDevice selbst anlegen und per
        // `hal::vulkan::Adapter::device_from_raw` an wgpu uebergeben, statt es
        // sich von wgpu anlegen zu lassen.
        //
        // **Und die Liste ist NICHT gleichbedeutend mit "verfuegbar".** Sie
        // fuehrt nur die ausdruecklich angeforderten Erweiterungen; was in eine
        // Kernfassung uebernommen wurde, steht nicht darin und ist trotzdem da.
        // Deshalb wird hier dazugesagt, ob es eine solche Uebernahme gibt:
        // `VK_KHR_external_semaphore_fd` hat keine (nur das elternlose
        // `VK_KHR_external_semaphore` wurde in 1.1 uebernommen, und
        // `vkGetSemaphoreFdKHR` steckt nicht darin) — ihr Fehlen ist also ein
        // echtes Fehlen. Ohne diesen Zusatz waere die Zeile eine Falle.
        println!(
            "  {SEMAPHOR_FD} am wgpu-Geraet: {} (nicht in eine Kernfassung \
             uebernommen, ihr Fehlen ist also ein echtes Fehlen)",
            if am_geraet(SEMAPHOR_FD) { "an" } else { "NICHT an" }
        );
        Vkseite::neu(
            hal.raw_device().clone(),
            hal.shared_instance().raw_instance().clone(),
            hal.raw_physical_device(),
            hal.raw_queue(),
            hal.queue_family_index(),
        )
    };
    // Einmal fragen, zweimal berichten: jeder Aufruf zaehlt die
    // Erweiterungsliste des Treibers neu auf.
    let karte_bietet_semaphor = v.karte_bietet(SEMAPHOR_FD);
    println!(
        "  {SEMAPHOR_FD} von der KARTE angeboten: {} — {}",
        if karte_bietet_semaphor { "ja" } else { "nein" },
        if karte_bietet_semaphor {
            "wgpu 29 laesst sie nur liegen. Ausweg fuer die Synchronisierung: \
             das VkDevice selbst anlegen und per Adapter::device_from_raw uebergeben."
        } else {
            "der Weg ueber Dateideskriptor-Semaphoren ist auf dieser Karte zu."
        }
    );
    Ok((device, queue, v))
}

/// CUDA hochfahren und gegen die Karte abgleichen, die wgpu benutzt.
pub fn cuda_aufbauen(v: &Vkseite) -> Result<Cuda> {
    let c = Cuda::laden()?;
    unsafe { c.pruefe((c.cuInit)(0), "cuInit")? };
    let mut dev: cuda::CUdevice = 0;
    unsafe { c.pruefe((c.cuDeviceGet)(&mut dev, 0), "cuDeviceGet")? };
    let mut cu_uuid = [0u8; 16];
    unsafe { c.pruefe((c.cuDeviceGetUuid)(&mut cu_uuid, dev), "cuDeviceGetUuid")? };
    let vk_uuid = v.uuid();
    println!("  CUDA-Geraet 0: UUID {}", hex(&cu_uuid));
    // Auf einer Maschine mit zwei Karten schluege der Import sonst aus einem
    // Grund fehl, der mit der Frage nichts zu tun hat.
    if cu_uuid != vk_uuid {
        bail!(
            "wgpus Karte ({}) und CUDAs Karte ({}) sind verschieden — die Probe \
             wuerde etwas anderes messen als gemeint",
            hex(&vk_uuid),
            hex(&cu_uuid)
        );
    }
    println!("  UUIDs stimmen ueberein — dieselbe Karte");
    let mut ctx: cuda::CUcontext = std::ptr::null_mut();
    unsafe {
        c.pruefe((c.cuDevicePrimaryCtxRetain)(&mut ctx, dev), "cuDevicePrimaryCtxRetain")?;
        c.pruefe((c.cuCtxSetCurrent)(ctx), "cuCtxSetCurrent")?;
    }
    Ok(c)
}
