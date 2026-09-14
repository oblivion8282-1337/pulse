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
//! HEVC ist seit dem 2026-09-13 dabei — bewusst als REINE Hardware-Route
//! (`hevc_nvenc`/`hevc_vaapi`): die Patentpools lizenzieren die
//! Implementierung, und die sitzt im Chip; wer nur Bitstreams in NVENC/VAAPI
//! füttert, vertreibt keinen Codec (dieselbe Linie, auf der RustDesk/Parsec
//! HEVC anbieten und Chrome es hardwareonly schaltet). Ein Software-Fallback
//! wäre genau der Ritt über diese Linie — deshalb gibt es keinen.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::encode;
use crate::system::drm::{self, Vendor};

/// Kandidaten in Präferenzordnung. HEVC ist die Mittelstufe: Encoder-Hardware
/// seit ~2015/16 (Pascal/VCE 3.x/Skylake), wo AV1 erst ab 2022 anfängt —
/// Karten dazwischen fielen bisher auf H.264 mit doppelter Bitrate zurück.
const CANDIDATES: &[&str] = &["h264", "hevc", "av1"];

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
    /// Dasselbe für HEVC (Main 10) — seit dem 2026-09-13 getrennt geführt,
    /// weil HEVC die Mittelstufe für Karten ist, die gerade KEIN AV1
    /// encodieren: Main-10-Encode gibt es ab ~2015 (NVENC GM206/Pascal, VCE
    /// 3.x, Skylake), AV1-Encode erst ab 2022. Wer hier nur `ten_bit`
    /// schaute, verlöre genau diese Karten.
    pub ten_bit_hevc: bool,
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
    // 10 bit je Codec proben, aber NUR wenn der Codec überhaupt geht — sonst
    // ist die Antwort schon nein. AV1 und HEVC getrennt: ihre 10-bit-Fähigkeit
    // fällt auseinander (Main 10 seit ~2015, AV1-Encode erst ab 2022).
    let mut zehn_bit_probe = |codec: &str| {
        if !out.contains(&codec) {
            return false;
        }
        match encode::probe_encoder(vendor, &render_node, codec, true) {
            Ok(v) => v,
            Err(e) => {
                definitive = false;
                tracing::warn!(
                    target: "stream", codec,
                    "10-bit-Probe fehlgeschlagen ({e:#}) — konservativ nicht anbieten"
                );
                false
            }
        }
    };
    let ten_bit = zehn_bit_probe("av1");
    let ten_bit_hevc = zehn_bit_probe("hevc");
    tracing::info!(
        target: "stream", vendor = vendor.slug(), codecs = ?out, ten_bit, ten_bit_hevc,
        "HW-Encode-Probe abgeschlossen"
    );
    (Caps { codecs: out, ten_bit, ten_bit_hevc }, definitive)
}

/// Kann diese Maschine den Pulse-Codec (h264/av1) per Hardware encodieren?
pub fn supports_codec(codec_id: &str) -> bool {
    available_video_codecs().contains(&codec_id)
}

/// Kann diese Maschine 10 bit in AV1 encodieren?
pub fn supports_ten_bit() -> bool {
    probe().ten_bit
}

/// Kann diese Maschine 10 bit in HEVC (Main 10) encodieren?
pub fn supports_ten_bit_hevc() -> bool {
    probe().ten_bit_hevc
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
    // 10 bit hängt am WUNSCH-Codec — der Start hat den Wunsch schon gegen die
    // Fähigkeiten geprüft, hier gilt er also für genau diesen Codec. Der
    // Ausweich-Codec wird ohne 10 bit probiert: der kann es evtl. nicht, und
    // die Kombination soll ohnehin nie laufen.
    let traegt = |c: &str| {
        let zehn = ten_bit && c == gewuenscht;
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
