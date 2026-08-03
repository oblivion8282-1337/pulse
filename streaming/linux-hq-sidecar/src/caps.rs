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
use crate::system::drm::{self, Vendor};

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
    /// Reicht das gelinkte FFmpeg rollenden Intra-Refresh durch?
    ///
    /// **Das ist eine Frage an FFmpeg, nicht an die Hardware.** Auf NVIDIA ist
    /// die Option upstream; auf VAAPI (AMD/Intel) gibt es sie in KEINER
    /// FFmpeg-Version, dort braucht es unseren Patch
    /// (`streaming/ffmpeg-patches/`). Ohne ihn bricht der Start ab, statt still
    /// Keyframes zu fahren — die Oberfläche soll das Kästchen deshalb gar nicht
    /// erst anbieten.
    pub intra_refresh: bool,
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
    // Intra-Refresh fragt nur die Optionsliste des Encoders ab — keine
    // Hardware, kein `open`, also auch nichts, was `definitive` kippen könnte.
    // Ein einziger Codec genügt: die Option sitzt bei beiden Vendorn im
    // gemeinsamen Optionsblock, und was hier gemeldet wird, ist die Eigenschaft
    // des FFmpeg-Baus, nicht die des Codecs.
    let intra_refresh = out
        .first()
        .is_some_and(|c| encode::opts::intra_refresh_verfuegbar(vendor, c));
    tracing::info!(
        target: "stream", vendor = vendor.slug(), codecs = ?out, ten_bit, intra_refresh,
        "HW-Encode-Probe abgeschlossen"
    );
    (Caps { codecs: out, ten_bit, intra_refresh }, definitive)
}

/// Kann diese Maschine den Pulse-Codec (h264/av1) per Hardware encodieren?
pub fn supports_codec(codec_id: &str) -> bool {
    available_video_codecs().contains(&codec_id)
}

/// Kann diese Maschine 10 bit encodieren (impliziert AV1)?
pub fn supports_ten_bit() -> bool {
    probe().ten_bit
}

/// Welchen Codec dieser Stream wirklich fahren kann — geprüft an der ECHTEN
/// Auflösung. Gibt den gewünschten zurück, wenn er trägt.
///
/// **Warum das die Codec-Liste oben nicht erledigt.** [`probe`] öffnet den
/// Encoder bei 720p und beantwortet damit „kann diese Karte den Codec". Das
/// muss so sein: die Liste steht, bevor der Wayland-Dialog die Quelle festlegt
/// — vorher weiß niemand, wie groß der Schirm ist. „Kann sie ihn auch bei 8K"
/// ist aber eine andere Frage, und die Antwort weicht ab: gemessen am
/// 2026-08-03 auf einer Radeon 780M öffnet `h264_vaapi` bei 4K und scheitert
/// bei 7680x4320 mit `Invalid argument`, während `av1_vaapi` beides trägt.
///
/// Ohne diese Prüfung bekäme ein Nutzer mit großem Schirm eine Treibermeldung
/// beim Start — obwohl der andere Codec auf derselben Karte funktioniert hätte.
///
/// Der Rückfall geht bewusst in BEIDE Richtungen. `ops::start` fällt von AV1 auf
/// H.264 zurück, wenn die Karte kein AV1 encodiert; hier ist es umgekehrt, weil
/// H.264 zuerst an der Bildgröße scheitert. Schlägt die Probe für beide fehl,
/// bleibt es beim Wunsch — dann soll der echte Open seine eigene, genauere
/// Fehlermeldung liefern statt einer geratenen.
///
/// Meldet NICHTS an den Nutzer: eine Fähigkeits-Probe ist die falsche Ebene für
/// Oberflächen-Ereignisse. Der Aufrufer vergleicht mit seinem Wunsch und sagt es.
pub fn codec_fuer_aufloesung(
    vendor: Vendor,
    node: &str,
    gewuenscht: &str,
    ten_bit: bool,
    breite: u32,
    hoehe: u32,
) -> String {
    // Geprüft wird erst OBERHALB dessen, was jede Karte sicher kann, und zwar
    // an den Abmessungen — nicht an der Fläche. Der Unterschied ist real: ein
    // 5120x1440-Ultrawide hat weniger Bildpunkte als 4K, überschreitet aber die
    // Breitengrenze und ist genau der Fall, den diese Prüfung fangen soll.
    //
    // Die Zahlen sind die H.264-Grenze von VCN 4 (rund 4096x2304). Jede Karte,
    // die die 720p-Probe besteht, encodiert auch darunter in beiden Codecs;
    // unterhalb würde die Prüfung nur Zeit kosten (eine zusätzliche
    // Encoder-Öffnung samt HW-Pool in voller Bildgröße, bei JEDEM Start) und
    // nie etwas finden.
    //
    // Das ist eine Annahme über Hardware, keine Messung. Wandert die Grenze,
    // gehören diese Werte mitgezogen.
    const MAX_SICHER_BREITE: u32 = 4096;
    const MAX_SICHER_HOEHE: u32 = 2304;
    if breite <= MAX_SICHER_BREITE && hoehe <= MAX_SICHER_HOEHE {
        return gewuenscht.to_string();
    }
    // 10 bit ist an AV1 gebunden (s. [`Caps::ten_bit`]) — der Ausweich-Codec
    // muss deshalb ohne geprüft werden, sonst testet die Probe eine
    // Kombination, die ohnehin nie laufen soll.
    let traegt = |c: &str| {
        let zehn = ten_bit && c == "av1";
        matches!(encode::probe_encoder_at(vendor, node, c, zehn, breite, hoehe), Ok(true))
    };
    if traegt(gewuenscht) {
        return gewuenscht.to_string();
    }
    let ausweich = if gewuenscht == "h264" { "av1" } else { "h264" };
    if traegt(ausweich) {
        return ausweich.to_string();
    }
    tracing::warn!(
        target: "stream", codec = gewuenscht, breite, hoehe,
        "weder der gewuenschte noch der andere Codec oeffnet bei dieser Groesse"
    );
    gewuenscht.to_string()
}
