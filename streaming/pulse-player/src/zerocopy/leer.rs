//! Der Platzhalter fuer alles, was nicht Windows ist.
//!
//! Es gibt ihn, damit `decode.rs` und `render/` keine `#[cfg]`-Zweige
//! brauchen: dort steht ueberall `Option<Arc<GpuBild>>`, und ausserhalb von
//! Windows ist dieses `Option` schlicht immer `None`. Der VAAPI-Weg unter Linux
//! braeuchte eine eigene Bruecke (DMA-BUF statt NT-Handle) — die gibt es nicht,
//! und sie hier vorzutaeuschen waere schlimmer als ihr Fehlen.

use anyhow::{bail, Result};

/// Ein Bild, das im Grafikspeicher liegt. Ausserhalb von Windows nicht
/// herstellbar — es gibt keinen oeffentlichen Weg, eines zu bauen.
pub struct GpuBild {
    _privat: (),
}

impl GpuBild {
    /// Die Masse der geteilten Textur. Nie aufgerufen, weil es kein `GpuBild`
    /// gibt; steht hier, damit die Aufrufseite ohne `#[cfg]` uebersetzt.
    pub fn textur_masse(&self) -> (u32, u32) {
        (0, 0)
    }
    pub fn zehn_bit(&self) -> bool {
        false
    }
    pub fn handle(&self) -> isize {
        0
    }
}

pub struct Bruecke {
    _privat: (),
}

impl Bruecke {
    pub fn neu(_frame: &ffmpeg_next::util::frame::video::Video) -> Result<Self> {
        bail!("Zero-Copy gibt es nur unter Windows")
    }

    pub fn uebernehmen(
        &mut self,
        _frame: &ffmpeg_next::util::frame::video::Video,
    ) -> Result<Option<std::sync::Arc<GpuBild>>> {
        bail!("Zero-Copy gibt es nur unter Windows")
    }
}
