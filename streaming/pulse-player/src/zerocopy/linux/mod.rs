//! Die Bruecke CUDA → Vulkan unter Linux. Aufbau und Begruendung im Modulkopf
//! von [`super`]; hier steht, was DIESE Plattform anders macht.
//!
//! ## Warum sie umgekehrt herum gebaut ist als die von Windows
//!
//! Auf Windows gehoert die Decoder-Textur D3D11, wird GPU-intern in eine
//! teilbare Textur kopiert und ueber ein NT-Handle an wgpu gereicht. Hier ist
//! die Richtung vertauscht, und zwar zwingend: der Decoder-Frame liegt in
//! CUDA-Speicher, den FFmpeg mit `cuMemAlloc` anlegt — **und der ist nicht
//! exportierbar**. Exportieren kann nur, wer beim Anlegen das entsprechende
//! Flag setzt, und das ist die Vulkan-Seite. Also legt Vulkan das Ziel an,
//! CUDA bekommt es eingehaengt, und der fertige Frame wird GPU-lokal
//! hineinkopiert (`cuMemcpy2D`). Keine Nullkopie im Wortsinn — aber die Kopie
//! bleibt auf der Karte, statt ueber PCIe zu laufen.
//!
//! ## NV12 und P010 sind hier ZWEI Bilder, nicht eines
//!
//! Ein mehrplaniges `VkImage` weist CUDA ab (`CUDA_ERROR_INVALID_VALUE` in
//! `cuExternalMemoryGetMappedMipmappedArray`): `CUDA_ARRAY3D_DESCRIPTOR` kennt
//! nur **ein** Format und **eine** Kanalzahl, NV12 hat aber zwei Ebenen
//! verschiedener Groesse und Kanalzahl. Gemessen, nicht erschlossen —
//! `cuda.h` fuehrt ein `CU_AD_FORMAT_NV12`, das nahelegt, es ginge doch.
//! Deshalb zwei getrennte Bilder (R8+Rg8 bzw. R16+Rg16). Das kostet nichts:
//! getrennte Ebenen sind ohnehin die Form, in der der Shader sie abtastet, und
//! der Renderer bindet auf Windows dieselben zwei Ansichten — dort nur als
//! zwei Aspekte EINER Textur.
//!
//! Beleg: `profiles/player-2026-08-07-cuda-vulkan-bild-import.json`.
//!
//! ## Der Gleichlauf: Warten auf der CPU, nicht ueber ein Semaphor
//!
//! Nach der Kopie wartet die Bruecke mit `cuCtxSynchronize`, bevor sie das Bild
//! herausgibt. **Das ist eine bewusste Entscheidung gegen den scheinbar
//! feineren Weg**, und der Grund ist die Belegkette:
//!
//! * Genau so lief die Messung, die belegt, dass wgpu den Inhalt sieht
//!   (`player-2026-08-07-wgpu29-vkimage-import.json` — die Probe synchronisiert
//!   host-seitig). Ein Semaphor-Weg waere eine **andere**, ungemessene Bauart.
//! * Die Semaphor-Kopplung ist zwar belegt
//!   (`player-2026-08-07-semaphor-kopplung.json`), aber nur als
//!   Funktionsnachweis in EINER Richtung. Fuer die hier gebrauchte Rueckrichtung
//!   (Vulkan signalisiert, CUDA wartet, damit kein Ringplatz zu frueh
//!   ueberschrieben wird) sagt die Messakte ausdruecklich: **nicht belegt**.
//!   **Nachtrag 2026-08-08:** wgpu 30 bringt dafuer immerhin die fehlende
//!   Haelfte mit — `Queue::add_wait_semaphore`
//!   (`wgpu-hal-30.0.0/src/vulkan/mod.rs:1552`); in wgpu 29 gab es nur
//!   `add_signal_semaphore`. Das aendert an der Belegfrage nichts, raeumt aber
//!   ein Hindernis weg, falls die Rueckrichtung je gebaut wird.
//! * Sie verlangt ausserdem ein selbst angelegtes `VkDevice`, weil wgpu
//!   `VK_KHR_external_semaphore_fd` nicht anfordert — also einen zweiten
//!   Aufbauweg fuer einen unbelegten Gewinn. **Das gilt fuer wgpu 30
//!   unveraendert**, nachgesehen am 2026-08-08: `vulkan/adapter.rs` fordert
//!   `external_memory_fd` an (`:1345`), `external_semaphore_fd` kommt dort
//!   nicht vor.
//! * `cuMemcpy2D` ist bei Geraet→Array nicht zwingend host-synchron; das
//!   Warten ist also nicht bloss Vorsicht, sondern noetig.
//!
//! Was es kostet, steht in der Messakte zum Umbau. Wird es dort zum
//! Engpass, ist der Semaphor-Weg der naechste Schritt — samt der
//! Empfindlichkeitsstufe, die die Messakte dafuer verlangt.
//!
//! ## Der Ringplatz wird beim Fallenlassen frei
//!
//! Dieselbe Lebensdauer-Regel wie auf Windows, und aus demselben Grund
//! (s. `zerocopy::platz::GpuBild`): das Bild muss so lange leben, wie
//! IRGENDJEMAND die Textur liest — der `DecodedFrame` genauso wie ein
//! abgeschickter, noch laufender Zeichendurchgang.
//!
//! ## Wo was steht
//!
//! | Datei | Frage, die sie beantwortet |
//! |---|---|
//! | hier | Wann wird ein Platz genommen und beschrieben? |
//! | [`platz`] | Was IST ein Platz, und wie lange lebt er? |
//! | [`ebene`] | Wie heisst eine Bildebene in Vulkan, CUDA und wgpu? |
//! | [`kern`] | Woher kommt der geteilte CUDA-Kontext? |
//! | [`vkbild`] | Wie entsteht ein exportierbares `VkImage`? |
//! | [`cuda`] | Die Treiber-API per `dlopen`. |

