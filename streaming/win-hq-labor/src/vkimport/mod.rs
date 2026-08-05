//! D3D11-Texturen zero-copy als Vulkan-Bilder in den FFmpeg-Encoder.
//!
//! **Warum es das gibt.** Intra-Refresh gibt es auf AMD/Windows nur über den
//! Vulkan-Encoder (AMF ignoriert es, D3D12 liefert nichts Brauchbares —
//! Messakten vom 2026-08-01). Die Aufnahme kommt aber von WGC und damit als
//! D3D11-Textur, und FFmpegs Vulkan-Schicht kennt keine Brücke dorthin: sie
//! bildet nur von DRM, VAAPI und CUDA ab, alles Linux. Also selbst bauen.
//!
//! **Der Weg**, jeder Schritt einzeln nachgewiesen
//! (`examples/probe_d3d11_vulkan_import.rs`, Messakte
//! `vulkan-2026-08-01-d3d11-import-zerocopy.json`):
//!
//! ```text
//! WGC (BGRA, D3D11)
//!   → VideoProcessorBlt        Farbwandlung + Skalierung in einem Durchgang
//!   → NV12/P010-Textur         geteilt als NT-Handle
//!   → vkAllocateMemory(Import) dediziert, an ein VkImage gebunden
//!   → AVVkFrame                an den Encoder
//! ```
//!
//! **Drei Dinge, die nicht offensichtlich sind und je Stück Stunden kosten
//! können:**
//!
//! 1. `SHARED_NTHANDLE` allein reicht nicht — die Textur braucht zusätzlich
//!    `SHARED`, sonst lehnt `CreateTexture2D` mit `E_INVALIDARG` ab. **Nicht
//!    `KEYEDMUTEX`**, obwohl auch das die Textur erzeugbar macht; Begründung
//!    an `HwPoolConfig::shared` im Sidecar.
//! 2. Der Import muss **dediziert** sein (`VkMemoryDedicatedAllocateInfo`),
//!    und der Speichertyp muss zu Bild *und* Handle passen.
//! 3. Der Pool muss aus **Einzeltexturen** bestehen. Ein Texture-Array
//!    (FFmpegs Vorgabe bei `initial_pool_size > 0`) lässt sich nicht je Bild
//!    importieren — Vulkan importiert die ganze Ressource. Auf AMD gibt es
//!    den Einzeltextur-Pool ohnehin, weil AMF über das Array zerrissene
//!    Bilder liefert.
//!
//! **Synchronisierung.** Der Encoder darf das Bild nicht anfassen, solange der
//! Video-Prozessor noch schreibt — ein Fehler, der sich als sporadisch
//! zerrissenes Bild zeigt und in keiner Kennzahl auftaucht. Der naheliegende
//! Weg, den D3D11-Fence als Vulkan-Semaphore zu importieren, ist geprüft und
//! **verworfen**: FFmpeg kommt damit nicht zurecht, schon das erste Bild endet
//! in `VK_ERROR_DEVICE_LOST`. Stattdessen bekommt jede Textur eine gewöhnliche
//! Vulkan-Zeitleisten-Semaphore, und auf D3D11 wird kurz auf der CPU gewartet.
//! Das kostet Wartezeit, aber keine Kopie. Die ganze Übergabe steckt in
//! [`VulkanImport::mit_bild`], wo auch die Reihenfolge begründet ist.

//!
//! **Aufteilung.** Die Vulkan-Deklarationen liegen in [`vk`] (reine
//! Bindungsfläche), der Aufbau des Importers in [`aufbau`], der einmalige
//! Import je Textur in [`einfuhr`]. Hier bleibt, was den Ablauf ausmacht: die
//! Übergabe je Bild samt ihrer Reihenfolge, und das Aufräumen.

mod aufbau;
mod einfuhr;
mod profil;
mod vk;

