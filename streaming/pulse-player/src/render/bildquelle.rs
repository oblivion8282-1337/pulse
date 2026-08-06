//! Woraus der Shader gerade liest — und wie es dorthin kommt.
//!
//! Herausgeloest aus [`super`], weil dort die HARTE Groessengrenze (500 Zeilen)
//! gerissen war, als der Zero-Copy-Weg dazukam. Der Zeichenablauf und die Frage
//! „wo liegen die Ebenen" sind ohnehin zwei verschiedene Dinge.

use crate::decode::{DecodedFrame, PixelLayout};

use super::farbe::{narrow_plane_into, Bildform};

pub(super) struct Planes {
    pub y: wgpu::Texture,
    pub u: wgpu::Texture,
    pub v: wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub layout: PixelLayout,
    pub ten_bit: bool,
    /// Ob die TEXTUREN 16 bit tragen. Bei `false` liegen die Daten trotz
    /// 10-bit-Quelle als 8 bit darin — der Shader darf dann nicht skalieren.
    pub wide: bool,
}

/// Was gerade an den Shader gebunden ist.
///
/// **Zwei Faelle, kein dritter.** Entweder liegen die Ebenen in eigenen,
/// hochgeladenen Texturen (der bisherige Weg, `Eigen`), oder das Bild ist eine
/// eingehaengte Fremdtextur, die der Decoder gefuellt hat (`Fremd`, s.
/// [`crate::zerocopy`]). Beides zugleich gibt es nicht — sonst waere nicht
/// entscheidbar, was gezeichnet wird.
pub(super) enum Bildquelle {
    Eigen(Planes),
    Fremd(Fremdform),
}

/// Die beschreibenden Angaben eines eingehaengten Fremdbildes.
///
/// Getrennt von den Ansichten selbst, weil die im Zwischenspeicher
/// (`super::fremdbild::Fremdbilder`) liegen und ueber ihr NT-Handle gefunden
/// werden.
#[derive(Clone, Copy)]
pub(super) struct Fremdform {
    /// Bildmasse — nicht die der Textur (s. `nutzanteil`).
    pub width: u32,
    pub height: u32,
    pub ten_bit: bool,
    pub nutzanteil: [f32; 2],
}

impl Bildquelle {
    /// Bildmasse — fuer das Seitenverhaeltnis.
    pub fn masse(&self) -> (u32, u32) {
        match self {
            Bildquelle::Eigen(p) => (p.width, p.height),
            Bildquelle::Fremd(f) => (f.width, f.height),
        }
    }

    /// Wie die Daten in den gebundenen Texturen liegen.
    ///
    /// **Auf dem Zero-Copy-Weg ist `wide` gleich `ten_bit`**, nicht
    /// `ten_bit && wide_textures`: dort wird nichts heruntergerechnet — eine
    /// P010-Textur traegt 16 bit, oder der Import ist gar nicht erst zustande
    /// gekommen (`fremdbild::moeglich` prueft das Merkmal vorher).
    pub fn form(&self) -> Bildform {
        match self {
            Bildquelle::Eigen(p) => Bildform::voll(p.layout, p.ten_bit, p.wide),
            Bildquelle::Fremd(f) => Bildform {
                layout: PixelLayout::BiPlanar420,
                ten_bit: f.ten_bit,
                wide: f.ten_bit,
                nutzanteil: f.nutzanteil,
            },
        }
    }

    /// Passen die vorhandenen Texturen noch zu diesem Bild?
    pub fn passt_zu(&self, frame: &DecodedFrame, wide_textures: bool) -> bool {
        match self {
            Bildquelle::Fremd(_) => false,
            Bildquelle::Eigen(p) => {
                p.width == frame.width
                    && p.height == frame.height
                    && p.layout == frame.format
                    && p.ten_bit == frame.ten_bit
                    && p.wide == (frame.ten_bit && wide_textures)
            }
        }
    }
}

