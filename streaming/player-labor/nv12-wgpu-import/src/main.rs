//! Machbarkeitsnachweis: dekodierte D3D11-NV12-Textur ohne Umweg ueber den
//! Hauptspeicher in wgpu abtasten.
//!
//! Beantwortet genau eine Frage, und zwar nachpruefbar: kommt der Inhalt einer
//! geteilten D3D11-NV12-Textur unveraendert in einem wgpu-Renderdurchgang an?
//! Alles andere (Decoder anbinden, Synchronisierung, 10 bit) haengt daran — ist
//! die Antwort nein, erspart das den Umbau am Player.
//!
//! Aufbau in Stufen, jede mit eigenem Urteil, damit ein Fehlschlag verortbar
//! ist statt nur "geht nicht":
//!   1. Bietet der Vulkan-Adapter NV12 und externen Speicher an?
//!   2. Laesst sich eine geteilte NV12-Textur in D3D11 anlegen und fuellen?
//!   3. Nimmt wgpu sie ueber `texture_from_d3d11_shared_handle` entgegen?
//!   4. Stimmen die abgetasteten Werte mit den geschriebenen ueberein?
//!
//! Stufe 4 ist der eigentliche Punkt. Die Stufen 1-3 koennen gelingen und das
//! Bild trotzdem falsch ankommen — vertauschte Ebenen, falscher Zeilenabstand,
//! stillschweigende Formatwandlung. Deshalb wird nicht "kein Fehler" geprueft,
//! sondern jeder Bildpunkt gegen den geschriebenen Wert.

use windows::core::Interface;
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_RESOURCE_MISC_SHARED, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
    D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
    D3D11_MAP_WRITE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

const BREITE: u32 = 64;
const HOEHE: u32 = 64;

/// Was in die Textur geschrieben wird — und wogegen spaeter geprueft wird.
///
/// Luma laeuft als Rampe ueber die Zeile, Chroma steht fest. Eine Rampe deckt
/// Zeilenabstands-Fehler auf (bei falschem Abstand verrutscht sie sichtbar),
/// zwei verschiedene feste Chroma-Werte decken vertauschte U/V-Kanaele auf —
/// mit 128/128 waere beides unsichtbar geblieben.
fn luma(x: u32, y: u32) -> u8 {
    ((x * 4 + y) % 256) as u8
}
const U_WERT: u8 = 64;
const V_WERT: u8 = 192;

fn nv12_daten() -> Vec<u8> {
    let mut v = vec![0u8; (BREITE * HOEHE + BREITE * HOEHE / 2) as usize];
    for y in 0..HOEHE {
        for x in 0..BREITE {
            v[(y * BREITE + x) as usize] = luma(x, y);
        }
    }
    let uv_start = (BREITE * HOEHE) as usize;
    for i in 0..(BREITE * HOEHE / 4) as usize {
        v[uv_start + i * 2] = U_WERT;
        v[uv_start + i * 2 + 1] = V_WERT;
    }
    v
}

struct D3d11Quelle {
    mit_mutex: bool,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    textur: ID3D11Texture2D,
    handle: HANDLE,
}

