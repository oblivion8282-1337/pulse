//! Frame-Capture-Pipeline (Stage 5).
//!
//! Zwei Pfade aus `windows-capture` v2:
//!
//! - **WGC** (`wgc.rs`) — Windows Graphics Capture, primärer Pfad. Win10 1903+;
//!   sieht Game-Fenster + Desktop, kein Border-Flicker auf Win11. Per-Window
//!   und Per-Monitor.
//! - **DXGI-DDA** (`dxgi_dda.rs`, später) — Desktop Duplication API als Fallback.
//!   Nur Per-Monitor, älter, robuster auf Random-Edge-Cases (Hyper-V,
//!   bestimmte HDR-Modi). Nicht im Day-3-Spike.
//!
//! Eingangs-Quelle wird per `CaptureSource` ausgewählt — die UI in Pulse weiß
//! das schon, der Picker-Dialog aus `windows-capture::graphics_capture_picker`
//! wird *nicht* benutzt.

mod aufnahmeziel;
pub mod rueckruf;
pub mod source;
pub mod wgc;
pub mod wgc_d3d12;
pub mod wgc_hw;

pub use rueckruf::RueckrufStand;
pub use source::CaptureSource;
pub use wgc_d3d12::{D3d12CaptureItem, WgcD3d12Capture};
pub use wgc_hw::{HwCaptureItem, WgcHwCapture};

use anyhow::{Context as _, Result, anyhow};
use windows::Foundation::Metadata::ApiInformation;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    ID3D11Device, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::core::HSTRING;
use windows_capture::settings::{
    CursorCaptureSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
};

/// Präfix der „Quellgröße hat sich geändert"-Fehlermeldung — an allen drei
/// Abbruch-Stellen (wgc_hw / wgc_d3d12 / CPU-Pfad) UND in
/// `stream_controller::worker_finished` benutzt, das daraus das
/// maschinenlesbare `code: "capture_size_changed"` im error-Event ableitet.
/// Der Client startet den Stream auf diesen Code hin automatisch neu —
/// deshalb Konstante statt dreier Literale, die auseinanderdriften könnten.
pub(crate) const RESIZE_ERROR_MARKER: &str = "capture size changed";

/// Präfix der „Quell-Fenster wurde geschlossen"-Meldung — von den drei
/// Capture-Handlern geworfen, wenn der Privacy-Guard (`source::SourceGuard`)
/// ein geschlossenes Quell-Fenster meldet (Spiel beendet). ANDERS als der
/// Resize-Marker mappt `stream_controller::worker_finished` das NICHT auf ein
/// error-Event, sondern auf den sauberen Stop-Pfad (`{"ev":"stopped",
/// "reason":"source_closed"}`) — Spiel zu → Stream zu ist gewolltes Verhalten,
/// kein Fehler.
pub(crate) const SOURCE_CLOSED_MARKER: &str = "capture source closed";

/// Der Fehler, mit dem ein Capture-Handler den Worker beendet, wenn die Quelle
/// weg ist — einzige Erzeugungsstelle des Markers.
pub(crate) fn source_closed_err() -> anyhow::Error {
    anyhow!("{SOURCE_CLOSED_MARKER}")
}

/// In welchem Bildformat aufgenommen wird — **die eine Stelle**, an der das
/// steht.
///
/// Drei Werte, die zueinander passen MÜSSEN und die drei verschiedene APIs
/// verlangen: WGCs `ColorFormat`, das Pool-Format für libavutil und das
/// DXGI-Format für die schwarze Ersatztextur. Sie standen hier zwischenzeitlich
/// an drei Stellen — und ein Auseinanderlaufen fällt nicht als Fehler auf,
/// sondern als schwarzes Bild: `CopySubresourceRegion` zwischen zwei
/// verschiedenen Formaten ist im Release-Build ein wortloses No-Op.
///
/// * **SDR** — `Bgra8`, 4 Byte je Bildpunkt, wie seit jeher.
/// * **HDR** — `Rgba16F`, 8 Byte je Bildpunkt, Werte in scRGB (lineares Licht,
///   BT.709-Primärvalenzen, 1,0 = SDR-Weiß). Begründung, warum es nicht ohne
///   geht, an [`wgc::CaptureConfig::hdr`].
pub(crate) fn bildformat(
    hdr: bool,
) -> (
    windows_capture::settings::ColorFormat,
    ffmpeg_next::ffi::AVPixelFormat,
    windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
) {
    use ffmpeg_next::ffi::AVPixelFormat;
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R16G16B16A16_FLOAT;
    use windows_capture::settings::ColorFormat;
    if hdr {
        (
            ColorFormat::Rgba16F,
            // `AV_PIX_FMT_RGBAF16` heisst in FFmpegs Kopfdateien nur so, wenn
            // man die Maschine schon kennt — es ist ein Alias auf die Fassung
            // der eigenen Bytereihenfolge und existiert in den erzeugten
            // Rust-Bindungen deshalb gar nicht. Windows ist immer
            // little-endian; die Wahl ist damit keine, sondern eine
            // Feststellung.
            AVPixelFormat::AV_PIX_FMT_RGBAF16LE,
            DXGI_FORMAT_R16G16B16A16_FLOAT,
        )
    } else {
        (
            ColorFormat::Bgra8,
            AVPixelFormat::AV_PIX_FMT_BGRA,
            DXGI_FORMAT_B8G8R8A8_UNORM,
        )
    }
}