mod cuda;
mod ebene;
mod kern;
mod platz;
mod vkbild;

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use ffmpeg_next as ffmpeg;

use ebene::{ebenen, Ebene};
use kern::{kern, Kern};
use platz::ringgroesse;
use vkbild::Vkseite;

use super::freigabe::Freigabe;

pub use kern::kontext_bereitstellen;
pub use platz::{GpuBild, Ringplatz};

/// Masse und Bittiefe, fuer die ein Ring gilt.
///
/// **Als benannter Verbund und nicht als Tripel**, weil Breite und Hoehe
/// derselbe Typ sind: ein vertauschtes Paar faellt in `(u32, u32, bool)`
/// niemandem auf, weder dem Compiler noch dem Leser.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Bauart {
    breite: u32,
    hoehe: u32,
    zehn_bit: bool,
}

impl Bauart {
    /// Masse und Bittiefe aus dem dekodierten Bild lesen.
    ///
    /// Die Bittiefe steht **nicht** am Bild (dessen Format ist `CUDA`), sondern
    /// im `sw_format` seines `hw_frames_ctx` — dort merkt sich FFmpeg, was
    /// hinter dem Geraetezeiger liegt.
    fn von_frame(frame: &ffmpeg::util::frame::video::Video) -> Result<Self> {
        // SAFETY: das Bild lebt und traegt bei `AV_PIX_FMT_CUDA` einen
        // `hw_frames_ctx`; jede Stufe wird vor dem naechsten Zugriff geprueft.
        let sw = unsafe {
            let f = frame.as_ptr();
            let frames_ref = (*f).hw_frames_ctx;
            if frames_ref.is_null() {
                bail!("Bild ohne hw_frames_ctx");
            }
            let frames = (*frames_ref).data as *mut ffmpeg::ffi::AVHWFramesContext;
            if frames.is_null() {
                bail!("hw_frames_ctx ohne Inhalt");
            }
            (*frames).sw_format
        };
        let zehn_bit = match sw {
            ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_NV12 => false,
            ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_P010LE => true,
            andere => bail!("{andere:?} ist weder NV12 noch P010"),
        };
        let (breite, hoehe) = (frame.width(), frame.height());
        if breite == 0 || hoehe == 0 {
            bail!("Bild ohne Masse");
        }
        Ok(Self { breite, hoehe, zehn_bit })
    }

