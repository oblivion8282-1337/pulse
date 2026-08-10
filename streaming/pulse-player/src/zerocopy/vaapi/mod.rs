//! Die dritte Bruecke: VAAPI → wgpu ueber DMA-BUF (AMD, Intel).
//!
//! Aufbau und Begruendung der beiden anderen Wege im Modulkopf von [`super`];
//! hier steht, was DIESER Weg anders macht — und er macht fast alles anders.
//!
//! ## Sie kopiert nicht, sie ZEIGT auf die Decoder-Surface
//!
//! Die Windows-Bruecke kopiert GPU-intern in eine teilbare Textur, die
//! CUDA-Bruecke kopiert in ein selbst angelegtes `VkImage`. Hier wird gar nicht
//! kopiert: `av_hwframe_map` gibt die Surface als DMA-BUF heraus, und Vulkan
//! haengt genau diesen Speicher ein. Das ist der billigste der drei Wege — und
//! der einzige, bei dem der Decoder mitliest, was der Renderer noch braucht.
//! Daraus folgen die zwei Dinge, die die anderen nicht haben: der Lebensanker
//! und der Deckel, beide in [`anker`] begruendet.
//!
//! ## Was gemessen ist, und was nicht
//!
//! Belegt auf einer Radeon 780M (Mesa 26.1.5), fuer H.264-8-bit, AV1-8-bit und
//! AV1-10-bit, beide Ebenen, byteweise gegen den heruntergeladenen Frame:
//! **bitgenau** — `profiles/player-2026-08-10-vaapi-dmabuf-export.json`. Damit
//! sind drei Risiken erledigt: die Einplanigkeit (der fertige Helfer
//! `texture_from_dmabuf_fd` traegt), der Versatz der Farbebene im gemeinsamen
//! Objekt und der Layout-Uebergang aus `UNDEFINED`.
//!
//! **Nicht gemessen ist der Fall zweier GPUs.** `PULSE_PLAYER_VAAPI_DEVICE`
//! zeigt fest auf `renderD128`, wgpu waehlt seinen Adapter unabhaengig davon;
//! ueber eine GPU-Grenze hinweg scheitert der Import (dann greift der
//! Rueckfall) oder er ist still langsam. Die CUDA-Bruecke hat dafuer den
//! UUID-Abgleich (`linux::kern`), hier fehlt das Gegenstueck. Ebenso ungeprueft
//! ist Intel — derselbe Weg, andere Gestalt moeglich; [`gestalt`] weist ab, was
//! nicht passt, statt es zurechtzubiegen.
//!
//! ## Der eigene Schalter
//!
//! `PULSE_PLAYER_ZEROCOPY_VAAPI=0` schaltet **nur** diesen Weg ab und laesst
//! die anderen beiden laufen. Er ist noetig, weil `PULSE_PLAYER_ZEROCOPY=0`
//! zu grob waere: auf einer Maschine mit NVIDIA und AMD nebeneinander soll sich
//! der neue Weg einzeln stilllegen lassen, ohne den erprobten mitzunehmen.

mod anker;
mod gestalt;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use ffmpeg_next as ffmpeg;

use super::freigabe::Freigabe;
use anker::Anker;
pub use anker::Dmabufebene;

/// Wie viele Bilder der Renderer gleichzeitig festhalten darf.
///
/// **Dieselbe Zahl wie die Ringgroesse der CUDA-Bruecke, und aus demselben
/// Grund** (`linux::platz::ringgroesse`): `app::takt` haelt die Bilder rund
/// `vorhalt_ms` zurueck (Vorgabe 60 ms, bei 60 Bildern je Sekunde also vier
/// Stueck), dazu das anliegende, das gezeichnete und das, dessen
/// Zeichendurchgang noch laeuft — und die kurze Nachhut im Renderer
/// (`render::fremdbild::NACHHUT`).
///
/// Der Preis steht hier woanders als dort: nicht in eigenem Grafikspeicher,
/// sondern in Surfaces, die dem Decoder fehlen. Genau so viele bekommt er ueber
/// [`zusatzbilder`] zusaetzlich in seinen Pool.
fn deckelgroesse() -> usize {
    std::env::var("PULSE_PLAYER_ZEROCOPY_VAAPI_DECKEL")
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|n| (2..=32).contains(n))
        .unwrap_or(12)
}

/// Sicherheitsabstand im Decoder-Pool: so viele Surfaces mehr, als der Deckel
/// je festhaelt.
///
/// Ohne ihn liefe der Decoder bei voll ausgeschoepftem Deckel auf genau null
/// freie Surfaces zu — er braucht aber selbst noch welche, um ueberhaupt ein
/// Bild zu bauen (Referenzbilder zaehlt FFmpeg getrennt, die laufende
/// Rekonstruktion nicht).
const ABSTAND: i32 = 4;