/// Liest die Luma-Ebene der geteilten Textur ueber D3D11 zurueck.
///
/// Zaehlt, wie viele Werte von `erwartet` abweichen. Getrennt von der vollen
/// Rueckprobe, weil Stufe 5 nur die Luma-Ebene beschreibt.
fn d3d11_luma_lesen(q: &D3d11Quelle, erwartet: &dyn Fn(u32, u32) -> u8) -> Result<usize, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: BREITE,
        Height: HOEHE,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut ablage: Option<ID3D11Texture2D> = None;
    unsafe { q.device.CreateTexture2D(&desc, None, Some(&mut ablage)) }
        .map_err(|e| format!("Ablage: {e}"))?;
    let ablage = ablage.ok_or("Ablage fehlt")?;
    let mutex: Option<IDXGIKeyedMutex> =
        if q.mit_mutex { Some(q.textur.cast().map_err(|e| format!("Mutex: {e}"))?) } else { None };
    if let Some(m) = &mutex {
        unsafe { m.AcquireSync(0, u32::MAX) }.map_err(|e| format!("AcquireSync: {e}"))?;
    }
    unsafe { q.context.CopyResource(&ablage, &q.textur) };
    if let Some(m) = &mutex {
        unsafe { m.ReleaseSync(0) }.map_err(|e| format!("ReleaseSync: {e}"))?;
    }
    let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { q.context.Map(&ablage, 0, D3D11_MAP_READ, 0, Some(&mut abbild)) }
        .map_err(|e| format!("Map: {e}"))?;
    let pitch = abbild.RowPitch as usize;
    let basis = abbild.pData as *const u8;
    let mut abweichend = 0usize;
    for y in 0..HOEHE {
        for x in 0..BREITE {
            let ist = unsafe { *basis.add(y as usize * pitch + x as usize) };
            if ist != erwartet(x, y) {
                abweichend += 1;
            }
        }
    }
    unsafe { q.context.Unmap(&ablage, 0) };
    Ok(abweichend)
}

/// Stufe 2b: liest die geteilte Textur ueber D3D11 selbst zurueck.
///
/// **Ohne diesen Schritt ist ein schwarzes Ergebnis nicht deutbar.** Kommt in
/// Stufe 4 nichts an, kann das genauso gut heissen, dass nie etwas drin stand.
/// Erst wenn D3D11 den geschriebenen Inhalt wiederfindet, ist ein leeres
/// Vulkan-Ergebnis ein Vulkan-Befund.
fn d3d11_rueckprobe(q: &D3d11Quelle) -> Result<usize, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: BREITE,
        Height: HOEHE,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut ablage: Option<ID3D11Texture2D> = None;
    unsafe { q.device.CreateTexture2D(&desc, None, Some(&mut ablage)) }
        .map_err(|e| format!("Ablage-Textur: {e}"))?;
    let ablage = ablage.ok_or("Ablage-Textur fehlt")?;
    let mutex: Option<IDXGIKeyedMutex> =
        if q.mit_mutex { Some(q.textur.cast().map_err(|e| format!("Mutex: {e}"))?) } else { None };
    if let Some(m) = &mutex {
        unsafe { m.AcquireSync(0, u32::MAX) }.map_err(|e| format!("AcquireSync: {e}"))?;
    }
    unsafe { q.context.CopyResource(&ablage, &q.textur) };
    if let Some(m) = &mutex {
        unsafe { m.ReleaseSync(0) }.map_err(|e| format!("ReleaseSync: {e}"))?;
    }

    let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { q.context.Map(&ablage, 0, D3D11_MAP_READ, 0, Some(&mut abbild)) }
        .map_err(|e| format!("Map: {e}"))?;
    let pitch = abbild.RowPitch as usize;
    let basis = abbild.pData as *const u8;
    let mut abweichend = 0usize;
    for y in 0..HOEHE as usize {
        for x in 0..BREITE as usize {
            let ist = unsafe { *basis.add(y * pitch + x) };
            if ist != luma(x as u32, y as u32) {
                abweichend += 1;
            }
        }
    }
    // Die Chroma-Ebene beginnt bei NV12 genau `pitch * hoehe` nach dem Anfang.
    let uv = pitch * HOEHE as usize;
    for i in 0..(BREITE * HOEHE / 4) as usize {
        let zeile = i / (BREITE as usize / 2);
        let spalte = i % (BREITE as usize / 2);
        let u = unsafe { *basis.add(uv + zeile * pitch + spalte * 2) };
        let v = unsafe { *basis.add(uv + zeile * pitch + spalte * 2 + 1) };
        if u != U_WERT || v != V_WERT {
            abweichend += 1;
        }
    }
    unsafe { q.context.Unmap(&ablage, 0) };
    Ok(abweichend)
}

