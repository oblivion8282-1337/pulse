//! Welchen Farbraum der Video-Prozessor liest und welchen er schreibt — die
//! eine Stelle, an der das entschieden wird.
//!
//! Gehört zu [`super::d3d11_scale::D3D11Scaler`], steht aber daneben: dort geht
//! es um Views, Sperren und einen `Blt`, hier um Farbwissenschaft. Zusammen in
//! einer Datei hat beides die Größen-Grenze gerissen (`PLAN.md` §12.1) und die
//! Begründungen zwischen Zeigerarbeit versteckt.
//!
//! **Drei Wege, und der dritte ist der Grund für dieses Modul:**
//!
//! | Weg | Eingang | Ausgang | wer wandelt |
//! |---|---|---|---|
//! | [`Farbweg::Durchreichen`] | BGRA, voller Bereich | BGRA | niemand |
//! | [`Farbweg::NachP010`] | BGRA, voller Bereich | P010, BT.709, Studio | der Prozessor |
//! | [`Farbweg::Hdr10`] | **scRGB fp16** | P010, **PQ/BT.2020**, Studio | der Prozessor |
//!
//! **Warum HDR eine andere API braucht.** Die erste Fassung stellte den
//! Farbraum über `D3D11_VIDEO_PROCESSOR_COLOR_SPACE` ein — ein Bitfeld mit
//! Platz für „BT.601 oder BT.709" und „voll oder Studio". PQ und BT.2020 lassen
//! sich darin **gar nicht ausdrücken**; es gibt kein Bit dafür. Wer HDR über
//! dieses Bitfeld einzustellen versucht, stellt zwangsläufig etwas anderes ein,
//! und der Prozessor tut dann etwas Wohldefiniertes, nur nicht das Gewünschte.
//! Die Umstellung auf `VideoProcessorSetStreamColorSpace1` ist deshalb kein
//! Aufräumen, sondern die Voraussetzung.
//!
//! **Die SDR-Wege behalten bewusst die alte Bitfeld-Fassung.** Sie sind
//! gemessen und in Betrieb; sie auf die neue API umzuschreiben wäre eine
//! Verhaltensänderung ohne Anlass — und die Zuordnung „Bitfeld 1<<2 | 1<<4"
//! gegen „`DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709`" ist genau die Sorte
//! Übersetzung, bei der ein Treiber anders entscheidet als der Kopfkommentar
//! erwarten lässt.

use anyhow::{Result, anyhow, bail};
use ffmpeg_next::ffi::AVPixelFormat;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE, ID3D11VideoContext, ID3D11VideoContext1,
    ID3D11VideoContext2, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorEnumerator1,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709, DXGI_COLOR_SPACE_TYPE,
    DXGI_COLOR_SPACE_YCBCR_STUDIO_G2084_LEFT_P2020, DXGI_FORMAT, DXGI_FORMAT_P010,
    DXGI_FORMAT_R16G16B16A16_FLOAT,
};
use windows::Win32::Graphics::Dxgi::{DXGI_HDR_METADATA_HDR10, DXGI_HDR_METADATA_TYPE_HDR10};
use windows::core::Interface;

use crate::system::hdr::SchirmFarbe;

/// Was der Prozessor mit den Farben zu tun hat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Farbweg {
    /// BGRA rein, BGRA raus — nur Skalieren, keine Farbwandlung.
    Durchreichen,
    /// BGRA rein, P010 raus — BT.709, Studio-Bereich. Der 10-bit-SDR-Weg.
    NachP010,
    /// scRGB in 16-Bit-Fließkomma rein, P010 in PQ/BT.2020 raus.
    Hdr10,
}

impl Farbweg {
    /// Der Weg, der sich aus Aufnahme- und Zielformat ergibt.
    ///
    /// Die Frage wird an zwei Stellen gestellt (beim Bau des Prozessors und
    /// beim Prüfen, ob der Treiber die Wandlung kann); als Feld durchgereicht
    /// wäre sie an einer davon vergessbar.
    pub fn aus_formaten(hdr: bool, dst_format: AVPixelFormat) -> Self {
        match (hdr, dst_format) {
            (true, _) => Farbweg::Hdr10,
            (false, AVPixelFormat::AV_PIX_FMT_BGRA) => Farbweg::Durchreichen,
            (false, _) => Farbweg::NachP010,
        }
    }
}