use std::collections::HashMap;

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11DeviceContext4, ID3D11Fence, ID3D11Texture2D,
};
use windows::Win32::System::Threading::{
    CRITICAL_SECTION, EnterCriticalSection, LeaveCriticalSection,
};
use windows::core::Interface;
use einfuhr::Importiert;
use profil::Videoprofil;
pub use profil::Videocodec;
use vk::*;
pub use vk::{AVVkFrame, VK_FORMAT_NV12, VK_FORMAT_P010};

/// Hält Vulkan-Gerät, Frames-Kontext, den geteilten Fence und den Cache der
/// importierten Texturen.
pub struct VulkanImport {
    device_ref: *mut AVBufferRef,
    frames_ref: *mut AVBufferRef,
    act_dev: u64,
    phys_dev: u64,
    fns: VkFns,
    /// D3D11-Fence, auf den nach jedem Schreiben kurz gewartet wird.
    /// **Nicht** nach Vulkan importiert — s. [`Self::mit_bild`].
    fence: ID3D11Fence,
    /// Ereignis für das Warten auf den Fence.
    ereignis: HANDLE,
    ctx4: ID3D11DeviceContext4,
    /// Die Section, unter der Befehle auf `ctx4` stehen müssen. Sie gehört dem
    /// Pool, nicht uns — s. [`VulkanImport::new`].
    lock_ptr: *mut CRITICAL_SECTION,
    /// Schlüssel ist der rohe `ID3D11Texture2D`-Zeiger. Die Pool-Texturen
    /// wiederholen sich, der Import passiert also einmal je Textur und nicht
    /// je Bild — sonst wären es 60 Importe je Sekunde.
    cache: HashMap<usize, Importiert>,
    /// Zaehler der D3D11-Fence-Zeitleiste (s. `Self::mit_bild`). Rein
    /// D3D11-seitig — Vulkan hat seine eigenen Semaphoren je Textur.
    timeline: u64,
    /// Alle Queue-Familien des Geraets — fuer CONCURRENT-Bilder (s. importiere).
    queue_families: Vec<u32>,
    /// `VkImageCreateFlags` und `VkImageUsageFlags`, **von FFmpeg errechnet**
    /// und beim Aufbau zurueckgelesen (s. [`Self::new`]). Nicht selbst gewaehlt.
    img_flags: u32,
    usage: u32,
    vk_format: i32,
    /// Das Video-Profil — **Rückfall, nicht Regelweg**: angehängt wird es nur,
    /// wenn die Bilder nicht profilunabhängig sind (s. [`Videoprofil`]).
    /// **Muss so lange leben wie der Importer**: die Vulkan-Strukturen
    /// verweisen aufeinander mit rohen Zeigern, und `vkCreateImage` liest die
    /// Kette beim Aufruf.
    profil: Videoprofil,
    breite: u32,
    hoehe: u32,
}

impl VulkanImport {
    /// Der Frames-Kontext, den der Encoder binden muss.
    pub fn frames_ref(&self) -> *mut AVBufferRef {
        self.frames_ref
    }

