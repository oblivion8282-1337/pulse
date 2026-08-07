//! Der Ablauf je Ebene — in Stufen, jede mit eigenem Befund.
//!
//! Die Reihenfolge ist nicht beliebig. Sie ist so gelegt, dass ein schwarzes
//! Ergebnis bei wgpu **verortbar** wird statt nur „geht nicht":
//!
//! | Stufe | beantwortet |
//! |---|---|
//! | A | traegt der Vulkan-eigene Bildweg ueberhaupt? |
//! | B | hat CUDA geschrieben — nachgesehen VOR wgpu, an wgpu vorbei |
//! | C | misst der Abtastweg etwas? (dieselbe Pruefung an einer wgpu-eigenen Textur) |
//! | D | **die Frage der Probe:** sieht wgpu den Inhalt im fremden Bild? |
//! | E | steht der Inhalt NACH dem wgpu-Zugriff noch im Speicher? |
//! | F | der Betriebsfall: kommen spaetere CUDA-Schreibzugriffe an? |
//!
//! D und E zusammen trennen die beiden moeglichen Ursachen: ist D schwarz und E
//! leer, hat der Uebergang aus `UNDEFINED` den Inhalt verworfen. Ist D schwarz
//! und E voll, liest wgpu anderen Speicher. Eine der beiden Aussagen allein
//! waere eine Vermutung.

use anyhow::{bail, Result};
use ash::vk;

use crate::abtasten::{eigene_textur, Abtaster};
use crate::cuda::Cuda;
use crate::cudaseite;
use crate::ebene::{muster, Ebene};
use crate::uebernahme::uebernehmen;
use crate::vkseite::{Bild, Vkseite};
use crate::Schalter;

/// Vorher-Wert. Ohne ihn waere „CUDA hat richtig geschrieben" nicht von „hier
/// steht frischer Nullspeicher" zu unterscheiden.
const VORHER: u8 = 0x5A;

/// Das Layout, in dem wgpu die Textur nach dem ersten Zugriff hinterlaesst.
/// Nachgesehen in `wgpu-hal-29.0.4/src/vulkan/conv.rs:221`, nicht geraten —
/// wer hier `UNDEFINED` einsetzt, verwirft den Inhalt beim eigenen Nachsehen
/// selbst und schoebe es dann wgpu zu.
const NACH_WGPU: vk::ImageLayout = vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL;

pub struct Befund {
    pub name: &'static str,
    /// Abweichende Texel beim ersten wgpu-Zugriff (Stufe D).
    pub erste_runde: usize,
    /// Steht der Inhalt nach dem wgpu-Zugriff noch im Speicher (Stufe E)?
    pub inhalt_bleibt: bool,
    /// Abweichende Texel je Betriebsrunde (Stufe F).
    pub runden: Vec<usize>,
}

impl Befund {
    pub fn traegt(&self) -> bool {
        self.erste_runde == 0 && self.runden.iter().all(|&n| n == 0)
    }
    pub fn traegt_ab_zweitem_bild(&self) -> bool {
        !self.runden.is_empty() && self.runden.iter().all(|&n| n == 0)
    }
}

