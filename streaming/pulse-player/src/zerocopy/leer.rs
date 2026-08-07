//! Der Platzhalter fuer alles, was nicht Windows ist.
//!
//! Es gibt ihn, damit `decode.rs` und `render/` keine `#[cfg]`-Zweige
//! brauchen: dort steht ueberall `Option<Arc<GpuBild>>`, und ausserhalb von
//! Windows ist dieses `Option` schlicht immer `None`. Der VAAPI-Weg unter Linux
//! braeuchte eine eigene Bruecke (DMA-BUF statt NT-Handle) — die gibt es nicht,
//! und sie hier vorzutaeuschen waere schlimmer als ihr Fehlen.

use anyhow::{bail, Result};

/// Ein Bild, das im Grafikspeicher liegt.
///
/// **Ein leeres `enum`, kein `struct` mit privatem Feld.** Der Unterschied ist
/// nicht kosmetisch: ein leeres `enum` hat keine Werte, also BEWEIST der
/// Compiler, dass `Option<Arc<GpuBild>>` ausserhalb von Windows immer `None`
/// ist. Die Methoden brauchen dann keinen Rumpf mehr — `match *self {}` sagt
/// „hierher kommt niemand", statt (0, 0) und `false` zurueckzugeben.
///
/// Hier standen bis zum 2026-08-06 solche Ersatzwerte, und der Aufrufer hatte
/// sich bereits eine passende Abfrage darauf zugelegt. Ein Ersatzwert, der nie
/// gilt, zieht Pruefungen nach sich, die nie greifen.
pub enum GpuBild {}

impl GpuBild {
    pub fn textur_masse(&self) -> (u32, u32) {
        match *self {}
    }
    pub fn zehn_bit(&self) -> bool {
        match *self {}
    }
    pub fn handle(&self) -> isize {
        match *self {}
    }
    pub fn briefkasten(&self) -> &std::sync::Arc<crate::einfrieren::Briefkasten> {
        match *self {}
    }
}

/// Ebenfalls unbewohnt: `neu` kann nur scheitern.
pub enum Bruecke {}

impl Bruecke {
    pub fn neu(
        _frame: &ffmpeg_next::util::frame::video::Video,
        _briefkasten: std::sync::Arc<crate::einfrieren::Briefkasten>,
    ) -> Result<Self> {
        bail!("Zero-Copy gibt es nur unter Windows")
    }

    pub fn uebernehmen(
        &mut self,
        _frame: &ffmpeg_next::util::frame::video::Video,
    ) -> Result<Option<std::sync::Arc<GpuBild>>> {
        match *self {}
    }
}
