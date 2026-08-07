//! Probe: **Semaphor-Kopplung CUDA ↔ Vulkan unter wgpu 29** (Linux/NVIDIA).
//!
//! Sie beantwortet zwei GETRENNTE Fragen, und die Trennung ist der Punkt:
//!
//! 1. Traegt `cuImportExternalSemaphore` gegen ein Vulkan-Semaphor, das ueber
//!    `VK_KHR_external_semaphore_fd` als OPAQUE_FD exportiert wurde? **Binaer**
//!    und **Zeitlinie** sind dabei zwei Faelle, nicht zwei Zahlenwerte — beide
//!    werden geprueft und getrennt berichtet.
//! 2. Nimmt wgpu 29 ein SELBST angelegtes `VkDevice` entgegen, auf dem die
//!    Erweiterung eingeschaltet ist? Noetig, weil wgpu 29 sie von sich aus
//!    nicht anfordert, obwohl die Karte sie anbietet (belegt in
//!    `../wgpu-cuda-import`).
//!
//! Das ist der dritte Schritt zum Zero-Copy-Player unter Linux/NVIDIA. Die
//! ersten beiden sind beantwortet: CUDA und Vulkan teilen sich hier denselben
//! Speicher (Messakten `player-2026-08-06-cuda-vulkan-linux.json` und
//! `player-2026-08-07-cuda-vulkan-bild-import.json`), und wgpu 29 nimmt ein
//! fremdes `VkImage` mitsamt Inhalt an. Beide Vorgaenger haben sich die
//! Synchronisierung ausdruecklich vom Hals gehalten, indem sie die
//! Warteschlange vor jedem Schritt leerten. Im Betrieb geht das nicht: der
//! Decoder schreibt, waehrend gezeichnet wird.
//!
//! Rueckgabewert 0 = der gepruefte Weg traegt.

mod cudasem;
mod geraet;
mod muster;
mod probe;
mod vksem;

// Die CUDA-Speicher-Bindungen kommen aus der Nachbarprobe statt aus einer
// Kopie: ihre von Hand nachgebauten Struct-Layouts sind der heikelste Teil des
// Ganzen (ein falscher Feld-Versatz erzeugt keinen Fehler, sondern stille
// Falschergebnisse), und sie tragen einen Selbsttest gegen ein kompiliertes
// `sizeof`/`offsetof` aus `cuda.h`. Zwei Fassungen davon waeren genau die
// Fehlerklasse, gegen die dieser Selbsttest steht. Die SEMAPHOR-Strukturen gibt
// es dort nicht — sie stehen in `cudasem.rs` und haben ihren eigenen
// Selbsttest, nach demselben Verfahren.
//
// `dead_code` aus: diese Probe braucht den Bild-/Array-Teil der Nachbarkiste
// nicht. Die Warnungen wegzuschalten ist hier richtig und nicht bequem — sie
// beziehen sich auf fremden, unveraenderten Quelltext, und ein Rauschen aus
// zwoelf Zeilen wuerde eine echte Warnung aus DIESER Kiste zudecken.
#[allow(dead_code)]
#[path = "../../cuda-vulkan-import/src/cuda/mod.rs"]
mod cuda;

use anyhow::{bail, Result};

use probe::Ausgang;
use vksem::Bauart;

pub struct Schalter {
    /// Das `VkDevice` selbst anlegen (Frage 2) statt es von wgpu oeffnen zu
    /// lassen. `false` ist die Gegenprobe dazu und muss scheitern — auf dem
    /// wgpu-Geraet fehlt die Erweiterung.
    pub eigenes_geraet: bool,
    pub mib: usize,
    pub runden: u32,
    /// Wie viele zusaetzliche Kopien des ALTEN Musters CUDA vor der einen
    /// entscheidenden Kopie abschickt. Sie kosten nur Zeit — und genau darum
    /// geht es: sie weiten das Zeitfenster, in dem ein fehlendes Warten
    /// sichtbar wird.
    pub vorkopien: u32,
    pub binaer: bool,
    pub zeitlinie: bool,
    /// Stufe C — der Aufbau OHNE Semaphor.
    pub empfindlichkeit: bool,
    /// Stufe D — der Aufbau MIT Semaphor.
    pub hauptlauf: bool,
    /// Vulkan-Pruefschicht. Steht mit im Schalterblock, damit die gemeldete
    /// Lage und die tatsaechlich aufgebaute Instanz denselben Wert benutzen.
    pub pruefschicht: bool,
}

/// Ein Empfaenger fuer `log`, in Handarbeit. Die Pruefschicht meldet ueber
/// wgpu, wgpu ueber `log`; ohne Empfaenger ist sie stumm — und ein Lauf ohne
/// Meldungen saehe dann aus wie ein regelkonformer Lauf.
struct Mitschreiber;

