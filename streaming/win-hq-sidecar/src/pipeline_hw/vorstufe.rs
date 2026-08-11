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
/// in einem anderen Farbraum, **und gar nicht, wenn sich nichts geändert hat.**
pub(super) struct Vorstufe {
    weg: Weg,
    /// Das zuletzt gelieferte Encoder-Bild.
    ///
    /// Gehalten, damit ein Tick ohne frisches Aufnahmebild es erneut bekommt,
    /// statt es bitgleich neu zu rechnen (s. [`Vorstufe::verarbeiten`]). Der
    /// Zwischenspeicher gehört hierher und nicht in die Taktschleife: was seine
    /// Gültigkeit ausmacht, ist eine Eigenschaft dieser Stufe, und der Frame
    /// geht mit ihr in denselben Teardown (die Taktschleife müsste ihn sonst
    /// einzeln vom Abbau ausnehmen).
    letztes: Option<OwnedHwFrame>,
}

/// **Zwei Ausführungen, weil eine nicht überall geht.** Der Regelweg ist der
/// Video-Prozessor der Grafikkarte ([`D3D11Scaler`]) — er skaliert und wandelt
/// in einem Zug und kostet fast nichts. Für HDR verweigert er auf AMD den
/// Dienst, also rechnet dort ein eigener Shader
/// ([`HdrWandler`](crate::encode::hdr_wandler::HdrWandler)).
///
/// Ein Enum statt zweier `Option`-Felder: die beiden schließen einander aus,
/// und zwei Felder ließen einen Zustand zu, in dem beide gesetzt sind — dann
/// liefe die Farbwandlung zweimal.
enum Weg {
    Skalierer(D3D11Scaler),
    Hdr(crate::encode::hdr_wandler::HdrWandler),
}

impl Vorstufe {
    fn neu(weg: Weg) -> Self {
        Self { weg, letztes: None }
    }

    pub(super) fn dst_frames_ref(&self) -> *mut AVBufferRef {
        match &self.weg {
            Weg::Skalierer(s) => s.dst_frames_ref(),
            Weg::Hdr(h) => h.dst_frames_ref(),
        }
    }

    /// Ein Aufnahme-Bild in ein Encoder-Bild verwandeln.
    ///
    /// `vorher` läuft nach dem Holen des Ziel-Bildes und vor dem Beschreiben —
    /// die Zusage aus `BildEncoder::vor_dem_schreiben`. Der HDR-Weg kennt sie
    /// nicht, weil sich auf ihm heute kein fremder Encoder anmelden kann: der
    /// verlangte einen 8-bit-Pool, und dann wäre `hdr` schon in
    /// `encode::hdr::pruefen` abgelehnt worden.
    ///
    /// # `unveraendert` heisst: gar nicht rechnen
    ///
    /// Ist die Quelle dieselbe wie beim letzten Aufruf, kommt das zuletzt
    /// gelieferte Bild zurück — es wäre Bit für Bit dasselbe. Befund 1 der
    /// Durchsicht vom 2026-08-06; gemessen sinkt die 3D-Einheit des Senders auf
    /// einem stehenden Bildschirm von 14,2 auf 0,4 %
    /// (`testbench/profiles/leistung-2026-08-06-vier-befunde.json`).
    ///
    /// **Der Aufrufer sagt es, statt dass diese Stufe es errät**, und das ist
    /// Absicht: die einzige Kennung, die sie selbst hätte, wäre der Zeiger auf
    /// die Quelltextur — und der taugt nicht, weil der Aufnahme-Pool seine
    /// Texturen reihum wiederverwendet. Ein frisches Bild in derselben Textur
    /// sähe damit aus wie ein unverändertes, und der Strom fröre ein.
    ///
    /// **Drei Voraussetzungen, alle geprüft statt angenommen:**
    ///
    /// 1. *Der Encoder verträgt dieselbe Textur zweimal.* Genau das tut der Weg
    ///    ganz ohne Vorstufe seit jeher. Anders als dort wird hier ausserdem
    ///    NICHT hineingeschrieben, während der Encoder das vorige Einschieben
    ///    noch hält (AMF gibt ein Bild verzögert heraus) — die harmlosere der
    ///    beiden Lagen, nicht die riskantere.
    /// 2. *Die HDR-Begleitdaten wachsen nicht an.* Sie hängen am Bild, und
    ///    `av_frame_new_side_data` hängt AN, statt zu ersetzen (Nachweis:
    ///    `encode::hdr_metadaten::tests::ffmpeg_haengt_begleitdaten_an`). Solange jeder
    ///    Tick ein frisches `AVFrame` zog, war das folgenlos; jetzt räumt
    ///    `encode::hdr_metadaten::am_bild` vorher weg.
    /// 3. *Der Pool verliert ein Bild*, solange es gehalten wird. Auf dem
    ///    Einzeltextur-Weg (AMD, P010) folgenlos, weil er ohnehin bis zur
    ///    Arbeitsmenge wächst; auf dem Array-Pool eines von sechzehn.
    ///
    /// Und `vorher` entfällt dabei folgerichtig: die Zusage gilt dem
    /// BESCHREIBEN des Zielbildes, und es wird nicht beschrieben.
    pub(super) fn verarbeiten<F>(
        &mut self,
        src: &OwnedHwFrame,
        unveraendert: bool,
        vorher: F,
    ) -> Result<&mut OwnedHwFrame>
    where
        F: FnOnce(&OwnedHwFrame) -> Result<()>,
    {
        if !unveraendert || self.letztes.is_none() {
            // Die Zuweisung gibt das vorige Zielbild in den Pool zurück.
            self.letztes = Some(match &mut self.weg {
                Weg::Skalierer(s) => s.scale_mit(src, vorher)?,
                Weg::Hdr(h) => h.wandeln(src)?,
            });
        }
        self.letztes.as_mut().ok_or_else(|| anyhow!("Vorstufe ohne Zielbild"))
    }
}

