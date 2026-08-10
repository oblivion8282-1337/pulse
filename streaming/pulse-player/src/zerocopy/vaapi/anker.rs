//! Der Lebensanker eines VAAPI-Bildes — und der Deckel, der verhindert, dass
//! der Renderer den Decoder aushungert.
//!
//! ## Warum es hier einen Anker braucht und bei CUDA nicht
//!
//! Auf dem CUDA-Weg gehoert das Zielbild UNS: Vulkan legt es an, CUDA kopiert
//! hinein, und niemand sonst fasst es an. Hier ist es umgekehrt — die
//! eingehaengte Textur zeigt auf die **Decoder-Surface selbst**. Solange der
//! abgebildete `AVFrame` lebt, haelt FFmpeg eine Referenz auf diese Surface und
//! gibt sie nicht in den Pool zurueck (`av_hwframe_map` legt dafuer einen
//! `HWMapDescriptor` an, der den Quell-Frame per `av_frame_ref` festhaelt —
//! `libavutil/hwcontext.c`, `ff_hwframe_map_create`). Faellt der Anker zu
//! frueh, dekodiert der Decoder in genau die Surface hinein, die der Renderer
//! gerade abtastet: ein Riss quer durchs Bild, unregelmaessig und ohne jede
//! Fehlermeldung.
//!
//! ## Und warum der Anker zugleich ein Deckel ist
//!
//! Genau daraus folgt die Gegenrichtung: **jedes festgehaltene Bild ist eine
//! Surface, die dem Decoder fehlt.** Der VAAPI-Pool ist fest (er entsteht beim
//! Oeffnen des Decoders); sind alle Surfaces beim Renderer, liefert der Decoder
//! gar nichts mehr. Der Ring der CUDA-Bruecke hat dafuer sein `Ok(None)`-Ventil
//! — hier gibt es von sich aus keines, weil nichts vorher angelegt wird, dessen
//! Ausgehen man bemerken koennte.
//!
//! Deshalb nimmt jedes festgehaltene Bild einen Platz aus der [`Freigabe`] der
//! Bruecke, und ist keiner mehr frei, gibt sie nichts mehr heraus (sie antwortet dann mit
//! `Ok(None)`, das Bild nimmt den alten Weg). Der Platz kehrt zurueck, wenn der
//! Anker faellt — **nach** der Surface, dafuer sorgt [`Anker::drop`]. Die
//! Gegenseite dazu ist `AVCodecContext.extra_hw_frames`: der Pool bekommt genau
//! so viele Surfaces mehr, wie die Bruecke maximal festhaelt (s.
//! `super::zusatzbilder`). Ohne beides zusammen waere das Symptom ein
//! stehendes Bild, dessen Ursache der Einfrier-Waechter falsch zuordnet — er
//! saehe einen Decoder, der nichts liefert, und nicht den Renderer, der ihm
//! den Vorrat weggenommen hat.
//!
//! **Der Platzstapel ist derselbe wie auf den anderen beiden Wegen**
//! (`zerocopy::freigabe`), obwohl hier gar kein Ring dahintersteht: gezaehlt
//! wird nicht vorgehaltener Speicher, sondern das Versprechen, dem Decoder
//! nicht mehr als diese Zahl an Surfaces vorzuenthalten. Die Nummer selbst ist
//! auf diesem Weg ohne Bedeutung.

use std::os::fd::{BorrowedFd, OwnedFd};
use std::sync::Arc;

use anyhow::{bail, Result};
use ffmpeg_next as ffmpeg;

use crate::zerocopy::freigabe::Freigabe;

use super::gestalt::{self, Gestalt, RohGestalt, RohLayer, RohObjekt, RohPlane};

/// Der Lebensanker: der abgebildete DRM_PRIME-Frame, seine geprüfte Gestalt und
/// der Platz, den er belegt.
pub struct Anker {
    /// **Gehalten, nie gelesen — genau darin besteht seine Aufgabe.** Solange
    /// dieser Frame lebt, gehoert die Surface uns; alles Gebrauchte steht als
    /// Zahlenwert in `gestalt`.
    ///
    /// `Option`, damit [`Anker::drop`] ihn vor dem Platz fallen lassen kann.
    drm: Option<ffmpeg::util::frame::video::Video>,
    pub(super) gestalt: Gestalt,
    slot: usize,
    frei: Arc<Freigabe>,
}