/// Der Eingangs-Farbraum des HDR-Wegs: **scRGB**.
///
/// `G10` heißt Gamma 1.0, also lineares Licht; `P709` sind die
/// BT.709-Primärvalenzen; `FULL` der volle Wertebereich. Das ist genau, was WGC
/// aus einem HDR-Desktop in `Rgba16F` herausgibt — 1,0 entspricht dem
/// SDR-Weiß (per Vereinbarung 80 cd/m²), Spitzlichter liegen darüber, und
/// Farben außerhalb von BT.709 stehen als negative Werte drin. Der Wertebereich
/// ist also **nicht** auf [0,1] begrenzt, und genau deshalb geht die
/// zusätzliche Information nicht verloren.
const EINGANG_SCRGB: DXGI_COLOR_SPACE_TYPE = DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709;

/// Der Ausgangs-Farbraum des HDR-Wegs: **HDR10**.
///
/// `G2084` ist die PQ-Kurve (SMPTE ST 2084), `P2020` sind die
/// BT.2020-Primärvalenzen, `STUDIO` der begrenzte Wertebereich (64–940 in
/// 10 bit), `LEFT` die Chroma-Lage neben dem Luma-Wert. Alle vier Angaben
/// müssen zu dem passen, was der Encoder anschließend in den Strom schreibt
/// (`encoder_hw.rs`) — steht dort etwas anderes, sagen die Metadaten das eine
/// und die Bildpunkte das andere. Der Fehler sieht beim Zuschauer nach zu
/// dunklen oder zu blassen Farben aus, nicht nach einem Defekt.
const AUSGANG_HDR10: DXGI_COLOR_SPACE_TYPE = DXGI_COLOR_SPACE_YCBCR_STUDIO_G2084_LEFT_P2020;

/// Kann dieser Treiber die HDR-Wandlung wirklich?
///
/// `CheckVideoProcessorFormatConversion` fragt nach **genau dieser** Kombination
/// aus Eingangsformat, Eingangsfarbraum, Ausgangsformat und Ausgangsfarbraum —
/// nicht danach, ob eine Option in einer Tabelle steht. Das ist der Unterschied
/// zu dem Fall, an dem sich `encode::auffrischung` die Finger verbrannt hat:
/// dort nahm ein Encoder eine Option an und tat nichts damit. Hier antwortet
/// der Treiber über die konkrete Wandlung.
///
/// **Trotzdem bleibt es eine Zusage, keine Messung.** Ob am Ende wirklich
/// PQ-Werte herauskommen, steht am fertigen Strom — und genau dort ist es auch
/// nachgesehen worden (`docs/2026-08-06-hdr-windows-amd.md`). Diese Prüfung
/// verhindert den anderen Fall: einen Start, der später wortlos falsche Farben
/// liefert, weil `VideoProcessorBlt` eine nicht unterstützte Wandlung
/// stillschweigend als Durchreichen ausführt.
///
/// `ID3D11VideoProcessorEnumerator1` gibt es seit Windows 8.1. Fehlt es, sagen
/// wir Nein statt „vermutlich ja": ein System ohne diese Schnittstelle ist
/// keines, auf dem wir HDR belegt haben.
pub fn treiber_kann_hdr(enumerator: &ID3D11VideoProcessorEnumerator) -> bool {
    let Ok(enum1) = enumerator.cast::<ID3D11VideoProcessorEnumerator1>() else {
        return false;
    };
    unsafe {
        enum1.CheckVideoProcessorFormatConversion(
            DXGI_FORMAT_R16G16B16A16_FLOAT,
            EINGANG_SCRGB,
            DXGI_FORMAT_P010,
            AUSGANG_HDR10,
        )
    }
    .is_ok_and(|b| b.as_bool())
}

