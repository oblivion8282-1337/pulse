//! Fragt den TREIBER, welche Codecs die Video-Engine dieser GPU kodieren kann —
//! über die D3D12-Fähigkeitsabfrage, ohne eine Encoder-Sitzung zu öffnen.
//!
//! **Wofür das da ist.** `codec_probe` hat für AMD und Intel eine feste Liste
//! `[h264, hevc, av1]` gemeldet, und für AMD ist die seit jeher falsch: AV1
//! kodiert dort erst RDNA 3 (RX 7000). Auf einer Radeon RX 570 (Polaris, VCE
//! 3.4) bot die Oberfläche AV1 also an, der Start scheiterte am nicht
//! vorhandenen `av1_amf` — und der Rückfall danach lief auf einen Weg, der den
//! angemeldeten WHIP-Sendeweg nicht bedienen kann, sodass der Nutzer statt
//! einer Codec-Meldung „dieser Encode-Weg kann den angemeldeten Sendeweg nicht
//! bedienen" las (2026-08-21 gemeldet). Der Rückfall ist getrennt repariert
//! (`encode::bildencoder::baue_mit_rueckfall`); hier steht die Antwort auf die
//! eigentliche Frage.
//!
//! **Warum eine D3D12-Abfrage und nicht die Open-Probe aus `codec_probe`.**
//! Genau die gab es hier schon einmal, und sie wurde ausgebaut: `*_amf`/`*_qsv`
//! öffneten treiberseitig unzuverlässig für HEVC und AV1, obwohl die
//! Laufzeitwege beide Codecs encodieren — Nutzer sahen nur noch H.264. Die
//! Ursache ist nie geklärt worden. Diese Abfrage öffnet gar nichts: sie fragt
//! den Treiber nach einer Eigenschaft, keine Sitzung, keine AMF-Laufzeit, kein
//! Zustand, der schiefgehen könnte. Damit fällt der Grund für die damalige
//! Rücknahme weg, statt bloß umgangen zu werden.
//!
//! **Dass der Laufzeitweg AMF ist und nicht D3D12, spielt keine Rolle.**
//! Gefragt wird nach der Video-Engine des Chips, nicht nach einer API: eine
//! Karte ohne AV1-Engine meldet über beide Wege kein AV1, und eine mit
//! AV1-Engine über beide Wege AV1. Der Umkehrschluss („D3D12 sagt ja, also
//! nimm den D3D12-Encoder") wird hier ausdrücklich NICHT gezogen — `av1_d3d12va`
//! liefert auf AMD einen unbrauchbaren Bitstrom (Messung in `pipeline_d3d12::run`),
//! und die Wegwahl bleibt allein bei `encode::VideoCodec::encode_path`.
//!
//! **Vorwärtskompatibel, keine Generationstabelle.** Jede künftige Architektur
//! wird ohne Codepflege richtig erkannt — dieselbe Eigenschaft, wegen der
//! NVIDIA auf seiner Open-Probe steht.
//!
//! **NVIDIA bleibt bei der Open-Probe.** Sie ist dort gegen echte Hardware
//! belegt (der Turing-AV1-Fehlbefund war der Anlass), und ein Wechsel auf diese
//! Abfrage wäre eine Änderung ohne Beschwerde dahinter. Wer sie später
//! vereinheitlichen will, misst das auf einer Karte ohne AV1 (RTX 20) gegen —
//! die Frage ist offen, nicht entschieden.

use anyhow::{Context, Result, anyhow};
use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
use windows::Win32::Graphics::Direct3D12::{D3D12CreateDevice, ID3D12Device};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1, IDXGIFactory1,
};
use windows::Win32::Media::MediaFoundation::{
    D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC, D3D12_FEATURE_VIDEO_ENCODER_CODEC,
    D3D12_VIDEO_ENCODER_CODEC, D3D12_VIDEO_ENCODER_CODEC_AV1, D3D12_VIDEO_ENCODER_CODEC_HEVC,
    ID3D12VideoDevice,
};
use windows::core::Interface;

use super::dxgi::Adapter;

/// Die Codecs, die der Treiber für diese GPU als encodierbar meldet.
///
/// **H.264 steht unbedingt drin**, wie in `codec_probe::probe_inner`: es ist die
/// Grundlinie jeder Hardware, die diesen Sidecar überhaupt trägt, und eine
/// Antwort ohne H.264 wäre keine Einschränkung, sondern ein Nutzer ohne
/// Streaming. Abgefragt werden nur HEVC und AV1 — die beiden, bei denen sich
/// Generationen unterscheiden.
pub fn kodierbare_codecs(adapter: &Adapter) -> Result<Vec<String>> {
    let video = video_device(adapter)?;
    let mut codecs = vec!["h264".to_string()];
    for (codec, label) in [
        (D3D12_VIDEO_ENCODER_CODEC_HEVC, "hevc"),
        (D3D12_VIDEO_ENCODER_CODEC_AV1, "av1"),
    ] {
        if traegt(&video, codec) {
            codecs.push(label.to_string());
        } else {
            eprintln!(
                "[encode-caps] {label}: der Treiber meldet keine Encoder-Unterstützung — \
                 wird nicht angeboten"
            );
        }
    }
    Ok(codecs)
}

