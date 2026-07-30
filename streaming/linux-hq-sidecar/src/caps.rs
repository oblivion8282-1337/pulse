//! Encoder-Fähigkeits-Probe — welche Video-Codecs DIESE Maschine per Hardware
//! encodieren kann (VAAPI für AMD/Intel, NVENC für Nvidia), über das gelinkte
//! FFmpeg.
//!
//! Treibt den `health`/`gpu_info`-Report (der Renderer zeigt nur Codecs, die die
//! HW kann) und den Codec-Rückfall in `start`. Gate nach *Fähigkeit*, nie nach
//! Modellname.
//!
//! Echte Probe (`encode::probe_encoder`): pro Codec wird der Encoder mit einem
//! HW-Frames-Kontext tatsächlich geöffnet. Nur was sich öffnen lässt, gilt als
//! verfügbar — so verschwindet AV1 auf Karten ohne AV1-Encode (RTX 30xx, ältere
//! AMD-iGPUs) automatisch aus der UI, statt beim Streamen zu crashen. Ergebnis
//! wird einmal pro Prozess gecacht (die Probe legt CUDA/VAAPI-Kontexte an).
//! HEVC wird auf Linux nicht angeboten (Nutzerentscheidung: nur H264 + AV1).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::encode;
use crate::system::drm;

/// Kandidaten in Präferenzordnung (kein HEVC).
const CANDIDATES: &[&str] = &["h264", "av1"];

/// Was diese Maschine per Hardware encodieren kann.
#[derive(Debug, Clone, Default)]
pub struct Caps {
    /// Video-Codecs in Präferenzordnung.
    pub codecs: Vec<&'static str>,
    /// Kann 10 bit encodiert werden? Immer AV1-gebunden: H.264 mit 10 bit wäre
    /// `High 10`, und das dekodiert KEIN Browser — der WHEP-Rückfall im Web
    /// läuft aber über `<video>`. Heute nur der NVENC-Pfad (s.
    /// `encode::probe_encoder`).
    pub ten_bit: bool,
}

/// Hardware-encodierbare Video-Codecs auf dieser Maschine, in Präferenzordnung.
/// Nur DEFINITIVE Ergebnisse werden gecacht (Probe öffnet echte Encoder —
/// einmal reicht). Schlug eine Probe mit `Err` fehl (transienter Treiber-/
/// Init-Fehler, GPU-Reset, Session gerade hochgefahren), wird beim nächsten
/// Aufruf neu probiert — der Sidecar bleibt warm, ein dauerhaft gecachtes
/// Fehl-Ergebnis würde HQ-Streaming sonst bis zum Prozess-Neustart abschalten.
pub fn available_video_codecs() -> Vec<&'static str> {
    probe().codecs
}

/// Volle Fähigkeiten (Codecs + Bittiefe), aus EINEM Probe-Lauf und derselben
/// Cache-Entscheidung.
pub fn probe() -> Caps {
    /// Frühestens alle 30 s neu proben, wenn das letzte Ergebnis nicht
    /// definitiv war: `list_profiles` fragt pro Profil, `start` bis zu 2× —
    /// bei DAUERHAFT kaputtem Treiber wären das sonst echte Encoder-Opens
    /// (HwContext, GPU-Kontexte) bei jedem UI-Poll, sogar während ein Stream
    /// läuft.
    const RETRY_EVERY: Duration = Duration::from_secs(30);
    struct Cache {
        definitive: Option<Caps>,
        last: Option<(Instant, Caps)>,
    }
    static CACHE: Mutex<Cache> = Mutex::new(Cache { definitive: None, last: None });

    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(v) = cache.definitive.as_ref() {
        return v.clone();
    }
    if let Some((at, v)) = cache.last.as_ref() {
        if at.elapsed() < RETRY_EVERY {
            return v.clone();
        }
    }
    let (caps, definitive) = probe_all();
    if definitive {
        cache.definitive = Some(caps.clone());
    } else {
        tracing::warn!(
            target: "stream",
            "Codec-Probe unvollständig — Retry frühestens in {}s",
            RETRY_EVERY.as_secs()
        );
    }
    cache.last = Some((Instant::now(), caps.clone()));
    caps
}

/// `(caps, definitive)` — `definitive=false`, wenn irgendein Schritt mit
/// einem echten Fehler (nicht „HW kann's nicht") endete.
fn probe_all() -> (Caps, bool) {
    let Some((vendor, render_node)) = drm::detect() else {
        tracing::warn!(target: "stream", "keine bekannte GPU erkannt — keine HW-Codecs gemeldet");
        return (Caps::default(), false);
    };
    let mut out = Vec::new();
    let mut definitive = true;
    for &c in CANDIDATES {
        match encode::probe_encoder(vendor, &render_node, c, false) {
            Ok(true) => out.push(c),
            Ok(false) => tracing::info!(
                target: "stream", codec = c, vendor = vendor.slug(),
                "HW-Encode nicht verfügbar → wird nicht angeboten"
            ),
            Err(e) => {
                definitive = false;
                tracing::warn!(
                    target: "stream", codec = c,
                    "Codec-Probe fehlgeschlagen ({e:#}) — konservativ nicht anbieten"
                );
            }
        }
    }
    // 10 bit nur proben, wenn AV1 überhaupt geht (H.264-10-bit wird bewusst
    // nicht angeboten, s. `Caps::ten_bit`) — sonst ist die Antwort schon nein.
    let ten_bit = out.contains(&"av1")
        && match encode::probe_encoder(vendor, &render_node, "av1", true) {
            Ok(v) => v,
            Err(e) => {
                definitive = false;
                tracing::warn!(
                    target: "stream",
                    "10-bit-Probe fehlgeschlagen ({e:#}) — konservativ nicht anbieten"
                );
                false
            }
        };
    tracing::info!(
        target: "stream", vendor = vendor.slug(), codecs = ?out, ten_bit,
        "HW-Encode-Probe abgeschlossen"
    );
    (Caps { codecs: out, ten_bit }, definitive)
}

/// Kann diese Maschine den Pulse-Codec (h264/av1) per Hardware encodieren?
pub fn supports_codec(codec_id: &str) -> bool {
    available_video_codecs().contains(&codec_id)
}

/// Kann diese Maschine 10 bit encodieren (impliziert AV1)?
pub fn supports_ten_bit() -> bool {
    probe().ten_bit
}