/// Die Leuchtdichten und Primärvalenzen des Schirms in die Einheiten von
/// HDR10 umrechnen.
///
/// **Drei verschiedene Einheiten, und keine davon ist cd/m².** Das ist die
/// häufigste Fehlerquelle an dieser Stelle, deshalb steht jede einzeln da:
/// * Primärvalenzen und Weißpunkt in Vielfachen von **0,00002** (CIE-xy),
/// * die höchste Leuchtdichte in **ganzen** cd/m²,
/// * die niedrigste in Vielfachen von **0,0001** cd/m².
///
/// `MaxContentLightLevel` und `MaxFrameAverageLightLevel` beschreiben den
/// **Inhalt**, nicht das Gerät — was wirklich im Bild vorkommt, wissen wir erst
/// hinterher, und einen Bildschirminhalt vorher zu analysieren wäre eine
/// zweite Rechenlast je Bild. Wir setzen sie deshalb auf die Gerätewerte: das
/// ist die konservative Angabe („heller als der Schirm kann wird es nicht"),
/// und sie ist nachweislich wahr, während eine geratene kleinere Zahl den
/// Zuschauer zu früh abdunkeln ließe.
pub fn hdr10_metadaten(schirm: &SchirmFarbe) -> DXGI_HDR_METADATA_HDR10 {
    let xy = |p: [f32; 2]| [(p[0] / 0.00002) as u16, (p[1] / 0.00002) as u16];
    DXGI_HDR_METADATA_HDR10 {
        RedPrimary: xy(schirm.primaervalenzen[0]),
        GreenPrimary: xy(schirm.primaervalenzen[1]),
        BluePrimary: xy(schirm.primaervalenzen[2]),
        WhitePoint: xy(schirm.weisspunkt),
        MaxMasteringLuminance: schirm.max_nits as u32,
        MinMasteringLuminance: (schirm.min_nits / 0.0001) as u32,
        MaxContentLightLevel: schirm.max_nits as u16,
        MaxFrameAverageLightLevel: schirm.max_vollbild_nits as u16,
    }
}

/// Den Prozessor auf den gewählten Weg einstellen. Einmal beim Bau, nie im
/// laufenden Betrieb.
///
/// `schirm` wird nur beim HDR-Weg gebraucht und ist dort **Pflicht**: ohne die
/// Angaben des Schirms gäbe es keine Mastering-Metadaten, und der Zuschauer
/// bekäme einen PQ-Strom ohne jede Aussage darüber, für welches Anzeigegerät er
/// gemacht ist. Fehlt sie, ist das ein Programmierfehler weiter oben — nicht
/// etwas, das man mit erfundenen Standardwerten überdecken sollte.
pub fn anwenden(
    video_context: &ID3D11VideoContext,
    enumerator: &ID3D11VideoProcessorEnumerator,
    processor: &ID3D11VideoProcessor,
    weg: Farbweg,
    schirm: Option<&SchirmFarbe>,
) -> Result<()> {
    if weg == Farbweg::Hdr10 {
        return hdr_anwenden(video_context, enumerator, processor, schirm);
    }
    // ── SDR: unveränderte Bitfeld-Fassung, s. Modul-Kopf ────────────────────
    //
    // Der EINGANG ist immer BGRA vom Desktop, also RGB in voller Auflösung
    // 0-255 — dafür ist das genullte Bitfeld exakt richtig (Usage=Playback,
    // RGB_Range=Full). Explizit gesetzt, damit kein Treiber-Default
    // dazwischenfunkt (z.B. Studio-Range).
    //
    // Der AUSGANG hängt am Zielformat: bei BGRA bleibt es dasselbe RGB (keine
    // Wandlung, genulltes Feld). Bei P010 wandelt der Prozessor nach YCbCr und
    // muss dabei die Werte treffen, die der Encoder anschließend als Metadaten
    // anschreibt — `encoder_hw.rs` signalisiert dort BT.709 mit MPEG-Range.
    unsafe {
        let cs = std::mem::zeroed();
        video_context.VideoProcessorSetStreamColorSpace(processor, 0, &cs);
        let out_cs = if weg == Farbweg::Durchreichen {
            cs
        } else {
            D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                // Bit 2 = YCbCr_Matrix 1 (BT.709), Bits 4-5 = Nominal_Range 1
                // (16-235). Reihenfolge der Bitfelder aus `d3d11.h`:
                // Usage, RGB_Range, YCbCr_Matrix, YCbCr_xvYCC, Nominal_Range.
                _bitfield: (1 << 2) | (1 << 4),
            }
        };
        video_context.VideoProcessorSetOutputColorSpace(processor, &out_cs);
    }
    Ok(())
}