    fn ebenen(self) -> [Ebene; 2] {
        ebenen(self.zehn_bit, self.breite, self.hoehe)
    }
}

/// Die Bruecke: Vulkan legt an, CUDA schreibt hinein.
pub struct Bruecke {
    vk: Arc<Vkseite>,
    kern: &'static Kern,
    ring: Vec<Arc<Ringplatz>>,
    frei: Arc<Freigabe>,
    ebenen: [Ebene; 2],
    /// Masse und Bittiefe, fuer die der Ring gilt. Aendert sich etwas davon,
    /// wird er verworfen und neu gebaut.
    bauart: Bauart,
    briefkasten: Arc<crate::einfrieren::Briefkasten>,
}

// SAFETY: `Vkseite` ist bereits `Send`; die CUDA-Zeiger im Ring werden
// ausschliesslich vom Decoder-Thread benutzt, und der Kontext wird dort vor
// jedem Gebrauch gesetzt. Die `Bruecke` lebt in `VideoDecoder` und wandert mit
// ihm.
unsafe impl Send for Bruecke {}

impl Bruecke {
    /// Baut die Bruecke fuer die Masse und Bittiefe eines dekodierten Bildes.
    ///
    /// **Das wgpu-Geraet MUSS mitkommen**, und das ist der Unterschied zur
    /// Windows-Bruecke, die sich alles aus dem Bild holt: ein `VkImage` gehoert
    /// unaufloesbar zu seinem `VkDevice`, es muss also auf genau dem entstehen,
    /// das der Renderer dieses Fensters fuehrt. Ein prozessweites Geraet waere
    /// falsch — der Player kann mehrere Fenster mit je eigenem Geraet fuehren
    /// (`app::Session`).
    pub fn neu(
        frame: &ffmpeg::util::frame::video::Video,
        briefkasten: Arc<crate::einfrieren::Briefkasten>,
        geraet: &Option<wgpu::Device>,
    ) -> Result<Self> {
        let d = geraet
            .as_ref()
            .context("kein wgpu-Geraet zur Hand — ohne das laesst sich kein Zielbild anlegen")?;
        let vk = Arc::new(Vkseite::neu(d)?);
        let kern = kern(vk.uuid())?;
        let bauart = Bauart::von_frame(frame)?;
        let mut b = Self {
            vk,
            kern,
            ring: Vec::new(),
            frei: Freigabe::leer(),
            ebenen: bauart.ebenen(),
            bauart,
            briefkasten,
        };
        b.ring_bauen()?;
        Ok(b)
    }

    /// Ein Bild ueber die Bruecke nehmen. `Ok(None)` heisst „kein freier
    /// Ringplatz" — dieses eine Bild nimmt den alten Weg, der naechste Versuch
    /// laeuft wieder.
    ///
    /// **Das Bild kommt nackt heraus, nicht in einem `Arc`.** Die gemeinsame
    /// Huelle setzt die Weiche darueber (`zerocopy::linuxweg`), damit beide
    /// Linux-Wege dieselbe tragen — hier eines anzulegen ergaebe ein `Arc` im
    /// `Arc`, also zwei Zaehler fuer eine Lebensdauer.
    pub fn uebernehmen(
        &mut self,
        frame: &ffmpeg::util::frame::video::Video,
    ) -> Result<Option<GpuBild>> {
        let bauart = Bauart::von_frame(frame)?;
        if bauart != self.bauart {
            // Aufloesung oder Bittiefe gewechselt. Der alte Ring passt nicht
            // mehr; er wird komplett verworfen und neu gebaut.
            self.ring_abbauen();
            self.bauart = bauart;
            self.ebenen = bauart.ebenen();
            self.ring_bauen()?;
        }
        let Some(slot) = self.frei.nehmen() else { return Ok(None) };
        match self.kopieren(frame, slot) {
            Ok(()) => Ok(Some(GpuBild::neu(
                self.ring[slot].clone(),
                self.bauart,
                slot,
                self.frei.clone(),
                self.briefkasten.clone(),
            ))),
            Err(e) => {
                // Der Platz war entnommen und ist nie in ein `GpuBild`
                // gewandert — ohne diese Zeile bliebe er auf Dauer verloren,
                // und der Ring liefe bei wiederholten Fehlern leer.
                self.frei.zurueck(slot);
                Err(e)
            }
        }
    }

