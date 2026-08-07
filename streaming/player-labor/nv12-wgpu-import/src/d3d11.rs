//! Die Quelle: eine geteilte D3D11-Textur mit bekanntem Inhalt.
//!
//! Was daraus zurueckgelesen wird, steht in [`crate::rueckprobe`] — getrennt,
//! weil das Schreiben und das Nachpruefen zwei verschiedene Fragen sind und
//! beides zusammen ueber die Groessengrenze ginge.

use windows::core::Interface;
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_DECODER,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_WRITE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_WRITE, D3D11_RESOURCE_MISC_SHARED,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

use crate::bildformat::{chroma_codes, luma_code, Bildformat, BREITE, HOEHE};

pub struct D3d11Quelle {
    pub mit_mutex: bool,
    pub format: Bildformat,
    /// Schichten des Stapels — 1 heisst Einzeltextur, also der bisherige Fall.
    pub schichten: u32,
    pub(crate) device: ID3D11Device,
    pub(crate) context: ID3D11DeviceContext,
    pub(crate) textur: ID3D11Texture2D,
    pub handle: HANDLE,
    /// Aufgehoben fuer [`neu_fuellen`] — die Ablage muss dieselbe Bauart haben.
    desc: D3D11_TEXTURE2D_DESC,
}

/// Stufe 2: geteilte Textur in D3D11 anlegen und mit bekanntem Inhalt fuellen.
///
/// `SHARED_NTHANDLE` verlangt laut Doku die Paarung mit `SHARED_KEYEDMUTEX`;
/// beides zusammen ergibt das NT-Handle, das sowohl Vulkan (als
/// `D3D11_TEXTURE`-Handle-Typ) als auch D3D12 (`OpenSharedHandle`) erwarten.
///
/// **Fuer den D3D12-Weg ist der Mutex ohne Wirkung** — eine ueber
/// `OpenSharedHandle` geoeffnete Ressource stellt gar keinen `IDXGIKeyedMutex`
/// bereit (dieselbe Feststellung steht in
/// `streaming/win-hq-sidecar/src/capture/wgc_d3d12.rs`). Er erfuellt dort nur
/// die Erstellungs-Anforderung von D3D11 und klammert den D3D11-seitigen
/// Schreibvorgang.
///
/// `schichten > 1` legt einen Stapel an — die Form, in der ein
/// Hardware-Decoder seine Bilder liefert (eine Schicht je Bild). **Jede
/// Schicht bekommt einen anderen Inhalt**, sonst waere ein Weg, der immer
/// Schicht 0 liest, von einem richtigen nicht zu unterscheiden.
pub fn quelle(
    mit_mutex: bool,
    format: Bildformat,
    schichten: u32,
    decoder_flag: bool,
) -> Result<D3d11Quelle, String> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_1]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
    let device = device.ok_or("D3D11CreateDevice lieferte kein Geraet")?;
    let context = context.ok_or("D3D11CreateDevice lieferte keinen Kontext")?;

    let desc = D3D11_TEXTURE2D_DESC {
        Width: BREITE,
        Height: HOEHE,
        MipLevels: 1,
        ArraySize: schichten,
        Format: format.dxgi(),
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        // **Ein Stapel braucht zusaetzlich das Decoder-Flag.** Ohne es lehnt
        // D3D11 einen Video-Format-Stapel rundweg ab (`E_INVALIDARG`), mit ihm
        // gelingt er — geteilt wie ungeteilt (Halbierung im Fehlerpfad unten,
        // gemessen 2026-08-06 auf einer Radeon 780M). Eine Einzeltextur kommt
        // dagegen ohne aus; die Vorgabe laesst es dort deshalb weg, damit der
        // Fall mit den frueheren Messungen vergleichbar bleibt.
        //
        // `decoder_flag` erzwingt es auch bei einer Einzeltextur — und das ist
        // keine Spielerei, sondern der Fall des Players: libavutils
        // D3D11VA-Pool setzt `D3D11_BIND_DECODER` in JEDEM Fall, auch bei
        // `initial_pool_size = 0` (`hwcontext_d3d11va.c`, `d3d11va_frames_init`
        // legt den Deskriptor an, `d3d11va_alloc_single` benutzt genau ihn mit
        // `ArraySize = 1`). Ohne diesen Schalter liesse sich nicht trennen, ob
        // ein Fehlschlag am Stapel oder am Bindungsflag haengt.
        BindFlags: if schichten > 1 || decoder_flag {
            (D3D11_BIND_DECODER.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32
        } else {
            D3D11_BIND_SHADER_RESOURCE.0 as u32
        },
        CPUAccessFlags: 0,
        // Zwei Bauarten, weil zwei Ursachen fuer ein schwarzes Bild in Frage
        // kommen und sie sich sonst nicht trennen lassen:
        //   mit Mutex  — vorschriftsmaessig, aber die wgpu-Seite erwirbt ihn
        //                nie (wgpu kennt den Begriff nicht).
        //   ohne Mutex — schlichtes Teilen; faellt der Unterschied darauf,
        //                war der Mutex die Ursache, nicht die Bildlage.
        MiscFlags: if mit_mutex {
            (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32
        } else {
            (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED.0) as u32
        },
    };
    let mut textur: Option<ID3D11Texture2D> = None;
    if let Err(e) = unsafe { device.CreateTexture2D(&desc, None, Some(&mut textur)) } {
        return Err(halbierung(&device, &desc, format, schichten, &e.to_string()));
    }
    let textur = textur.ok_or("CreateTexture2D lieferte keine Textur")?;

    fuellen(&device, &context, &textur, &desc, format, schichten, mit_mutex, 0)?;

    let res: IDXGIResource1 = textur.cast().map_err(|e| format!("IDXGIResource1: {e}"))?;
    // 0x80000000 = GENERIC_READ, 1 = GENERIC_WRITE fuer geteilte DXGI-Ressourcen.
    let handle = unsafe { res.CreateSharedHandle(None, 0x8000_0000 | 1, None) }
        .map_err(|e| format!("CreateSharedHandle: {e}"))?;

    Ok(D3d11Quelle {
        mit_mutex,
        format,
        schichten,
        device,
        context,
        textur,
        handle,
        desc,
    })
}

/// Dieselbe Textur mit NEUEM Inhalt ueberschreiben — ueber D3D11, nachdem wgpu
/// sie bereits eingehaengt hat.
///
/// **Das ist der Betriebsfall, den die Probe bis zum 2026-08-06 nicht abbildete.**
/// Sie schrieb einmal und las danach nur; im Player schreibt der Decoder in
/// jedes Bild neu, waehrend die eingehaengte wgpu-Textur bestehen bleibt. Zwei
/// Dinge koennen dabei schiefgehen und sonst nirgends auffallen: der Import
/// haelt eine Momentaufnahme statt des lebenden Speichers (dann steht das erste
/// Bild fuer immer), oder D3D12 sieht die Aenderung erst mit Verzoegerung.
///
/// `variante` verschiebt den Inhalt, sodass jede Runde nachweislich anders ist.
pub fn neu_fuellen(q: &D3d11Quelle, variante: u32) -> Result<(), String> {
    fuellen(
        &q.device,
        &q.context,
        &q.textur,
        &q.desc,
        q.format,
        q.schichten,
        q.mit_mutex,
        variante,
    )
}

/// **Halbieren statt melden.** Ein `E_INVALIDARG` sagt nicht, WELCHER der acht
/// Werte im Deskriptor gemeint ist. Vier Varianten lassen je eine Erklaerung
/// uebrig; die dritte ist die wichtigste, denn **so legt libavutil seine
/// Decoder-Poolen an** (`DECODER|SHADER_RESOURCE`) — genau solche Stapel
/// bekaeme der Player. Ohne diese Unterscheidung stuende in der Messakte nur
/// „geht nicht", und der naechste Anlauf finge wieder bei null an.
fn halbierung(
    device: &ID3D11Device,
    desc: &D3D11_TEXTURE2D_DESC,
    format: Bildformat,
    schichten: u32,
    fehler: &str,
) -> String {
    let versuch = |name: &str, bind: u32, misc: u32| {
        let mut t: Option<ID3D11Texture2D> = None;
        let d = D3D11_TEXTURE2D_DESC { BindFlags: bind, MiscFlags: misc, ..*desc };
        let ok = unsafe { device.CreateTexture2D(&d, None, Some(&mut t)) }.is_ok();
        format!("\n    {name}: {}", if ok { "geht" } else { "geht nicht" })
    };
    let sr = D3D11_BIND_SHADER_RESOURCE.0 as u32;
    let dec = D3D11_BIND_DECODER.0 as u32;
    let mut befund = String::new();
    befund.push_str(&versuch("nur Shader-Ansicht, ungeteilt", sr, 0));
    befund.push_str(&versuch("Decoder + Shader-Ansicht, ungeteilt", dec | sr, 0));
    befund.push_str(&versuch("Decoder + Shader-Ansicht, geteilt", dec | sr, desc.MiscFlags));
    befund.push_str(&versuch("nur Decoder, ungeteilt", dec, 0));
    format!(
        "CreateTexture2D ({}, geteilt, {schichten} Schicht(en)): {fehler}\
         \n  Halbierung, welche Bauart dieser Treiber annimmt:{befund}",
        format.name()
    )
}

/// Fuellen ueber eine Ablage-Textur, NICHT ueber `pInitialData`.
///
/// Der erste Versuch reichte die Bilddaten beim Anlegen mit — und die
/// Rueckprobe fand die Textur komplett auf null. Fuer NV12 traegt der Weg ueber
/// Anfangsdaten hier also nicht (es gibt eine Ebene mit halber Hoehe hinter der
/// ersten; ein einzelner `SysMemPitch` beschreibt das nicht eindeutig). Ueber
/// `Map` steht der echte Zeilenabstand des Treibers zur Verfuegung, und der ist
/// bei 64 Punkten Breite bereits groesser als 64.
#[allow(clippy::too_many_arguments)]
fn fuellen(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    textur: &ID3D11Texture2D,
    desc: &D3D11_TEXTURE2D_DESC,
    format: Bildformat,
    schichten: u32,
    mit_mutex: bool,
    variante: u32,
) -> Result<(), String> {
    // **Einschichtig, auch wenn das Ziel ein Stapel ist** — Begruendung in
    // `ablage_mit_inhalt`.
    let ablage_desc = D3D11_TEXTURE2D_DESC {
        ArraySize: 1,
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
        MiscFlags: 0,
        ..*desc
    };
    let mut ablage: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&ablage_desc, None, Some(&mut ablage)) }
        .map_err(|e| format!("Ablage zum Fuellen: {e}"))?;
    let ablage = ablage.ok_or("Ablage fehlt")?;
    let (u_wert, v_wert) = chroma_codes(format);
    let b = format.bytes();
    let schreiben = |basis: *mut u8, versatz: usize, code: u32| unsafe {
        let w = format.gespeichert(code);
        match b {
            1 => *basis.add(versatz) = w as u8,
            _ => std::ptr::copy_nonoverlapping(w.to_le_bytes().as_ptr(), basis.add(versatz), 2),
        }
    };
    // **Das Erwerben des Schluessels steht VOR der Schleife**, nicht dahinter.
    // Beim ersten Anlauf lag es hinter dem Kopieren — die Textur blieb leer, und
    // zwar ohne jede Fehlermeldung: D3D11 verwirft die Arbeit still, wenn der
    // Aufrufer den Schluessel nicht haelt. Genau die Sorte Fehler, die man ohne
    // Rueckprobe der wgpu-Seite anlastet.
    let mutex: Option<IDXGIKeyedMutex> = if mit_mutex {
        Some(textur.cast().map_err(|e| format!("IDXGIKeyedMutex: {e}"))?)
    } else {
        None
    };
    if let Some(m) = &mutex {
        unsafe { m.AcquireSync(0, u32::MAX) }.map_err(|e| format!("AcquireSync: {e}"))?;
    }
    for schicht in 0..schichten {
        let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(&ablage, 0, D3D11_MAP_WRITE, 0, Some(&mut abbild)) }
            .map_err(|e| format!("Map zum Schreiben (Schicht {schicht}): {e}"))?;
        let pitch = abbild.RowPitch as usize;
        let basis = abbild.pData as *mut u8;
        for y in 0..HOEHE as usize {
            for x in 0..BREITE as usize {
                let code = luma_code(format, x as u32, y as u32, schicht + variante);
                schreiben(basis, y * pitch + x * b, code);
            }
        }
        let uv = pitch * HOEHE as usize;
        for zeile in 0..(HOEHE / 2) as usize {
            for spalte in 0..(BREITE / 2) as usize {
                let versatz = uv + zeile * pitch + spalte * 2 * b;
                schreiben(basis, versatz, u_wert);
                schreiben(basis, versatz + b, v_wert);
            }
        }
        unsafe { context.Unmap(&ablage, 0) };
        unsafe { context.CopySubresourceRegion(textur, schicht, 0, 0, 0, &ablage, 0, None) };
    }
    unsafe { context.Flush() };
    if let Some(m) = &mutex {
        unsafe { m.ReleaseSync(0) }.map_err(|e| format!("ReleaseSync: {e}"))?;
    }
    Ok(())
}