/// Die drei Ebenen-Texturen fuer ein Bild anlegen.
pub(super) fn planes_anlegen(
    device: &wgpu::Device,
    frame: &DecodedFrame,
    wide_textures: bool,
) -> Planes {
    // 16-bit-Texturen nur, wenn die GPU sie erlaubt. Sonst werden die
    // Quelldaten beim Hochladen auf 8 bit heruntergerechnet.
    let wide = frame.ten_bit && wide_textures;
    let single =
        if wide { wgpu::TextureFormat::R16Unorm } else { wgpu::TextureFormat::R8Unorm };
    let chroma_format = match frame.format {
        PixelLayout::Planar420 => single,
        PixelLayout::BiPlanar420 if wide => wgpu::TextureFormat::Rg16Unorm,
        PixelLayout::BiPlanar420 => wgpu::TextureFormat::Rg8Unorm,
    };
    let chroma_w = frame.width.div_ceil(2);
    let chroma_h = frame.height.div_ceil(2);
    Planes {
        y: textur(device, frame.width, frame.height, single, "y"),
        u: textur(device, chroma_w, chroma_h, chroma_format, "u"),
        v: textur(device, chroma_w, chroma_h, single, "v"),
        width: frame.width,
        height: frame.height,
        layout: frame.format,
        ten_bit: frame.ten_bit,
        wide,
    }
}

fn textur(
    device: &wgpu::Device,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    label: &str,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: width.max(1),
            height: height.max(1),
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

/// Die Ebenen des Bildes in die Texturen schreiben.
pub(super) fn planes_fuellen(
    queue: &wgpu::Queue,
    planes: &Planes,
    frame: &DecodedFrame,
    wide_textures: bool,
    scratch: &mut [Vec<u8>; 3],
) {
    let bytes_per_sample: u32 = if frame.ten_bit { 2 } else { 1 };
    let chroma_w = frame.width.div_ceil(2);
    let chroma_h = frame.height.div_ceil(2);

    // Die dritte Ebene bleibt bei verschraenktem UV ungenutzt — der Shader
    // liest sie dann nicht.
    let targets = match frame.format {
        PixelLayout::Planar420 => [
            (&planes.y, frame.width, frame.height, Some(0usize)),
            (&planes.u, chroma_w, chroma_h, Some(1)),
            (&planes.v, chroma_w, chroma_h, Some(2)),
        ],
        PixelLayout::BiPlanar420 => [
            (&planes.y, frame.width, frame.height, Some(0usize)),
            (&planes.u, chroma_w, chroma_h, Some(1)),
            (&planes.v, 1, 1, None),
        ],
    };

    let narrow = frame.ten_bit && !wide_textures;
    for (tex, w, h, plane_idx) in targets {
        let Some(idx) = plane_idx else { continue };
        let Some(source) = frame.planes.get(idx) else { continue };
        // Ohne 16-bit-Texturen die Quelle verkleinern statt abzustuerzen.
        if narrow {
            // In einen wiederverwendeten Puffer, nicht in einen frischen:
            // dieser Pfad laeuft pro Ebene und Bild, und die Ebenen sind
            // megabytegross (s. `narrow_plane`).
            narrow_plane_into(source, frame.format, &mut scratch[idx.min(2)]);
        }
        let data: &[u8] = if narrow { &scratch[idx.min(2)] } else { source };
        let stride = if narrow { frame.strides[idx] / 2 } else { frame.strides[idx] };
        let bytes_per_sample: u32 = if narrow { 1 } else { bytes_per_sample };
        // verschraenktes UV traegt zwei Komponenten je Bildpunkt
        let components: u32 =
            if frame.format == PixelLayout::BiPlanar420 && idx == 1 { 2 } else { 1 };
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride as u32),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d {
                width: w.min(stride as u32 / (bytes_per_sample * components)),
                height: h,
                depth_or_array_layers: 1,
            },
        );
    }
}