fn hdr_anwenden(
    video_context: &ID3D11VideoContext,
    enumerator: &ID3D11VideoProcessorEnumerator,
    processor: &ID3D11VideoProcessor,
    schirm: Option<&SchirmFarbe>,
) -> Result<()> {
    let schirm = schirm.ok_or_else(|| {
        anyhow!("HDR-Farbweg ohne Angaben zum Bildschirm — ohne sie gäbe es keine Mastering-Metadaten")
    })?;
    if !treiber_kann_hdr(enumerator) {
        bail!(
            "der Grafiktreiber sagt, er kann scRGB (16-Bit-Fließkomma) nicht nach PQ/BT.2020 in \
             P010 wandeln. Ohne diese Wandlung gäbe es keinen HDR-Strom, nur ein falsch \
             beschriftetes Bild — deshalb Abbruch statt Rückfall. Geprüft über \
             CheckVideoProcessorFormatConversion; s. encode/farbraum.rs"
        );
    }

    // `ID3D11VideoContext1` gibt es seit Windows 8.1 — dass es hier fehlt, ist
    // nach der Treiber-Prüfung oben praktisch ausgeschlossen; die Meldung
    // trotzdem klar, weil ein `?` auf einem Cast sonst als „unbekannter
    // COM-Fehler" ankommt.
    let ctx1 = video_context
        .cast::<ID3D11VideoContext1>()
        .map_err(|e| anyhow!("ID3D11VideoContext1 nicht verfügbar (für PQ/BT.2020 nötig): {e}"))?;
    unsafe {
        ctx1.VideoProcessorSetStreamColorSpace1(processor, 0, EINGANG_SCRGB);
        ctx1.VideoProcessorSetOutputColorSpace1(processor, AUSGANG_HDR10);
    }

    // Die Metadaten sind **kein Beiwerk**: der Prozessor wandelt lineares Licht
    // in PQ, und PQ ist eine absolute Kurve — welcher Zahlenwert welcher
    // Helligkeit entspricht, hängt daran, welche Spitzenhelligkeit gemeint ist.
    // Ohne die Angabe entscheidet der Treiber nach eigenem Ermessen, und
    // dasselbe Bild sähe auf zwei Rechnern verschieden hell aus.
    //
    // `ID3D11VideoContext2` (Windows 10 1703) ist die erste Fassung, die sie
    // annimmt. Fehlt sie, brechen wir NICHT ab: die Wandlung selbst läuft, nur
    // ohne unsere Angabe zum Mastering-Gerät. Das ist ein Qualitätsverlust,
    // keine Falschaussage — und der Encoder schreibt dieselben Werte gleich
    // darauf noch einmal in den Strom (`encoder_hw.rs`), wo sie den Zuschauer
    // ohnehin erreichen.
    let meta = hdr10_metadaten(schirm);
    match video_context.cast::<ID3D11VideoContext2>() {
        Ok(ctx2) => unsafe {
            let groesse = std::mem::size_of::<DXGI_HDR_METADATA_HDR10>() as u32;
            let zeiger = Some(std::ptr::from_ref(&meta).cast::<std::ffi::c_void>());
            ctx2.VideoProcessorSetStreamHDRMetaData(
                processor,
                0,
                DXGI_HDR_METADATA_TYPE_HDR10,
                groesse,
                zeiger,
            );
            ctx2.VideoProcessorSetOutputHDRMetaData(
                processor,
                DXGI_HDR_METADATA_TYPE_HDR10,
                groesse,
                zeiger,
            );
        },
        Err(e) => eprintln!(
            "[farbraum] HDR-Metadaten nicht an den Video-Prozessor übergebbar ({e}) — \
             die Wandlung läuft, der Treiber wählt die Spitzenhelligkeit dann selbst"
        ),
    }

    eprintln!(
        "[farbraum] HDR-Wandlung eingestellt: scRGB (fp16, linear) → PQ/BT.2020, P010, \
         Studio-Bereich. Schirm: {}",
        schirm.beschreibung()
    );
    Ok(())
}