impl Drop for Anker {
    fn drop(&mut self) {
        // **Erst die Surface loslassen, dann den Platz melden.** Andersherum
        // koennte die Bruecke ein neues Bild abbilden, bevor das alte wirklich
        // losgelassen ist — sie haelte dann einen Augenblick lang eines mehr,
        // als der Decoder-Pool eingeplant hat.
        drop(self.drm.take());
        self.frei.zurueck(self.slot);
    }
}

// SAFETY: der `AVFrame` wird nach dem Abbilden nur noch gehalten, nie gelesen
// und nie veraendert — alles Gebrauchte steht als Zahlenwert in `gestalt`.
// Beruehrt wird er allein im `Drop`, und der kann auf dem Fenster-Thread laufen
// (wenn der Renderer das Bild zuletzt loslaesst). Genau dieselbe Ueberlegung
// wie bei `zerocopy::linux::Ringplatz`.
unsafe impl Send for Anker {}
unsafe impl Sync for Anker {}

impl Anker {
    /// Ein VAAPI-Bild nach DRM_PRIME abbilden und die Gestalt pruefen.
    ///
    /// **Das Flag ist `AV_HWFRAME_MAP_READ`, nicht `AV_HWFRAME_MAP_DIRECT`.**
    /// `DIRECT` wird auf diesem Weg gar nicht ausgewertet (es gilt nur fuer
    /// `vaapi_map_to_memory`); `READ` setzt `VA_EXPORT_SURFACE_READ_ONLY` und
    /// loest `vaSyncSurface` aus. Damit ist die dekodierseitige
    /// Synchronisation erledigt — diese Bruecke braucht **kein** Gegenstueck zu
    /// `cuCtxSynchronize`, und das ist gemessen, nicht angenommen
    /// (`profiles/player-2026-08-10-vaapi-dmabuf-export.json`).
    pub(super) fn abbilden(
        frame: &ffmpeg::util::frame::video::Video,
        slot: usize,
        frei: Arc<Freigabe>,
    ) -> Result<Self> {
        let (breite, hoehe) = (frame.width(), frame.height());
        let mut drm = ffmpeg::util::frame::video::Video::empty();
        // SAFETY: `drm` ist leer und gehoert uns; das Format muss VOR dem
        // Abbilden stehen, daran erkennt `av_hwframe_map` das Ziel.
        unsafe {
            (*drm.as_mut_ptr()).format = ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;
        }
        // SAFETY: beide Bilder sind gueltig; `av_hwframe_map` schreibt
        // ausschliesslich in `drm` und nimmt dabei eine Referenz auf `frame`.
        let rc = unsafe {
            ffmpeg::ffi::av_hwframe_map(
                drm.as_mut_ptr(),
                frame.as_ptr(),
                ffmpeg::ffi::AV_HWFRAME_MAP_READ as i32,
            )
        };
        if rc < 0 {
            bail!("av_hwframe_map nach DRM_PRIME scheiterte (rc={rc})");
        }
        // SAFETY: nach erfolgreichem Abbilden steht in `data[0]` ein
        // `AVDRMFrameDescriptor`, der so lange lebt wie `drm`. Null wird
        // geprueft; gelesen wird nur innerhalb der gemeldeten Anzahlen.
        let roh = unsafe { roh_gestalt(&drm)? };
        let gestalt = gestalt::pruefen(&roh, breite, hoehe)?;
        Ok(Self { drm: Some(drm), gestalt, slot, frei })
    }
}

