//! DXGI-Adapter-Enumeration.
//!
//! Liefert die GPU-Liste in HIGH_PERFORMANCE-Reihenfolge (IDXGIFactory6, Win10
//! 1803+); fällt sonst auf `IDXGIFactory1::EnumAdapters1` zurück. Vendor-IDs:
//! NVIDIA `0x10DE`, AMD `0x1002`, Intel `0x8086` — Rest „other".
//!
//! Wird von `health` + `gpu_info` gelesen (Stage 2). In Stage 5 (capture)
//! brauchen wir denselben Adapter-Pointer als D3D11Device-Quelle, damit
//! Capture und Encode auf derselben GPU laufen (Optimus-Fix).

use anyhow::{Context, Result};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_DESC1, DXGI_ERROR_NOT_FOUND,
    DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IDXGIAdapter1, IDXGIFactory1, IDXGIFactory6,
};
use windows::core::Interface;

/// Vendor-Slug einer GPU-Vendor-ID. Die EINE Tabelle im Crate — sie stand
/// zwischenzeitlich an vier Stellen (hier, `pipeline_hw`, `encode/hwctx`,
/// `encode/encoder_d3d12`), und eine Vendor-Zuordnung, die auseinanderlaufen
/// kann, ist genau die Art Fehler, die man erst am kaputten Bild bemerkt.
/// `None` = unbekannter Hersteller.
pub fn vendor_slug(vendor_id: u32) -> Option<&'static str> {
    match vendor_id {
        0x10DE => Some("nvidia"),
        0x1002 => Some("amd"),
        0x8086 => Some("intel"),
        _ => None,
    }
}

/// Vendor-Slug der GPU hinter einem **D3D11-Device** — via
/// `IDXGIDevice::GetAdapter`.
///
/// Maßgeblich ist die GPU, auf der WGC sein Device gebaut hat — der Encoder
/// muss zu ihr passen, nicht zu einer Liste.
///
/// **Seit dem 2026-08-17 sollte das dieselbe sein wie die aus
/// `select_adapter()`**: die Aufnahme bekommt ihr Gerät jetzt vorgegeben
/// (`capture::auf_gpu`). Vorher liefen die beiden auf Rechnern mit zwei Karten
/// auseinander, und diese Funktion war die einzige Stelle, die die Wahrheit
/// kannte. Sie bleibt die Gegenprobe: dass WGC auf einer Karte aufnimmt, die
/// keinen Bildschirm versorgt, ist vorgesehen, aber nirgends zugesagt.
///
/// `None` wenn die Abfrage fehlschlägt oder der Vendor unbekannt ist.
pub fn device_vendor(
    device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
) -> Option<&'static str> {
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    let dxgi: IDXGIDevice = device.cast().ok()?;
    let adapter = unsafe { dxgi.GetAdapter() }.ok()?;
    let desc = unsafe { adapter.GetDesc() }.ok()?;
    vendor_slug(desc.VendorId)
}

/// Knappes Adapter-Profil, JSON-serialisierbar.
#[derive(Debug, Clone)]
pub struct Adapter {
    pub description: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub vram_mb: u64,
}

impl Adapter {
    /// Vendor-Slug für die JSON-Response (`"nvidia"`/`"amd"`/`"intel"`/`"other"`).
    pub fn vendor(&self) -> &'static str {
        vendor_slug(self.vendor_id).unwrap_or("other")
    }

    /// Encoder-Codecs die die GPU in Hardware wirklich unterstützt (FFmpeg-Codec-
    /// Namen). Echte Open-Probe — siehe `codec_probe`. Selbst-korrigierend und
    /// vorwärtskompatibel: meldet AV1 erst ab Ada (RTX 40+) / RDNA3 / Intel Arc,
    /// und erkennt künftige Architekturen ohne Tabellenpflege.
    pub fn supported_video_codecs(&self) -> Vec<String> {
        super::codec_probe::supported_video_codecs(self)
    }

    /// Beschreibung dieser Karte für die Auswahlregel (`system::gpu_wahl`).
    pub fn karte(&self) -> super::gpu_wahl::Karte {
        super::gpu_wahl::Karte {
            beschreibung: self.description.clone(),
            vendor_id: self.vendor_id,
            device_id: self.device_id,
            vendor: self.vendor().to_string(),
            vram_mb: self.vram_mb,
        }
    }
}

