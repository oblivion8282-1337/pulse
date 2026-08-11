//! Codec- und Encode-Weg-Tabellen: welcher FFmpeg-Encoder-Name zu welchem
//! (Vendor, Codec) gehört, und welcher der drei Encode-Pfade
//! (`stream_controller::run_pipeline`) eine Kombination bedient.
//!
//! Getrennt von `encoder.rs` (dem eigentlichen CPU-Pfad-Encoder), weil diese
//! Tabellen von ALLEN drei Encode-Pfaden (`pipeline_hw`, `pipeline_d3d12`,
//! `run_cpu_pipeline`) und dem Dispatcher gelesen werden — sie gehören
//! logisch vor die Verzweigung, nicht in einen ihrer Zweige.

use anyhow::{Result, anyhow};

/// `PULSE_HQ_AMD_D3D12=1` — AMD mit H.264/HEVC zurück auf `h264_d3d12va`
/// statt auf AMF. Der Gegenprobe-Schalter, seit AMF der Regelweg ist.
///
/// **Bis 2026-08-04 war es umgekehrt**, und die Umkehrung ist eine
/// Produktentscheidung, keine Messung — die Zahlen darunter gelten weiter:
///
/// | H.264 über | Encode-Latenz | GPU-Video |
/// |---|---|---|
/// | D3D12 (`h264_d3d12va`) | **6,8 ms** | 25,4 % |
/// | D3D11 (`h264_amf`)     | 17,2 ms    | 10,5 % |
///
/// (Radeon 780M, 1440p → 1080p60, 4000 kbps, 2026-07-30. Die D3D11-Zeile
/// entstand vor dem Einzeltextur-Fix in `hwctx.rs`, ihr Bild war zerrissen —
/// und ein zerrissenes Bild kostet weniger Video-Engine, weil weniger echter
/// Inhalt drinsteckt. Die **Last**-Zahl ist damit unbelegt; die **Latenz**-Zahl
/// ist es nicht, sie steht über drei Bildraten und mehrere Optionen gegengeprüft.)
///
/// **Was AMF kostet:** rund 10 ms, exakt ein Bildabstand — AMF hält ein Bild
/// zurück, codec-unabhängig, und keine Option bewegt das (`async_depth` 1 wie
/// 16, `latency`, `preanalysis`, alle gemessen). Bei 120 fps sind es nur noch
/// 8,9 ms, die Bildrate ist also der einzige Hebel darauf.
///
/// **Warum trotzdem AMF, für beide Codecs:** ein Weg statt zwei. Die frühere
/// Aufteilung — H.264 über D3D12, AV1 über AMF — war je Codec begründet und in
/// der Summe teuer: zwei Encode-Wege, die auseinanderlaufen, zwei Stellen für
/// jede Option, und Eigenschaften, die nur auf einem der beiden ankommen.
/// Intra-Refresh ist genau so ein Fall: `h264_d3d12va` nimmt die Option an und
/// tut nichts damit, `h264_amf` frischt unter `usage=ultralowlatency` von sich
/// aus auf. Auch `usage` selbst gibt es nur bei AMF — der d3d12va-Zweig liegt
/// fest bei rund 25 % Video-Engine und lässt sich nicht sparsam stellen.
///
/// **Das Risiko, das mitkommt, und es ist benannt:** `h264_amf` auf
/// D3D11-Eingang ist die Konstellation aus AMF-Issue #455
/// (`SubmitInput`-Integer-Divide-by-Zero). Auf dieser Maschine ist der Absturz
/// nicht reproduzierbar — das ist eine Maschine, kein Beleg. Deshalb bleibt
/// `pipeline_hw` bei einem gescheiterten Open auf AMD weiterhin an
/// `pipeline_d3d12` abgeben können (s. `bildencoder.rs`), und dieser Schalter
/// stellt den alten Weg ohne Neubau wieder her.
fn amd_forces_d3d12() -> bool {
    crate::env::flag("PULSE_HQ_AMD_D3D12")
}

#[derive(Debug, Clone, Copy)]
pub enum VideoCodec {
    H264,
    Hevc,
    Av1,
}

/// Welcher der drei Encode-Wege eine (Vendor, Codec)-Kombination bedient.
/// Siehe [`VideoCodec::encode_path`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodePath {
    /// `pipeline_hw` — WGC → D3D11VA-Pool → Encoder (NVENC bzw. AMF).
    D3d11ZeroCopy,
    /// `pipeline_d3d12` — WGC → Shared-Handle → D3D12-Compute → `*_d3d12va`.
    D3d12ZeroCopy,
    /// `run_cpu_pipeline` — CPU-Readback + swscale. Notausgang.
    Cpu,
}