/// Schwarze BGRA-Textur in Capture-Größe — Ersatz-Quelltextur für den
/// Privacy-Mask-Pfad (`source::SourceGuard`): ist das ursprünglich gewählte
/// Fenster minimiert/geschlossen, kopieren die GPU-Pfade statt der WGC-Frame
/// diese Textur in den Encoder-Pool. So fließen weiter Frames (Stream bleibt
/// live, geht auch live, wenn der User beim Start noch in Pulse ist und das
/// Spiel deshalb minimiert ist) — nur eben schwarz statt Desktop.
///
/// Einmal pro Session erzeugt (Default-Usage, nie beschrieben); zeroed BGRA
/// = Schwarz nach jeder NV12-Konversion (Alpha wird überall verworfen).
///
/// **Das Format folgt der Aufnahme** (`hdr`), es ist also nicht immer BGRA.
/// Genullte 16-Bit-Fließkommawerte sind ebenfalls Schwarz — in scRGB ist 0,0
/// kein Licht, genau wie in BGRA. Nur die Bytebreite unterscheidet sich, und
/// die muss stimmen: eine BGRA-Ersatztextur in einen Fließkomma-Pool zu
/// kopieren wäre der wortlose No-Op aus [`bildformat`], und die Privacy-Maske
/// zeigte dann statt Schwarz das letzte Bild — also genau den Desktop, den sie
/// verbergen soll.
pub(crate) fn black_bgra_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    hdr: bool,
) -> Result<ID3D11Texture2D> {
    let (_, _, dxgi_format) = bildformat(hdr);
    let bytes_je_punkt: u32 = if hdr { 8 } else { 4 };
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: dxgi_format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let zeros = vec![0u8; width as usize * height as usize * bytes_je_punkt as usize];
    let init = D3D11_SUBRESOURCE_DATA {
        pSysMem: zeros.as_ptr() as *const _,
        SysMemPitch: width * bytes_je_punkt,
        SysMemSlicePitch: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut tex)) }
        .context("CreateTexture2D(black mask)")?;
    tex.ok_or_else(|| anyhow!("Black-Mask-Textur NULL"))
}

/// Zeitlimit fürs Joinen eines Capture-Workers beim Stoppen.
const JOIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Capture-Worker auslaufen lassen — mit Zeitlimit, danach **detachen**.
///
/// Der Worker sieht sein Stop-Signal nur in `on_frame_arrived`. Liefert WGC nie
/// einen Frame (totes oder minimiertes Target, verweigerte Permission,
/// HDR-Edge-Case), kommt der Callback nie dran und ein unbegrenztes `join()`
/// wartet für immer. Das traf ausgerechnet den Fehlerpfad: die Pipelines geben
/// nach 5 s ohne ersten Frame auf und droppen die Capture — der Drop blockierte
/// dann genau in der Situation, die der Timeout eigentlich melden soll, und die
/// fertige Fehlermeldung erreichte den Renderer nie.
///
/// Nach Ablauf lassen wir den Thread laufen: der Per-Stream-Sidecar endet
/// ohnehin gleich, `ExitProcess` räumt ihn ab (gleiche Überlegung wie der
/// bewusst unterlassene Teardown in `pipeline_hw::run`).
pub(crate) fn join_or_detach(handle: std::thread::JoinHandle<Result<(), String>>, label: &str) {
    let _ = join_result_or_detach(handle, label);
}

