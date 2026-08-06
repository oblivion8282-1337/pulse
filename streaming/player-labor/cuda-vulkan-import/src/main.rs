//! Probe: teilen sich CUDA und Vulkan auf dieser Karte denselben Speicher?
//!
//! Beantwortet **eine** Frage, nachpruefbar: kommt ein Inhalt, den CUDA in
//! einen von Vulkan exportierten Speicher schreibt, dort unveraendert an — und
//! umgekehrt?
//!
//! Davon haengt Zero-Copy im `pulse-player` unter Linux/NVIDIA ab. Heute nimmt
//! jedes Bild den Weg GPU -> Hauptspeicher -> GPU zurueck: `av1_cuvid` liefert
//! seine Bilder in den Hauptspeicher (`decode.rs`, Modulkopf), der Renderer
//! laedt sie wieder hoch. Was das kostet, steht in
//! `streaming/testbench/profiles/player-2026-08-06-bildweg-kosten.json` —
//! 5,26 ms je Bild bei 1440p60 10 bit, also 32 Prozent des Budgets.
//!
//! **Warum diese Richtung und nicht die umgekehrte.** Fuer den Player muss
//! CUDA schreiben und Vulkan lesen, nicht andersherum: Der Decoder-Frame liegt
//! in CUDA-Speicher, den FFmpeg mit `cuMemAlloc` anlegt — und der ist NICHT
//! exportierbar. Exportieren kann nur, wer beim Anlegen das Flag setzt, und das
//! ist hier die Vulkan-Seite. Der Weg im Player waere also: Vulkan legt die
//! Zieltextur an, CUDA bekommt sie eingehaengt, und der fertige Decoder-Frame
//! wird GPU-lokal hineinkopiert. Das ist keine Nullkopie im Wortsinn, aber es
//! ist die Kopie, die auf der Karte bleibt statt ueber PCIe zu laufen.
//!
//! **Warum ohne wgpu.** Diese Stufe fragt nur, ob Treiber und CUDA sich einig
//! sind. Kaeme wgpu dazu, waere ein Fehlschlag nicht mehr eindeutig zuzuordnen
//! — auf der Windows-Seite ist genau diese Verwechslung passiert (es sah nach
//! wgpu aus und war der Treiber, s. `player-2026-08-06-nv12-wgpu-import*.json`).
//!
//! Rueckgabewert 0 = der Weg traegt.

mod cuda;

use std::ffi::c_void;

use anyhow::{bail, Context, Result};
use ash::vk;

use cuda::Cuda;

/// Wie viele Bytes geteilt werden. Vorgabe entspricht grob einer 1440p-Luma-
/// Ebene, damit die Groessenordnung der spaeteren Anwendung stimmt.
fn groesse() -> usize {
    std::env::var("SPIKE_BYTES").ok().and_then(|s| s.parse().ok()).unwrap_or(2560 * 1440)
}

/// Positionsabhaengiges Muster.
///
/// Bewusst NICHT konstant und bewusst nicht nur vom niederwertigsten Byte
/// abhaengig: ein Weg, der um einige Bytes versetzt liest oder nur den Anfang
/// trifft, kaeme mit einem gleichfoermigen Muster als fehlerfrei durch. Genau
/// dieser Fehler ist auf der Windows-Seite beim Textur-Stapel aufgetreten und
/// waere ohne so ein Muster als "geht" durchgegangen.
fn muster(i: usize) -> u8 {
    ((i.wrapping_mul(31).wrapping_add(i >> 8).wrapping_add(7)) & 0xFF) as u8
}

struct Vulkan {
    _entry: ash::Entry,
    instance: ash::Instance,
    device: ash::Device,
    phys: vk::PhysicalDevice,
    queue: vk::Queue,
    queue_familie: u32,
    uuid: [u8; 16],
}