/// Enumeriert alle Hardware-Adapter (Software-Treiber wie WARP überspringen wir
/// per Flag-Check). HIGH_PERFORMANCE-Reihenfolge wenn IDXGIFactory6 verfügbar.
///
/// Dedup-Hinweis: NVIDIA-Optimus-Treiber listen die dGPU manchmal zweimal (einmal
/// als physisches Device, einmal als virtuellen Optimus-Bridge). LUID ist pro
/// Adapter eindeutig — wir filtern Dubletten darüber raus.
pub fn list_adapters() -> Result<Vec<Adapter>> {
    // Reihenfolge, Software-Filter und Dedup stecken in `enumerieren` — dieselbe
    // Aufzählung, die `geraet_auf_karte` benutzt, um eine gewählte Karte
    // wiederzufinden. Zwei eigene Schleifen wären zwei Reihenfolgen, und eine
    // Auswahl, die auf der einen getroffen und auf der anderen aufgelöst wird,
    // trifft irgendwann die falsche Karte.
    enumerieren(|_adapter, desc| {
        Some(Adapter {
            description: utf16_to_string(&desc.Description),
            vendor_id: desc.VendorId,
            device_id: desc.DeviceId,
            vram_mb: (desc.DedicatedVideoMemory / (1024 * 1024)) as u64,
        })
    })
}

/// Steht die Liste aus [`list_adapters`] in **Windows' Leistungsreihenfolge**?
///
/// `IDXGIFactory6::EnumAdapterByGpuPreference(HIGH_PERFORMANCE)` ist Microsofts
/// eigene Antwort auf „eingesteckte Karte vor eingebauter Grafik" und seit
/// Windows 10 1803 da. Fehlt sie, fällt [`list_adapters`] auf `EnumAdapters1`
/// zurück — **dort ist die Reihenfolge nicht nach Leistung geordnet**, und
/// `system::gpu_wahl` muss sich dann an etwas anderem festhalten.
///
/// Eigene Funktion statt eines Rückgabewerts an `list_adapters`, weil sonst
/// drei Aufrufer ein Feld mitschleppen müssten, das nur einen von ihnen
/// angeht. Der zweite Factory-Aufruf kostet nichts Messbares.
pub fn sortiert_nach_leistung() -> bool {
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return false;
    };
    factory.cast::<IDXGIFactory6>().is_ok()
}

/// Der Adapter, den ein Start **ohne Einstellung** bekäme.
///
/// Klammert die drei Schritte zusammen, die `health` und `gpu_info` sonst je
/// für sich ausschreiben: Karten beschreiben, `system::gpu_wahl` befragen, die
/// Antwort wieder auf den Adapter zurückführen. Zwei Abschriften derselben
/// Kette wären zwei Stellen, an denen „welche Karte melden wir" auseinander
/// laufen kann — und beide melden dem Renderer Hersteller und Codec-Angebot,
/// also genau das, woran er die Auswahl seiner Codecs aufhängt.
///
/// `traegt_schnellen_weg` kommt vom Aufrufer
/// (`encode::vendor_traegt_zero_copy`), damit dieses Modul FFmpeg-frei bleibt —
/// dieselbe Überlegung wie in `system::gpu_wahl`.
pub fn vorgabe_adapter(
    adapters: &[Adapter],
    traegt_schnellen_weg: impl Fn(&str) -> bool,
) -> Option<&Adapter> {
    let karten: Vec<_> = adapters.iter().map(Adapter::karte).collect();
    let wahl = super::gpu_wahl::vorgabe(&karten, traegt_schnellen_weg, sortiert_nach_leistung())?;
    adapters
        .iter()
        .find(|a| a.vendor_id == wahl.vendor_id && a.device_id == wahl.device_id)
}

/// Ein **D3D11-Gerät auf einer bestimmten Karte**.
///
/// Das ist der Hebel, um den es in `system::gpu_wahl` geht: `windows-capture`
/// baut sein Gerät sonst mit `D3D11CreateDevice(None, …)`, und dann entscheidet
/// Windows, welche Karte aufnimmt — auf Rechnern mit eingebauter und
/// eingesteckter Grafik oft die eingebaute. Das hier erzeugte Gerät reicht
/// `capture::wgc*` in die Aufnahme hinein (Pulse-Patch `0002` an der Crate),
/// und weil `pipeline_hw` den Hersteller aus genau diesem Gerät liest, folgt
/// der ganze Encode-Weg der Wahl von selbst.
///
/// **`D3D_DRIVER_TYPE_UNKNOWN` ist bei nicht-leerem Adapter Pflicht**, nicht
/// Geschmackssache: `D3D11CreateDevice` beantwortet die Kombination aus einem
/// gesetzten Adapter und `D3D_DRIVER_TYPE_HARDWARE` mit `E_INVALIDARG`. Der
/// Treibertyp steckt dann bereits im Adapter.
///
/// `D3D11_CREATE_DEVICE_BGRA_SUPPORT` muss mit, sonst nimmt WGC das Gerät nicht
/// an — dieselbe Flagge, die die Crate im eigenen Pfad setzt.
pub fn geraet_auf_karte(
    vendor_id: u32,
    device_id: u32,
) -> Result<(
    windows::Win32::Graphics::Direct3D11::ID3D11Device,
    windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
)> {
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice,
    };

    let adapter = enumerieren(|adapter, desc| {
        (desc.VendorId == vendor_id && desc.DeviceId == device_id).then(|| adapter.clone())
    })?
    .into_iter()
    .next()
    .ok_or_else(|| {
        anyhow::anyhow!("keine GPU mit vendor_id=0x{vendor_id:04X} device_id=0x{device_id:04X}")
    })?;

    // Nur 11_1 und 11_0 — die Crate reicht bis 9_1 hinunter und lehnt danach
    // alles unter 11_0 wieder ab. Was sie am Ende verwirft, muss hier gar nicht
    // erst entstehen.
    let stufen = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
    let mut device = None;
    let mut stufe = D3D_FEATURE_LEVEL::default();
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&stufen),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut stufe),
            Some(&mut context),
        )
    }
    .context("D3D11CreateDevice auf der gewählten GPU")?;

    match (device, context) {
        (Some(d), Some(c)) => Ok((d, c)),
        _ => Err(anyhow::anyhow!(
            "D3D11CreateDevice meldete Erfolg, gab aber kein Gerät heraus"
        )),
    }
}

