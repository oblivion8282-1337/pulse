//! `pulse-player --hdr-auskunft` — beide HDR-Fragen stellen und die **Zahlen**
//! dazu ausgeben.
//!
//! **Warum es das gibt.** Der Player beantwortet die zwei Fragen im Betrieb und
//! schreibt das Ergebnis ins Log. Ein Logsatz „HDR: nein" laesst aber offen, ob
//! der Treiber den Farbraum nicht traegt, ob der Schirm in SDR laeuft oder ob
//! eine Abfrage stillschweigend fehlgeschlagen ist — drei ganz verschiedene
//! Befunde mit derselben Zeile. Hier stehen die Eingangsgroessen.
//!
//! **Es geht durch dieselben Funktionen wie der Betrieb** ([`super::hdr_vulkan`],
//! [`super::hdr_schirm`]) und legt dafuer ein echtes Fenster mit echter
//! Oberflaeche an. Ein nachgebauter Prueffall waere als Beleg wertlos: gemessen
//! wuerde der Nachbau.
//!
//! Es belegt kurz die Grafikkarte und oeffnet ein Fenster — bei einer laufenden
//! Messreihe also erst die GPU-Sperre nehmen.

use std::sync::Arc;

use anyhow::{Context, Result};
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowId};

/// Beide Fragen stellen und beantworten.
pub fn ausfuehren() -> Result<()> {
    schirm_bericht();
    fenster_bericht()
}

/// Frage 2: was sagt der Compositor ueber die Ausgaenge?
fn schirm_bericht() {
    println!("== Frage 2: laeuft ein Schirm in HDR? (wp_color_manager_v1) ==");
    let Some(wacht) = super::hdr_schirm::Schirmwacht::starten() else {
        println!("  kein wp_color_manager_v1 erreichbar — die Frage ist hier nicht zu stellen");
        return;
    };
    // Ein kurzer Moment: die Beschreibungen kommen als Ereignisfolge, nicht als
    // Antwort auf eine Anfrage.
    std::thread::sleep(std::time::Duration::from_millis(200));
    let alle = wacht.alles();
    if alle.is_empty() {
        println!("  Farbverwaltung da, aber kein Ausgang hat sich gemeldet");
    }
    for (name, l) in alle {
        println!(
            "  {name}: max {} cd/m², Bezugsweiss {} cd/m², Verhaeltnis {:.2} -> {}",
            l.max,
            l.bezugsweiss,
            if l.bezugsweiss > 0.0 { l.max / l.bezugsweiss } else { 0.0 },
            if l.ist_hdr() { "HDR" } else { "SDR" },
        );
    }
}

/// Frage 1: traegt die Oberflaeche des Fensters scRGB-linear?
fn fenster_bericht() -> Result<()> {
    println!("\n== Frage 1: kann das Fenster HDR ausgeben? (Vulkan) ==");
    let ereignisse = EventLoop::new().context("keine Fenster-Ereignisschleife")?;
    let mut lauf = Lauf { fehler: None };
    ereignisse.run_app(&mut lauf).context("Ereignisschleife abgebrochen")?;
    match lauf.fehler {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

struct Lauf {
    fehler: Option<anyhow::Error>,
}

impl ApplicationHandler for Lauf {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        // **Sichtbar und winzig.** Ein unsichtbares Fenster bekommt unter
        // manchen Compositoren gar keine Oberflaeche, und dann waere die
        // Antwort ein Artefakt der Auskunft statt ein Befund.
        let attrs = Window::default_attributes()
            .with_title("pulse-player — HDR-Auskunft")
            .with_inner_size(winit::dpi::LogicalSize::new(320.0, 200.0))
            .with_active(false);
        match event_loop.create_window(attrs) {
            Ok(w) => self.fehler = berichten(Arc::new(w)).err(),
            Err(e) => self.fehler = Some(e.into()),
        }
        event_loop.exit();
    }

    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, _: WindowEvent) {}
}

