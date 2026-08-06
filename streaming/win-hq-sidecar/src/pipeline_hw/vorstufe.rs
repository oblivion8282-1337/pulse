//! Die Stufe zwischen Aufnahme und Encoder — und die Frage, welche davon.
//!
//! Herausgezogen aus [`super`], weil die Datei mit den HDR-Begründungen über die
//! harte Größen-Grenze von 500 Zeilen gewachsen war (`PLAN.md` §12.1). Eigener
//! Verantwortungsbereich: hier steht, WAS mit dem Bild zwischen Aufnahme und
//! Encoder passiert; dort, wie der Stream drumherum läuft.

use anyhow::{Result, anyhow, bail};
use ffmpeg_next::ffi::{AVBufferRef, AVPixelFormat};

use crate::encode::{D3D11Scaler, HwContext, OwnedHwFrame};
use crate::stream_controller::StartParams;

/// Aus einem Aufnahme-Bild ein Encoder-Bild machen — gegebenenfalls kleiner und
/// in einem anderen Farbraum.
///
/// **Zwei Ausführungen, weil eine nicht überall geht.** Der Regelweg ist der
/// Video-Prozessor der Grafikkarte ([`D3D11Scaler`]) — er skaliert und wandelt
/// in einem Zug und kostet fast nichts. Für HDR verweigert er auf AMD den
/// Dienst, also rechnet dort ein eigener Shader
/// ([`HdrWandler`](crate::encode::hdr_wandler::HdrWandler)).
///
/// Ein Enum statt zweier `Option`-Felder: die beiden schließen einander aus,
/// und zwei Felder ließen einen Zustand zu, in dem beide gesetzt sind — dann
/// liefe die Farbwandlung zweimal.
pub(super) enum Vorstufe {
    Skalierer(D3D11Scaler),
    Hdr(crate::encode::hdr_wandler::HdrWandler),
}

impl Vorstufe {
    pub(super) fn dst_frames_ref(&self) -> *mut AVBufferRef {
        match self {
            Vorstufe::Skalierer(s) => s.dst_frames_ref(),
            Vorstufe::Hdr(h) => h.dst_frames_ref(),
        }
    }

    /// Ein Aufnahme-Bild in ein Encoder-Bild verwandeln.
    ///
    /// `vorher` läuft nach dem Holen des Ziel-Bildes und vor dem Beschreiben —
    /// die Zusage aus `BildEncoder::vor_dem_schreiben`. Der HDR-Weg kennt sie
    /// nicht, weil sich auf ihm heute kein fremder Encoder anmelden kann: der
    /// verlangte einen 8-bit-Pool, und dann wäre `hdr` schon in
    /// `encode::hdr::pruefen` abgelehnt worden.
    pub(super) fn verarbeiten<F>(&mut self, src: &OwnedHwFrame, vorher: F) -> Result<OwnedHwFrame>
    where
        F: FnOnce(&OwnedHwFrame) -> Result<()>,
    {
        match self {
            Vorstufe::Skalierer(s) => s.scale_mit(src, vorher),
            Vorstufe::Hdr(h) => h.wandeln(src),
        }
    }
}