impl log::Log for Mitschreiber {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, r: &log::Record) {
        if r.level() <= log::Level::Warn {
            println!("  [{}] {}: {}", r.level(), r.target(), r.args());
        }
    }
    fn flush(&self) {}
}

static MITSCHREIBER: Mitschreiber = Mitschreiber;

fn zahl<T: std::str::FromStr>(name: &str, vorgabe: T) -> T {
    std::env::var(name).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(vorgabe)
}

fn an(name: &str, vorgabe: bool) -> bool {
    match std::env::var(name).as_deref().map(str::trim) {
        Ok("1") => true,
        Ok("0") => false,
        _ => vorgabe,
    }
}

fn main() -> Result<()> {
    log::set_logger(&MITSCHREIBER).ok();
    log::set_max_level(log::LevelFilter::Warn);

    let s = Schalter {
        eigenes_geraet: an("SPIKE_EIGENES_GERAET", true),
        mib: zahl("SPIKE_MIB", 256usize),
        runden: zahl("SPIKE_RUNDEN", 5u32),
        vorkopien: zahl("SPIKE_VORKOPIEN", 8u32),
        binaer: an("SPIKE_BINAER", true),
        zeitlinie: an("SPIKE_ZEITLINIE", true),
        empfindlichkeit: an("SPIKE_EMPFINDLICHKEIT", true),
        hauptlauf: an("SPIKE_HAUPTLAUF", true),
        pruefschicht: an("SPIKE_PRUEFSCHICHT", false),
    };
    // **Die Kopfzeile gibt die TATSAECHLICHE Schalterstellung aus.** Ein nicht
    // greifender Schalter hat in diesem Labor schon dreimal Matrixzeilen
    // entwertet; eine Zeile, die nur wiederholt, was man eingegeben zu haben
    // glaubt, waere wertlos.
    println!(
        "Lauf: eigenes VkDevice: {}, {} MiB je Puffer, {} Wiederholungen, {} Vorkopien, \
         binaer: {}, Zeitlinie: {}, Stufe C (Empfindlichkeit): {}, Stufe D (Hauptlauf): {}, \
         Pruefschicht: {}",
        s.eigenes_geraet,
        s.mib,
        s.runden,
        s.vorkopien,
        s.binaer,
        s.zeitlinie,
        s.empfindlichkeit,
        s.hauptlauf,
        s.pruefschicht
    );
    if !s.binaer && !s.zeitlinie {
        bail!("beide Bauarten abgewaehlt — es gaebe nichts zu pruefen");
    }
    if !s.empfindlichkeit && s.hauptlauf {
        println!(
            "  HINWEIS: ohne Stufe C kann dieser Lauf einen Erfolg nicht von einem nie \
             eingetretenen Wettrennen unterscheiden. Der Ausgang heisst dann trotzdem \
             'traegt' — verlassen sollte man sich darauf nicht."
        );
    }

    cuda::selbsttest_layout()?;
    cudasem::selbsttest_layout_semaphor()?;
    println!("Struct-Layouts gegen cuda.h geprueft (Speicher UND Semaphor): ok");

    let g = geraet::aufbauen(s.eigenes_geraet, s.pruefschicht)?;

    // **Frage 2, hier faellt sie.** Die Erweiterungszahl ist die Groesse, die
    // sich aendern MUSS, wenn der Schalter greift — sie wird oben ausgegeben.
    if !g.semaphor_fd_am_geraet {
        bail!(
            "ANTWORT AUF FRAGE 2: das Geraet hat {} NICHT an ({} Erweiterungen). \
             Ohne sie faellt kein Dateideskriptor aus vkGetSemaphoreFdKHR, und Frage 1 ist \
             gar nicht erst pruefbar. Mit SPIKE_EIGENES_GERAET=1 wird das Geraet selbst \
             angelegt.",
            geraet::SEMAPHOR_FD.to_string_lossy(),
            g.erweiterungen_am_geraet
        );
    }
    println!(
        "ANTWORT AUF FRAGE 2: wgpu 29 nimmt {} — das Geraet fuehrt {} und ist ueber \
         create_device_from_hal bei wgpu angekommen.",
        if s.eigenes_geraet { "das selbst angelegte VkDevice an" } else { "(wgpu-Weg)" },
        geraet::SEMAPHOR_FD.to_string_lossy()
    );

    let v = vksem::Vkseite::neu(&g)?;
    let c = probe::cuda_aufbauen(v.uuid())?;
    let sem = cudasem::Semapi::laden()?;

    let mut befunde = Vec::new();
    if s.binaer {
        befunde.push(probe::pruefen(&c, &sem, &v, Bauart::Binaer, &s)?);
    }
    if s.zeitlinie {
        befunde.push(probe::pruefen(&c, &sem, &v, Bauart::Zeitlinie, &s)?);
    }

    urteil(&befunde, &g)
}