/// Wie `join_or_detach`, liefert aber das Worker-Ergebnis: `Some(msg)` bei
/// Fehler/Panic, `None` bei cleanem Exit ODER wenn der Join ins Zeitlimit
/// läuft (dann ist die Fehlerursache nicht abholbar — der Timeout-Fall wird
/// geloggt). Basis der `join_error()`-Methoden der drei Capture-Structs: die
/// werden aus den Pipeline-Fehlerpfaden gerufen, und ein unbegrenztes `join()`
/// dort würde exakt den Hänger wieder einbauen, den das Zeitlimit oben
/// verhindern soll — die Pipeline bliebe mitten im Fehlerpfad stecken und das
/// `error`-Event erreichte den Renderer nie.
pub(crate) fn join_result_or_detach(
    handle: std::thread::JoinHandle<Result<(), String>>,
    label: &str,
) -> Option<String> {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    if std::thread::Builder::new()
        .name("capture-joiner".into())
        .spawn(move || {
            let result = match handle.join() {
                Ok(Ok(())) => None,
                Ok(Err(s)) => Some(s),
                Err(_) => Some("capture thread panicked".into()),
            };
            let _ = done_tx.send(result);
        })
        .is_err()
    {
        // Kein Thread frei — nicht warten. `handle` ist mit der Closure
        // gedroppt, der Worker läuft damit detached weiter.
        return None;
    }
    match done_rx.recv_timeout(JOIN_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            eprintln!("[capture] {label}: Worker nach {JOIN_TIMEOUT:?} nicht beendet — detached");
            None
        }
    }
}

/// Haengt einen optionalen Worker-Fehlertext an eine Fehlermeldung an: `":
/// <text>"` wenn vorhanden, sonst `" (<fallback>)"`. Zusammengezogen aus
/// sechs wortgleichen Vorkommen in den drei Pipelines (`pipeline_hw`,
/// `pipeline_d3d12`, `stream_controller::cpu_pipeline`) — jede ruft beim
/// Scheitern des Capture-Kanals `join_error()` und haengt das Ergebnis so an
/// ihre jeweilige Fehlermeldung an.
pub(crate) fn worker_err_suffix(worker_err: Option<String>, fallback: &str) -> String {
    worker_err
        .map(|s| format!(": {s}"))
        .unwrap_or_else(|| format!(" ({fallback})"))
}

/// Hat `GraphicsCaptureSession` auf DIESEM Windows die Property?
///
/// Die Settings-Enums der Crate sind nicht abwärtskompatibel: jedes
/// Nicht-`Default` fasst die Session-Property an, und die Crate bricht hart ab,
/// wenn das OS sie nicht kennt. `IsBorderRequired` gibt es erst ab Build
/// 20348/Win11 — Windows-10-Clients starben deshalb VOR dem ersten Frame mit
/// "Toggling the capture border is not supported …" (Support-Fall 2026-07-20,
/// RTX-2080-User; die GPU war unbeteiligt). Fehlt die Property, degradieren
/// die Helfer unten auf `Default` (= Property gar nicht anfassen).
fn session_has(prop: &str) -> bool {
    ApiInformation::IsPropertyPresent(
        &HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
        &HSTRING::from(prop),
    )
    .unwrap_or(false)
}

/// Cursor an/aus. `IsCursorCaptureEnabled` gibt es seit Win10 1903 (= WGC-
/// Minimum) — der Guard ist reine Vorsicht, gleiche Bauart wie beim Border.
pub(crate) fn cursor_settings(include_cursor: bool) -> CursorCaptureSettings {
    if !session_has("IsCursorCaptureEnabled") {
        eprintln!("[capture] IsCursorCaptureEnabled fehlt auf diesem Windows — Cursor-Einstellung ignoriert");
        return CursorCaptureSettings::Default;
    }
    if include_cursor {
        CursorCaptureSettings::WithCursor
    } else {
        CursorCaptureSettings::WithoutCursor
    }
}