/// Das DXGI-Format, das zu einem Pool-Format gehört — für die Treiber-Abfrage
/// und für Log-Zeilen. Nur die drei Formate, die im Sidecar wirklich
/// vorkommen; alles andere ist ein Programmierfehler, kein Laufzeitfall.
pub fn dxgi_format(pool_format: AVPixelFormat) -> Option<DXGI_FORMAT> {
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
    match pool_format {
        AVPixelFormat::AV_PIX_FMT_BGRA => Some(DXGI_FORMAT_B8G8R8A8_UNORM),
        AVPixelFormat::AV_PIX_FMT_P010LE => Some(DXGI_FORMAT_P010),
        AVPixelFormat::AV_PIX_FMT_RGBAF16LE => Some(DXGI_FORMAT_R16G16B16A16_FLOAT),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Diagnose, kein Test.** Fragt den echten Treiber, WELCHE Wandlungen er
    /// von 16-Bit-Fließkomma nach P010 anbietet, und druckt die Tabelle.
    ///
    /// Der Anlass: am 2026-08-06 hat `CheckVideoProcessorFormatConversion` die
    /// Kombination aus scRGB und HDR10 verneint, und die Frage war, ob das die
    /// Wahrheit über den Treiber ist oder nur über diese eine Zeile. Eine
    /// Absage anzunehmen, ohne die Nachbarn zu probieren, wäre genau der
    /// Fehlschluss, gegen den `encode::auffrischung` gebaut ist — dort hat eine
    /// einzelne Abfrage ebenfalls eine falsche Auskunft gegeben.
    ///
    /// Aufruf:
    /// `cargo test -- --ignored --nocapture wandlungen_dieses_treibers`
    #[test]
    #[ignore = "fragt echte Hardware ab; Ergebnis ist treiberabhängig"]
    fn wandlungen_dieses_treibers() {
        use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
            D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
            D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11CreateDevice, ID3D11Device, ID3D11VideoDevice,
        };
        use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R10G10B10A2_UNORM, DXGI_RATIONAL};

        let mut device: Option<ID3D11Device> = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                windows::Win32::Foundation::HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .expect("D3D11-Gerät");
        let video_device: ID3D11VideoDevice = device.unwrap().cast().expect("ID3D11VideoDevice");
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            InputWidth: 2560,
            InputHeight: 1440,
            OutputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            OutputWidth: 1920,
            OutputHeight: 1080,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        let enumerator =
            unsafe { video_device.CreateVideoProcessorEnumerator(&desc) }.expect("Enumerator");
        let enum1 = enumerator
            .cast::<ID3D11VideoProcessorEnumerator1>()
            .expect("ID3D11VideoProcessorEnumerator1");

        // Die Farbräume als rohe Zahlen: `windows` benennt nicht alle, und für
        // eine Tabelle ist der Zahlenwert ohnehin das, was man vergleicht.
        let namen: &[(i32, &str)] = &[
            (0, "RGB_FULL_G22_NONE_P709 (sRGB)"),
            (1, "RGB_FULL_G10_NONE_P709 (scRGB)"),
            (12, "RGB_FULL_G2084_NONE_P2020 (HDR10 als RGB)"),
            (17, "RGB_FULL_G22_NONE_P2020"),
        ];
        let ausgaenge: &[(i32, &str)] = &[
            (8, "YCBCR_STUDIO_G22_LEFT_P709 (SDR)"),
            (10, "YCBCR_STUDIO_G22_LEFT_P2020"),
            (13, "YCBCR_STUDIO_G2084_LEFT_P2020 (HDR10)"),
            (16, "YCBCR_STUDIO_G2084_TOPLEFT_P2020 (HDR10, andere Chroma-Lage)"),
        ];
        for (ein_format, ein_name) in
            [(DXGI_FORMAT_R16G16B16A16_FLOAT, "RGBA16F"), (DXGI_FORMAT_R10G10B10A2_UNORM, "RGB10A2")]
        {
            for (e, en) in namen {
                for (a, an) in ausgaenge {
                    let ok = unsafe {
                        enum1.CheckVideoProcessorFormatConversion(
                            ein_format,
                            DXGI_COLOR_SPACE_TYPE(*e),
                            DXGI_FORMAT_P010,
                            DXGI_COLOR_SPACE_TYPE(*a),
                        )
                    }
                    .is_ok_and(|b| b.as_bool());
                    println!("{:9} {en:44} -> {an:60} {}", ein_name, if ok { "JA" } else { "nein" });
                }
            }
        }
    }

    #[test]
    fn hdr_schlaegt_das_zielformat() {
        // Der HDR-Weg endet immer in P010 — dass jemand ihn mit BGRA-Ziel
        // anfordert, wäre ein Fehler weiter oben; hier darf daraus jedenfalls
        // kein SDR-Weg werden.
        assert_eq!(
            Farbweg::aus_formaten(true, AVPixelFormat::AV_PIX_FMT_P010LE),
            Farbweg::Hdr10
        );
        assert_eq!(
            Farbweg::aus_formaten(true, AVPixelFormat::AV_PIX_FMT_BGRA),
            Farbweg::Hdr10
        );
    }

    #[test]
    fn ohne_hdr_entscheidet_das_zielformat() {
        assert_eq!(
            Farbweg::aus_formaten(false, AVPixelFormat::AV_PIX_FMT_BGRA),
            Farbweg::Durchreichen
        );
        assert_eq!(
            Farbweg::aus_formaten(false, AVPixelFormat::AV_PIX_FMT_P010LE),
            Farbweg::NachP010
        );
        assert_eq!(
            Farbweg::aus_formaten(false, AVPixelFormat::AV_PIX_FMT_NV12),
            Farbweg::NachP010
        );
    }

    /// Die drei Einheiten von HDR10. Der Test rechnet mit den Werten eines
    /// echten Geräts (BT.709-Primärvalenzen, D65) gegen die Zahlen, die im
    /// Strom landen — ein Faktor an der falschen Stelle fiele sonst erst
    /// jemandem auf, der den fertigen Strom auseinandernimmt.
    #[test]
    fn metadaten_treffen_die_einheiten() {
        let schirm = SchirmFarbe {
            hdr_aktiv: true,
            bits_je_kanal: 10,
            max_nits: 1000.0,
            max_vollbild_nits: 400.0,
            min_nits: 0.005,
            primaervalenzen: [[0.640, 0.330], [0.300, 0.600], [0.150, 0.060]],
            weisspunkt: [0.3127, 0.3290],
        };
        let m = hdr10_metadaten(&schirm);
        // CIE-xy in Vielfachen von 0,00002: 0,640 → 32000.
        assert_eq!(m.RedPrimary, [32000, 16500]);
        assert_eq!(m.WhitePoint, [15635, 16450]);
        // Spitze in ganzen cd/m², Schwarz in Vielfachen von 0,0001 cd/m².
        assert_eq!(m.MaxMasteringLuminance, 1000);
        assert_eq!(m.MinMasteringLuminance, 50);
        assert_eq!(m.MaxContentLightLevel, 1000);
        assert_eq!(m.MaxFrameAverageLightLevel, 400);
    }
}