/// Wie viele Surfaces der VAAPI-Decoder ueber seinen eigenen Bedarf hinaus
/// anlegen soll (`AVCodecContext.extra_hw_frames`, gesetzt VOR
/// `avcodec_open2`).
///
/// **Ohne diese Zahl ist der Deckel nur die halbe Abhilfe.** Er verhindert,
/// dass der Renderer mehr nimmt als vereinbart; dass der Decoder mit dem Rest
/// auskommt, sichert erst der groessere Pool. Faellt beides auseinander, steht
/// das Bild — und der Einfrier-Waechter meldete einen Decoder, der nichts
/// liefert, statt der wahren Ursache.
///
/// **Ob dieser Weg ueberhaupt laeuft, prueft der Aufrufer**
/// (`zerocopy::zusatzbilder_vaapi`) — hier stand dieselbe Abfrage bis zum
/// 2026-08-10 ein zweites Mal.
pub fn zusatzbilder() -> i32 {
    deckelgroesse() as i32 + ABSTAND
}

/// Ist dieser Weg eingeschaltet? (s. Modulkopf)
pub fn erlaubt() -> bool {
    static AN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AN.get_or_init(|| {
        !matches!(
            std::env::var("PULSE_PLAYER_ZEROCOPY_VAAPI").as_deref().map(str::trim),
            Ok("0")
        )
    })
}

/// Die Bruecke haelt selbst nichts vor — sie vergibt nur Marken.
///
/// **Das ist der Unterschied zu den anderen beiden**, und er ist der Grund,
/// warum hier weder ein Ring noch eine `Bauart` steht: es gibt kein Zielbild,
/// das zur Aufloesung passen muesste. Wechselt der Strom seine Groesse, traegt
/// das naechste abgebildete Bild einfach die neue — geprueft wird sie ohnehin
/// je Bild (`gestalt::pruefen`).
pub struct Bruecke {
    /// Der Deckel: so viele Plaetze, wie der Renderer Bilder festhalten darf
    /// (Begruendung in [`anker`]). Die Platznummern selbst sind hier ohne
    /// Bedeutung — es haengt kein Ring daran, nur die Anzahl zaehlt.
    frei: Arc<Freigabe>,
    briefkasten: Arc<crate::einfrieren::Briefkasten>,
}

impl Bruecke {
    /// Prueft das Geraet und legt den Deckel an.
    ///
    /// **Das Merkmal wird hier geprueft und nicht erst beim Einhaengen.**
    /// Fehlt es, scheitert `texture_from_dmabuf_fd` im Renderer mit einem
    /// `DeviceError::Unexpected` — der Rueckkanal daraus ist
    /// `zerocopy::abschalten`, also der Weg ueber einen Fehlschlag. Ein
    /// Fehlschlag beim Aufbau ist derselbe Rueckfall, nur eine Meldung frueher
    /// und mit der richtigen Ursache im Text.
    pub fn neu(
        frame: &ffmpeg::util::frame::video::Video,
        briefkasten: Arc<crate::einfrieren::Briefkasten>,
        geraet: &Option<wgpu::Device>,
    ) -> Result<Self> {
        let d = geraet
            .as_ref()
            .context("kein wgpu-Geraet zur Hand — ohne das laesst sich nichts einhaengen")?;
        if !d.features().contains(wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF) {
            bail!(
                "die GPU bietet VULKAN_EXTERNAL_MEMORY_DMA_BUF nicht an \
                 (kein VK_EXT_external_memory_dma_buf / VK_EXT_image_drm_format_modifier)"
            );
        }
        if frame.format() != ffmpeg::format::Pixel::VAAPI {
            bail!("{:?} ist kein VAAPI-Bild", frame.format());
        }
        Ok(Self { frei: Freigabe::mit(deckelgroesse()), briefkasten })
    }