/// Die Oberflaeche genauso anlegen wie der Player und den Treiber fragen.
fn berichten(window: Arc<Window>) -> Result<()> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..wgpu::InstanceDescriptor::new_with_display_handle_from_env(Box::new(window.clone()))
    });
    let surface = instance.create_surface(window).context("keine Oberflaeche")?;
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: Some(&surface),
        force_fallback_adapter: false,
    }))
    .context("keine passende GPU")?;

    let info = adapter.get_info();
    println!("  Karte: {} ({:?})", info.name, info.backend);

    let Some(formate) = super::hdr_vulkan::oberflaechenformate(&adapter, &surface) else {
        println!("  kein Vulkan — die Frage ist auf diesem Weg nicht zu stellen");
        return Ok(());
    };
    println!("  Der Treiber meldet {} Format/Farbraum-Paare fuer diese Oberflaeche.", formate.len());
    let gesucht: Vec<_> = formate
        .iter()
        .filter(|f| f.format == ash::vk::Format::R16G16B16A16_SFLOAT)
        .map(|f| format!("{:?}", f.color_space))
        .collect();
    println!("  Davon mit fp16 ({} Stueck): {}", gesucht.len(), gesucht.join(", "));
    let moeglich = super::hdr_vulkan::weiter_farbraum_moeglich(&adapter, &surface);
    println!(
        "  scRGB-linear in fp16 (das Paar, das wgpu fuer Rgba16Float setzt): {}",
        match moeglich {
            Some(true) => "JA",
            Some(false) => "nein",
            None => "nicht gefragt",
        }
    );
    probeschaltung(&adapter, &surface)
}

/// **Die dritte Stufe der Kette, und die einzige, die wirklich schaltet.**
///
/// Dass der Treiber das Paar meldet, heisst noch nicht, dass eine Swapchain
/// damit auch zustande kommt — dazwischen liegen die Formatliste von wgpu, die
/// Merkmale des Geraets und `vkCreateSwapchainKHR` selbst. Hier wird die
/// Oberflaeche wirklich auf [`super::HDR_OBERFLAECHE`] gelegt und danach
/// nachgesehen, ob eine native Vulkan-Swapchain steht und ein Bild
/// herausfaellt.
///
/// Was auch das NICHT belegt: dass der Compositor die Werte am Ende als
/// lineares scRGB auf den Schirm bringt. Dafuer braeuchte es ein Messgeraet vor
/// dem Bildschirm.
fn probeschaltung(adapter: &wgpu::Adapter, surface: &wgpu::Surface<'static>) -> Result<()> {
    let caps = surface.get_capabilities(adapter);
    if !caps.formats.contains(&super::HDR_OBERFLAECHE) {
        println!("  Probeschaltung: wgpu bietet {:?} gar nicht an", super::HDR_OBERFLAECHE);
        return Ok(());
    }
    let (device, _queue, _) =
        pollster::block_on(super::geraet_oeffnen(adapter, "pulse-player-hdr-auskunft"))?;
    let mut config = surface
        .get_default_config(adapter, 320, 200)
        .context("keine Vorgabe-Einstellung fuer diese Oberflaeche")?;
    config.format = super::HDR_OBERFLAECHE;
    surface.configure(&device, &config);
    let nativ = super::hdr_vulkan::swapchain_ist_nativ(surface);
    let bild = matches!(
        surface.get_current_texture(),
        wgpu::CurrentSurfaceTexture::Success(_) | wgpu::CurrentSurfaceTexture::Suboptimal(_)
    );
    println!(
        "  Probeschaltung auf {:?}: native Vulkan-Swapchain {}, Bild abholbar {}",
        super::HDR_OBERFLAECHE,
        if nativ { "ja" } else { "NEIN" },
        if bild { "ja" } else { "NEIN" },
    );
    Ok(())
}