/// Stufe 2: geteilte NV12-Textur in D3D11 anlegen und mit bekanntem Inhalt
/// fuellen.
///
/// `SHARED_NTHANDLE` verlangt laut Doku die Paarung mit `SHARED_KEYEDMUTEX`;
/// beides zusammen ergibt das NT-Handle, das Vulkan als
/// `D3D11_TEXTURE`-Handle-Typ erwartet. Der Mutex wird hier nur einmal
/// freigegeben — fuer einen Einmal-Nachweis genuegt das, im laufenden Betrieb
/// braucht es echte Synchronisierung (s. Ausgabe am Ende).
fn d3d11_quelle(mit_mutex: bool) -> Result<D3d11Quelle, String> {
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
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        // Zwei Bauarten, weil zwei Ursachen fuer ein schwarzes Bild in Frage
        // kommen und sie sich sonst nicht trennen lassen:
        //   mit Mutex  — vorschriftsmaessig, aber die Vulkan-Seite erwirbt ihn
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
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut textur)) }
        .map_err(|e| format!("CreateTexture2D (NV12, geteilt): {e}"))?;
    let textur = textur.ok_or("CreateTexture2D lieferte keine Textur")?;

    // Fuellen ueber eine Ablage-Textur, NICHT ueber `pInitialData`.
    //
    // Der erste Versuch reichte die Bilddaten beim Anlegen mit — und die
    // Rueckprobe fand die Textur komplett auf null. Fuer NV12 traegt der Weg
    // ueber Anfangsdaten hier also nicht (es gibt eine Ebene mit halber Hoehe
    // hinter der ersten; ein einzelner `SysMemPitch` beschreibt das nicht
    // eindeutig). Ueber `Map` steht der echte Zeilenabstand des Treibers zur
    // Verfuegung, und der ist bei 64 Punkten Breite bereits groesser als 64.
    let ablage_desc = D3D11_TEXTURE2D_DESC {
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
        MiscFlags: 0,
        ..desc
    };
    let mut ablage: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&ablage_desc, None, Some(&mut ablage)) }
        .map_err(|e| format!("Ablage zum Fuellen: {e}"))?;
    let ablage = ablage.ok_or("Ablage fehlt")?;
    let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&ablage, 0, D3D11_MAP_WRITE, 0, Some(&mut abbild)) }
        .map_err(|e| format!("Map zum Schreiben: {e}"))?;
    let pitch = abbild.RowPitch as usize;
    let basis = abbild.pData as *mut u8;
    for y in 0..HOEHE as usize {
        for x in 0..BREITE as usize {
            unsafe { *basis.add(y * pitch + x) = luma(x as u32, y as u32) };
        }
    }
    let uv = pitch * HOEHE as usize;
    for zeile in 0..(HOEHE / 2) as usize {
        for spalte in 0..(BREITE / 2) as usize {
            unsafe {
                *basis.add(uv + zeile * pitch + spalte * 2) = U_WERT;
                *basis.add(uv + zeile * pitch + spalte * 2 + 1) = V_WERT;
            }
        }
    }
    unsafe { context.Unmap(&ablage, 0) };

    // Der Schluessel-Mutex muss VOR dem Zugriff erworben werden.
    //
    // Beim ersten Anlauf stand das Erwerben hinter dem Kopieren — die Textur
    // blieb leer, und zwar ohne jede Fehlermeldung: D3D11 verwirft die Arbeit
    // still, wenn der Aufrufer den Schluessel nicht haelt. Genau die Sorte
    // Fehler, die man ohne Rueckprobe der Vulkan-Seite anlastet.
    let mutex: Option<IDXGIKeyedMutex> = if mit_mutex {
        Some(textur.cast().map_err(|e| format!("IDXGIKeyedMutex: {e}"))?)
    } else {
        None
    };
    if let Some(m) = &mutex {
        unsafe { m.AcquireSync(0, u32::MAX) }.map_err(|e| format!("AcquireSync: {e}"))?;
    }
    unsafe { context.CopyResource(&textur, &ablage) };
    unsafe { context.Flush() };
    if let Some(m) = &mutex {
        unsafe { m.ReleaseSync(0) }.map_err(|e| format!("ReleaseSync: {e}"))?;
    }

    let res: IDXGIResource1 = textur.cast().map_err(|e| format!("IDXGIResource1: {e}"))?;
    // 0x80000000 = GENERIC_READ, 1 = GENERIC_WRITE fuer geteilte DXGI-Ressourcen.
    let handle = unsafe { res.CreateSharedHandle(None, 0x8000_0000 | 1, None) }
        .map_err(|e| format!("CreateSharedHandle: {e}"))?;

    Ok(D3d11Quelle { mit_mutex, device, context, textur, handle })
}