    /// Ein Bild ueber die Bruecke nehmen.
    ///
    /// `Ok(None)` heisst „der Deckel ist erreicht" — dieses eine Bild nimmt den
    /// alten Weg ueber den Hauptspeicher, der naechste Versuch laeuft wieder.
    /// Das ist hier kein Randfall, sondern das Ventil, das den Decoder am Leben
    /// haelt (s. [`anker`]).
    pub fn uebernehmen(
        &mut self,
        frame: &ffmpeg::util::frame::video::Video,
    ) -> Result<Option<GpuBild>> {
        let Some(slot) = self.frei.nehmen() else { return Ok(None) };
        // Der Platz wandert in den Anker und kehrt mit dessen `Drop` zurueck.
        // Scheitert das Abbilden, ist er nie dort angekommen — ohne diese Zeile
        // bliebe er auf Dauer verloren, und der Deckel schloesse sich bei
        // wiederholten Fehlschlaegen ganz (wie `linux::Bruecke::uebernehmen`).
        let anker = match Anker::abbilden(frame, slot, self.frei.clone()) {
            Ok(a) => a,
            Err(e) => {
                self.frei.zurueck(slot);
                return Err(e);
            }
        };
        Ok(Some(GpuBild::neu(Arc::new(anker), self.briefkasten.clone())))
    }
}

/// Ein dekodiertes Bild, das in der Decoder-Surface liegen bleibt.
pub struct GpuBild {
    anker: Arc<Anker>,
    kennung: isize,
    briefkasten: Arc<crate::einfrieren::Briefkasten>,
}

impl GpuBild {
    fn neu(anker: Arc<Anker>, briefkasten: Arc<crate::einfrieren::Briefkasten>) -> Self {
        Self { anker, kennung: naechste_kennung(), briefkasten }
    }

    /// Masse der Luma-Ebene — und damit die des Bildes.
    ///
    /// Wie auf dem CUDA-Weg sind sie gleich den Bildmassen: eingehaengt wird,
    /// was der Deskriptor nennt, und der nennt die Bildgroesse. Der Zuschnitt
    /// im Renderer (`render::farbe::Bildform::nutzanteil`) rechnet damit die
    /// Eins aus — richtig, nur wirkungslos.
    pub fn textur_masse(&self) -> (u32, u32) {
        let e = &self.anker.gestalt.ebenen[0];
        (e.breite, e.hoehe)
    }

    pub fn zehn_bit(&self) -> bool {
        self.anker.gestalt.zehn_bit
    }

    /// Der Schluessel, unter dem der Renderer seinen Import fuehrt.
    ///
    /// **Hier ist er je BILD verschieden, nicht je Ringplatz** — und das ist
    /// der Kern des Unterschieds zu den anderen beiden Bruecken: jedes Bild ist
    /// eine andere Surface mit einer frisch angelegten Abbildung, es gibt gar
    /// nichts wiederzuverwenden. Eine laufende Nummer statt eines Zeigerwerts,
    /// damit sich kein Schluessel je wiederholt: ein wiederverwendeter Wert
    /// liefe in einen Zwischenspeicher-Treffer auf eine Textur, die auf eine
    /// laengst weitergereichte Surface zeigt.
    pub fn handle(&self) -> isize {
        self.kennung
    }

    pub fn briefkasten(&self) -> &Arc<crate::einfrieren::Briefkasten> {
        &self.briefkasten
    }

    /// Beide Ebenen mit frischen Dateideskriptoren (s. [`Dmabufebene`]).
    pub fn ebenen_zum_einhaengen(&self) -> Result<[Dmabufebene; 2]> {
        anker::ebenen_zum_einhaengen(&self.anker)
    }
}

/// Laufende Nummer je abgebildetem Bild.
///
/// Prozessweit und nicht je Bruecke: der Player kann mehrere Fenster mit je
/// eigener Bruecke fuehren, und zwei gleiche Schluessel in zwei
/// Zwischenspeichern waeren zwar unschaedlich, aber beim Lesen eines Logs
/// irrefuehrend.
fn naechste_kennung() -> isize {
    static NAECHSTE: AtomicI64 = AtomicI64::new(1);
    NAECHSTE.fetch_add(1, Ordering::Relaxed) as isize
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Deckel muss in einem Bereich bleiben, in dem der Weg funktioniert:
    /// unter zwei Bildern stockt die Anzeige, ueber 32 nimmt er dem Decoder
    /// mehr Surfaces weg, als `extra_hw_frames` ihm zurueckgibt. Ein unsinniger
    /// Wert in der Umgebung faellt auf die Vorgabe zurueck.
    #[test]
    fn die_deckelgroesse_bleibt_im_rahmen() {
        assert_eq!(deckelgroesse(), 12, "ohne Umgebungsvariable gilt die Vorgabe");
    }

    /// **Der Pool muss groesser sein als der Deckel.** Waeren beide gleich,
    /// haette der Decoder im Grenzfall keine einzige freie Surface mehr — das
    /// Bild stuende, und die Ursache saehe nach einem toten Decoder aus.
    #[test]
    fn der_pool_ist_groesser_als_der_deckel() {
        assert!(zusatzbilder() > deckelgroesse() as i32);
    }
}