/// Gelber Capture-Rahmen an/aus. Auf Windows 10 existiert der Rahmen gar
/// nicht — `Default` ist dort verlustfrei identisch mit "aus".
pub(crate) fn border_settings(draw_border: bool) -> DrawBorderSettings {
    if !session_has("IsBorderRequired") {
        eprintln!("[capture] IsBorderRequired fehlt auf diesem Windows (10?) — Border-Einstellung ignoriert");
        return DrawBorderSettings::Default;
    }
    if draw_border {
        DrawBorderSettings::WithBorder
    } else {
        DrawBorderSettings::WithoutBorder
    }
}

/// Frame-Takt-Deckel der Capture. `MinUpdateInterval` gibt es erst ab Win11
/// 24H2 (Build 26100) — davor liefert WGC ungedrosselt und der Pacing-Loop
/// taktet selbst (das Intervall ist eine Optimierung, keine Korrektheit).
pub(crate) fn min_interval_settings(max_fps: u32) -> MinimumUpdateIntervalSettings {
    // Defensiv: 1.0/max_fps würde bei 0 als Duration::from_secs_f64(inf) panicken.
    // Die eigentliche Validierung passiert beim Parsen der CLI-Args — dieser
    // Helfer darf trotzdem nie selbst abstürzen.
    if max_fps == 0 {
        return MinimumUpdateIntervalSettings::Default;
    }
    // **Hier stand bis 2026-08-05 eine Ausnahme fuer `max_fps == 60`**, die die
    // Drosselung ganz abschaltete. Sie kam aus dem Win10-Kompatibilitaets-Commit
    // `348fd8cd`, dessen Begruendung `MinUpdateInterval` als etwas beschreibt,
    // das "Streams mit reduzierter fps" betreffe. Dahinter steckt die Annahme,
    // bei 60 gebe es nichts zu drosseln — und die gilt nur, wenn der Bildschirm
    // hoechstens 60 Hz laeuft. WGC liefert ohne Deckel mit der
    // WIEDERHOLRATE DES SCHIRMS, nicht mit der Zielbildrate.
    //
    // Auf einem 280-Hz-Schirm (am 2026-08-05 auf der Entwicklungsmaschine
    // gemessen: primaer 280 Hz, daneben zweimal 144) holt der Encode-Takt damit
    // rund viereinhalb Bilder je Takt ab und wirft dreieinhalb davon weg. Die
    // Verwuerfe erscheinen in KEINEM Zaehler: `capture_drops` kennt nur
    // Pool-Erschoepfung und Rueckstau. Bezahlt werden sie trotzdem — in
    // Kopien ueber den geteilten D3D11-Immediate-Context, also genau auf dem
    // Weg, der auch die Bildgleichmaessigkeit traegt.
    //
    // **Was das NICHT behebt:** das vom Nutzer berichtete Ruckeln. Ein Test mit
    // dem Schirm auf 60 Hz (also derselbe Effekt von Hand hergestellt) aenderte
    // am 2026-08-05 nichts. Diese Aenderung ist Sparsamkeit und ehrliche
    // Inhaltszeit, nicht die Ruckel-Ursache.
    if !session_has("MinUpdateInterval") {
        eprintln!("[capture] MinUpdateInterval fehlt auf diesem Windows (< 24H2) — Capture ungedrosselt, Pacing-Loop taktet");
        return MinimumUpdateIntervalSettings::Default;
    }
    // Deckel = 1/fps, ABER mit einem Zehntel Sicherheitsabstand.
    //
    // Der Abstand ist noetig, sobald Zielbildrate und Wiederholrate
    // zusammenfallen (60 auf 60 Hz): traefe der Deckel den Bildabstand exakt,
    // wuerde ein Bild, das eine Haarspitze zu frueh kommt, unterdrueckt — aus
    // 60 wuerden 59 mit einem sichtbaren Aussetzer je Sekunde. Das ist der
    // Grund, warum die Ausnahme oben ueberhaupt plausibel wirkte; sie hat das
    // Problem nur mit dem Holzhammer geloest.
    //
    // Bei 60 sind das 15,0 ms statt 16,7 — der Schirm mit 280 Hz kommt damit
    // auf hoechstens ~66 Bilder je Sekunde statt 280, und ein 60-Hz-Schirm
    // verliert keines. Fuer reduzierte Bildraten aendert der Abstand praktisch
    // nichts (30 fps: 30,0 statt 33,3 ms, die Quelle liefert dort ohnehin
    // seltener).
    let deckel = 0.9 / max_fps as f64;
    MinimumUpdateIntervalSettings::Custom(std::time::Duration::from_secs_f64(deckel))
}