impl Vulkan {
    fn aufbauen() -> Result<Self> {
        let entry = unsafe { ash::Entry::load() }.context("Vulkan-Laufzeit nicht ladbar")?;
        let app = vk::ApplicationInfo::default()
            .api_version(vk::API_VERSION_1_2)
            .application_name(c"cuda-vulkan-import");
        let instance = unsafe {
            entry.create_instance(&vk::InstanceCreateInfo::default().application_info(&app), None)
        }
        .context("vkCreateInstance")?;

        let phys_liste = unsafe { instance.enumerate_physical_devices() }?;
        // Die Karte wird ueber die UUID gewaehlt, die auch CUDA meldet — auf
        // einer Maschine mit zwei GPUs waere "die erste" sonst womoeglich eine
        // andere als die, die CUDA benutzt, und der Import scheiterte aus einem
        // Grund, der nichts mit der Sache zu tun hat.
        let mut gewaehlt = None;
        for p in phys_liste {
            let mut id = vk::PhysicalDeviceIDProperties::default();
            let mut props = vk::PhysicalDeviceProperties2::default().push_next(&mut id);
            unsafe { instance.get_physical_device_properties2(p, &mut props) };
            let name = unsafe { std::ffi::CStr::from_ptr(props.properties.device_name.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            println!("  Vulkan-Geraet: {name}  UUID {}", hex(&id.device_uuid));
            if gewaehlt.is_none() {
                gewaehlt = Some((p, id.device_uuid, name));
            }
        }
        let (phys, uuid, name) = gewaehlt.context("keine Vulkan-faehige Karte gefunden")?;
        println!("  gewaehlt: {name}");

        let familien = unsafe { instance.get_physical_device_queue_family_properties(phys) };
        let queue_familie = familien
            .iter()
            .position(|f| f.queue_flags.contains(vk::QueueFlags::TRANSFER))
            .context("keine Queue-Familie mit Transfer")? as u32;

        let prio = [1.0f32];
        let qinfo = [vk::DeviceQueueCreateInfo::default()
            .queue_family_index(queue_familie)
            .queue_priorities(&prio)];
        // `VK_KHR_external_memory_fd` ist der Kern der Sache: ohne sie gibt es
        // keinen Dateideskriptor zum Weiterreichen. `external_memory` selbst ist
        // seit Vulkan 1.1 Kernbestand und braucht keine Anforderung.
        let ext = [c"VK_KHR_external_memory_fd".as_ptr()];
        let device = unsafe {
            instance.create_device(
                phys,
                &vk::DeviceCreateInfo::default()
                    .queue_create_infos(&qinfo)
                    .enabled_extension_names(&ext),
                None,
            )
        }
        .context("vkCreateDevice — fehlt VK_KHR_external_memory_fd?")?;
        let queue = unsafe { device.get_device_queue(queue_familie, 0) };

        Ok(Self { _entry: entry, instance, device, phys, queue, queue_familie, uuid })
    }

    /// Speichertyp mit den geforderten Eigenschaften suchen.
    fn speichertyp(&self, erlaubt: u32, noetig: vk::MemoryPropertyFlags) -> Result<u32> {
        let props = unsafe { self.instance.get_physical_device_memory_properties(self.phys) };
        for i in 0..props.memory_type_count {
            if erlaubt & (1 << i) != 0
                && props.memory_types[i as usize].property_flags.contains(noetig)
            {
                return Ok(i);
            }
        }
        bail!("kein Speichertyp mit {noetig:?}")
    }

    /// Puffer im GERAETESPEICHER anlegen und seinen Speicher exportierbar
    /// machen. Geraetespeicher, weil das die Lage der spaeteren Zieltextur ist —
    /// ein host-sichtbarer Puffer waere ein anderer Fall und wuerde die Frage
    /// nicht beantworten.
    fn exportierbarer_puffer(&self, bytes: usize, dediziert: bool)
        -> Result<(vk::Buffer, vk::DeviceMemory, i32)>
    {
        let mut ext_info = vk::ExternalMemoryBufferCreateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let puffer = unsafe {
            self.device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(bytes as u64)
                    .usage(vk::BufferUsageFlags::TRANSFER_SRC | vk::BufferUsageFlags::TRANSFER_DST)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .push_next(&mut ext_info),
                None,
            )
        }?;

        let bedarf = unsafe { self.device.get_buffer_memory_requirements(puffer) };
        let typ = self.speichertyp(bedarf.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)?;

        let mut export = vk::ExportMemoryAllocateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let mut dedi = vk::MemoryDedicatedAllocateInfo::default().buffer(puffer);
        let mut info = vk::MemoryAllocateInfo::default()
            .allocation_size(bedarf.size)
            .memory_type_index(typ)
            .push_next(&mut export);
        if dediziert {
            info = info.push_next(&mut dedi);
        }
        let speicher = unsafe { self.device.allocate_memory(&info, None) }?;
        unsafe { self.device.bind_buffer_memory(puffer, speicher, 0) }?;

        // Der Deskriptor gehoert nach dem Holen UNS; CUDA uebernimmt ihn beim
        // Import und schliesst ihn selbst. Deshalb wird er hier nicht geschlossen
        // — ein doppeltes close waere ein Fehler, der erst viel spaeter auffiele.
        let fd_api = ash::khr::external_memory_fd::Device::new(&self.instance, &self.device);
        let fd = unsafe {
            fd_api.get_memory_fd(
                &vk::MemoryGetFdInfoKHR::default()
                    .memory(speicher)
                    .handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD),
            )
        }?;
        Ok((puffer, speicher, fd))
    }

