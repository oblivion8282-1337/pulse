//! Die Befehlsseite von `Vkseite`: Layout-Uebergaenge und die beiden
//! Kopierwege, mit denen die Probe **an wgpu vorbei** nachsieht, was wirklich
//! im Speicher steht.
//!
//! Eigene Datei nur wegen der Groessen-Vorgabe des Projekts (350 Zeilen); es ist
//! derselbe Typ und dieselbe Zustaendigkeit wie im Elternmodul, deshalb ein
//! Kindmodul und kein Nachbar — nur so bleiben die Felder von `Vkseite` privat.

use anyhow::Result;
use ash::vk;

use super::{Bild, Vkseite};

impl Vkseite {
    fn mit_befehlen(&self, f: impl FnOnce(vk::CommandBuffer)) -> Result<()> {
        let pool = unsafe {
            self.device.create_command_pool(
                &vk::CommandPoolCreateInfo::default().queue_family_index(self.familie),
                None,
            )
        }?;
        let cb = unsafe {
            self.device.allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1),
            )
        }?[0];
        unsafe {
            self.device.begin_command_buffer(
                cb,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )?;
            f(cb);
            self.device.end_command_buffer(cb)?;
            let cbs = [cb];
            let submit = [vk::SubmitInfo::default().command_buffers(&cbs)];
            self.device.queue_submit(self.queue, &submit, vk::Fence::null())?;
            self.device.queue_wait_idle(self.queue)?;
            self.device.destroy_command_pool(pool, None);
        }
        Ok(())
    }

    /// Einen Layout-Uebergang von Hand fahren.
    ///
    /// **`alt` ist hier kein Beiwerk, sondern die Kernfrage der ganzen Probe.**
    /// Ein Uebergang aus `UNDEFINED` darf den Inhalt verwerfen; aus jedem
    /// anderen Layout darf er es nicht. Deshalb nimmt diese Funktion das alte
    /// Layout entgegen, statt bequem `UNDEFINED` einzusetzen — genau der
    /// bequeme Weg wuerde messen, was er zu messen vorgibt zu vermeiden.
    pub fn uebergang(&self, bild: &Bild, alt: vk::ImageLayout, neu: vk::ImageLayout) -> Result<()> {
        self.mit_befehlen(|cb| unsafe {
            self.device.cmd_pipeline_barrier(
                cb,
                vk::PipelineStageFlags::ALL_COMMANDS,
                vk::PipelineStageFlags::ALL_COMMANDS,
                vk::DependencyFlags::empty(),
                &[],
                &[],
                &[sperre(
                    bild,
                    alt,
                    neu,
                    vk::AccessFlags::MEMORY_WRITE,
                    vk::AccessFlags::MEMORY_WRITE | vk::AccessFlags::MEMORY_READ,
                )],
            );
        })
    }

    /// Ablage nach Bild. Das Bild muss im angegebenen Layout liegen.
    pub fn puffer_nach_bild(
        &self,
        quelle: vk::Buffer,
        bild: &Bild,
        layout: vk::ImageLayout,
    ) -> Result<()> {
        self.mit_befehlen(|cb| unsafe {
            self.device.cmd_copy_buffer_to_image(
                cb,
                quelle,
                bild.image,
                layout,
                &[bereich_kopie(bild.breite, bild.hoehe)],
            );
        })
    }

    /// Bild nach Ablage — der Weg, mit dem die Probe **an wgpu vorbei**
    /// nachsieht, was wirklich im Speicher steht.
    ///
    /// Er ist der Trennschnitt zwischen den beiden moeglichen Ursachen eines
    /// schwarzen wgpu-Ergebnisses: Inhalt verworfen (dann steht hier auch
    /// nichts mehr) gegen falsch gebundener Speicher (dann steht hier noch
    /// alles).
    /// `layout` ist das Layout, in dem das Bild liegt und in dem es hinterher
    /// wieder liegen soll.
    ///
    /// **Warum dazwischen nach `TRANSFER_SRC_OPTIMAL` gewechselt wird:**
    /// `vkCmdCopyImageToBuffer` laesst laut Spezifikation nur `GENERAL`,
    /// `TRANSFER_SRC_OPTIMAL` oder `SHARED_PRESENT_KHR` zu — `SHADER_READ_ONLY_OPTIMAL`,
    /// in dem wgpu die Textur hinterlaesst, gehoert nicht dazu. Hier stand
    /// zuerst ein Aufruf mit ebendiesem Layout; er lieferte auf dieser Karte
    /// **richtige Werte** und faellt daher bei keiner Messung auf. Gefunden hat
    /// ihn allein die Pruefschicht
    /// (`VUID-vkCmdCopyImageToBuffer-srcImageLayout-01397`). Ein Befund, der auf
    /// einem regelwidrigen Aufruf beruht, ist kein Befund — auch wenn die Zahl
    /// stimmt.
    ///
    /// Der Rueckweg am Ende ist Pflicht: wgpu geht davon aus, dass die Textur
    /// weiter in ihrem Zustand liegt, und erzeugt beim naechsten Zugriff keine
    /// Sperre mehr.
    /// `regelwidrig` laesst die Zwischen-Sperre absichtlich weg und kopiert
    /// direkt aus `layout`. Das ist die **Kontrolle fuer die Pruefschicht**:
    /// bei `SHADER_READ_ONLY_OPTIMAL` ist das ein echter Regelverstoss, und er
    /// ist der einzige hier erprobte, der zuverlaessig gemeldet wird
    /// (`VUID-vkCmdCopyImageToBuffer-srcImageLayout-01397`, an dieser Probe
    /// selbst beobachtet, bevor er behoben war). Ein Barrieren-Verstoss mit
    /// falschem alten Layout wurde ausprobiert und **nicht** gemeldet — als
    /// Kontrolle taugt er deshalb nicht.
    pub fn bild_nach_puffer(
        &self,
        bild: &Bild,
        ziel: vk::Buffer,
        layout: vk::ImageLayout,
        regelwidrig: bool,
    ) -> Result<()> {
        let kopier_layout =
            if regelwidrig { layout } else { vk::ImageLayout::TRANSFER_SRC_OPTIMAL };
        self.mit_befehlen(|cb| unsafe {
            self.device.cmd_pipeline_barrier(
                cb,
                vk::PipelineStageFlags::ALL_COMMANDS,
                vk::PipelineStageFlags::TRANSFER,
                vk::DependencyFlags::empty(),
                &[],
                &[],
                &[sperre(
                    bild,
                    layout,
                    kopier_layout,
                    vk::AccessFlags::MEMORY_WRITE,
                    vk::AccessFlags::TRANSFER_READ,
                )],
            );
            self.device.cmd_copy_image_to_buffer(
                cb,
                bild.image,
                kopier_layout,
                ziel,
                &[bereich_kopie(bild.breite, bild.hoehe)],
            );
            self.device.cmd_pipeline_barrier(
                cb,
                vk::PipelineStageFlags::TRANSFER,
                vk::PipelineStageFlags::ALL_COMMANDS,
                vk::DependencyFlags::empty(),
                &[],
                &[],
                &[sperre(
                    bild,
                    kopier_layout,
                    layout,
                    vk::AccessFlags::TRANSFER_READ,
                    vk::AccessFlags::MEMORY_READ,
                )],
            );
        })
    }
}