/// Dieselbe Frage für eine rohe Kennziffer — nur für `examples/probe_encode_caps`.
///
/// Existiert, damit sich das Prüfwerkzeug vergewissern kann, dass die Abfrage
/// auch **Nein** sagt: eine Karte, die alles kodiert, belegt sonst nur, dass
/// dreimal „ja" herauskommt, und das täte eine Abfrage mit falscher
/// Struktur-Größe womöglich auch.
pub fn traegt_kennziffer(adapter: &Adapter, kennziffer: i32) -> Result<bool> {
    Ok(traegt(
        &video_device(adapter)?,
        D3D12_VIDEO_ENCODER_CODEC(kennziffer),
    ))
}

/// Meldet der Treiber Encoder-Unterstützung für diesen Codec?
///
/// **Ein Fehlschlag zählt als Nein, nicht als Ausnahme.** Eine Laufzeit, die die
/// Kennziffer gar nicht kennt, antwortet mit `E_INVALIDARG` — und eine Windows-
/// Fassung, die die AV1-Kennziffer nicht kennt, läuft auch auf keiner Karte, die
/// AV1 kodiert. Ein Nein ist dort die richtige Antwort und kein Notbehelf.
fn traegt(video: &ID3D12VideoDevice, codec: D3D12_VIDEO_ENCODER_CODEC) -> bool {
    let mut daten = D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC {
        // Knoten 0: Multi-Adapter-Knoten (Crossfire/SLI) fasst D3D12 als ein
        // Gerät zusammen; die Video-Engine hängt am ersten.
        NodeIndex: 0,
        Codec: codec,
        IsSupported: false.into(),
    };
    // SAFETY: `daten` liegt auf dem Stack dieser Funktion, ist `#[repr(C)]` und
    // lebt über den Aufruf hinaus; die übergebene Größe stammt vom selben Wert.
    // Der Aufruf schreibt nur `IsSupported`.
    let ergebnis = unsafe {
        video.CheckFeatureSupport(
            D3D12_FEATURE_VIDEO_ENCODER_CODEC,
            (&raw mut daten).cast(),
            size_of_val(&daten) as u32,
        )
    };
    match ergebnis {
        Ok(()) => daten.IsSupported.as_bool(),
        Err(e) => {
            eprintln!("[encode-caps] CheckFeatureSupport({codec:?}) fehlgeschlagen: {e}");
            false
        }
    }
}

/// Das `ID3D12VideoDevice` **dieses** Adapters.
///
/// Der Adapter wird neu enumeriert statt durchgereicht: [`Adapter`] ist ein
/// JSON-fähiges Profil ohne COM-Zeiger, und ihn darum aufzubohren hieße, jeden
/// Träger dieses Typs an eine COM-Lebensdauer zu binden. Gesucht wird über
/// dasselbe Paar (Hersteller, Gerät), mit dem `dxgi::list_adapters` schon seine
/// Dubletten zusammenfasst — auf einen anderen Adapter kann das also nicht
/// zeigen.
fn video_device(adapter: &Adapter) -> Result<ID3D12VideoDevice> {
    let dxgi = finde_adapter(adapter.vendor_id, adapter.device_id)?;
    let mut device: Option<ID3D12Device> = None;
    // SAFETY: `dxgi` ist ein gültiger Adapter aus der Enumeration; `device` ist
    // ein gültiges Ziel, das der Aufruf setzt.
    unsafe { D3D12CreateDevice(&dxgi, D3D_FEATURE_LEVEL_11_0, &mut device) }
        .context("D3D12CreateDevice")?;
    let device = device.ok_or_else(|| anyhow!("D3D12CreateDevice lieferte kein Geraet"))?;
    device
        .cast::<ID3D12VideoDevice>()
        .context("ID3D12VideoDevice (Treiber ohne D3D12-Video)")
}

fn finde_adapter(vendor_id: u32, device_id: u32) -> Result<IDXGIAdapter1> {
    // SAFETY: Fabrik-Erzeugung ohne Vorbedingung; DXGI ist nicht COM-init-pflichtig
    // (gleiche Begründung wie in `dxgi::list_adapters`).
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.context("CreateDXGIFactory1")?;
    let mut idx = 0u32;
    loop {
        // SAFETY: `idx` zählt hoch, bis DXGI mit `NOT_FOUND` abbricht.
        let adapter = match unsafe { factory.EnumAdapters1(idx) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => {
                return Err(anyhow!(
                    "Adapter {vendor_id:#06X}:{device_id:#06X} in der DXGI-Enumeration nicht gefunden"
                ));
            }
            Err(e) => return Err(anyhow!("EnumAdapters1: {e}")),
        };
        idx += 1;
        // SAFETY: `adapter` stammt aus der Enumeration und lebt bis zum Ende
        // dieses Durchlaufs.
        let desc = unsafe { adapter.GetDesc1() }.context("GetDesc1")?;
        if desc.VendorId == vendor_id && desc.DeviceId == device_id {
            return Ok(adapter);
        }
    }
}