/// Den Deskriptor in die einfache Form uebersetzen, die [`gestalt::pruefen`]
/// erwartet.
///
/// # Safety
/// `drm` muss ein erfolgreich abgebildeter DRM_PRIME-Frame sein.
unsafe fn roh_gestalt(drm: &ffmpeg::util::frame::video::Video) -> Result<RohGestalt> {
    let desc = (*drm.as_ptr()).data[0] as *const ffmpeg::ffi::AVDRMFrameDescriptor;
    if desc.is_null() {
        bail!("av_hwframe_map lieferte einen leeren Deskriptor");
    }
    let d = &*desc;
    // Die Felder sind `c_int` und duerfen in den Arrays (je vier Plaetze) nicht
    // ueberlaufen — ein negativer oder zu grosser Wert waere sonst ein
    // Zugriff ausserhalb.
    let objekte_n = (d.nb_objects.max(0) as usize).min(d.objects.len());
    let layer_n = (d.nb_layers.max(0) as usize).min(d.layers.len());
    let objekte = (0..objekte_n)
        .map(|i| RohObjekt { fd: d.objects[i].fd, modifier: d.objects[i].format_modifier })
        .collect();
    let layer = (0..layer_n)
        .map(|i| {
            let l = &d.layers[i];
            let p = &l.planes[0];
            RohLayer {
                fourcc: l.format,
                planes: l.nb_planes.max(0) as usize,
                erste: RohPlane {
                    objekt: p.object_index.max(0) as usize,
                    offset: p.offset.max(0) as u64,
                    pitch: p.pitch.max(0) as u64,
                },
            }
        })
        .collect();
    Ok(RohGestalt { objekte, layer })
}

/// Eine Bildebene, wie der Renderer sie einhaengt.
///
/// **Der `fd` ist ein frisches Duplikat und geht an Vulkan ueber**
/// (`texture_from_dmabuf_fd` uebernimmt ihn; bei Fehlschlag schliesst es ihn
/// selbst). Der Original-fd bleibt beim `AVFrame`, der ihn seinerseits beim
/// Aufraeumen schliesst — ihn direkt weiterzureichen hiesse, ihn zweimal zu
/// schliessen.
pub struct Dmabufebene {
    pub fd: OwnedFd,
    pub modifier: u64,
    pub format: wgpu::TextureFormat,
    pub offset: u64,
    pub pitch: u64,
    pub breite: u32,
    pub hoehe: u32,
}

/// Beide Ebenen zum Einhaengen bereitstellen — je Aufruf mit frischen fds.
///
/// Je Import ein `dup()`, und bei einem Objekt mit zwei Layern sind das ZWEI
/// Duplikate desselben Deskriptors: Vulkan nimmt jeden entgegengenommenen fd in
/// Besitz, zwei Texturen brauchen also zwei.
pub(super) fn ebenen_zum_einhaengen(anker: &Anker) -> Result<[Dmabufebene; 2]> {
    let e = &anker.gestalt.ebenen;
    // SAFETY: die fds gehoeren dem `AVFrame` in `anker` und sind offen,
    // solange er lebt — und er lebt, weil `anker` geliehen ist.
    let fds = unsafe { [fd_kopieren(e[0].fd)?, fd_kopieren(e[1].fd)?] };
    let [f0, f1] = fds;
    Ok([ebene(e[0], f0), ebene(e[1], f1)])
}

fn ebene(e: gestalt::Ebene, fd: OwnedFd) -> Dmabufebene {
    Dmabufebene {
        fd,
        modifier: e.modifier,
        format: e.format,
        offset: e.offset,
        pitch: e.pitch,
        breite: e.breite,
        hoehe: e.hoehe,
    }
}

/// **`try_clone_to_owned` und nicht `dup(2)`**, und der Unterschied ist nicht
/// die Kuerze: `std` nimmt `F_DUPFD_CLOEXEC`, das nackte `dup()` nicht. Ohne
/// das Merkmal erbte jeder `fork`/`exec` dieses Prozesses den duplizierten
/// DMA-BUF-Deskriptor — und damit ein Kindprozess einen Zeiger auf
/// Grafikspeicher, den es nichts angeht, gehalten bis zu seinem Ende.
///
/// # Safety
/// `roh` muss ein gueltiger, offener Dateideskriptor sein.
unsafe fn fd_kopieren(roh: i32) -> Result<OwnedFd> {
    BorrowedFd::borrow_raw(roh)
        .try_clone_to_owned()
        .map_err(|e| anyhow::anyhow!("dup({roh}) scheiterte: {e}"))
}
