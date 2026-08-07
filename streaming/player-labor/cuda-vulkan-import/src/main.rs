//! Probe: teilen sich CUDA und Vulkan auf dieser Karte denselben Speicher —
//! und laesst sich ein Vulkan-BILD von CUDA beschreiben?
//!
//! Zwei Stufen, getrennt aufrufbar (`SPIKE_MODUS`):
//!
//! 1. **Puffer** (`puffer.rs`) — die Grundfrage: kommt ein Inhalt, den CUDA in
//!    einen von Vulkan exportierten Speicher schreibt, dort unveraendert an?
//!    Am 2026-08-06 mit Ja beantwortet.
//! 2. **Bild** (`bild.rs`) — die Frage, die der Player wirklich stellt: ein
//!    Puffer laesst sich nicht abtasten. Kann CUDA in ein exportiertes
//!    `VkImage` schreiben (NV12 und P010), oder muss eine Puffer-nach-Bild-
//!    Kopie dazwischen?
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
//! ist hier die Vulkan-Seite.
//!
//! **Warum ohne wgpu.** Diese Stufe fragt nur, ob Treiber und CUDA sich einig
//! sind. Kaeme wgpu dazu, waere ein Fehlschlag nicht mehr eindeutig zuzuordnen
//! — auf der Windows-Seite ist genau diese Verwechslung passiert (es sah nach
//! wgpu aus und war der Treiber, s. `player-2026-08-06-nv12-wgpu-import*.json`).
//!
//! Rueckgabewert 0 = der gepruefte Weg traegt.

mod bild;
mod cuda;
mod puffer;
mod vk;

use anyhow::{bail, Result};

use cuda::Cuda;
use vk::Vulkan;

/// Wie viele Bytes die Puffer-Stufe teilt. Vorgabe entspricht grob einer
/// 1440p-Luma-Ebene, damit die Groessenordnung der spaeteren Anwendung stimmt.
fn groesse() -> usize {
    std::env::var("SPIKE_BYTES").ok().and_then(|s| s.parse().ok()).unwrap_or(2560 * 1440)
}

fn zahl(name: &str, vorgabe: u32) -> u32 {
    std::env::var(name).ok().and_then(|s| s.parse().ok()).unwrap_or(vorgabe)
}

fn an(name: &str, vorgabe: bool) -> bool {
    match std::env::var(name).as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => vorgabe,
    }
}

