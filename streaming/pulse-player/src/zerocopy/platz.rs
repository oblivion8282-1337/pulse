//! Ein Ringplatz und wer ihn haelt.
//!
//! Herausgeloest aus [`super::bruecke`]: die Lebensdauer-Regel unten ist die
//! heikelste Stelle des ganzen Weges und soll nicht zwischen COM-Aufrufen
//! stehen.

use std::sync::Arc;

use super::freigabe::Freigabe;

/// Ein dekodiertes Bild, das im Grafikspeicher liegen bleibt.
///
/// **Der Ringplatz wird beim `Drop` frei, und deshalb muss dieses Ding so lange
/// leben, wie IRGENDJEMAND die Textur liest** — der `DecodedFrame` genauso wie
/// der Renderer, der noch einen abgeschickten Zeichendurchgang darauf offen
/// hat. Beide halten ein `Arc` darauf; der Platz kehrt zurueck, wenn der letzte
/// es fallen laesst. Ein Weg, der ihn schon beim Verwerfen des `DecodedFrame`
/// freigaebe, ueberschriebe das Bild, das gerade gezeichnet wird — und zwar
/// unregelmaessig, also als flackernder Riss quer durchs Bild.
pub struct GpuBild {
    pub(super) handle: isize,
    pub(super) breite: u32,
    pub(super) hoehe: u32,
    pub(super) zehn_bit: bool,
    pub(super) slot: usize,
    pub(super) frei: Arc<Freigabe>,
    /// Der Rueckweg fuer den Fingerabdruck, den der Renderer auf der GPU
    /// rechnet (s. `crate::einfrieren::Briefkasten`).
    ///
    /// **Er faehrt im BILD mit, statt in einem eigenen Kanal.** Damit findet
    /// der Renderer immer den Briefkasten des Decoders, aus dem dieses Bild
    /// stammt — auch wenn mehrere Sitzungen gleichzeitig laufen. Ein Kanal
    /// muesste durch `session.rs` und `app` hindurchgereicht werden, ein
    /// globaler wuerde die Sitzungen vermischen.
    pub(super) briefkasten: Arc<crate::einfrieren::Briefkasten>,
}

impl GpuBild {
    /// Masse der GETEILTEN Textur — nicht die des Bildes.
    ///
    /// Der Decoder rundet auf (bei AV1 auf Vielfache von 128), und die Bruecke
    /// kopiert die volle Teilressource statt eines Ausschnitts: ein Ausschnitt
    /// in einem Video-Format muesste auf gerade Koordinaten fallen und waere
    /// eine zweite Stelle, an der sich ein Rundungsfehler verstecken kann. Der
    /// Renderer schneidet stattdessen beim Abtasten zu
    /// (s. `render::farbe::Bildform::nutzanteil`).
    pub fn textur_masse(&self) -> (u32, u32) {
        (self.breite, self.hoehe)
    }
    pub fn zehn_bit(&self) -> bool {
        self.zehn_bit
    }
    /// NT-Handle der geteilten Textur. Bleibt ueber die ganze Lebensdauer der
    /// Bruecke gueltig und ist damit der Schluessel, unter dem der Renderer
    /// seinen Import zwischenspeichert.
    pub fn handle(&self) -> isize {
        self.handle
    }
    /// Wohin der gerechnete Fingerabdruck gehoert (s. [`GpuBild::briefkasten`]).
    pub fn briefkasten(&self) -> &Arc<crate::einfrieren::Briefkasten> {
        &self.briefkasten
    }
}

impl Drop for GpuBild {
    fn drop(&mut self) {
        self.frei.zurueck(self.slot);
    }
}
