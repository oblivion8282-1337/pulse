//! Die Linux-Haelfte von [`super::fremdbild`]: aus einem fremden Bild werden
//! zwei wgpu-Texturen.
//!
//! **Zwei Wege, ein Ergebnis.** Was hier herauskommt, ist in beiden Faellen
//! dasselbe — zwei Texturen (Luma, Chroma), aus denen der Aufrufer seine
//! Bindegruppen baut. Wie sie entstehen, ist grundverschieden:
//!
//! | | CUDA-Weg | VAAPI-Weg |
//! |---|---|---|
//! | Was ankommt | zwei fertige `VkImage` auf DIESEM Geraet | zwei DMA-BUF-Ebenen eines fremden Objekts |
//! | Wer legt die Bilder an | die Bruecke (`zerocopy::linux::vkbild`) | wgpu selbst, beim Import |
//! | Lebensanker | im `drop_callback` von `texture_from_raw` | im Import festgehalten (s. unten) |
//! | Gueltig fuer | einen Ringplatz, die ganze Sitzung | genau ein Bild |
//!
//! ## Warum der Anker auf dem VAAPI-Weg NICHT im Rueckruf haengen kann
//!
//! Auf dem CUDA-Weg bekommt `texture_from_raw` einen Rueckruf mit, der den
//! Ringplatz freigibt, sobald wgpu die Textur wirklich zerstoert — also
//! garantiert nach dem letzten Zeichendurchgang. Fuer den DMA-BUF-Import gibt
//! es diese Moeglichkeit nicht: `texture_from_dmabuf_fd`
//! (`wgpu-hal-30.0.0/src/vulkan/device.rs:525`) legt das `VkImage` selbst an
//! und setzt den Rueckruf fest auf `None` — die Felder von `hal::Texture` sind
//! privat, es gibt keinen Weg, spaeter einen nachzureichen.
//!
//! Der Anker haengt deshalb am [`super::fremdbild::Import`], und der Aufrufer
//! haelt eine kurze **Nachhut** frueherer Importe
//! (`fremdbild::NACHHUT`, dort auch die Zahl und ihre Begruendung). Das ist
//! schwaecher als der Rueckruf und wird hier ausdruecklich so benannt: die
//! Surface wird nicht freigegeben, wenn die GPU fertig ist, sondern wenn ein
//! paar Bilder spaeter niemand mehr auf sie zeigt. Bei drei nachgehaltenen
//! Bildern liegen zwischen der letzten Abgabe eines Bildes und seiner Freigabe
//! zwei volle Bilddurchgaenge — die Zeichenarbeit eines Bildes dauert
//! Bruchteile davon.
//!
//! **Diese Kette ist der Ort, an dem sie ausfuehrlich steht.** Die Stellen, die
//! sie betrifft (`zerocopy::linuxweg::Einhaengung::Dmabuf`,
//! `fremdbild::Import::festhalten`, `fremdbild::NACHHUT`), verweisen hierher,
//! statt sie erneut zu erzaehlen.

use std::sync::Arc;

use crate::zerocopy::{Einhaengung, GpuBild};

/// Beide Ebenen einhaengen. `None` heisst „geht nicht" — der Aufrufer schaltet
/// den Weg dann ab.
///
/// Zurueck kommt neben den Texturen der Anker, den der Import festhalten muss:
/// auf dem CUDA-Weg ist er schon im Rueckruf untergebracht und deshalb `None`,
/// auf dem VAAPI-Weg gehoert er in den Import (s. Modulkopf).
pub(super) fn einhaengen(
    device: &wgpu::Device,
    bild: &Arc<GpuBild>,
    kopierbar: bool,
) -> Option<[wgpu::Texture; 2]> {
    let plan = match bild.einhaengung() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("pulse-player: Fremdbild nicht einhaengbar ({e:#})");
            return None;
        }
    };
    // **Nur mit laufender Latenz-Sonde**, und dann fuer beide Ebenen statt nur
    // fuer die Luma-Seite: die Farbebene braucht `COPY_SRC` nicht, aber sie
    // entsteht in derselben Schleife, und ein zweiter Parameter dafuer waere
    // teurer als die eine ungenutzte Nutzungsart. Gedeckt ist sie in jedem Fall
    // — das `VkImage` traegt `TRANSFER_SRC` (`zerocopy::linux::vkbild`), und der
    // DMA-BUF-Import meldet die Nutzungsart beim Anlegen selbst an.
    let (hal_extra, wgpu_extra) = if kopierbar {
        (wgpu::TextureUses::COPY_SRC, wgpu::TextureUsages::COPY_SRC)
    } else {
        (wgpu::TextureUses::empty(), wgpu::TextureUsages::empty())
    };
    match plan {
        Einhaengung::Vulkanbilder { ebenen, anker } => {
            let [y, uv] = ebenen;
            Some([
                vulkanbild(device, y, "fremdbild-y", anker.clone(), hal_extra, wgpu_extra)?,
                vulkanbild(device, uv, "fremdbild-uv", anker, hal_extra, wgpu_extra)?,
            ])
        }
        Einhaengung::Dmabuf { ebenen } => {
            let [y, uv] = ebenen;
            Some([
                dmabuf(device, y, "fremdbild-y", hal_extra, wgpu_extra)?,
                dmabuf(device, uv, "fremdbild-uv", hal_extra, wgpu_extra)?,
            ])
        }
    }
}

