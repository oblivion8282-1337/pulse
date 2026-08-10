//! Schritt 2: das exportierte DMA-BUF in wgpu einhaengen und den Inhalt
//! nachrechnen.
//!
//! Schritt 1 hat die Gestalt geklaert (ein Objekt, zwei Layer, je eine Plane).
//! Hier geht es um die zwei Fragen, die man nur durch Hinsehen beantwortet:
//!
//! * **Traegt der Versatz?** Beide Layer teilen sich EIN Objekt; das Chroma
//!   sitzt mitten im Puffer (Versatz 2621440 bei 8 bit, 4718592 bei 10 bit).
//!   `texture_from_dmabuf_fd` bindet den Speicher immer bei 0 und reicht den
//!   Versatz als `SubresourceLayout::offset` durch — die Frage ist, ob die
//!   Allokationsgroesse, die wgpu aus den Anforderungen des EINplanigen Bildes
//!   nimmt, den Versatz ueberhaupt abdeckt. Tut sie es nicht, scheitert das
//!   Einhaengen oder das Chroma ist verschoben.
//! * **Ueberlebt der Inhalt den Layout-Uebergang?** `create_texture_from_hal`
//!   mit `TextureUses::UNINITIALIZED` heisst auf Vulkan `oldLayout = UNDEFINED`,
//!   und der Uebergang DARF den Inhalt verwerfen. Fuer den CUDA-Weg tut er es
//!   auf dieser Karte nicht; ein Bild aus fremder Queue-Family ist ein anderer
//!   Fall.
//!
//! Die Gegenprobe ist der heruntergeladene Frame (`av_hwframe_transfer_data`) —
//! also genau der Weg, den die Bruecke ersetzen soll. Stimmen beide ueberein,
//! ist bewiesen, dass der schnelle Weg dasselbe Bild liefert wie der langsame.

use anyhow::{anyhow, bail, Result};
use ffmpeg::ffi;
use ffmpeg_next as ffmpeg;
use std::os::fd::{FromRawFd, OwnedFd};

/// Ein Layer, so wie ihn Schritt 1 gefunden hat.
pub struct Layer {
    pub fourcc: u32,
    pub offset: u64,
    pub pitch: u64,
    pub breite: u32,
    pub hoehe: u32,
}

/// Fourcc → wgpu-Format. Bewusst eine Tabelle mit genau den Faellen, die auf
/// dieser Hardware wirklich vorkommen — ein unbekanntes Format soll auffallen
/// und nicht auf ein plausibles geraten werden.
fn format_aus_fourcc(f: u32) -> Option<wgpu::TextureFormat> {
    match &f.to_le_bytes() {
        b"R8  " => Some(wgpu::TextureFormat::R8Unorm),
        b"GR88" => Some(wgpu::TextureFormat::Rg8Unorm),
        b"R16 " => Some(wgpu::TextureFormat::R16Unorm),
        // GR32 = zwei 16-bit-Kanaele, also 32 bit je Bildpunktpaar.
        b"GR32" => Some(wgpu::TextureFormat::Rg16Unorm),
        _ => None,
    }
}

/// Ein Layer als wgpu-Textur einhaengen.
///
/// # Safety
/// `fd` muss ein gueltiger DMA-BUF sein, `modifier` der zugehoerige. Der
/// Aufrufer muss sicherstellen, dass der Quell-Frame lebt, solange die Textur
/// benutzt wird.
pub unsafe fn einhaengen(
    device: &wgpu::Device,
    fd: OwnedFd,
    modifier: u64,
    layer: &Layer,
) -> Result<wgpu::Texture> {
    let format = format_aus_fourcc(layer.fourcc)
        .ok_or_else(|| anyhow!("unbekanntes Fourcc {:#010x}", layer.fourcc))?;
    let masse = wgpu::Extent3d {
        width: layer.breite,
        height: layer.hoehe,
        depth_or_array_layers: 1,
    };
    let hal_desc = wgpu::hal::TextureDescriptor {
        label: Some("dmabuf-layer"),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUses::RESOURCE | wgpu::TextureUses::COPY_SRC,
        memory_flags: wgpu::hal::MemoryFlags::empty(),
        view_formats: vec![],
    };
    let hal_tex = {
        let hal = device
            .as_hal::<wgpu::hal::api::Vulkan>()
            .ok_or_else(|| anyhow!("kein Vulkan-Backend"))?;
        hal.texture_from_dmabuf_fd(fd, &hal_desc, modifier, layer.pitch, layer.offset)
            .map_err(|e| anyhow!("texture_from_dmabuf_fd: {e:?}"))?
    };
    Ok(device.create_texture_from_hal::<wgpu::hal::api::Vulkan>(
        hal_tex,
        &wgpu::TextureDescriptor {
            label: Some("dmabuf-layer"),
            size: masse,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        },
        // Kein anderer Wert ist hier sinnvoll: das Bild kommt von aussen, wgpu
        // kennt seinen Zustand nicht. Ob der Uebergang den Inhalt verwirft, ist
        // genau die Frage dieser Probe.
        wgpu::TextureUses::UNINITIALIZED,
    ))
}