pub fn ebene_pruefen(
    v: &Vkseite,
    c: &Cuda,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    e: &Ebene,
    s: &Schalter,
) -> Result<Befund> {
    let bytes = e.bytes();
    println!(
        "\n  Ebene {} — {:?} / wgpu {:?}, {}x{}, {} Byte je Texel, {bytes} Byte",
        e.name,
        e.vk_format,
        e.wgpu_format,
        e.breite,
        e.hoehe,
        e.bytes_je_texel()
    );

    let bild = v.exportierbares_bild(e.vk_format, e.breite, e.hoehe, s.dediziert)?;
    println!(
        "    exportiert, Deskriptor {}, Allokation {} Byte (dicht waeren {bytes})",
        bild.fd, bild.alloc
    );
    let (ablage, ablage_mem) = v.ablage(bytes)?;
    v.uebergang(&bild, vk::ImageLayout::UNDEFINED, vk::ImageLayout::GENERAL)?;

    // ── Stufe A: traegt der Vulkan-eigene Bildweg? ──────────────────────────
    v.schreiben(ablage_mem, &vec![VORHER; bytes])?;
    v.puffer_nach_bild(ablage, &bild, vk::ImageLayout::GENERAL)?;
    let vorher = auslesen(v, &bild, ablage, ablage_mem, bytes, vk::ImageLayout::GENERAL)?;
    if vorher.iter().any(|&b| b != VORHER) {
        bail!(
            "Stufe A fehlgeschlagen: der Vorher-Wert 0x{VORHER:02x} kam nicht unveraendert \
             zurueck — der Bildweg auf wgpus Geraet ist kaputt, damit ist die wgpu-Frage \
             hier gar nicht messbar"
        );
    }
    println!("    Stufe A: Vulkan fuellt und liest das Bild verlustfrei — Weg messbar");

    // Kontrolle fuer die Pruefschicht: eine Sperre, die ein falsches altes
    // Layout behauptet (das Bild liegt in GENERAL). Das ist ein echter
    // Regelverstoss, den die Schicht benennen MUSS. Schweigt sie auch hier,
    // sagt ihr Schweigen im Hauptlauf nichts.
    if s.verstoss {
        println!(
            "    ABSICHTLICHER VERSTOSS: Stufe E kopiert direkt aus \
             SHADER_READ_ONLY_OPTIMAL — die Pruefschicht MUSS das melden"
        );
    }

    // ── Stufe B: CUDA schreibt, nachgesehen an wgpu vorbei ──────────────────
    let eingehaengt = cudaseite::einhaengen(c, e, &bild, s.dediziert)?;
    let soll_bytes = if s.ohne_schreiben {
        println!("    GEGENPROBE: CUDA schreibt NICHT — es MUSS abweichen");
        (0..bytes).map(|i| muster(i, 0)).collect::<Vec<u8>>()
    } else {
        eingehaengt.schreiben(c, e, 0)?
    };
    let nach_cuda = auslesen(v, &bild, ablage, ablage_mem, bytes, vk::ImageLayout::GENERAL)?;
    let abweichend_b = nach_cuda.iter().zip(&soll_bytes).filter(|(a, b)| a != b).count();
    if s.ohne_schreiben {
        println!("    Stufe B: {abweichend_b} von {bytes} Byte abweichend (erwartet: alle)");
    } else if abweichend_b > 0 {
        bail!(
            "Stufe B fehlgeschlagen: {abweichend_b} von {bytes} Byte weichen ab, BEVOR wgpu \
             das Bild ueberhaupt gesehen hat — der in der Nachbarprobe belegte CUDA-Weg \
             traegt auf wgpus Geraet nicht, und ueber wgpu sagt dieser Lauf nichts"
        );
    } else {
        println!("    Stufe B: der CUDA-Inhalt steht vollstaendig im Bild, vor jedem wgpu-Zugriff");
    }

    // ── Stufe C: misst der Abtastweg ueberhaupt etwas? ──────────────────────
    let abtaster = Abtaster::neu(device, e);
    let soll_null = soll_codes(e, 0);
    let eigene = eigene_textur(device, queue, e, &soll_bytes);
    let eigene_view = eigene.create_view(&wgpu::TextureViewDescriptor::default());
    let gelesen = abtaster.lauf(device, queue, &eigene_view)?;
    let abweichend_c = zaehlen(&soll_null, &gelesen);
    if abweichend_c > 0 {
        bail!(
            "Stufe C fehlgeschlagen: schon an einer wgpu-EIGENEN Textur mit demselben \
             Inhalt weichen {abweichend_c} von {} Texeln ab — der Abtast- und Vergleichsweg \
             ist kaputt, jede Zahl ueber den Import waere bedeutungslos",
            e.texel()
        );
    }
    println!(
        "    Stufe C: dieselbe Pruefung an einer wgpu-eigenen Textur — 0 von {} Texeln \
         abweichend, der Abtastweg misst",
        e.texel()
    );
    // Kontrolle: schlaegt der Vergleich an? Ein verfaelschter Sollwert MUSS
    // auffallen, sonst waere „0 abweichend" auch mit einem Vergleich
    // vereinbar, der gar nichts prueft.
    let mut verdorben = soll_null.clone();
    verdorben[e.texel() / 2] ^= 0xFFFF;
    if zaehlen(&verdorben, &gelesen) == 0 {
        bail!("Kontrolle fehlgeschlagen: ein verfaelschter Sollwert fiel NICHT auf");
    }
    println!("    Kontrolle: ein verfaelschter Sollwert faellt auf — der Vergleich greift");
    drop(eigene_view);
    eigene.destroy();

    // ── Stufe D: die Frage der Probe ────────────────────────────────────────
    // SAFETY: das Bild liegt auf demselben Geraet und lebt bis zum Ende dieser
    // Funktion; die Textur wird vorher fallengelassen.
    let textur = unsafe { uebernehmen(device, &bild, e)? };
    let view = textur.create_view(&wgpu::TextureViewDescriptor::default());
    let gelesen = abtaster.lauf(device, queue, &view)?;
    let erste_runde = zaehlen(&soll_null, &gelesen);
    let unveraendert = gelesen.iter().filter(|&&w| w == 0).count();
    println!(
        "    Stufe D: wgpu 29 tastet das fremde VkImage ab — {erste_runde} von {} Texeln \
         abweichend, davon {unveraendert} auf Null",
        e.texel()
    );

    // ── Stufe E: steht der Inhalt danach noch im Speicher? ──────────────────
    let nach_wgpu = auslesen_roh(v, &bild, ablage, ablage_mem, bytes, NACH_WGPU, s.verstoss)?;
    let abweichend_e = nach_wgpu.iter().zip(&soll_bytes).filter(|(a, b)| a != b).count();
    let inhalt_bleibt = abweichend_e == 0;
    println!(
        "    Stufe E: nach dem wgpu-Zugriff stehen {} von {bytes} Byte noch im Bild",
        bytes - abweichend_e
    );

    // ── Stufe F: der Betriebsfall ───────────────────────────────────────────
    // Im Player schreibt CUDA jedes Bild neu, lange nachdem die Textur
    // eingehaengt wurde. Selbst wenn das ERSTE Bild verlorenginge, waere der
    // Weg brauchbar, sofern die spaeteren ankommen — deshalb ist diese Stufe
    // kein Beiwerk, sondern die praktisch entscheidende.
    let mut runden = Vec::new();
    if !s.ohne_schreiben {
        for r in 1..=s.runden {
            if s.layout_um {
                v.uebergang(&bild, NACH_WGPU, vk::ImageLayout::GENERAL)?;
            }
            eingehaengt.schreiben(c, e, r)?;
            if s.layout_um {
                v.uebergang(&bild, vk::ImageLayout::GENERAL, NACH_WGPU)?;
            }
            let gelesen = abtaster.lauf(device, queue, &view)?;
            let soll_r = soll_codes(e, r);
            let n = zaehlen(&soll_r, &gelesen);
            // **Die Kontrolle gegen den stillschweigend wirkungslosen
            // Schalter.** Jede Runde schreibt ein anderes Muster; wuerde eine
            // Runde in Wahrheit gar nichts neu schreiben, traege das Bild noch
            // das Muster der Vorrunde und der Vergleich gegen die Vorrunde
            // ginge auf. Genau das muss auffallen.
            let wie_vorrunde = zaehlen(&soll_codes(e, r - 1), &gelesen);
            if n == 0 && wie_vorrunde == 0 {
                bail!(
                    "Runde {r}: der Inhalt passt zu ZWEI verschiedenen Varianten — das kann \
                     nicht sein, das Muster unterscheidet sie in fast jedem Byte. Der \
                     Vergleich prueft nicht, was er zu pruefen behauptet."
                );
            }
            println!(
                "    Stufe F, Runde {r}: {n} von {} Texeln abweichend (gegen die Vorrunde: \
                 {wie_vorrunde} — muss gross sein, sonst hat die Runde nichts geschrieben)",
                e.texel()
            );
            runden.push(n);
            if n > 0 {
                break;
            }
        }
    }

    drop(view);
    drop(textur);
    // Erst wenn wgpu wirklich fertig ist, darf das Bild weg — sonst zerstoerte
    // die Probe Speicher, auf den wgpu noch zeigt.
    device.poll(wgpu::PollType::wait_indefinitely()).ok();
    eingehaengt.aufraeumen(c)?;
    unsafe {
        v.device.destroy_image(bild.image, None);
        v.device.free_memory(bild.memory, None);
        v.device.destroy_buffer(ablage, None);
        v.device.free_memory(ablage_mem, None);
    }
    Ok(Befund { name: e.name, erste_runde, inhalt_bleibt, runden })
}