const SHADER: &str = r#"
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    return vec4<f32>(p[i], 0.0, 1.0);
}
@group(0) @binding(0) var y_tex: texture_2d<f32>;
@group(0) @binding(1) var uv_tex: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let c = vec2<i32>(i32(pos.x), i32(pos.y));
    let y = textureLoad(y_tex, c, 0).r;
    let uv = textureLoad(uv_tex, c / 2, 0).rg;
    // Roh weitergereicht, NICHT nach RGB gerechnet: geprueft werden soll der
    // Weg der Daten, nicht die Farbmatrix.
    return vec4<f32>(y, uv.r, uv.g, 1.0);
}
"#;

fn main() {
    let code = lauf();
    std::process::exit(code);
}

fn lauf() -> i32 {
    println!("== Stufe 1: Adapter ==");
    let mut beschreibung = wgpu::InstanceDescriptor::new_without_display_handle();
    beschreibung.backends = wgpu::Backends::VULKAN;
    // Pruefschicht an: die Vermutung "der Uebergang aus UNDEFINED verwirft den
    // Inhalt" ist aus dem Quelltext gelesen, nicht beobachtet. Die Schicht sagt
    // es entweder selbst — oder sie widerspricht, und dann ist die Ursache eine
    // andere (etwa ein falsch gewaehlter Speichertyp beim Import).
    if std::env::var("SPIKE_PRUEFSCHICHT").as_deref() == Ok("1") {
        beschreibung.flags |= wgpu::InstanceFlags::VALIDATION | wgpu::InstanceFlags::DEBUG;
    }
    let instance = wgpu::Instance::new(beschreibung);
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .ok() else {
        println!("FEHLER: kein Vulkan-Adapter");
        return 1;
    };
    let info = adapter.get_info();
    println!("GPU        {} ({:?}, {})", info.name, info.backend, info.driver);

    let f = adapter.features();
    let nv12 = f.contains(wgpu::Features::TEXTURE_FORMAT_NV12);
    let extmem = f.contains(wgpu::Features::VULKAN_EXTERNAL_MEMORY_WIN32);
    println!("NV12       {}", if nv12 { "ja" } else { "NEIN" });
    println!("ext. Speicher (Win32)  {}", if extmem { "ja" } else { "NEIN" });
    if !nv12 || !extmem {
        println!("\nURTEIL: Der Weg ist auf dieser GPU nicht gangbar.");
        return 1;
    }

    let Ok((device, queue)) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("nv12-import"),
        required_features: wgpu::Features::TEXTURE_FORMAT_NV12
            | wgpu::Features::VULKAN_EXTERNAL_MEMORY_WIN32,
        ..Default::default()
    })) else {
        println!("FEHLER: Geraet mit NV12 + externem Speicher liess sich nicht oeffnen");
        return 1;
    };

    // Vorgabe: mit Mutex (die vorschriftsmaessige Bauart). SPIKE_MUTEX=0
    // schaltet auf schlichtes Teilen um.
    let mit_mutex = std::env::var("SPIKE_MUTEX").as_deref() != Ok("0");
    println!(
        "\n== Stufe 2: geteilte D3D11-NV12-Textur ({}) ==",
        if mit_mutex { "mit Schluessel-Mutex" } else { "ohne Mutex, schlicht geteilt" }
    );
    let quelle = match d3d11_quelle(mit_mutex) {
        Ok(q) => q,
        Err(e) => {
            println!("FEHLER: {e}");
            return 1;
        }
    };
    println!("angelegt, gefuellt, Handle steht ({}x{}, NV12)", BREITE, HOEHE);
    match d3d11_rueckprobe(&quelle) {
        Ok(0) => println!("Rueckprobe ueber D3D11: Inhalt steht vollstaendig in der Textur"),
        Ok(n) => {
            println!("Rueckprobe ueber D3D11: {n} Werte abweichend");
            println!("\nURTEIL: Der Inhalt kommt schon in D3D11 nicht an — das ist kein");
            println!("        Vulkan-Problem. Anfangsdaten fuer NV12 pruefen.");
            return 1;
        }
        Err(e) => println!("Rueckprobe nicht moeglich ({e}) — Stufe 4 bleibt damit mehrdeutig"),
    }

    println!("\n== Stufe 3: Einblenden in wgpu ==");
    let hal_desc = wgpu::hal::TextureDescriptor {
        label: Some("nv12-import"),
        size: wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::NV12,
        // COPY_DST zusaetzlich, damit Stufe 5 in die Textur schreiben kann.
        usage: wgpu::TextureUses::RESOURCE | wgpu::TextureUses::COPY_DST,
        memory_flags: wgpu::hal::MemoryFlags::empty(),
        view_formats: vec![wgpu::TextureFormat::R8Unorm, wgpu::TextureFormat::Rg8Unorm],
    };
    let start = std::time::Instant::now();
    let hal_tex = unsafe {
        let Some(hal_device) = device.as_hal::<wgpu::hal::api::Vulkan>() else {
            println!("FEHLER: Geraet ist kein Vulkan-Geraet");
            return 1;
        };
        match hal_device.texture_from_d3d11_shared_handle(quelle.handle, &hal_desc) {
            Ok(t) => t,
            Err(e) => {
                println!("FEHLER: texture_from_d3d11_shared_handle: {e:?}");
                return 1;
            }
        }
    };
    let einblendzeit = start.elapsed();

    // DER Punkt dieses zweiten Durchgangs.
    //
    // wgpu 30 laesst den Zustand angeben, in dem die Fremdressource bereits
    // ist, statt UNINITIALIZED anzunehmen. Welcher Zustand richtig ist, ist
    // selbst eine Frage: D3D11 kennt keine Bildlagen, die uebliche Verabredung
    // beim Teilen ist VK_IMAGE_LAYOUT_GENERAL. `derive_image_layout` trifft
    // GENERAL nur ueber eine KOMBINATION von Flags — eine einzelne wie
    // RESOURCE ergaebe SHADER_READ_ONLY_OPTIMAL. Beides ist hier waehlbar,
    // damit die Antwort gemessen und nicht geraten ist.
    let zustand = match std::env::var("SPIKE_ZUSTAND").as_deref() {
        Ok("resource") => wgpu::TextureUses::RESOURCE,
        Ok("uninit") => wgpu::TextureUses::UNINITIALIZED,
        _ => wgpu::TextureUses::RESOURCE | wgpu::TextureUses::COPY_SRC,
    };
    println!("Anfangszustand fuer wgpu: {zustand:?}");
    let textur = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Vulkan>(
            hal_tex,
            &wgpu::TextureDescriptor {
                label: Some("nv12-import"),
                size: wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::NV12,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[wgpu::TextureFormat::R8Unorm, wgpu::TextureFormat::Rg8Unorm],
            },
            zustand,
        )
    };
    println!("eingeblendet in {:.3} ms", einblendzeit.as_secs_f64() * 1000.0);

    let y_view = textur.create_view(&wgpu::TextureViewDescriptor {
        label: Some("y"),
        format: Some(wgpu::TextureFormat::R8Unorm),
        aspect: wgpu::TextureAspect::Plane0,
        ..Default::default()
    });
    let uv_view = textur.create_view(&wgpu::TextureViewDescriptor {
        label: Some("uv"),
        format: Some(wgpu::TextureFormat::Rg8Unorm),
        aspect: wgpu::TextureAspect::Plane1,
        ..Default::default()
    });
    println!("Ebenen-Ansichten angelegt (Plane0 als R8, Plane1 als Rg8)");

    println!("\n== Stufe 4: abtasten und nachrechnen ==");
    let werte = zeichnen(&device, &queue, &y_view, &uv_view);

    let mut fehler = 0usize;
    let mut erstes: Option<String> = None;
    for y in 0..HOEHE {
        for x in 0..BREITE {
            let i = ((y * BREITE + x) * 4) as usize;
            let (r, g, b) = (werte[i], werte[i + 1], werte[i + 2]);
            let soll = (luma(x, y), U_WERT, V_WERT);
            // Ein Schritt Spielraum: die Abtastung laeuft ueber
            // Gleitkomma-Normierung, das letzte Bit darf wandern.
            let ok = (r as i32 - soll.0 as i32).abs() <= 1
                && (g as i32 - soll.1 as i32).abs() <= 1
                && (b as i32 - soll.2 as i32).abs() <= 1;
            if !ok {
                fehler += 1;
                erstes.get_or_insert_with(|| {
                    format!("({x},{y}): gelesen {r}/{g}/{b}, erwartet {}/{}/{}", soll.0, soll.1, soll.2)
                });
            }
        }
    }
    let gesamt = (BREITE * HOEHE) as usize;
    println!("Bildpunkte geprueft: {gesamt}, abweichend: {fehler}");
    if let Some(e) = &erstes {
        println!("erste Abweichung  {e}");
    }

    // Stufe 5 laeuft NUR, wenn Stufe 4 schwarz war — sonst ist die Frage, die
    // sie beantwortet, schon beantwortet.
    // Stufe 5 riss beim ersten Versuch das Geraet mit (`Parent device is
    // lost`) — sie schreibt in eine eingehaengte Textur, deren Bildlage wgpu
    // anders sieht als der Treiber. Deshalb nur noch auf Anforderung: sie
    // beantwortet eine Nebenfrage und darf Stufe 4 nicht das Ergebnis
    // verhageln.
    if fehler > 0 && std::env::var("SPIKE_GEGENRICHTUNG").as_deref() == Ok("1") {
        println!("\n== Stufe 5: Gegenrichtung — aus Vulkan schreiben, mit D3D11 lesen ==");
        println!("Trennt die zwei moeglichen Ursachen: verworfener Anfangsinhalt");
        println!("(dann sieht D3D11 die Aenderung) gegen falsch gebundenen Speicher");
        println!("(dann sieht D3D11 nichts).");
        const MARKE: u8 = 0xA5;
        let zeile = vec![MARKE; BREITE as usize];
        let mut alle = Vec::with_capacity((BREITE * HOEHE) as usize);
        for _ in 0..HOEHE {
            alle.extend_from_slice(&zeile);
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &textur,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::Plane0,
            },
            &alle,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(BREITE),
                rows_per_image: Some(HOEHE),
            },
            wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
        );
        queue.submit([]);
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        match d3d11_luma_lesen(&quelle, &|_, _| MARKE) {
            Ok(0) => {
                println!("D3D11 sieht das aus Vulkan Geschriebene: Speicher IST geteilt.");
                println!();
                println!("URTEIL: Der Weg ist grundsaetzlich offen — Handle, Import und");
                println!("        Ebenen-Ansichten stimmen, und beide Seiten arbeiten auf");
                println!("        DEMSELBEN Speicher. Was fehlt, ist allein die Erhaltung");
                println!("        des vorhandenen Inhalts beim ersten Zugriff: wgpu traegt");
                println!("        jede eingehaengte Textur als UNINITIALIZED ein");
                println!("        (wgpu-core-29.0.4 device/resource.rs:1253), und das wird");
                println!("        zu VK_IMAGE_LAYOUT_UNDEFINED (wgpu-hal conv.rs:218). Ein");
                println!("        Uebergang aus UNDEFINED darf den Inhalt verwerfen — und");
                println!("        dieser Treiber tut es. Das ist regelkonform, deshalb");
                println!("        schweigt auch die Pruefschicht.");
                println!();
                println!("        Folge: OHNE Aenderung an wgpu traegt der Weg nicht.");
                return 2;
            }
            Ok(n) => {
                println!("D3D11 sieht die Aenderung NICHT ({n} von {} Werten).", BREITE * HOEHE);
                println!();
                println!("URTEIL: Der Import bindet nicht den geteilten Speicher. Die");
                println!("        Ursache liegt frueher als die Bildlage — vermutlich in der");
                println!("        Wahl des Speichertyps beim Import (wgpu nimmt nur die");
                println!("        Anforderungen des Bildes plus DEVICE_LOCAL, nicht die");
                println!("        vom Handle erlaubten Typen).");
                return 3;
            }
            Err(e) => println!("Gegenrichtung nicht pruefbar: {e}"),
        }
    }

    println!();
    if fehler == 0 {
        println!("URTEIL: Der Weg traegt. Eine D3D11-NV12-Textur kommt ohne");
        println!("        Umweg ueber den Hauptspeicher unveraendert im Shader an.");
        println!();
        println!("Was dieser Nachweis NICHT zeigt, und was am Player noch zu tun ist:");
        println!("  - Synchronisierung. Hier wird einmal geschrieben und danach nur");
        println!("    gelesen. Im Betrieb schreibt der Decoder waehrend gezeichnet");
        println!("    wird; ohne Zaun sieht der Shader halbe Bilder.");
        println!("  - Der Decoder liefert ein Textur-ARRAY (eine Schicht je Bild),");
        println!("    nicht wie hier eine Einzeltextur.");
        println!("  - 10 bit (P010) ist ein anderes Format und hier ungeprueft.");
        0
    } else {
        println!("URTEIL: Der Import gelingt, aber der Inhalt stimmt nicht.");
        println!("        Verdacht: Zeilenabstand oder Ebenen-Zuordnung.");
        1
    }
}

fn zeichnen(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    y_view: &wgpu::TextureView,
    uv_view: &wgpu::TextureView,
) -> Vec<u8> {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    let eintrag = |b: u32| wgpu::BindGroupLayoutEntry {
        binding: b,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[eintrag(0), eintrag(1)],
    });
    let gruppe = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(y_view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(uv_view) },
        ],
    });
    let pipe_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(&pipe_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });

    let ziel = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let ziel_view = ziel.create_view(&Default::default());
    // 64 Punkte * 4 Byte = 256 — genau die geforderte Zeilenausrichtung.
    let puffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (BREITE * HOEHE * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut enc = device.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &ziel_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &gruppe, &[]);
        pass.draw(0..3, 0..1);
    }
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &ziel,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &puffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(BREITE * 4),
                rows_per_image: Some(HOEHE),
            },
        },
        wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);

    let slice = puffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let daten = slice.get_mapped_range().expect("Puffer nicht lesbar").to_vec();
    drop(slice);
    puffer.unmap();
    daten
}