    /// Importiert die Textur (oder holt sie aus dem Cache) und liefert den
    /// `AVVkFrame` für den Encoder. Der D3D11-Schreibvorgang läuft
    /// **innerhalb** — zwischen dem Warten auf den Encoder und dem Warten auf
    /// D3D11.
    ///
    /// **Das ist der einzig richtige Ablauf, und die Reihenfolge ist der
    /// ganze Punkt:**
    ///
    /// 1. warten, bis der Encoder mit DIESER Textur fertig ist — sonst
    ///    überschreibt D3D11 ein Bild, das gerade kodiert wird. Der Fehler
    ///    zeigt sich nicht dort, sondern später als Geräteverlust oder als
    ///    zerrissenes Bild, und nur manchmal.
    /// 2. schreiben (Blt, Kopie, was auch immer der Aufrufer tut)
    /// 3. warten, bis D3D11 fertig ist — sonst liest der Encoder ein halb
    ///    geschriebenes Bild.
    ///
    /// Getrennte Aufrufe für 1 und 3 wären die falsche Schnittstelle: man kann
    /// sie in der falschen Reihenfolge benutzen oder einen vergessen, und
    /// beides fällt erst im Betrieb auf.
    ///
    /// **Wo der Aufrufer nicht selbst schreibt** — etwa weil eine Pipeline den
    /// Blt macht — gibt es [`warte_auf_encoder`](Self::warte_auf_encoder) für
    /// Schritt 1 einzeln; `mit_bild` mit leerer Schreib-Closure erledigt dann
    /// nur noch Schritt 3.
    ///
    /// # Safety
    ///
    /// `tex` muss eine Textur des Pools sein, deren Beschreibung zu Format und
    /// Maßen dieses Importers passt, und sie muss den Encode-Aufruf überleben.
    pub unsafe fn mit_bild<F>(&mut self, tex: &ID3D11Texture2D, schreiben: F) -> Result<*mut AVVkFrame>
    where
        F: FnOnce() -> Result<()>,
    {
        // SAFETY: gleicher Vertrag wie diese Funktion.
        unsafe { self.warte_auf_encoder(tex)? };
        // SAFETY: dito; die Textur ist nach dem Warten frei.
        unsafe { self.uebergib(tex, schreiben) }
    }

    /// Schritt 1 einzeln: warten, bis der Encoder mit dieser Textur fertig ist.
    ///
    /// **Vor jedem Schreiben in sie aufzurufen.** Wer das dem Blt nachstellt,
    /// wartet ein Bild zu spät — dann hat der Video-Prozessor schon
    /// hineingeschrieben, während der Encoder noch las.
    ///
    /// Importiert die Textur beim ersten Mal mit; danach ist es ein Nachschlagen
    /// und, falls FFmpeg sie schon benutzt hat, ein `vkWaitSemaphores`.
    ///
    /// # Safety
    ///
    /// Wie [`mit_bild`](Self::mit_bild).
    pub unsafe fn warte_auf_encoder(&mut self, tex: &ID3D11Texture2D) -> Result<()> {
        let key = tex.as_raw() as usize;
        if !self.cache.contains_key(&key) {
            let importiert = self.importiere(tex)?;
            self.cache.insert(key, importiert);
        }

        // `sem_value` ist der Wert, den FFmpeg nach der letzten Benutzung
        // hinterlassen hat; 0 heisst "noch nie benutzt".
        let (letzter, sem) = {
            let e = &self.cache[&key];
            (e.vk.sem_value[0], e.vk.sem[0])
        };
        if letzter > 0 && sem != 0 {
            let info = VkSemaphoreWaitInfo {
                s_type: VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO,
                p_next: std::ptr::null(),
                flags: 0,
                semaphore_count: 1,
                p_semaphores: &sem,
                p_values: &letzter,
            };
            // Eine Sekunde ist grosszuegig; laeuft sie ab, ist etwas grundlegend
            // kaputt und ein stiller Weiterlauf waere das Schlechteste.
            let rc = unsafe { (self.fns.wait_semaphores)(self.act_dev, &info, 1_000_000_000) };
            if rc != VK_SUCCESS {
                return Err(anyhow!("vkWaitSemaphores rc={rc} — Encoder nicht fertig"));
            }
        }
        Ok(())
    }