/// Soll-Codewerte je Texel, in derselben Verpackung wie der Shader sie liefert
/// (`r | g << 16`).
fn soll_codes(e: &Ebene, variante: u32) -> Vec<u32> {
    let mut v = Vec::with_capacity(e.texel());
    for y in 0..e.hoehe {
        for x in 0..e.breite {
            let (r, g) = e.soll(x, y, variante);
            v.push(r | (g << 16));
        }
    }
    v
}

fn zaehlen(soll: &[u32], ist: &[u32]) -> usize {
    soll.iter().zip(ist).filter(|(a, b)| a != b).count()
}

fn auslesen(
    v: &Vkseite,
    bild: &Bild,
    ablage: vk::Buffer,
    ablage_mem: vk::DeviceMemory,
    bytes: usize,
    layout: vk::ImageLayout,
) -> Result<Vec<u8>> {
    auslesen_roh(v, bild, ablage, ablage_mem, bytes, layout, false)
}

fn auslesen_roh(
    v: &Vkseite,
    bild: &Bild,
    ablage: vk::Buffer,
    ablage_mem: vk::DeviceMemory,
    bytes: usize,
    layout: vk::ImageLayout,
    regelwidrig: bool,
) -> Result<Vec<u8>> {
    // Die Ablage wird vorher genullt: bliebe der vorige Inhalt stehen, saehe
    // ein ausgefallener Bild-nach-Puffer-Weg genauso aus wie ein gelungener.
    v.schreiben(ablage_mem, &vec![0u8; bytes])?;
    v.bild_nach_puffer(bild, ablage, layout, regelwidrig)?;
    v.lesen(ablage_mem, bytes)
}