/// **Läuft die Farbwandlung schon im Aufnahme-Rückruf?** Dann gibt es gar keine
/// Vorstufe mehr, und die fp16-Zwischenkopie entfällt.
///
/// Muss **vor** dem Start der Aufnahme beantwortet werden: das Pool-Format
/// entscheidet sich beim ersten Bild. Preis und Herleitung stehen in
/// [`crate::capture::aufnahmeziel`], die Messung in
/// `streaming/testbench/profiles/leistung-2026-08-07-wandlung-im-rueckruf.json`.
///
/// Drei Fälle, in denen es beim alten Weg bleibt:
///
/// 1. **SDR.** Dort wandelt der Video-Prozessor, nicht dieser Shader — eine
///    andere Sache mit eigener Vorgeschichte. Die Kopie kostet dort gemessen
///    0,96 ms und bleibt vorerst.
/// 2. **`PULSE_HQ_HDR_ZWISCHENKOPIE=1`.** Der Notausschalter: stellt den Stand
///    vor dem 2026-08-07 wieder her, ohne Neubau. Er ist zugleich der zweite
///    Arm jeder Vorher/Nachher-Messung — beide aus DEMSELBEN Binary, wie bei
///    `PULSE_PLAYER_EINFRIER_MS` am 2026-08-05.
/// 3. **Ein angemeldeter Encode-Weg** — und der bricht ab statt zurückzufallen,
///    s. unten.
pub(super) fn direktwandlung(params: &StartParams) -> Result<bool> {
    if !params.hdr {
        return Ok(false);
    }
    if crate::env::flag("PULSE_HQ_HDR_ZWISCHENKOPIE") {
        eprintln!(
            "[pipeline-hw] PULSE_HQ_HDR_ZWISCHENKOPIE=1 — Farbwandlung läuft wieder auf dem \
             Taktfaden, mit fp16-Zwischenkopie in der Aufnahme"
        );
        return Ok(false);
    }
    if crate::encode::bildencoder::angemeldet().is_some() {
        // **Abbrechen statt stillschweigend den alten Weg zu nehmen** —
        // dieselbe Regel wie am Ende von [`bauen`]. Wandelt die Aufnahme
        // direkt, schreibt der Aufnahme-Faden in das Bild, das der Encoder
        // gleich liest; die Zusage aus `BildEncoder::vor_dem_schreiben` wäre
        // dort nicht einzulösen (sie gilt dem Taktfaden, der das Bild vorher
        // vorzeigt). Still auf die Zwischenkopie auszuweichen hiesse, einen
        // Messarm unter falschem Etikett zu fahren.
        bail!(
            "HDR mit Farbwandlung im Aufnahme-Rückruf und ein angemeldeter Encode-Weg gehen \
             nicht zusammen: der Aufnahme-Faden beschreibt das Bild, das der Encoder liest, \
             und kann es ihm vorher nicht zeigen. Abhilfe: PULSE_HQ_HDR_ZWISCHENKOPIE=1"
        );
    }
    Ok(true)
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
        return Ok(Some(Vorstufe::neu(Weg::Hdr(crate::encode::hdr_wandler::HdrWandler::new(
            hw.device().clone(),
            // Safety: nur ein Clone (atomarer COM-AddRef), kein GPU-Befehl —
            // der Lock ist hier nicht nötig (s. `HwContext::device_context`).
            unsafe { hw.device_context() }.clone(),
            dst_w,
            dst_h,
            16,
            hw.lock_ptr(),
        )?))));
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
        return Ok(Some(Vorstufe::neu(Weg::Skalierer(
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
        ))));
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