/// Der CUDA-Weg: ein bereits auf diesem Geraet angelegtes `VkImage` uebergeben.
///
/// **Ohne eigene Vulkan-Aufrufe** — die Bilder sind bereits auf genau diesem
/// Geraet angelegt (`zerocopy::linux::vkbild`), hier werden sie nur an wgpu
/// uebergeben. Das ist der Unterschied zur Windows-Seite, wo erst noch ein
/// Handle geoeffnet werden muss.
///
/// Belegt: wgpu 29.0.4 uebernimmt so ein Bild **mitsamt Inhalt**, ueber 720p
/// bis 4K und ueber 20 aufeinanderfolgende CUDA-Schreibrunden in dieselbe
/// eingehaengte Textur — `profiles/player-2026-08-07-wgpu29-vkimage-import.json`.
/// Der begruendete Verdacht dagegen (wgpu traegt eingehaengte Texturen als
/// `UNINITIALIZED` ein, der Uebergang aus `VK_IMAGE_LAYOUT_UNDEFINED` **darf**
/// den Inhalt verwerfen) ist am Quelltext bestaetigt, tritt auf dieser Karte
/// aber nicht ein. „Darf verwerfen" ist keine Zusage zu verwerfen.
fn vulkanbild(
    device: &wgpu::Device,
    (image, format, breite, hoehe): (ash::vk::Image, wgpu::TextureFormat, u32, u32),
    name: &'static str,
    anker: Arc<crate::zerocopy::Ringplatz>,
    hal_extra: wgpu::TextureUses,
    wgpu_extra: wgpu::TextureUsages,
) -> Option<wgpu::Texture> {
    let masse = wgpu::Extent3d { width: breite, height: hoehe, depth_or_array_layers: 1 };
    let hal_desc = wgpu::hal::TextureDescriptor {
        label: Some(name),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUses::RESOURCE | hal_extra,
        memory_flags: wgpu::hal::MemoryFlags::empty(),
        // Leer, weil das Bild ohne `MUTABLE_FORMAT` angelegt ist —
        // wgpu-hal verlangt das ausdruecklich in der Sicherheitsauflage
        // von `texture_from_raw`.
        view_formats: vec![],
    };
    // SAFETY: `image` wurde auf genau diesem Geraet angelegt
    // (`zerocopy::linux`), die Masse stammen aus derselben Rechnung, und
    // `anker` haelt es ueber die Lebensdauer der Textur am Leben.
    let hal_tex = unsafe {
        let hal = device.as_hal::<wgpu::hal::api::Vulkan>()?;
        hal.texture_from_raw(
            image,
            &hal_desc,
            // **Der Rueckruf MUSS gesetzt sein.** Ohne ihn naehme wgpu-hal
            // das `VkImage` in Besitz und zerstoerte es beim Fallenlassen —
            // waehrend der Speicher uns gehoert und CUDA ihn noch
            // eingehaengt haelt. Ein doppeltes Zerstoeren faellt erst viel
            // spaeter auf. Der Rumpf gibt zugleich den Lebensanker frei.
            Some(Box::new(move || drop(anker))),
            // Andernfalls uebernaehme wgpu-hal auch die Speicherverwaltung.
            wgpu::hal::vulkan::TextureMemory::External,
        )
    };
    // SAFETY: die hal-Textur gehoert ab hier wgpu.
    Some(unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Vulkan>(
            hal_tex,
            &beschreibung(name, masse, format, wgpu_extra),
            // **Neu in wgpu 30, und `UNINITIALIZED` ist hier keine
            // Bequemlichkeit, sondern die Sache selbst.**
            //
            // Der Parameter sagt wgpu, in welchem Zustand das fremde Bild
            // gerade ist, damit die erste Sperre den richtigen `oldLayout`
            // nennt. wgpu 29 hatte ihn nicht und trug intern immer
            // `UNINITIALIZED` ein (`wgpu-core-29.0.4`,
            // `device/resource.rs:1253`) — dieselbe Zeile nimmt in
            // wgpu 30 den Wert von hier entgegen (`:1272`). Derselbe Wert
            // heisst also unveraendertes Verhalten.
            //
            // Und er ist zugleich der richtige: das `VkImage` wird mit
            // `initial_layout(UNDEFINED)` angelegt
            // (`zerocopy::linux::vkbild`), und gefuellt wird es von CUDA
            // ueber den geteilten Speicher, nicht ueber einen
            // Vulkan-Uebergang. Es gibt also gar keinen Layout-Zustand, den
            // man hier stattdessen angeben koennte.
            wgpu::TextureUses::UNINITIALIZED,
        )
    })
}