/// Welche Vorstufe dieser Stream braucht — oder keine.
///
/// `None` heißt: das Aufnahme-Bild geht unverändert in den Encoder. Das ist der
/// schnellste Weg und gilt nur, wenn Maße UND Format schon stimmen.
#[allow(clippy::too_many_arguments)]
pub(super) fn bauen(
    params: &StartParams,
    hw: &HwContext,
    width: u32,
    height: u32,
    dst_w: u32,
    dst_h: u32,
    fps: u32,
    dst_format: AVPixelFormat,
    geteilt: bool,
) -> Result<Option<Vorstufe>> {
    if params.hdr {
        // **HDR geht NICHT über den Video-Prozessor**, und das ist ein Befund,
        // keine Vorliebe: der Treiber dieser Karte verneint jede Wandlung mit
        // 16-Bit-Fließkomma am Eingang und jede mit PQ am Ausgang (Tabelle in
        // `encode::farbraum::tests::wandlungen_dieses_treibers`, 32 geprüfte
        // Kombinationen, zwei möglich, keine mit PQ). Der eigene Shader macht
        // dieselbe Arbeit — Verkleinern inbegriffen — und hängt an keinem
        // Treiber-Zugeständnis.
        return Ok(Some(Vorstufe::Hdr(crate::encode::hdr_wandler::HdrWandler::new(
            hw.device().clone(),
            // Safety: nur ein Clone (atomarer COM-AddRef), kein GPU-Befehl —
            // der Lock ist hier nicht nötig (s. `HwContext::device_context`).
            unsafe { hw.device_context() }.clone(),
            dst_w,
            dst_h,
            16,
            hw.lock_ptr(),
        )?)));
    }

    // Downscale-Pfad: GPU-Scaler (VideoProcessorBlt) zwischen Capture und
    // Encoder. Der Scaler hat einen eigenen D3D11VA-Ziel-Pool (dst-res,
    // +RENDER_TARGET) — der Encoder bindet dann diesen statt des Capture-Pools.
    // Bei dst==src und 8 bit bleibt es bei `None` und der Encoder bindet den
    // Capture-Pool direkt. Im 10-bit-Fall ist er auch OHNE Verkleinerung nötig:
    // er ist dann die einzige Stelle, die BGRA nach P010 wandelt.
    //
    // **Die Bedingung fragt nach Eigenschaften, nicht nach Anmeldungen.**
    // „Es hat sich jemand angemeldet" wäre hier die falsche Frage — sie gehört
    // nicht in den ausgelieferten Ablauf, und sie verdeckt, worum es geht:
    // unterscheidet sich der Ziel-Pool vom Aufnahme-Pool? Ein fremder Weg
    // bekommt den Skalierer damit weiterhin immer (er verlangt NV12 oder
    // geteilte Texturen, beides ≠ Aufnahme-Pool) — aber weil das zutrifft, und
    // nicht weil er fremd ist.
    let anderes_format = dst_format != AVPixelFormat::AV_PIX_FMT_BGRA;
    if (dst_w, dst_h) != (width, height) || anderes_format || geteilt {
        let farbweg = crate::encode::farbraum::Farbweg::aus_formaten(false, dst_format);
        return Ok(Some(Vorstufe::Skalierer(
            D3D11Scaler::new(
                hw.device().clone(),
                unsafe { hw.device_context() }.clone(),
                width,
                height,
                dst_w,
                dst_h,
                fps,
                16,
                hw.lock_ptr(), // Capture-Pool-Lock teilen → eine CS für Copy+Blt+NVENC (#2).
                dst_format,
                geteilt,
                farbweg,
                None,
            )
            .map_err(|e| anyhow!("D3D11Scaler::new: {e:#}"))?,
        )));
    }

    if crate::encode::bildencoder::angemeldet().is_some() {
        // **Abbrechen statt stillschweigend weitermachen.** Ohne Vorstufe geht
        // das Aufnahme-Bild direkt in den Encoder, und in das hat der
        // Aufnahme-Faden längst geschrieben (`wgc_hw::copy_into_pool`) — die
        // Zusage aus `BildEncoder::vor_dem_schreiben` (dort steht, was sonst
        // passiert) ist auf diesem Weg gar nicht einzulösen. Heute unerreichbar;
        // die Prüfung steht hier, damit die Zusage nicht davon abhängt, dass
        // ein paar Zeilen weiter oben zufällig etwas anderes gilt.
        bail!(
            "angemeldeter Encode-Weg ohne eigenen Ziel-Pool: er verlangt weder ein anderes \
             Pool-Format noch geteilte Texturen — dann kann die Pipeline ihm das Bild nicht \
             vor dem Beschreiben zeigen"
        );
    }
    Ok(None)
}