    /// Schritte 2 und 3: schreiben lassen, dann auf D3D11 warten und den
    /// `AVVkFrame` herausgeben.
    ///
    /// # Safety
    ///
    /// Wie [`mit_bild`](Self::mit_bild). Zusätzlich: der Aufrufer hat für
    /// diese Textur bereits [`warte_auf_encoder`](Self::warte_auf_encoder)
    /// gerufen.
    pub unsafe fn uebergib<F>(
        &mut self,
        tex: &ID3D11Texture2D,
        schreiben: F,
    ) -> Result<*mut AVVkFrame>
    where
        F: FnOnce() -> Result<()>,
    {
        let key = tex.as_raw() as usize;
        if !self.cache.contains_key(&key) {
            let importiert = self.importiere(tex)?;
            self.cache.insert(key, importiert);
        }

        // (2) Der Aufrufer schreibt.
        schreiben()?;

        // (3) **Warten, bis D3D11 mit dem Bild fertig ist.**
        //
        // Der naheliegende Weg wäre gewesen, den D3D11-Fence als
        // Vulkan-Zeitleisten-Semaphore zu importieren und FFmpeg darauf warten
        // zu lassen. Der Import gelingt auch (`probe_d3d11_vulkan_import`),
        // aber **FFmpeg kann sie nicht benutzen**: sobald eine so gestützte
        // Semaphore im `AVVkFrame` steht, endet schon das erste Bild in
        // `VK_ERROR_DEVICE_LOST` — und zwar auch dann, wenn gar nicht
        // signalisiert wird. Durch Halbierung nachgewiesen: es liegt nicht am
        // Signalwert, sondern an der Semaphore selbst.
        //
        // Deshalb bleibt die Semaphore im `AVVkFrame` eine gewöhnliche, von uns
        // erzeugte — eine **je Textur**, nicht eine für alle (Begründung an der
        // Erzeugung in `importiere`).
        //
        // Die Synchronisierung macht stattdessen ein kurzes Warten auf der CPU:
        // Fence signalisieren, spülen, auf das Ereignis warten. Das kostet
        // Wartezeit, aber **keine Kopie** — der Bildweg bleibt zero-copy. Für
        // einen VideoProcessorBlt liegt das deutlich unter einer Millisekunde;
        // ob es bei 60 Bildern je Sekunde ins Gewicht fällt, ist zu messen und
        // nicht zu vermuten.
        self.timeline += 1;
        let wert = self.timeline;
        // **Unter der Section.** `Signal` und `Flush` sind Befehle auf dem
        // immediate Kontext, auf dem gleichzeitig die Aufnahme-Kopie (WGC-Faden)
        // und der Blt laufen; der Kontext ist nicht thread-sicher. Das WARTEN
        // gehört bewusst NICHT hinein — es dauert bis zu einer Millisekunde,
        // und so lange den Aufnahme-Faden zu blockieren hiesse, Bilder zu
        // verlieren, um ein Datenrennen zu vermeiden, das es dann gar nicht
        // mehr gibt: der Fence-Wert ist nach dem Flush festgeschrieben.
        // SAFETY: der Zeiger stammt aus dem Vertrag von `new`.
        unsafe { EnterCriticalSection(self.lock_ptr) };
        let signal = unsafe { self.ctx4.Signal(&self.fence, wert) };
        if signal.is_ok() {
            unsafe { self.ctx4.Flush() };
        }
        // SAFETY: dieselbe Section, genau einmal betreten.
        unsafe { LeaveCriticalSection(self.lock_ptr) };
        signal.map_err(|e| anyhow!("ID3D11DeviceContext4::Signal: {e}"))?;
        if unsafe { self.fence.GetCompletedValue() } < wert {
            unsafe { self.fence.SetEventOnCompletion(wert, self.ereignis) }
                .map_err(|e| anyhow!("SetEventOnCompletion: {e}"))?;
            unsafe { windows::Win32::System::Threading::WaitForSingleObject(self.ereignis, 1000) };
        }

        let eintrag = self.cache.get_mut(&key).expect("gerade eingefügt");
        // **Layout zurücksetzen, nicht stehen lassen.**
        //
        // FFmpeg schreibt nach jeder Benutzung den erreichten Zustand in
        // `layout`/`access` und geht beim nächsten Mal von dort aus. Dazwischen
        // hat aber D3D11 in die Textur geschrieben — von Vulkan aus gesehen ist
        // der vermerkte Zustand damit hinfällig. Eine Barriere aus einem
        // Zustand, in dem das Bild gar nicht mehr ist, ist ungültig; sie
        // scheitert nicht sichtbar, sondern gelegentlich.
        //
        // `UNDEFINED` heisst "über den bisherigen Inhalt wird nichts behauptet"
        // und ist nach einem fremden Schreibzugriff die einzige ehrliche
        // Angabe. Der Inhalt bleibt dabei erhalten — nachgerechnet am
        // dekodierten Muster, nicht angenommen.
        eintrag.vk.layout[0] = VK_IMAGE_LAYOUT_UNDEFINED;
        eintrag.vk.access[0] = 0;
        Ok(&mut *eintrag.vk as *mut AVVkFrame)
    }

}