/// Der VAAPI-Weg: eine Ebene der Decoder-Surface als DMA-BUF importieren.
///
/// **Der Versatz ist der heikle Wert.** Beide Ebenen teilen sich EIN Objekt;
/// das Chroma sitzt mitten darin (2621440 bei 8 bit, 4718592 bei 10 bit).
/// `texture_from_dmabuf_fd` bindet den Speicher immer bei 0 und reicht den
/// Versatz als `SubresourceLayout::offset` durch — ob die Allokationsgroesse,
/// die wgpu aus den Anforderungen des EINplanigen Bildes nimmt, ihn abdeckt,
/// war die offene Frage. Sie tut es: beide Ebenen kommen bitgenau an
/// (`profiles/player-2026-08-10-vaapi-dmabuf-export.json`).
///
/// Der `fd` geht an Vulkan ueber; bei einem Fehlschlag schliesst wgpu-hal ihn
/// selbst (so steht es in der Sicherheitsauflage der Funktion). Hier darf er
/// deshalb weder vorher dupliziert noch nachher geschlossen werden.
fn dmabuf(
    device: &wgpu::Device,
    ebene: crate::zerocopy::Dmabufebene,
    name: &'static str,
    hal_extra: wgpu::TextureUses,
    wgpu_extra: wgpu::TextureUsages,
) -> Option<wgpu::Texture> {
    let masse =
        wgpu::Extent3d { width: ebene.breite, height: ebene.hoehe, depth_or_array_layers: 1 };
    let hal_desc = wgpu::hal::TextureDescriptor {
        label: Some(name),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: ebene.format,
        usage: wgpu::TextureUses::RESOURCE | hal_extra,
        memory_flags: wgpu::hal::MemoryFlags::empty(),
        view_formats: vec![],
    };
    // SAFETY: der `fd` ist ein frisches Duplikat eines gueltigen DMA-BUF
    // (`zerocopy::vaapi::anker`), Modifier, Zeilenabstand und Versatz stammen
    // aus demselben Deskriptor, und der Anker haelt die Surface am Leben.
    let hal_tex = unsafe {
        let hal = device.as_hal::<wgpu::hal::api::Vulkan>()?;
        match hal.texture_from_dmabuf_fd(
            ebene.fd,
            &hal_desc,
            ebene.modifier,
            ebene.pitch,
            ebene.offset,
        ) {
            Ok(t) => t,
            Err(e) => {
                // Eine Zeile, kein Absturz: der Aufrufer faellt auf den Weg
                // ueber den Hauptspeicher zurueck. Haeufigster Grund waere ein
                // anderer Adapter unter FFmpeg als unter wgpu (zwei GPUs im
                // Rechner) — dafuer fehlt hier der UUID-Abgleich, den die
                // CUDA-Bruecke hat.
                eprintln!("pulse-player: DMA-BUF-Import scheiterte ({e:?})");
                return None;
            }
        }
    };
    // SAFETY: die hal-Textur gehoert ab hier wgpu.
    Some(unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Vulkan>(
            hal_tex,
            &beschreibung(name, masse, ebene.format, wgpu_extra),
            // Dasselbe wie oben, und hier zusaetzlich gemessen: der Uebergang
            // aus `UNDEFINED` verwirft den Inhalt auf dieser Karte auch dann
            // nicht, wenn das Bild einen DRM-Modifier traegt und aus einer
            // fremden Queue-Family kommt (Messakte s. Funktionskopf). Einen
            // anderen Wert gibt es hier ohnehin nicht: wgpu hat das Bild
            // gerade erst angelegt, ein Layout-Zustand ist nie gesetzt worden.
            wgpu::TextureUses::UNINITIALIZED,
        )
    })
}

/// Die wgpu-Beschreibung, die zu beiden Wegen passt.
///
/// An einer Stelle, weil sie die hal-Beschreibung spiegeln MUSS: laufen Masse
/// oder Format auseinander, ist das ein Geraetefehler und damit ein Absturz.
fn beschreibung(
    name: &'static str,
    masse: wgpu::Extent3d,
    format: wgpu::TextureFormat,
    zusatz: wgpu::TextureUsages,
) -> wgpu::TextureDescriptor<'static> {
    wgpu::TextureDescriptor {
        label: Some(name),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | zusatz,
        view_formats: &[],
    }
}

/// Der Lebensanker, den der Import festhalten muss — `None` auf dem CUDA-Weg
/// (dort haengt er im Rueckruf, s. Modulkopf).
///
/// **Getrennt von [`einhaengen`] geholt und nicht von dort mitgeliefert**, weil
/// er einen anderen Weg nimmt: die Texturen wandern in den Import, der Anker
/// wandert daneben. Ein gemeinsames Rueckgabetupel muesste den CUDA-Fall mit
/// einem `None` fuellen, das nichts bedeutet.
pub(super) fn festhalten(bild: &Arc<GpuBild>) -> Option<Arc<GpuBild>> {
    bild.import_je_bild().then(|| bild.clone())
}