/// Positionsabhaengiges Muster.
///
/// Bewusst NICHT konstant und bewusst nicht nur vom niederwertigsten Byte
/// abhaengig: ein Weg, der um einige Bytes versetzt liest oder nur den Anfang
/// trifft, kaeme mit einem gleichfoermigen Muster als fehlerfrei durch. Genau
/// dieser Fehler ist auf der Windows-Seite beim Textur-Stapel aufgetreten und
/// waere ohne so ein Muster als "geht" durchgegangen. Bei Bildern faengt es
/// zusaetzlich eine falsch angenommene Zeilenlaenge.
pub fn muster(i: usize) -> u8 {
    ((i.wrapping_mul(31).wrapping_add(i >> 8).wrapping_add(7)) & 0xFF) as u8
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Erste abweichende Stelle suchen — und melden, WAS dort steht. Ein
/// verschobener Wert (Nachbarbyte) heisst etwas voellig anderes als eine Null:
/// das eine ist eine falsche Rechnung, das andere fehlender Speicher.
pub fn vergleichen(soll: &[u8], ist: &[u8]) -> Option<(usize, u8, u8)> {
    soll.iter().zip(ist.iter()).position(|(a, b)| a != b).map(|i| (i, soll[i], ist[i]))
}

/// Vergleichsergebnis fuer eine Richtung ausgeben; meldet per Rueckgabewert,
/// ob eine Abweichung auftrat.
pub fn ergebnis_melden(richtung: &str, soll: &[u8], ist: &[u8]) -> bool {
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

/// Bei einer Abweichung im Bild: wie verteilt sie sich ueber die Zeilen?
///
/// Die Form der Abweichung trennt zwei bekannte Fehlerbilder voneinander, die
/// beide OHNE Fehlermeldung auftreten: eine Fehlanpassung bei der dedizierten
/// Allokation erzeugt senkrechte Streifen (also in JEDER Zeile ungefaehr
/// gleich viele abweichende Bytes), ein falsches `depth`-Feld ein Lochmuster
/// (also ganze Zeilen heil, andere ganz kaputt). Ohne diese Aufschluesselung
/// waere beides nur "es stimmt nicht".
pub fn streifen_diagnose(soll: &[u8], ist: &[u8], zeilenbytes: usize) -> String {
    if zeilenbytes == 0 {
        return String::from("Verteilung: keine Zeilenlaenge bekannt");
    }
    let zeilen: Vec<usize> = soll
        .chunks(zeilenbytes)
        .zip(ist.chunks(zeilenbytes))
        .map(|(a, b)| a.iter().zip(b).filter(|(x, y)| x != y).count())
        .collect();
    let heil = zeilen.iter().filter(|&&n| n == 0).count();
    let ganz = zeilen.iter().filter(|&&n| n == zeilenbytes).count();
    let max = zeilen.iter().copied().max().unwrap_or(0);
    let min = zeilen.iter().copied().min().unwrap_or(0);
    format!(
        "Verteilung ueber {} Zeilen: {heil} voellig heil, {ganz} voellig kaputt, \
         je Zeile {min}..{max} von {zeilenbytes} abweichend",
        zeilen.len()
    )
}

fn main() -> Result<()> {
    let modus = std::env::var("SPIKE_MODUS").unwrap_or_else(|_| String::from("puffer"));
    let dediziert = an("SPIKE_DEDIZIERT", true);

    cuda::selbsttest_layout()?;
    println!("Struct-Layouts gegen cuda.h geprueft: ok");

    let v = Vulkan::aufbauen()?;
    let c = Cuda::laden()?;

    unsafe { c.pruefe((c.cuInit)(0), "cuInit")? };
    let mut dev: cuda::CUdevice = 0;
    unsafe { c.pruefe((c.cuDeviceGet)(&mut dev, 0), "cuDeviceGet")? };
    let mut cu_uuid = [0u8; 16];
    unsafe { c.pruefe((c.cuDeviceGetUuid)(&mut cu_uuid, dev), "cuDeviceGetUuid")? };
    println!("  CUDA-Geraet 0: UUID {}", hex(&cu_uuid));

    // Reden beide ueber dieselbe Karte? Sonst ist jeder Befund wertlos.
    if cu_uuid != v.uuid {
        bail!(
            "Vulkan-Karte ({}) und CUDA-Karte ({}) sind verschieden — \
             die Probe wuerde etwas anderes messen als gemeint",
            hex(&v.uuid),
            hex(&cu_uuid)
        );
    }
    println!("  UUIDs stimmen ueberein — dieselbe Karte");

    let mut ctx: cuda::CUcontext = std::ptr::null_mut();
    unsafe {
        c.pruefe((c.cuDevicePrimaryCtxRetain)(&mut ctx, dev), "cuDevicePrimaryCtxRetain")?;
        c.pruefe((c.cuCtxSetCurrent)(ctx), "cuCtxSetCurrent")?;
    }

    match modus.as_str() {
        "puffer" => puffer::pruefen(&v, &c, groesse(), dediziert),
        "bild" => bild_stufe(&v, &c, dediziert),
        anderes => bail!("SPIKE_MODUS={anderes} unbekannt — 'puffer' oder 'bild'"),
    }
}

/// Die Bild-Stufe: NV12 und P010, je als zwei getrennte Bilder, dazu der
/// Ein-Bild-Versuch. Das Urteil bezieht sich NUR auf die getrennten Ebenen —
/// der Ein-Bild-Weg ist eine Zusatzfrage, sein Scheitern ist kein Fehlschlag
/// der Stufe.
fn bild_stufe(v: &Vulkan, c: &Cuda, dediziert: bool) -> Result<()> {
    let breite = zahl("SPIKE_BREITE", 2560);
    let hoehe = zahl("SPIKE_HOEHE", 1440);
    let s = bild::Schalter {
        dediziert,
        surface_ldst: an("SPIKE_SURFACE_LDST", false),
        ohne_schreiben: an("SPIKE_OHNE_SCHREIBEN", false),
        dedi_fehlanpassung: an("SPIKE_DEDI_FEHLANPASSUNG", false),
    };
    println!(
        "Stufe Bild: {breite}x{hoehe}, dedizierte Allokation: {dediziert}, \
         SURFACE_LDST: {}, Gegenprobe ohne Schreiben: {}, \
         Gegenprobe Dedicated-Fehlanpassung: {}",
        s.surface_ldst, s.ohne_schreiben, s.dedi_fehlanpassung
    );

    let mut getragen = 0usize;
    let mut geprueft = 0usize;
    for (bezeichnung, zehn_bit) in [("NV12 (8 bit)", false), ("P010 (10 bit)", true)] {
        println!("\n=== {bezeichnung} als zwei getrennte Bilder ===");
        for e in bild::ebenen(zehn_bit, breite, hoehe) {
            geprueft += 1;
            if bild::ebene_pruefen(v, c, &e, &s)? {
                getragen += 1;
            }
        }
        println!("\n=== {bezeichnung} als EIN mehrplaniges Bild ===");
        bild::ein_bild_versuchen(v, c, zehn_bit, breite, hoehe);
    }

    println!();
    // Bei der Gegenprobe ohne Schreiben ist die Erwartung UMGEKEHRT: dort waere
    // ein fehlerfreier Vergleich der Beweis, dass die Probe gar nichts misst.
    // Deshalb wird das Urteil dort gedreht, statt den Lauf von Hand zu deuten —
    // eine Gegenprobe, deren Ergebnis man selbst noch auslegen muss, wird beim
    // naechsten Mal falsch ausgelegt.
    if s.ohne_schreiben {
        return if getragen == 0 {
            println!(
                "URTEIL DER GEGENPROBE: bestanden. Ohne CUDA-Schreibzugriff weicht \
                 jede der {geprueft} Ebenen ab — ein Erfolg im Hauptlauf ist also \
                 kein Artefakt der Pruefmechanik."
            );
            Ok(())
        } else {
            bail!(
                "URTEIL DER GEGENPROBE: DURCHGEFALLEN. {getragen} von {geprueft} Ebenen \
                 galten als fehlerfrei, OBWOHL CUDA nichts geschrieben hat — die Probe \
                 misst nicht, was sie zu messen behauptet. Jeder frueher hier gewonnene \
                 Bild-Befund ist damit hinfaellig."
            )
        };
    }

    // Bei der Fehlanpassungs-Gegenprobe steht ausdruecklich KEIN Urteil ueber
    // den Bild-Import: dieser Lauf beantwortet eine andere Frage (faellt eine
    // falsch gesetzte Speicherlage auf?), und ein "traegt" waere hier eine
    // Aussage ueber einen Weg, den so niemand baut.
    if s.dedi_fehlanpassung {
        println!(
            "BEFUND DER FEHLANPASSUNG (Vulkan dediziert={dediziert}, CUDA-Flag \
             dediziert={}): {getragen} von {geprueft} Ebenen kamen trotzdem \
             fehlerfrei durch. {}",
            !dediziert,
            if getragen == geprueft {
                "Der Treiber laesst sich von dem falschen Flag hier nicht beirren."
            } else {
                "Die Fehlanpassung faellt auf — Verteilung oben beachten."
            }
        );
        return Ok(());
    }

    if getragen == geprueft {
        println!(
            "URTEIL: der Bild-Import traegt. CUDA schreibt direkt in exportierte \
             Vulkan-Bilder ({getragen} von {geprueft} Ebenen fehlerfrei)."
        );
        Ok(())
    } else {
        bail!(
            "URTEIL: der Bild-Import traegt NICHT ({getragen} von {geprueft} Ebenen \
             fehlerfrei) — der Weg fuehrt ueber Puffer plus vkCmdCopyBufferToImage"
        )
    }
}