/// Die eine Adapter-Aufzählung: Reihenfolge, Software-Filter, Dedup.
///
/// `abbilden` bekommt jeden durchgelassenen Adapter samt Beschreibung und gibt
/// zurück, was der Aufrufer davon braucht — `None` überspringt ihn, ohne den
/// Dedup-Zustand zu stören.
fn enumerieren<T>(
    mut abbilden: impl FnMut(&IDXGIAdapter1, &DXGI_ADAPTER_DESC1) -> Option<T>,
) -> Result<Vec<T>> {
    // CoInitialize ist hier nicht zwingend — DXGI ist nicht COM-init-pflichtig,
    // im Gegensatz zu WASAPI. Wir lassen's weg um keine Apartment-Konflikte
    // mit dem `wasapi`-Pfad zu provozieren (der initialisiert MTA selbst).

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.context("CreateDXGIFactory1")?;

    // IDXGIFactory6 ist seit Win10 1803 da. Wenn das Cast fehlschlägt fallen wir
    // auf EnumAdapters1 zurück (z.B. auf älteren Windows Server-Images).
    let factory6: Option<IDXGIFactory6> = factory.cast::<IDXGIFactory6>().ok();

    let mut out = Vec::new();
    // Dedup nach (vendor_id, device_id) — robuster als LUID, weil NVIDIAs
    // Treiber denselben physischen RTX-Adapter mit unterschiedlichen LUIDs
    // exponiert (einer pro WDDM-Engine-Pfad, gesehen 2026-05-19 auf RTX 4090).
    let mut seen: std::collections::BTreeSet<(u32, u32)> = std::collections::BTreeSet::new();
    let mut idx: u32 = 0;
    loop {
        let adapter: Result<IDXGIAdapter1, windows::core::Error> = unsafe {
            if let Some(f6) = &factory6 {
                f6.EnumAdapterByGpuPreference(idx, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)
            } else {
                factory.EnumAdapters1(idx)
            }
        };
        let adapter = match adapter {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(anyhow::anyhow!("EnumAdapter failed: {e}")),
        };

        let desc: DXGI_ADAPTER_DESC1 = unsafe { adapter.GetDesc1() }.context("GetDesc1")?;
        idx += 1;

        // Software-Renderer (z.B. Microsoft Basic Render Driver, WARP) ausblenden —
        // die kommen sonst als „Encoder verfügbar" durch und werfen erst beim
        // ersten Frame Fehler. Bit 0x2 (DXGI_ADAPTER_FLAG_SOFTWARE).
        if (desc.Flags & 0x2) != 0 {
            continue;
        }

        if !seen.insert((desc.VendorId, desc.DeviceId)) {
            // Sichtbar machen statt still verschlucken: bei zwei echten
            // physischen GPUs desselben Modells (nicht nur Optimus-Dubletten)
            // geht die zweite hier unter — im Diagnose-Log soll das auffallen.
            eprintln!(
                "[dxgi] Adapter übersprungen (Dedup nach vendor/device-id): {}",
                utf16_to_string(&desc.Description)
            );
            continue;
        }

        // Erst NACH dem Dedup abbilden: `abbilden` darf `None` sagen (der
        // Aufrufer sucht eine bestimmte Karte), und das ist etwas anderes als
        // „schon gesehen". Andersherum verlöre die Suche Karten, die ein
        // früherer Durchlauf bereits verworfen hat.
        if let Some(wert) = abbilden(&adapter, &desc) {
            out.push(wert);
        }
    }

    Ok(out)
}

/// `DXGI_ADAPTER_DESC1::Description` ist ein 128-char UTF-16-Buffer mit Nullterm.
fn utf16_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}