    /// Beide Ebenen des Bildes in den Ringplatz kopieren und auf die Karte
    /// warten.
    fn kopieren(&self, frame: &ffmpeg::util::frame::video::Video, slot: usize) -> Result<()> {
        let c = &self.kern.cuda;
        // Vor jedem Bild neu, nicht nur einmal beim Aufbau — Begruendung bei
        // `Kern::kontext_setzen`.
        self.kern.kontext_setzen()?;
        for (i, e) in self.ebenen.iter().enumerate() {
            // SAFETY: das Bild lebt und traegt bei `AV_PIX_FMT_CUDA` in
            // `data[i]` einen Geraetezeiger; Null wird geprueft.
            let (quelle, schrittweite) = unsafe {
                let f = frame.as_ptr();
                ((*f).data[i] as cuda::CUdeviceptr, (*f).linesize[i])
            };
            if quelle == 0 {
                bail!("Bild ohne CUDA-Speicher in Ebene {i}");
            }
            if schrittweite <= 0 {
                bail!("Ebene {i} ohne Zeilenabstand");
            }
            let kopie = cuda::Memcpy2d::geraet_nach_array(
                quelle,
                // **`linesize`, nicht Breite mal Tiefe.** NVDEC fuellt auf:
                // 1080p NV12 2048 statt 1920, 1080p P010 4096 statt 3840. Bei
                // 1440p sind beide zufaellig gleich — dort faellt der Fehler
                // nicht auf, und deshalb steht der Hinweis hier UND an
                // `Memcpy2d::geraet_nach_array`.
                schrittweite as usize,
                self.ring[slot].array(i),
                e.zeilenbytes(),
                e.hoehe as usize,
            );
            // SAFETY: Quelle und Ziel gehoeren beide dem gesetzten Kontext; die
            // Masse stammen aus derselben Rechnung, mit der das Zielbild
            // angelegt wurde.
            unsafe { c.pruefe((c.cuMemcpy2d)(&kopie), "cuMemcpy2D Geraet -> Array")? };
        }
        // Warten, bevor das Bild herausgeht — Begruendung im Modulkopf.
        // SAFETY: der Kontext ist auf diesem Thread gesetzt.
        unsafe { c.pruefe((c.cuCtxSynchronize)(), "cuCtxSynchronize")? }
        Ok(())
    }

    fn ring_bauen(&mut self) -> Result<()> {
        // **Auch hier, nicht nur beim Kopieren** — aus demselben Grund
        // (s. `Kern::kontext_setzen`), und diese Zeile hat im ersten Lauf am
        // 2026-08-07 gefehlt: `cuImportExternalMemory` antwortete mit
        // `invalid device context` (rc=201), der Weg schaltete sich beim ersten
        // Bild selbst ab, und im Log stand nur der Rueckfall. Der Kontext war
        // beim Oeffnen des Decoders gesetzt worden — auf einem anderen
        // Arbeitsthread als dem, auf dem das erste Bild ankam.
        self.kern.kontext_setzen()?;
        let n = ringgroesse();
        for _ in 0..n {
            match Ringplatz::bauen(&self.vk, self.kern, &self.ebenen) {
                Ok(p) => self.ring.push(Arc::new(p)),
                Err(e) => {
                    self.ring_abbauen();
                    return Err(e);
                }
            }
        }
        self.frei = Freigabe::mit(n);
        Ok(())
    }

    /// Den Ring loslassen.
    ///
    /// **Loslassen, nicht freigeben** — freigegeben wird jeder Platz erst,
    /// wenn ausser der Bruecke auch kein Bild und keine wgpu-Textur mehr auf
    /// ihn zeigt (s. [`Ringplatz`]). Deshalb steht hier kein `destroy`.
    fn ring_abbauen(&mut self) {
        self.ring.clear();
        self.frei = Freigabe::leer();
    }
}