    /// Host-sichtbarer Puffer zum Hinein- und Herauskopieren.
    fn ablage(&self, bytes: usize) -> Result<(vk::Buffer, vk::DeviceMemory)> {
        let puffer = unsafe {
            self.device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(bytes as u64)
                    .usage(vk::BufferUsageFlags::TRANSFER_SRC | vk::BufferUsageFlags::TRANSFER_DST)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE),
                None,
            )
        }?;
        let bedarf = unsafe { self.device.get_buffer_memory_requirements(puffer) };
        let typ = self.speichertyp(
            bedarf.memory_type_bits,
            vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
        )?;
        let speicher = unsafe {
            self.device.allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(bedarf.size)
                    .memory_type_index(typ),
                None,
            )
        }?;
        unsafe { self.device.bind_buffer_memory(puffer, speicher, 0) }?;
        Ok((puffer, speicher))
    }

    /// Eine Puffer-zu-Puffer-Kopie ausfuehren und auf ihr Ende warten.
    fn kopieren(&self, von: vk::Buffer, nach: vk::Buffer, bytes: usize) -> Result<()> {
        let pool = unsafe {
            self.device.create_command_pool(
                &vk::CommandPoolCreateInfo::default().queue_family_index(self.queue_familie),
                None,
            )
        }?;
        let cb = unsafe {
            self.device.allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1),
            )
        }?[0];
        unsafe {
            self.device.begin_command_buffer(
                cb,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )?;
            self.device.cmd_copy_buffer(
                cb,
                von,
                nach,
                &[vk::BufferCopy::default().size(bytes as u64)],
            );
            self.device.end_command_buffer(cb)?;
            let cbs = [cb];
            let submit = [vk::SubmitInfo::default().command_buffers(&cbs)];
            self.device.queue_submit(self.queue, &submit, vk::Fence::null())?;
            self.device.queue_wait_idle(self.queue)?;
            self.device.destroy_command_pool(pool, None);
        }
        Ok(())
    }

    fn lesen(&self, speicher: vk::DeviceMemory, bytes: usize) -> Result<Vec<u8>> {
        unsafe {
            let p = self.device.map_memory(speicher, 0, bytes as u64, vk::MemoryMapFlags::empty())?;
            let v = std::slice::from_raw_parts(p as *const u8, bytes).to_vec();
            self.device.unmap_memory(speicher);
            Ok(v)
        }
    }

    fn schreiben(&self, speicher: vk::DeviceMemory, daten: &[u8]) -> Result<()> {
        unsafe {
            let p = self.device.map_memory(
                speicher, 0, daten.len() as u64, vk::MemoryMapFlags::empty())?;
            std::ptr::copy_nonoverlapping(daten.as_ptr(), p as *mut u8, daten.len());
            self.device.unmap_memory(speicher);
        }
        Ok(())
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Erste abweichende Stelle suchen — und melden, WAS dort steht. Ein
/// verschobener Wert (Nachbarbyte) heisst etwas voellig anderes als eine Null:
/// das eine ist eine falsche Rechnung, das andere fehlender Speicher.
fn vergleichen(soll: &[u8], ist: &[u8]) -> Option<(usize, u8, u8)> {
    soll.iter()
        .zip(ist.iter())
        .position(|(a, b)| a != b)
        .map(|i| (i, soll[i], ist[i]))
}

/// Vergleichsergebnis fuer eine Richtung ausgeben; meldet per Rueckgabewert,
/// ob eine Abweichung auftrat (Aufrufer zaehlt das in `fehler` zusammen).
fn ergebnis_melden(richtung: &str, soll: &[u8], ist: &[u8]) -> bool {
    match vergleichen(soll, ist) {
        None => {
            println!("  {richtung}:  alle {} Bytes stimmen", soll.len());
            false
        }
        Some((i, s, g)) => {
            let abweichend = soll.iter().zip(ist).filter(|(a, b)| a != b).count();
            println!(
                "  {richtung}:  ABWEICHUNG bei Byte {i} (erwartet {s}, gelesen {g}); \
                 {abweichend} von {} abweichend",
                soll.len()
            );
            true
        }
    }
}

fn main() -> Result<()> {
    let bytes = groesse();
    let dediziert = std::env::var("SPIKE_DEDIZIERT").as_deref() != Ok("0");
    println!("Probe CUDA <-> Vulkan, {bytes} Bytes, dedizierte Allokation: {dediziert}");

    cuda::selbsttest_layout()?;
    println!("  Struct-Layouts gegen cuda.h geprueft: ok");

    let vk_seite = Vulkan::aufbauen()?;
    let c = Cuda::laden()?;

    unsafe { c.pruefe((c.cuInit)(0), "cuInit")? };
    let mut dev: cuda::CUdevice = 0;
    unsafe { c.pruefe((c.cuDeviceGet)(&mut dev, 0), "cuDeviceGet")? };
    let mut cu_uuid = [0u8; 16];
    unsafe { c.pruefe((c.cuDeviceGetUuid)(&mut cu_uuid, dev), "cuDeviceGetUuid")? };
    println!("  CUDA-Geraet 0: UUID {}", hex(&cu_uuid));

    // Reden beide ueber dieselbe Karte? Sonst ist jeder Befund wertlos.
    if cu_uuid != vk_seite.uuid {
        bail!(
            "Vulkan-Karte ({}) und CUDA-Karte ({}) sind verschieden — \
             die Probe wuerde etwas anderes messen als gemeint",
            hex(&vk_seite.uuid),
            hex(&cu_uuid)
        );
    }
    println!("  UUIDs stimmen ueberein — dieselbe Karte");

    let mut ctx: cuda::CUcontext = std::ptr::null_mut();
    unsafe {
        c.pruefe((c.cuDevicePrimaryCtxRetain)(&mut ctx, dev), "cuDevicePrimaryCtxRetain")?;
        c.pruefe((c.cuCtxSetCurrent)(ctx), "cuCtxSetCurrent")?;
    }

    // ── Vulkan legt den geteilten Speicher an und exportiert ihn ────────────
    let (geteilt, geteilt_mem, fd) = vk_seite.exportierbarer_puffer(bytes, dediziert)?;
    println!("  Vulkan-Speicher exportiert, Deskriptor {fd}");

    // ── CUDA haengt ihn ein ─────────────────────────────────────────────────
    // Das Flag fuer die dedizierte Allokation muss zur Vulkan-Seite passen —
    // die Begruendung steht am Konstruktor.
    let beschreibung = cuda::ExternalMemoryHandleDesc::fuer_fd(fd, bytes as u64, dediziert);
    let mut ext_mem: cuda::CUexternalMemory = std::ptr::null_mut();
    unsafe {
        c.pruefe(
            (c.cuImportExternalMemory)(&mut ext_mem, &beschreibung),
            "cuImportExternalMemory",
        )?
    };
    let mut zeiger: cuda::CUdeviceptr = 0;
    let puffer_desc = cuda::ExternalMemoryBufferDesc {
        offset: 0,
        size: bytes as u64,
        ..Default::default()
    };
    unsafe {
        c.pruefe(
            (c.cuExternalMemoryGetMappedBuffer)(&mut zeiger, ext_mem, &puffer_desc),
            "cuExternalMemoryGetMappedBuffer",
        )?
    };
    println!("  CUDA hat ihn eingehaengt, Geraetezeiger 0x{zeiger:x}");

    let (ablage, ablage_mem) = vk_seite.ablage(bytes)?;
    let soll: Vec<u8> = (0..bytes).map(muster).collect();
    let mut fehler = 0usize;

    // ── Hauptfall: CUDA schreibt, Vulkan liest ──────────────────────────────
    // Das ist die Richtung, auf die es fuer den Player ankommt.
    unsafe {
        c.pruefe((c.cuMemsetD8)(zeiger, 0, bytes), "cuMemsetD8")?;
        c.pruefe(
            (c.cuMemcpyHtoD)(zeiger, soll.as_ptr() as *const c_void, bytes),
            "cuMemcpyHtoD",
        )?;
        c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize")?;
    }
    vk_seite.kopieren(geteilt, ablage, bytes)?;
    let gelesen = vk_seite.lesen(ablage_mem, bytes)?;
    if ergebnis_melden("CUDA schreibt -> Vulkan liest", &soll, &gelesen) {
        fehler += 1;
    }

    // ── Gegenrichtung: Vulkan schreibt, CUDA liest ──────────────────────────
    // Nicht der Anwendungsfall, aber sie trennt zwei Ursachen: schluege nur der
    // Hauptfall fehl, laege es an der Schreibrichtung, nicht am geteilten
    // Speicher.
    let soll2: Vec<u8> = (0..bytes).map(|i| muster(i.wrapping_add(12345))).collect();
    vk_seite.schreiben(ablage_mem, &soll2)?;
    vk_seite.kopieren(ablage, geteilt, bytes)?;
    let mut zurueck = vec![0u8; bytes];
    unsafe {
        c.pruefe(
            (c.cuMemcpyDtoH)(zurueck.as_mut_ptr() as *mut c_void, zeiger, bytes),
            "cuMemcpyDtoH",
        )?;
        c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize")?;
    }
    if ergebnis_melden("Vulkan schreibt -> CUDA liest", &soll2, &zurueck) {
        fehler += 1;
    }

    // ── Kontrolle: schlaegt die Pruefung ueberhaupt an? ─────────────────────
    // Ohne sie waere "alles stimmt" nicht von "die Pruefung vergleicht nichts"
    // zu unterscheiden — dieselbe Klasse Werkzeugfehler, die in diesem Labor
    // schon mehrfach falsche Befunde erzeugt hat.
    let mut verdorben = soll2.clone();
    verdorben[bytes / 2] ^= 0xFF;
    if vergleichen(&verdorben, &zurueck).is_none() {
        bail!("Kontrolle fehlgeschlagen: ein absichtlich verfaelschtes Byte fiel NICHT auf");
    }
    println!("  Kontrolle: ein verfaelschtes Byte faellt auf — die Pruefung greift");

    unsafe {
        c.pruefe((c.cuDestroyExternalMemory)(ext_mem), "cuDestroyExternalMemory")?;
        vk_seite.device.destroy_buffer(geteilt, None);
        vk_seite.device.free_memory(geteilt_mem, None);
        vk_seite.device.destroy_buffer(ablage, None);
        vk_seite.device.free_memory(ablage_mem, None);
    }

    println!();
    if fehler == 0 {
        println!("URTEIL: der Weg traegt. CUDA und Vulkan teilen sich den Speicher.");
        Ok(())
    } else {
        bail!("URTEIL: der Weg traegt NICHT ({fehler} von 2 Richtungen abweichend)");
    }
}
