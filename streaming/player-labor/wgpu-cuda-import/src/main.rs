//! Probe: nimmt **wgpu 29** ein fremd angelegtes `VkImage` entgegen — und
//! behaelt es dessen Inhalt?
//!
//! Das ist der zweite Schritt auf dem Weg zum Zero-Copy-Player unter
//! Linux/NVIDIA. Der erste ist beantwortet: CUDA und Vulkan teilen sich hier
//! denselben Speicher, und CUDA schreibt direkt in exportierte Vulkan-Bilder
//! (Messakten `player-2026-08-06-cuda-vulkan-linux.json` und
//! `player-2026-08-07-cuda-vulkan-bild-import.json`). Was fehlt, ist die
//! Anbindung an den Renderer des Players — und der steht auf **wgpu 29.0.4**.
//!
//! Haelt 29 den Inhalt, ist der Weg frei. Haelt er ihn nicht, ist die naechste
//! Stufe ein Hauptversionssprung mitten im Renderer (wgpu 30 →
//! `egui-wgpu`/`egui-winit` 0.36 → Rust 1.95), dessen Nutzen **unbelegt** ist:
//! der einzige einschlaegige Neuzugang dort (`initial_state`) wurde auf der
//! Windows-Seite geprueft und als Ursache widerlegt. Deshalb wird hier
//! gemessen, statt erwartet.
//!
//! Rueckgabewert 0 = der gepruefte Weg traegt (bei der Gegenprobe: sie hat
//! bestanden).

mod abtasten;
mod cudaseite;
mod ebene;
mod pruefen;
mod uebernahme;
mod vkseite;

// Die CUDA-Bindungen kommen aus der Nachbarprobe statt aus einer Kopie: ihre
// von Hand nachgebauten Struct-Layouts sind der heikelste Teil des Ganzen (ein
// falscher Feld-Versatz erzeugt keinen Fehler, sondern stille Falschergebnisse),
// und sie tragen einen Selbsttest gegen ein kompiliertes `sizeof`/`offsetof`
// aus `cuda.h`. Zwei Fassungen davon waeren genau die Fehlerklasse, gegen die
// dieser Selbsttest steht.
#[path = "../../cuda-vulkan-import/src/cuda/mod.rs"]
mod cuda;

use anyhow::{bail, Context, Result};

use cuda::Cuda;
use vkseite::Vkseite;

pub struct Schalter {
    pub dediziert: bool,
    pub layout_um: bool,
    pub ohne_schreiben: bool,
    pub runden: u32,
    /// Vulkan-Pruefschicht an. Steht hier mit im Schalterblock, damit die
    /// gemeldete Lage und die tatsaechlich aufgebaute Instanz denselben Wert
    /// benutzen — zwei getrennte Abfragen derselben Umgebungsgroesse koennten
    /// auseinandergehen und die Lauf-Zeile wuerde dann etwas anderes
    /// behaupten, als der Lauf tut.
    pub pruefschicht: bool,
    /// **Kontrolle fuer die Pruefschicht.** Baut einen echten Regelverstoss
    /// ein (eine Sperre, die ein falsches altes Layout behauptet). Ohne so
    /// einen Lauf waere „die Pruefschicht meldet nichts" nicht von „die
    /// Pruefschicht ist nicht zu hoeren" zu unterscheiden — und genau das war
    /// hier zuerst der Fall.
    pub verstoss: bool,
}

/// Ein Empfaenger fuer `log`, in Handarbeit. Die Pruefschicht meldet ueber
/// wgpu, wgpu ueber `log`; ohne Empfaenger ist sie stumm.
struct Mitschreiber;

impl log::Log for Mitschreiber {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, r: &log::Record) {
        // Nur Warnungen und Fehler: `info`/`debug` von wgpu und ash sind
        // hunderte Zeilen und wuerden den Befund zudecken.
        if r.level() <= log::Level::Warn {
            println!("  [{}] {}: {}", r.level(), r.target(), r.args());
        }
    }
    fn flush(&self) {}
}

static MITSCHREIBER: Mitschreiber = Mitschreiber;