/// Das Urteil, je Bauart getrennt.
///
/// Es steht im Programm und nicht in der Anleitung: ein Ergebnis, das man
/// selbst noch auslegen muss, wird beim naechsten Mal falsch ausgelegt.
fn urteil(befunde: &[probe::Befund], g: &geraet::Geraet) -> Result<()> {
    println!("\nERGEBNIS auf {} ({} Erweiterungen am Geraet):", g.name, g.erweiterungen_am_geraet);
    for b in befunde {
        let text = match &b.ausgang {
            Ausgang::NichtGeprueft => String::from("nicht geprueft (Schalter)"),
            Ausgang::NichtImportierbar(e) => {
                format!("TRAEGT NICHT — cuImportExternalSemaphore weist ab: {e}")
            }
            Ausgang::TraegtNicht => format!(
                "TRAEGT NICHT — mit Semaphor kamen falsche Bytes heraus ({} von {} \
                 Wiederholungen abweichend)",
                b.mit_sync.iter().filter(|v| v.abweichend() != 0).count(),
                b.mit_sync.len()
            ),
            Ausgang::Unentscheidbar => String::from(
                "UNENTSCHEIDBAR — die Probe KANN DIE SACHE NICHT ENTSCHEIDEN: der Aufbau \
                 OHNE Semaphor lieferte ebenfalls durchweg das Richtige. Ein fehlendes \
                 Warten waere hier gar nicht aufgefallen, ein Erfolg mit Semaphor sagt \
                 also nichts. Zeitfenster weiten (SPIKE_VORKOPIEN / SPIKE_MIB hoch) und \
                 erneut laufen lassen.",
            ),
            Ausgang::Traegt => format!(
                "TRAEGT — {} von {} Wiederholungen mit Semaphor fehlerfrei, und die \
                 Gegenprobe schlaegt an ({} von {} Wiederholungen OHNE Semaphor lieferten \
                 veraltete Bytes)",
                b.mit_sync.len(),
                b.mit_sync.len(),
                b.ohne_sync.iter().filter(|v| v.abweichend() != 0).count(),
                b.ohne_sync.len()
            ),
        };
        let rueck = match b.rueckrichtung {
            Some(true) => "Rueckrichtung ok",
            Some(false) => "Rueckrichtung GESCHEITERT",
            None => "Rueckrichtung nicht erreicht",
        };
        println!("  {:<34} {text}\n      ({rueck})", b.bauart);
    }

    let traegt: Vec<_> = befunde.iter().filter(|b| b.traegt()).map(|b| b.bauart).collect();
    println!();

    // **Unentscheidbar ist KEIN Fehlschlag und wird auch nicht als solcher
    // gemeldet.** Wer hier „traegt nicht" schriebe, wuerde einen Mangel der
    // PROBE als Eigenschaft des Treibers ausgeben — das ist die schlimmere der
    // beiden Falschaussagen, weil sie einen gangbaren Weg verwirft.
    let unentscheidbar: Vec<_> = befunde
        .iter()
        .filter(|b| matches!(b.ausgang, Ausgang::Unentscheidbar))
        .map(|b| b.bauart)
        .collect();
    if !unentscheidbar.is_empty() {
        bail!(
            "URTEIL: fuer {} KANN DIESER LAUF DIE SACHE NICHT ENTSCHEIDEN. Das Wettrennen ist \
             nicht eingetreten — auch ohne Semaphor kam durchweg das Richtige heraus. Damit \
             ist WEDER belegt, dass die Kopplung traegt, NOCH dass sie es nicht tut; es ist \
             ein Befund ueber die Probe, nicht ueber den Treiber. Zeitfenster weiten \
             (SPIKE_VORKOPIEN und SPIKE_MIB hoch) und erneut laufen lassen.",
            unentscheidbar.join(" und ")
        )
    }

    if traegt.len() == befunde.len() {
        println!("URTEIL: beide gepruefte Bauarten tragen. Die Synchronisierung ueber die \
                  Grenze ist damit gebaut — der Zero-Copy-Weg haengt nicht mehr daran.");
        return Ok(());
    }
    if traegt.is_empty() {
        bail!(
            "URTEIL: KEINE der gepruefteten Bauarten traegt. Ohne Synchronisierung ueber \
             die Grenze bleibt nur der Weg, den die Vorgaengerproben gegangen sind: die \
             Warteschlange vor jedem Zugriff leeren — im Player heisst das ein Bild \
             Wartezeit je Zugriff."
        )
    }
    bail!(
        "URTEIL: nur {} traegt. Der Player muss sich darauf festlegen; die andere Bauart \
         ist keine Rueckfallebene.",
        traegt.join(" und ")
    )
}