impl Drop for VulkanImport {
    fn drop(&mut self) {
        unsafe {
            for (_, e) in self.cache.drain() {
                if !e.vk.internal.is_null() {
                    av_free(e.vk.internal);
                }
                (self.fns.free_memory)(self.act_dev, e.mem, std::ptr::null());
                (self.fns.destroy_image)(self.act_dev, e.image, std::ptr::null());
                if e.vk.sem[0] != 0 {
                    (self.fns.destroy_semaphore)(self.act_dev, e.vk.sem[0], std::ptr::null());
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(self.ereignis);
            av_buffer_unref(&mut self.frames_ref);
            av_buffer_unref(&mut self.device_ref);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Spiegel muss dieselbe Größe haben wie FFmpegs Struktur. Stimmt das
    /// nicht, schreibt der Encoder in fremde Felder — und das zeigt sich als
    /// sporadisch kaputtes Bild, nicht als Absturz.
    #[test]
    fn avvkframe_layout_plausibel() {
        // 8 Zeiger-Arrays à 8 Byte + 2 i32 + Ausrichtung. Der Test faengt
        // grobe Verschiebungen (fehlendes oder doppeltes Feld), nicht jede
        // denkbare Abweichung — dafuer gibt es keinen Weg ohne bindgen.
        let erwartet = 8 * 8  // img
            + 8               // tiling + Ausrichtung
            + 8 * 8           // mem
            + 8 * 8           // size
            + 4 + 8 * 4       // flags + access
            + 8 * 4           // layout
            + 4               // Ausrichtung vor sem
            + 8 * 8           // sem
            + 8 * 8           // sem_value
            + 8               // internal
            + 8 * 8           // offset
            + 8 * 4;          // queue_family
        assert_eq!(
            std::mem::size_of::<AVVkFrame>(),
            erwartet,
            "AVVkFrame-Spiegel passt nicht mehr zum Header"
        );
    }

    /// Der Spiegel wird nur GELESEN, und das macht ihn gefaehrlicher als den
    /// von `AVVkFrame`: ein Feld daneben liefert keine Absturzstelle, sondern
    /// eine plausible Zahl, mit der dann Bilder angelegt werden. Die
    /// Gesamtgroesse faengt jede Verschiebung ab, die ein Feld hinzufuegt oder
    /// wegnimmt.
    #[test]
    fn avvulkanframesctx_layout_plausibel() {
        let erwartet = 4        // tiling
            + 4                 // usage
            + 8                 // create_pnext
            + 8 * 8             // alloc_pnext
            + 4                 // flags
            + 4                 // img_flags
            + 8 * 4             // format
            + 4                 // nb_layers
            + 4                 // Ausrichtung vor den Zeigern
            + 8                 // lock_frame
            + 8; // unlock_frame
        assert_eq!(
            std::mem::size_of::<AVVulkanFramesContext>(),
            erwartet,
            "AVVulkanFramesContext-Spiegel passt nicht mehr zum Header"
        );
    }

    #[test]
    fn formate_sind_die_erwarteten() {
        assert_eq!(VK_FORMAT_NV12, 1_000_156_003);
        assert_eq!(VK_FORMAT_P010, 1_000_156_013);
    }
}
