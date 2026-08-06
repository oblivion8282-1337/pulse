//! Machbarkeitsnachweis: dekodierte D3D11-Textur ohne Umweg ueber den
//! Hauptspeicher in wgpu abtasten.
//!
//! Beantwortet genau eine Frage, und zwar nachpruefbar: kommt der Inhalt einer
//! geteilten D3D11-NV12/P010-Textur unveraendert in einem wgpu-Renderdurchgang
//! an — **auf dem Backend und in der wgpu-Fassung, die der Player wirklich
//! faehrt**? Alles andere (Decoder anbinden, Synchronisierung) haengt daran.
//!
//! **Diese Crate stand bis zum 2026-08-06 auf wgpu 30 und mass nur ueber
//! Vulkan. Beides ist falsch fuer die Frage, um die es geht**, und das hat
//! bereits einen Anlauf gekostet: der Player steht auf wgpu **29.0.4** und
//! nimmt unter Windows seit demselben Tag **D3D12** (`render/setup.rs`, ohne
//! das gibt es kein HDR im Fenster). Die frueheren Zahlen gelten fuer den
//! Vulkan-Weg und bleiben als solche in der README stehen — sie sagen ueber den
//! D3D12-Weg nichts.
//!
//! Der frueher hier stehende Schalter `SPIKE_ZUSTAND` ist mit dem Rueckgang auf
//! wgpu 29 weggefallen: `create_texture_from_hal` nimmt dort gar keinen
//! `initial_state` entgegen. Das ist kein Verlust — die volle Matrix ueber drei
//! Anfangszustaende war am 2026-08-06 gemessen und hat den Zustand als
//! entscheidende Groesse ausgeschlossen (Einzelheiten in der README).
//!
//! Aufbau in Stufen, jede mit eigenem Urteil, damit ein Fehlschlag verortbar
//! ist statt nur „geht nicht":
//!   1. Bietet der Adapter das Format an (und, auf Vulkan, externen Speicher)?
//!   2. Laesst sich eine geteilte Textur in D3D11 anlegen und fuellen?
//!   3. Nimmt wgpu sie entgegen?
//!   4. Stimmen die abgetasteten Werte mit den geschriebenen ueberein?

mod bildformat;
mod d3d11;
mod einblenden;
mod pruefen;
mod rueckprobe;
mod zeichnen;

use bildformat::{Bildformat, BREITE, HOEHE};
use einblenden::Weg;

fn main() {
    let code = lauf();
    std::process::exit(code);
}

/// Was geprueft wird — alles aus der Umgebung, damit ein Lauf ohne Argumente
/// den Fall des Players trifft.
pub struct Wahl {
    weg: Weg,
    pub format: Bildformat,
    schichten: u32,
    /// Welche Schicht abgetastet wird. Vorgabe ist die LETZTE, nicht die erste:
    /// ein Weg, der immer Schicht 0 liest, faellt sonst gar nicht auf.
    pub schicht: u32,
    mit_mutex: bool,
    /// `D3D11_BIND_DECODER` auch bei einer Einzeltextur setzen — die Bauart,
    /// die FFmpegs D3D11VA-Pool immer waehlt (s. `d3d11::quelle`).
    decoder_flag: bool,
    /// Wie oft die Quelle nach dem Einhaengen mit neuem Inhalt ueberschrieben
    /// und erneut geprueft wird (Stufe 4b, der Betriebsfall).
    wiederholungen: u32,
}

impl Wahl {
    fn aus_umgebung() -> Self {
        let format = match std::env::var("SPIKE_FORMAT").as_deref() {
            Ok("p010") => Bildformat::P010,
            _ => Bildformat::Nv12,
        };
        let schichten: u32 = std::env::var("SPIKE_SCHICHTEN")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .filter(|n| *n >= 1)
            .unwrap_or(1);
        let schicht: u32 = std::env::var("SPIKE_SCHICHT")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .filter(|n| *n < schichten)
            .unwrap_or(schichten - 1);
        Self {
            weg: Weg::aus_umgebung(),
            format,
            schichten,
            schicht,
            // Vorgabe: mit Mutex (die vorschriftsmaessige Bauart).
            mit_mutex: std::env::var("SPIKE_MUTEX").as_deref() != Ok("0"),
            decoder_flag: std::env::var("SPIKE_DECODER").as_deref() == Ok("1"),
            // Vorgabe 3, nicht 0: der Betriebsfall soll bei einem nackten Lauf
            // mitgeprueft werden, nicht nur auf Anforderung.
            wiederholungen: std::env::var("SPIKE_WIEDERHOLT")
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(3),
        }
    }
}