/// Eine Bild-Sperre. Die Warteschlangenfamilie bleibt in allen Faellen
/// unveraendert (`QUEUE_FAMILY_IGNORED`) — das Bild wandert nie zwischen
/// Familien, es wandert nur zwischen Layouts.
fn sperre(
    bild: &Bild,
    alt: vk::ImageLayout,
    neu: vk::ImageLayout,
    quell_zugriff: vk::AccessFlags,
    ziel_zugriff: vk::AccessFlags,
) -> vk::ImageMemoryBarrier<'static> {
    vk::ImageMemoryBarrier::default()
        .old_layout(alt)
        .new_layout(neu)
        .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .image(bild.image)
        .src_access_mask(quell_zugriff)
        .dst_access_mask(ziel_zugriff)
        .subresource_range(bereich())
}

fn bereich() -> vk::ImageSubresourceRange {
    vk::ImageSubresourceRange::default()
        .aspect_mask(vk::ImageAspectFlags::COLOR)
        .level_count(1)
        .layer_count(1)
}

/// `buffer_row_length`/`buffer_image_height` bleiben 0 = dicht gepackt nach
/// `image_extent`. Damit ist die Zeilenlaenge auf der Pufferseite genau
/// `breite * bytes_je_texel` und der Vergleich braucht keine Annahme ueber eine
/// Ausrichtung, die er falsch treffen koennte.
fn bereich_kopie(breite: u32, hoehe: u32) -> vk::BufferImageCopy {
    vk::BufferImageCopy::default()
        .image_subresource(
            vk::ImageSubresourceLayers::default()
                .aspect_mask(vk::ImageAspectFlags::COLOR)
                .layer_count(1),
        )
        .image_extent(vk::Extent3D { width: breite, height: hoehe, depth: 1 })
}