impl VideoCodec {
    /// FFmpeg-Encoder-Name für (Vendor, Codec). `vendor` ist der Slug aus
    /// `system::dxgi::Adapter::vendor()` (`"nvidia"`/`"amd"`/`"intel"`).
    pub fn ffmpeg_name(self, vendor: &str) -> Result<&'static str> {
        Ok(match (vendor, self) {
            ("nvidia", VideoCodec::H264) => "h264_nvenc",
            ("nvidia", VideoCodec::Hevc) => "hevc_nvenc",
            ("nvidia", VideoCodec::Av1) => "av1_nvenc",
            ("amd", VideoCodec::H264) => "h264_amf",
            ("amd", VideoCodec::Hevc) => "hevc_amf",
            ("amd", VideoCodec::Av1) => "av1_amf",
            ("intel", VideoCodec::H264) => "h264_qsv",
            ("intel", VideoCodec::Hevc) => "hevc_qsv",
            ("intel", VideoCodec::Av1) => "av1_qsv",
            _ => return Err(anyhow!("no HW encoder for vendor={vendor} codec={self:?}")),
        })
    }

    /// Welcher Encode-Weg diese Kombination bedient — die EINE Stelle, an der
    /// das steht.
    ///
    /// Die Regel hing vorher an zwei Orten (Dispatcher und `pipeline_hw`) in
    /// zwei verschiedenen Schreibweisen. Zwei Fassungen derselben Regel laufen
    /// auseinander, sobald eine Zelle dazukommt — und dann schickt der
    /// Dispatcher einen Stream auf einen Pfad, der ihn sofort wieder
    /// wegdelegiert. Sie steht hier, weil daneben mit
    /// [`ffmpeg_name`](Self::ffmpeg_name) schon die andere
    /// (Vendor, Codec)-Tabelle wohnt.
    ///
    /// - **NVIDIA, alles** → D3D11: NVENC nimmt D3D11-BGRA direkt.
    /// - **AMD, AV1** → D3D11: `av1_amf` nimmt D3D11-BGRA direkt. AV1 über
    ///   D3D12 kann die Hardware nicht (unbrauchbarer Bitstrom, Messung in
    ///   `pipeline_d3d12::run`), und über die CPU-Pipeline kostete AV1 113 %
    ///   einer CPU-Kerne samt 42 übersprungenen Bildern in 20 s; über D3D11
    ///   sind es ~10 % und 0 (2026-07-30, Radeon 780M, 1440p nativ).
    /// - **AMD, H.264/HEVC** → **ebenfalls D3D11** (`h264_amf`), seit dem
    ///   2026-08-04. **Hier stand bis zum 2026-08-06 „→ D3D12: `h264_d3d12va`
    ///   ist um das Zweieinhalbfache latenzärmer als `h264_amf` (6,8 gegen
    ///   17,2 ms)" — das ist falsch**, und zwar seit derselben Umstellung, die
    ///   zwanzig Zeilen weiter unten an `amd_forces_d3d12` begründet steht:
    ///   ein Encode-Weg statt zwei. Die Latenzzahlen stimmen weiterhin, sie
    ///   sind der **Preis** der Entscheidung, nicht ihr Ergebnis. Zurück auf
    ///   D3D12 kommt man nur noch über `PULSE_HQ_AMD_D3D12=1`.
    /// - **Rest (Intel)** → CPU.
    ///
    /// **AMD+AV1 war hier schon einmal auf D3D11 und wurde zurückgenommen**,
    /// weil das Bild zerrissen war (doppelte, versetzte Kopien, verschmierter
    /// Text) — bei formal einwandfreiem, fehlerfrei dekodierbarem Strom. Die
    /// Ursache ist gefunden und behoben: die AMF-Runtime liest aus dem
    /// D3D11VA-**Texture-Array**-Pool falsch; mit einem Pool aus
    /// **Einzeltexturen** ist das Bild sauber (Herleitung + Standbild-A/B am
    /// Wert in `hwctx.rs::HwContext::new`; `h264_amf` zeigte über das Array
    /// dieselben Risse, der Fehler ist codec-unabhängig). `hwctx.rs` wählt die
    /// Pool-Bauart seither automatisch nach GPU-Vendor.
    ///
    /// Aus der ersten Rücknahme bleibt die Regel: **bei Bildwegen gehört zu
    /// jeder Messung eine Sichtprüfung** — Latenz, CPU und Decodierbarkeit
    /// sahen auch beim zerrissenen Bild hervorragend aus. Der Fix hier ist
    /// per Standbild belegt (1440p nativ und 1080p über den Scaler-Pool).
    ///
    /// Neue Zellen gehören hierher und brauchen eine Messung, keine Vermutung —
    /// und bei Bildwegen eine Sichtprüfung.
    /// **Ein angemeldeter Sendeweg (`encode::senke`) schlägt alles andere**,
    /// unabhängig von Hersteller und Codec: nur der D3D11-Weg ist gegabelt,
    /// D3D12 und CPU schreiben in einen Container. Ohne diese Zeile bekäme
    /// AMD+H.264 den D3D12-Weg, dessen Pakete am Sendeweg vorbei in den
    /// ffmpeg-Muxer liefen — und der scheitert auf Windows an DTLS, ohne dass
    /// irgendwo etwas Brauchbares stünde (gemessen 2026-08-02: `Creating
    /// security context failed (0x80090331)`). Der Stream käme nie an.
    ///
    /// Die Entscheidung hängt an der **URL**, nicht bloß daran, ob überhaupt
    /// ein Sendeweg angemeldet ist: sonst nähme im Labor auch ein Stream nach
    /// RTMPS oder in eine Datei einen anderen Encode-Weg als im ausgelieferten
    /// Sidecar — und ein Messstand, der anders encodiert als das Original,
    /// misst das Falsche.
    pub fn encode_path(self, vendor: &str, push_url: &str) -> EncodePath {
        if super::senke::zustaendig(push_url) {
            return EncodePath::D3d11ZeroCopy;
        }
        // **Dasselbe gilt für einen angemeldeten ENCODER**, und aus demselben
        // Grund: nur der D3D11-Weg fragt `encode::bildencoder`. Auf jeder
        // anderen Route (Intel → CPU, AMD unter dem Gegenprobe-Schalter →
        // D3D12) würde die Anmeldung wortlos übergangen — der Stream liefe,
        // sähe gesund aus und beantwortete eine andere Frage als die gestellte.
        // Genau die Verwechslung, gegen die es `log_encoder_open` gibt.
        //
        // Hier ohne URL-Prüfung, anders als beim Sendeweg: ein Encoder ist
        // nicht an ein Ziel gebunden, er encodiert jeden Strom.
        if super::bildencoder::angemeldet().is_some() {
            return EncodePath::D3d11ZeroCopy;
        }
        // AV1 hat den Gegenprobe-Schalter nicht: `av1_d3d12va` gibt keine
        // brauchbare extradata heraus, der Weg endete ohnehin im Rückfall.
        if vendor == "amd" && !matches!(self, VideoCodec::Av1) && amd_forces_d3d12() {
            return EncodePath::D3d12ZeroCopy;
        }
        match vendor {
            // **AMD geht seit 2026-08-04 mit JEDEM Codec über AMF**, nicht mehr
            // nur mit AV1. Ein Weg statt zwei — Begründung und Preis stehen an
            // `amd_forces_d3d12`.
            "nvidia" | "amd" => EncodePath::D3d11ZeroCopy,
            _ => EncodePath::Cpu,
        }
    }

    /// Trägt dieser Codec 10 bit über den Zero-Copy-Weg? Steht hier neben den
    /// anderen beiden Codec-Tabellen, damit die Regel nicht als `if codec ==
    /// Av1` im Aufrufer landet und dort beim nächsten Codec vergessen wird.
    ///
    /// Heute nur AV1, und zwar nicht aus Prinzip, sondern weil nur dieser Weg
    /// gemessen ist — inzwischen auf **beiden** Herstellern:
    ///
    /// * **AMD** (2026-08-01, Radeon 780M): P010-Pool + `bitdepth=10` an
    ///   `av1_amf`, am Server als 10-bit-Strom bestätigt.
    /// * **NVIDIA** (2026-08-11, RTX 5080, Treiber 610.47): P010-Pool an
    ///   `av1_nvenc`, **ohne** Hersteller-Option — die Bittiefe folgt dort dem
    ///   Pool-Format (`opts.rs`, NVIDIA-Zweig). Belegt an beiden Enden:
    ///   `high_bitdepth = 1` im Sequenzkopf UND Bildpunkte zwischen den
    ///   8-bit-Stufen (Rest 0 bei 14,6 / 14,6 / 33,3 % über drei Läufe, gegen
    ///   100,0 % im 8-bit-Lauf desselben Aufbaus). Messakte
    ///   `testbench/profiles/nvidia-2026-08-11-windows-zehnbit.json`.
    ///
    /// **Die Antwort gilt nur für den D3D11-Zero-Copy-Weg.** Auf dem CPU- und
    /// dem D3D12-Weg gibt es 10 bit strukturell nicht (`EncoderConfig` kennt
    /// das Feld nicht, der D3D12-Pool liegt fest auf NV12). **Bis zum
    /// 2026-08-11 wurde ein 10-bit-Wunsch dort still auf 8 bit
    /// zurückgenommen** — nachgemessen über `PULSE_HQ_DISABLE_ZERO_COPY=1`:
    /// `yuv420p` statt `yuv420p10le`, ohne Abbruch. Das ist geschlossen:
    /// `encode::zehnbit::pruefen` bricht den Start jetzt ab, wenn der
    /// effektive Encode-Weg 10 bit nicht trägt (`stream_controller::mod::
    /// run_pipeline`, vor jeder Encoder-Öffnung). Das steht trotzdem hier,
    /// weil diese Funktion codec-, nicht wegabhängig antwortet und deshalb
    /// leicht als Gesamt-Zusage gelesen wird.
    ///
    /// **Hier stand bis zum 2026-08-06 „H.264 läuft auf AMD über D3D12
    /// (`encode_path`) und damit an diesem Pool vorbei". Das ist falsch** —
    /// seit dem 2026-08-04 geht AMD mit JEDEM Codec über AMF und damit über
    /// genau diesen Pool. Der Grund für das Nein bei H.264 ist ein anderer und
    /// hat mit dem Pool nichts zu tun: 10-bit-H.264 wäre High 10, und das
    /// dekodiert kein Browser (dieselbe Begründung wie in `encode::hdr`). Für
    /// HEVC gibt es keinen Anlass, weil der Codec ausgebaut wird.
    ///
    /// Wer hier eine Zeile ergänzt, misst sie — die Kette aus Pool-Format,
    /// Farbraum am Video-Prozessor (`d3d11_scale.rs`), Hersteller-Option
    /// (`opts.rs`) und Signalisierung (`encoder_hw.rs`) muss ganz stimmen. Ein
    /// Bruch darin liefert einen dekodierbaren Strom mit falschen Farben.
    pub fn supports_ten_bit(self) -> bool {
        matches!(self, VideoCodec::Av1)
    }

    /// Umkehrung von [`slug`](Self::slug): der Kurzname aus dem `start`-Request.
    /// Unbekanntes faellt auf H.264 zurueck, wie an allen drei Aufrufstellen
    /// zuvor einzeln ausgeschrieben.
    pub fn from_slug(s: &str) -> Self {
        match s {
            "hevc" => VideoCodec::Hevc,
            "av1" => VideoCodec::Av1,
            _ => VideoCodec::H264,
        }
    }

    /// Kurzname wie im `start`-Request (`"h264"`/`"hevc"`/`"av1"`) — die
    /// Rueckrichtung zu `parse_overrides`. Gebraucht fuer die argv-Zeile der
    /// `start`-Antwort, die sonst den Codec des PROFILS meldet statt den
    /// gewaehlten.
    pub fn slug(self) -> &'static str {
        match self {
            VideoCodec::H264 => "h264",
            VideoCodec::Hevc => "hevc",
            VideoCodec::Av1 => "av1",
        }
    }

    /// FFmpeg-Encoder-Name für den nativen D3D12VA-Pfad (AMD-GPU-Pfad). Die
    /// d3d12va-Encoder nutzen Microsofts D3D12 Video Encode API — NICHT
    /// NVENC/AMF/QSV — und umgehen so die AMF-Runtime + deren D3D11-Surface-
    /// Crash (Issue #455). Vendor-unabhängig: nur der Codec bestimmt den Namen.
    /// S. `encoder_d3d12.rs`.
    pub fn d3d12va_name(self) -> &'static str {
        match self {
            VideoCodec::H264 => "h264_d3d12va",
            VideoCodec::Hevc => "hevc_d3d12va",
            VideoCodec::Av1 => "av1_d3d12va",
        }
    }
}