fn lauf() -> i32 {
    let wahl = Wahl::aus_umgebung();

    println!("== Stufe 1: Adapter ==");
    let mut beschreibung = wgpu::InstanceDescriptor::new_without_display_handle();
    beschreibung.backends = wahl.weg.backends();
    // Pruefschicht nur auf Anforderung: sie kostet Zeit und faelscht die
    // Einblendzeit, ist aber das Einzige, was einen regelwidrigen Import selbst
    // benennt.
    if std::env::var("SPIKE_PRUEFSCHICHT").as_deref() == Ok("1") {
        beschreibung.flags |= wgpu::InstanceFlags::VALIDATION | wgpu::InstanceFlags::DEBUG;
    }
    let instance = wgpu::Instance::new(beschreibung);
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    })) else {
        println!("FEHLER: kein {}-Adapter", wahl.weg.name());
        return 1;
    };
    let info = adapter.get_info();
    println!("Weg        {}", wahl.weg.name());
    println!("GPU        {} ({:?}, {})", info.name, info.backend, info.driver);

    let f = adapter.features();
    let noetig = wahl.format.merkmal() | wahl.weg.zusatzmerkmale();
    let fehlend = noetig - f;
    println!(
        "Format     {} — {}",
        wahl.format.name(),
        if f.contains(wahl.format.merkmal()) { "ja" } else { "NEIN" }
    );
    if wahl.weg == Weg::Vulkan {
        println!(
            "ext. Speicher (Win32)  {}",
            if f.contains(wgpu::Features::VULKAN_EXTERNAL_MEMORY_WIN32) { "ja" } else { "NEIN" }
        );
    }
    println!("Stapel     {} Schicht(en), geprueft wird Schicht {}", wahl.schichten, wahl.schicht);
    if !fehlend.is_empty() {
        println!("\nURTEIL: Der Weg ist auf dieser GPU nicht gangbar — es fehlt {fehlend:?}.");
        return 1;
    }

    // Bei 10 Bit reicht ein 8-Bit-Ziel nicht: es kappte die unteren zwei Bit
    // und liesse damit genau den Fehler durch, um den es hier geht.
    // `Rgba32Float` ist im Kern von wgpu darstellbar und verlustfrei — ein
    // 16-Bit-Norm-Ziel braeuchte ein weiteres Merkmal.
    let zielformat = match wahl.format {
        Bildformat::Nv12 => wgpu::TextureFormat::Rgba8Unorm,
        Bildformat::P010 => wgpu::TextureFormat::Rgba32Float,
    };

    let Ok((device, queue)) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("nv12-import"),
        required_features: noetig,
        ..Default::default()
    })) else {
        println!("FEHLER: Geraet mit {noetig:?} liess sich nicht oeffnen");
        return 1;
    };

    println!(
        "\n== Stufe 2: geteilte D3D11-Textur, {} ({}{}) ==",
        wahl.format.name(),
        if wahl.mit_mutex { "mit Schluessel-Mutex" } else { "ohne Mutex, schlicht geteilt" },
        if wahl.decoder_flag || wahl.schichten > 1 { ", BIND_DECODER" } else { "" }
    );
    let quelle =
        match d3d11::quelle(wahl.mit_mutex, wahl.format, wahl.schichten, wahl.decoder_flag) {
        Ok(q) => q,
        Err(e) => {
            println!("FEHLER: {e}");
            return 1;
        }
    };
    println!(
        "angelegt, gefuellt, Handle steht ({BREITE}x{HOEHE}, {}, {} Schicht(en))",
        wahl.format.name(),
        wahl.schichten
    );
    match rueckprobe::rueckprobe(&quelle) {
        Ok(0) => println!("Rueckprobe ueber D3D11: Inhalt steht vollstaendig in der Textur"),
        Ok(n) => {
            println!("Rueckprobe ueber D3D11: {n} Werte abweichend");
            println!("\nURTEIL: Der Inhalt kommt schon in D3D11 nicht an — das ist kein");
            println!("        wgpu-Problem. Fuellweg fuer {} pruefen.", wahl.format.name());
            return 1;
        }
        Err(e) => println!("Rueckprobe nicht moeglich ({e}) — Stufe 4 bleibt damit mehrdeutig"),
    }

    println!("\n== Stufe 3: Einblenden in wgpu ueber {} ==", wahl.weg.name());
    let (ebene0, ebene1) = wahl.format.ebenen();
    let (textur, einblendzeit) = match einblenden::einhaengen(
        wahl.weg,
        &device,
        quelle.handle,
        wahl.format,
        wahl.schichten,
    ) {
        Ok(t) => t,
        Err(e) => {
            println!("FEHLER: {e}");
            return 1;
        }
    };
    println!("eingeblendet in {:.3} ms", einblendzeit.as_secs_f64() * 1000.0);

    // **Die Ansicht zeigt auf GENAU EINE Schicht.** `base_array_layer` waehlt
    // sie, `array_layer_count: 1` macht daraus eine gewoehnliche 2D-Ansicht —
    // sonst waere es eine Feld-Ansicht, und der Shader muesste ein
    // `texture_2d_array` binden. Fuer den Player ist die Einzelansicht der
    // richtige Fall: FFmpeg reicht den Schichtindex je Bild in `data[1]` mit,
    // und der Shader soll davon nichts wissen muessen.
    let ansicht = |name: &'static str, fmt: wgpu::TextureFormat, a: wgpu::TextureAspect| {
        textur.create_view(&wgpu::TextureViewDescriptor {
            label: Some(name),
            format: Some(fmt),
            aspect: a,
            dimension: Some(wgpu::TextureViewDimension::D2),
            base_array_layer: wahl.schicht,
            array_layer_count: Some(1),
            ..Default::default()
        })
    };
    let y_view = ansicht("y", ebene0, wgpu::TextureAspect::Plane0);
    let uv_view = ansicht("uv", ebene1, wgpu::TextureAspect::Plane1);
    println!(
        "Ebenen-Ansichten angelegt (Plane0 als {ebene0:?}, Plane1 als {ebene1:?}, Schicht {})",
        wahl.schicht
    );

    println!("\n== Stufe 4: abtasten und nachrechnen ==");
    let werte = zeichnen::zeichnen(&device, &queue, &y_view, &uv_view, zielformat);
    let (mut fehler, erstes) = pruefen::auswerten(&wahl, &werte, 0);
    println!("Bildpunkte geprueft: {}, abweichend: {fehler}", (BREITE * HOEHE) as usize);
    if let Some(e) = &erstes {
        println!("erste Abweichung  {e}");
    }

    // Stufe 4b: der Betriebsfall. Erst wenn wiederholtes Beschreiben durch
    // D3D11 in der bereits eingehaengten wgpu-Textur ankommt, taugt der Weg
    // fuer einen Player — sonst stuende ab dem zweiten Bild ein Standbild.
    if fehler == 0 && wahl.wiederholungen > 0 {
        println!("\n== Stufe 4b: {} Wiederholungen mit neuem Inhalt ==", wahl.wiederholungen);
        for runde in 1..=wahl.wiederholungen {
            if let Err(e) = d3d11::neu_fuellen(&quelle, runde) {
                println!("FEHLER beim Neubefuellen (Runde {runde}): {e}");
                fehler += 1;
                break;
            }
            let werte = zeichnen::zeichnen(&device, &queue, &y_view, &uv_view, zielformat);
            let (f, erstes) = pruefen::auswerten(&wahl, &werte, runde);
            println!("Runde {runde}: abweichend {f}");
            if f > 0 {
                fehler += f;
                if let Some(e) = erstes {
                    println!("  erste Abweichung  {e}");
                }
                break;
            }
        }
    }

    // Stufe 5 laeuft NUR, wenn Stufe 4 schwarz war — sonst ist die Frage, die
    // sie beantwortet, schon beantwortet. Sie riss beim ersten Versuch das
    // Geraet mit (`Parent device is lost`), deshalb nur auf Anforderung.
    if fehler > 0 && std::env::var("SPIKE_GEGENRICHTUNG").as_deref() == Ok("1") {
        if let Some(code) = pruefen::gegenrichtung(&wahl, &device, &queue, &textur, &quelle) {
            return code;
        }
    }

    println!();
    if fehler == 0 {
        println!("URTEIL: Der Weg traegt ueber {}. Eine D3D11-{}-Textur kommt", wahl.weg.name(), wahl.format.name());
        println!("        ohne Umweg ueber den Hauptspeicher unveraendert im Shader an.");
        println!();
        println!("Was dieser Nachweis NICHT zeigt, und was am Player noch zu tun ist:");
        println!("  - NEBENLAEUFIGE Synchronisierung. Stufe 4b schreibt und liest");
        println!("    abwechselnd auf EINEM Thread; im Betrieb schreibt der Decoder,");
        println!("    waehrend gezeichnet wird. Ohne Zaun sieht der Shader halbe Bilder.");
        println!("  - Den Textur-STAPEL. Der traegt hier nicht (s. README), und der");
        println!("    D3D11VA-Decoder liefert nur in dieser Form — der Player muss das");
        println!("    Bild also GPU-seitig in eine eigene geteilte Textur umkopieren.");
        0
    } else {
        println!("URTEIL: Der Import gelingt, aber der Inhalt stimmt nicht.");
        println!("        Verdacht: Zeilenabstand, Schichtabstand oder Ebenen-Zuordnung.");
        1
    }
}