fn zahl(name: &str, vorgabe: u32) -> u32 {
    std::env::var(name).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(vorgabe)
}

fn an(name: &str, vorgabe: bool) -> bool {
    match std::env::var(name).as_deref().map(str::trim) {
        Ok("1") => true,
        Ok("0") => false,
        _ => vorgabe,
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() -> Result<()> {
    log::set_logger(&MITSCHREIBER).ok();
    log::set_max_level(log::LevelFilter::Warn);
    let breite = zahl("SPIKE_BREITE", 2560);
    let hoehe = zahl("SPIKE_HOEHE", 1440);
    let s = Schalter {
        dediziert: an("SPIKE_DEDIZIERT", true),
        layout_um: an("SPIKE_LAYOUT_UM", true),
        ohne_schreiben: an("SPIKE_OHNE_SCHREIBEN", false),
        runden: zahl("SPIKE_RUNDEN", 3),
        pruefschicht: an("SPIKE_PRUEFSCHICHT", false),
        verstoss: an("SPIKE_VERSTOSS", false),
    };
    println!(
        "Lauf: {breite}x{hoehe}, dedizierte Allokation: {}, Layout-Wechsel um den \
         CUDA-Zugriff: {}, Betriebsrunden: {}, Gegenprobe ohne Schreiben: {}, \
         Pruefschicht: {}, absichtlicher Verstoss: {}",
        s.dediziert,
        s.layout_um,
        s.runden,
        s.ohne_schreiben,
        s.pruefschicht,
        s.verstoss
    );

    cuda::selbsttest_layout()?;
    println!("Struct-Layouts gegen cuda.h geprueft: ok");

    let (device, queue, v) = wgpu_aufbauen(s.pruefschicht)?;
    let c = cuda_aufbauen(&v)?;

    let mut befunde = Vec::new();
    for (bezeichnung, zehn_bit) in [("NV12 (8 bit)", false), ("P010 (10 bit)", true)] {
        println!("\n=== {bezeichnung} als zwei getrennte Bilder ===");
        for e in ebene::ebenen(zehn_bit, breite, hoehe) {
            befunde.push(pruefen::ebene_pruefen(&v, &c, &device, &queue, &e, &s)?);
        }
    }

    urteil(&befunde, &s)
}

/// wgpu aufbauen und die rohen Vulkan-Griffe daraus entnehmen.
///
/// Hier faellt bereits eine Vorentscheidung: **hat wgpus Geraet
/// `VK_KHR_external_memory_fd` an?** wgpu-hal 29 fordert sie an, wenn die Karte
/// sie anbietet (`vulkan/adapter.rs:1296`) — aber „fordert an, wenn" ist keine
/// Zusage. Ohne sie gaebe es keinen Dateideskriptor und der Weg waere bei
/// wgpu 29 zu, ganz unabhaengig von jeder Zustandsfrage.
fn wgpu_aufbauen(pruefschicht: bool) -> Result<(wgpu::Device, wgpu::Queue, Vkseite)> {
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
        let erweiterungen: Vec<String> =
            hal.enabled_device_extensions().iter().map(|c| c.to_string_lossy().into_owned()).collect();
        let noetige = "VK_KHR_external_memory_fd";
        if !erweiterungen.iter().any(|e| e == noetige) {
            bail!(
                "wgpus Geraet hat {noetige} NICHT an — ohne sie laesst sich kein \
                 Speicher an CUDA weiterreichen. Der Weg ist bei wgpu 29 damit zu, \
                 und zwar aus einem anderen Grund als der Zustandsfrage."
            );
        }
        println!("  {noetige} am wgpu-Geraet: an");
        Vkseite::neu(
            hal.raw_device().clone(),
            hal.shared_instance().raw_instance().clone(),
            hal.raw_physical_device(),
            hal.raw_queue(),
            hal.queue_family_index(),
        )
    };
    Ok((device, queue, v))
}

/// CUDA hochfahren und gegen die Karte abgleichen, die wgpu benutzt.
fn cuda_aufbauen(v: &Vkseite) -> Result<Cuda> {
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

/// Stufe D in einem Wort — abweichende Texel beim ersten wgpu-Zugriff.
fn erstes_bild_text(abweichend: usize) -> String {
    if abweichend == 0 {
        String::from("ok")
    } else {
        format!("{abweichend} abweichend")
    }
}

/// Stufe F in einem Wort. „keine" ist ein eigener Fall und nicht dasselbe wie
/// „0 von 0 ok": bei der Gegenprobe laeuft die Stufe gar nicht, und das darf
/// nicht wie ein bestandener Betriebslauf aussehen.
fn runden_text(runden: &[usize]) -> String {
    if runden.is_empty() {
        String::from("keine")
    } else if runden.iter().all(|&n| n == 0) {
        format!("{} von {} ok", runden.len(), runden.len())
    } else {
        format!("{runden:?} abweichend")
    }
}

/// Das Urteil — und bei der Gegenprobe das **umgekehrte** Urteil.
///
/// Die Umkehrung steht hier im Programm und nicht in der Anleitung: eine
/// Gegenprobe, deren Ergebnis man selbst noch auslegen muss, wird beim
/// naechsten Mal falsch ausgelegt.
fn urteil(befunde: &[pruefen::Befund], s: &Schalter) -> Result<()> {
    println!();
    let getragen = befunde.iter().filter(|b| b.traegt()).count();
    let alle = befunde.len();

    if s.ohne_schreiben {
        return if getragen == 0 {
            println!(
                "URTEIL DER GEGENPROBE: bestanden. Ohne CUDA-Schreibzugriff weicht jede \
                 der {alle} Ebenen ab — ein Erfolg im Hauptlauf ist also kein Artefakt \
                 der Pruefmechanik."
            );
            Ok(())
        } else {
            bail!(
                "URTEIL DER GEGENPROBE: DURCHGEFALLEN. {getragen} von {alle} Ebenen galten \
                 als fehlerfrei, OBWOHL CUDA nichts geschrieben hat — die Probe misst nicht, \
                 was sie zu messen behauptet."
            )
        };
    }

    for b in befunde {
        println!(
            "  {:<26} erstes Bild: {} | Inhalt nach wgpu im Speicher: {} | Betriebsrunden: {}",
            b.name,
            erstes_bild_text(b.erste_runde),
            if b.inhalt_bleibt { "ja" } else { "NEIN" },
            runden_text(&b.runden)
        );
    }
    println!();

    if getragen == alle {
        println!(
            "URTEIL: wgpu 29 traegt. Ein fremd angelegtes VkImage kommt mitsamt Inhalt in \
             der Textur an ({getragen} von {alle} Ebenen fehlerfrei, erstes Bild wie \
             Betriebsrunden). Der Sprung auf wgpu 30 ist damit nicht noetig."
        );
        return Ok(());
    }

    // Der Fall, der eine eigene Aussage verdient: das erste Bild geht verloren,
    // alle spaeteren kommen an. Fuer einen Player ist das brauchbar — es kostet
    // ein Bild — und es ist zugleich der Fingerabdruck des vermuteten
    // UNDEFINED-Uebergangs, der nur EINMAL stattfindet.
    let nur_erstes = befunde.iter().all(|b| b.traegt_ab_zweitem_bild());
    if nur_erstes {
        let verworfen = befunde.iter().filter(|b| !b.inhalt_bleibt).count();
        bail!(
            "URTEIL: wgpu 29 verliert das ERSTE Bild, traegt aber ab dem zweiten \
             ({verworfen} von {alle} Ebenen hatten den Inhalt nach dem wgpu-Zugriff auch \
             im Speicher nicht mehr). Das passt zum Uebergang aus UNDEFINED, der genau \
             einmal stattfindet. Fuer den Player heisst das: ein Bild Vorlauf, kein \
             Grund fuer wgpu 30 — aber es gehoert gemessen, nicht angenommen."
        )
    }
    bail!(
        "URTEIL: wgpu 29 traegt NICHT ({getragen} von {alle} Ebenen fehlerfrei). \
         Trennschnitt: wo 'Inhalt nach wgpu im Speicher' JA sagt, liest wgpu anderen \
         Speicher; wo es NEIN sagt, ist der Inhalt verworfen worden."
    )
}