/// Textur herunterladen — nur fuer die Gegenprobe, nicht fuer den Betrieb.
pub fn zurueck_lesen(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    tex: &wgpu::Texture,
    bytes_je_punkt: u32,
) -> Result<(Vec<u8>, u32)> {
    let b = tex.width() * bytes_je_punkt;
    // wgpu verlangt 256er-Ausrichtung der Zeilenlaenge beim Kopieren.
    let ausgerichtet = b.div_ceil(256) * 256;
    let groesse = (ausgerichtet * tex.height()) as u64;
    let puffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("rueckweg"),
        size: groesse,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &puffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(ausgerichtet),
                rows_per_image: Some(tex.height()),
            },
        },
        wgpu::Extent3d {
            width: tex.width(),
            height: tex.height(),
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(enc.finish()));
    let scheibe = puffer.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    scheibe.map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    device.poll(wgpu::PollType::wait_indefinitely())?;
    rx.recv()??;
    let daten = scheibe
        .get_mapped_range()
        .map_err(|e| anyhow!("Lesepuffer nicht lesbar: {e}"))?
        .to_vec();
    puffer.unmap();
    Ok((daten, ausgerichtet))
}

/// Denselben Frame auf dem langsamen Weg holen — die Gegenprobe.
///
/// # Safety
/// `gpu` muss ein gueltiger VAAPI-Frame sein.
pub unsafe fn herunterladen(gpu: &ffmpeg::frame::Video) -> Result<ffmpeg::frame::Video> {
    let mut ziel = ffmpeg::frame::Video::empty();
    let rc = ffi::av_hwframe_transfer_data(ziel.as_mut_ptr(), gpu.as_ptr(), 0);
    if rc < 0 {
        bail!("av_hwframe_transfer_data (rc={rc})");
    }
    Ok(ziel)
}

/// Zwei Ebenen vergleichen. Liefert (groesste Abweichung, Anteil ungleicher
/// Bytes).
///
/// **Byteweise, nicht stichprobenartig.** Ein verschobenes Chroma faellt bei
/// einer Stichprobe leicht durch — und genau der Fall ist hier der erwartete
/// Fehlermodus.
pub fn vergleichen(
    a: &[u8],
    a_pitch: u32,
    b: &[u8],
    b_pitch: u32,
    breite_bytes: u32,
    hoehe: u32,
) -> (u32, f64) {
    let mut max = 0u32;
    let mut ungleich = 0u64;
    let mut gesamt = 0u64;
    for y in 0..hoehe as usize {
        let za = &a[y * a_pitch as usize..][..breite_bytes as usize];
        let zb = &b[y * b_pitch as usize..][..breite_bytes as usize];
        for (x, y2) in za.iter().zip(zb.iter()) {
            let d = (*x as i32 - *y2 as i32).unsigned_abs();
            if d > max {
                max = d;
            }
            if d != 0 {
                ungleich += 1;
            }
            gesamt += 1;
        }
    }
    (max, ungleich as f64 / gesamt.max(1) as f64)
}

/// `dup()` auf einen rohen fd — je Import einer, weil der Original-fd dem
/// AVFrame gehoert und FFmpeg ihn beim Aufraeumen schliesst.
///
/// # Safety
/// `roh` muss ein gueltiger, offener Dateideskriptor sein.
pub unsafe fn fd_kopieren(roh: i32) -> Result<OwnedFd> {
    let neu = libc_dup(roh);
    if neu < 0 {
        bail!("dup({roh}) scheiterte");
    }
    Ok(OwnedFd::from_raw_fd(neu))
}

// Kein `libc`-Crate fuer einen einzigen Aufruf — das waere eine neue
// Abhaengigkeit fuer drei Zeilen (und in Pulse rueckfragepflichtig).
extern "C" {
    #[link_name = "dup"]
    fn libc_dup(fd: i32) -> i32;
}
