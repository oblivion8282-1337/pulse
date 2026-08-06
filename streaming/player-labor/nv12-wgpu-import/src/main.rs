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
    D3D11_BIND_DECODER, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_RESOURCE_MISC_SHARED, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
    D3D11_CPU_ACCESS_READ, D3D11_CPU_ACCESS_WRITE, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
    D3D11_MAP_WRITE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_NV12, DXGI_FORMAT_P010, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

const BREITE: u32 = 64;
const HOEHE: u32 = 64;

/// Welches Bildformat geprueft wird.
///
/// **Der Unterschied ist nicht nur die Bittiefe.** P010 legt seine zehn Bit in
/// die OBEREN Bits eines 16-Bit-Wortes, hat andere Ebenen-Formate und haengt an
/// einem eigenen wgpu-Merkmal. Alles davon steht hier beieinander, damit es
/// nicht an fuenf Stellen einzeln entschieden wird — genau die Sorte Streuung,
/// bei der ein Weg spaeter halb umgestellt ist.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Bildformat {
    Nv12,
    P010,
}

impl Bildformat {
    fn name(self) -> &'static str {
        match self {
            Bildformat::Nv12 => "NV12 (8 bit)",
            Bildformat::P010 => "P010 (10 bit)",
        }
    }
    fn dxgi(self) -> windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT {
        match self {
            Bildformat::Nv12 => DXGI_FORMAT_NV12,
            Bildformat::P010 => DXGI_FORMAT_P010,
        }
    }
    fn wgpu(self) -> wgpu::TextureFormat {
        match self {
            Bildformat::Nv12 => wgpu::TextureFormat::NV12,
            Bildformat::P010 => wgpu::TextureFormat::P010,
        }
    }
    /// Ebenen-Ansichten: Luma einkanalig, Chroma zweikanalig verschraenkt.
    fn ebenen(self) -> (wgpu::TextureFormat, wgpu::TextureFormat) {
        match self {
            Bildformat::Nv12 => (wgpu::TextureFormat::R8Unorm, wgpu::TextureFormat::Rg8Unorm),
            Bildformat::P010 => (wgpu::TextureFormat::R16Unorm, wgpu::TextureFormat::Rg16Unorm),
        }
    }
    /// Alle Merkmale, die dieses Format braucht — **auch die der
    /// Ebenen-Ansichten.**
    ///
    /// Bei P010 sind das zwei: das Format selbst UND `TEXTURE_FORMAT_16BIT_NORM`
    /// fuer `R16Unorm`/`Rg16Unorm`. Ohne das zweite gelingt der Import, und erst
    /// `create_view` scheitert — mitten in Stufe 3, mit einer Meldung ueber
    /// Merkmale statt ueber den Import. Genau die Sorte Fehlschlag, die man
    /// zuerst dem geteilten Speicher anlastet.
    fn merkmal(self) -> wgpu::Features {
        match self {
            Bildformat::Nv12 => wgpu::Features::TEXTURE_FORMAT_NV12,
            Bildformat::P010 => {
                wgpu::Features::TEXTURE_FORMAT_P010 | wgpu::Features::TEXTURE_FORMAT_16BIT_NORM
            }
        }
    }
    /// Byte je Abtastwert im Speicher — 1 bei NV12, 2 bei P010.
    fn bytes(self) -> usize {
        match self {
            Bildformat::Nv12 => 1,
            Bildformat::P010 => 2,
        }
    }
    fn hoechster_code(self) -> u32 {
        match self {
            Bildformat::Nv12 => 255,
            Bildformat::P010 => 1023,
        }
    }
    /// Wie ein Codewert im Speicher steht.
    ///
    /// **P010 schiebt um sechs Bit nach oben.** Wer das vergisst, schreibt ein
    /// um Faktor 64 zu dunkles Bild und sieht es dem Ergebnis nicht an — es ist
    /// dann nur „fast schwarz" statt schwarz.
    fn gespeichert(self, code: u32) -> u16 {
        match self {
            Bildformat::Nv12 => code as u16,
            Bildformat::P010 => (code << 6) as u16,
        }
    }
    /// Was der Sampler daraus macht, normiert auf [0,1] — der Sollwert, gegen
    /// den Stufe 4 prueft. Beide Ebenen-Formate sind `*Unorm`, der Wert ist
    /// also der gespeicherte geteilt durch den Hoechstwert des SPEICHERWORTES,
    /// nicht durch den des Codes.
    fn abtastwert(self, code: u32) -> f64 {
        match self {
            Bildformat::Nv12 => code as f64 / 255.0,
            Bildformat::P010 => self.gespeichert(code) as f64 / 65535.0,
        }
    }
}

/// Was in die Textur geschrieben wird — und wogegen spaeter geprueft wird.
///
/// Luma laeuft als Rampe ueber die Zeile, Chroma steht fest. Eine Rampe deckt
/// Zeilenabstands-Fehler auf (bei falschem Abstand verrutscht sie sichtbar),
/// zwei verschiedene feste Chroma-Werte decken vertauschte U/V-Kanaele auf —
/// mit 128/128 waere beides unsichtbar geblieben.
///
/// **`schicht` geht mit ein, und das ist der Zweck der Stapel-Pruefung.**
/// Jede Schicht traegt ein anderes Bild; ein Weg, der immer Schicht 0 liest
/// oder den Abstand zwischen den Schichten falsch berechnet, faellt damit auf.
/// Mit gleichem Inhalt in allen Schichten waere beides unsichtbar.
///
/// **Bei 10 Bit tragen die unteren zwei Bit eine eigene Stufe.** Ohne das
/// bestuenden alle Werte aus Vielfachen von vier, und ein Weg, der still auf
/// 8 Bit kappt, kaeme als fehlerfrei durch — also genau der Fehler, um den es
/// bei 10 Bit geht.
fn luma_code(f: Bildformat, x: u32, y: u32, schicht: u32) -> u32 {
    let acht = (x * 4 + y + schicht * 37) % 256;
    match f {
        Bildformat::Nv12 => acht,
        Bildformat::P010 => acht * 4 + (x + y) % 4,
    }
}

/// Feste Chroma-Werte. Bei 10 Bit bewusst UNGERADE Vielfache gewaehlt (257 und
/// 771 statt 256 und 768) — dieselbe Ueberlegung wie bei der Luma-Rampe: ein
/// Weg, der auf 8 Bit kappt, liefert dann sichtbar etwas anderes.
fn chroma_codes(f: Bildformat) -> (u32, u32) {
    match f {
        Bildformat::Nv12 => (64, 192),
        Bildformat::P010 => (257, 771),
    }
}

struct D3d11Quelle {
    mit_mutex: bool,
    format: Bildformat,
    /// Schichten des Stapels — 1 heisst Einzeltextur, also der bisherige Fall.
    schichten: u32,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    textur: ID3D11Texture2D,
    handle: HANDLE,
}

/// Eine EINSCHICHTIGE Ablage-Textur anlegen und den Inhalt genau einer Schicht
/// hineinkopieren — die gemeinsame Vorarbeit beider Rueckproben.
///
/// **Warum einschichtig, obwohl die Quelle ein Stapel sein kann.** Ein
/// Video-Format-Stapel laesst sich als CPU-Ablage gar nicht anlegen
/// (`E_INVALIDARG`, 2026-08-06 gemessen): der Stapel braucht das
/// Decoder-Bindungsflag, und eine Ablage-Textur darf ueberhaupt keine
/// Bindungsflags tragen. Beides zusammen geht nicht. Deshalb einschichtig und
/// `CopySubresourceRegion` je Schicht statt `CopyResource` am Stueck — genau
/// der Weg, den auch der Sidecar fuer seine Poolen nimmt.
fn ablage_mit_inhalt(q: &D3d11Quelle, schicht: u32) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: BREITE,
        Height: HOEHE,
        MipLevels: 1,
        ArraySize: 1,
        Format: q.format.dxgi(),
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
    unsafe {
        q.context
            .CopySubresourceRegion(&ablage, 0, 0, 0, 0, &q.textur, schicht, None)
    };
    if let Some(m) = &mutex {
        unsafe { m.ReleaseSync(0) }.map_err(|e| format!("ReleaseSync: {e}"))?;
    }
    Ok(ablage)
}

/// Einen Abtastwert aus einer abgebildeten Ebene lesen — ein oder zwei Byte,
/// je nach Format.
///
/// # Safety
/// `basis` muss auf die abgebildete Teilressource zeigen und der berechnete
/// Versatz innerhalb davon liegen.
unsafe fn wort(f: Bildformat, basis: *const u8, versatz: usize) -> u32 {
    match f.bytes() {
        1 => u32::from(unsafe { *basis.add(versatz) }),
        _ => {
            let b = unsafe { std::slice::from_raw_parts(basis.add(versatz), 2) };
            u16::from_le_bytes([b[0], b[1]]) as u32
        }
    }
}

/// Liest die Luma-Ebene EINER Schicht der geteilten Textur ueber D3D11 zurueck.
///
/// Zaehlt, wie viele Werte von `erwartet` (als gespeichertes Wort) abweichen.
/// Getrennt von der vollen Rueckprobe, weil Stufe 5 nur die Luma-Ebene
/// beschreibt.
fn d3d11_luma_lesen(
    q: &D3d11Quelle,
    schicht: u32,
    erwartet: &dyn Fn(u32, u32) -> u32,
) -> Result<usize, String> {
    let ablage = ablage_mit_inhalt(q, schicht)?;
    let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { q.context.Map(&ablage, 0, D3D11_MAP_READ, 0, Some(&mut abbild)) }
        .map_err(|e| format!("Map: {e}"))?;
    let pitch = abbild.RowPitch as usize;
    let basis = abbild.pData as *const u8;
    let b = q.format.bytes();
    let mut abweichend = 0usize;
    for y in 0..HOEHE {
        for x in 0..BREITE {
            let ist = unsafe { wort(q.format, basis, y as usize * pitch + x as usize * b) };
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
///
/// Prueft **jede** Schicht, nicht nur die spaeter abgetastete: liefe schon
/// D3D11 die Schichten durcheinander, waere ein Vulkan-Befund darueber wertlos.
fn d3d11_rueckprobe(q: &D3d11Quelle) -> Result<usize, String> {
    let (u_soll, v_soll) = chroma_codes(q.format);
    let b = q.format.bytes();
    let mut abweichend = 0usize;
    for schicht in 0..q.schichten {
        let ablage = ablage_mit_inhalt(q, schicht)?;
        let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { q.context.Map(&ablage, 0, D3D11_MAP_READ, 0, Some(&mut abbild)) }
            .map_err(|e| format!("Map (Schicht {schicht}): {e}"))?;
        let pitch = abbild.RowPitch as usize;
        let basis = abbild.pData as *const u8;
        for y in 0..HOEHE as usize {
            for x in 0..BREITE as usize {
                let ist = unsafe { wort(q.format, basis, y * pitch + x * b) };
                if ist != q.format.gespeichert(luma_code(q.format, x as u32, y as u32, schicht))
                    as u32
                {
                    abweichend += 1;
                }
            }
        }
        // Die Chroma-Ebene beginnt genau `pitch * hoehe` nach dem Anfang —
        // bei NV12 wie bei P010; nur die Wortbreite unterscheidet sich.
        let uv = pitch * HOEHE as usize;
        for i in 0..(BREITE * HOEHE / 4) as usize {
            let zeile = i / (BREITE as usize / 2);
            let spalte = i % (BREITE as usize / 2);
            let u = unsafe { wort(q.format, basis, uv + zeile * pitch + spalte * 2 * b) };
            let v = unsafe { wort(q.format, basis, uv + zeile * pitch + spalte * 2 * b + b) };
            if u != q.format.gespeichert(u_soll) as u32
                || v != q.format.gespeichert(v_soll) as u32
            {
                abweichend += 1;
            }
        }
        unsafe { q.context.Unmap(&ablage, schicht) };
    }
    Ok(abweichend)
}

/// Stufe 2: geteilte Textur in D3D11 anlegen und mit bekanntem Inhalt fuellen.
///
/// `SHARED_NTHANDLE` verlangt laut Doku die Paarung mit `SHARED_KEYEDMUTEX`;
/// beides zusammen ergibt das NT-Handle, das Vulkan als
/// `D3D11_TEXTURE`-Handle-Typ erwartet. Der Mutex wird hier nur einmal
/// freigegeben — fuer einen Einmal-Nachweis genuegt das, im laufenden Betrieb
/// braucht es echte Synchronisierung (s. Ausgabe am Ende).
///
/// `schichten > 1` legt einen Stapel an — die Form, in der ein
/// Hardware-Decoder seine Bilder liefert (eine Schicht je Bild). **Jede
/// Schicht bekommt einen anderen Inhalt**, sonst waere ein Weg, der immer
/// Schicht 0 liest, von einem richtigen nicht zu unterscheiden.
fn d3d11_quelle(
    mit_mutex: bool,
    format: Bildformat,
    schichten: u32,
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
        // dagegen ohne aus, und dabei bleibt es: der Fall soll mit den
        // frueheren Messungen vergleichbar bleiben.
        //
        // Das ist kein Kunstgriff, sondern genau die Bauart, die der Player
        // vorfaende: libavutils D3D11VA-Pool legt seine Decoder-Poolen mit
        // `DECODER|SHADER_RESOURCE` an.
        BindFlags: if schichten > 1 {
            (D3D11_BIND_DECODER.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32
        } else {
            D3D11_BIND_SHADER_RESOURCE.0 as u32
        },
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
    if let Err(e) = unsafe { device.CreateTexture2D(&desc, None, Some(&mut textur)) } {
        // **Halbieren statt melden.** Ein `E_INVALIDARG` sagt nicht, WELCHER
        // der acht Werte im Deskriptor gemeint ist. Bei einem Stapel kommen
        // genau zwei Erklaerungen in Frage — das Video-Format vertraegt keinen
        // Stapel, oder ein Stapel laesst sich nicht teilen — und die trennt ein
        // zweiter Versuch ohne die Teilungs-Flags. Ohne diese Unterscheidung
        // stuende in der Messakte nur "geht nicht", und der naechste Anlauf
        // finge wieder bei null an.
        // Vier Varianten, jede laesst genau eine Erklaerung uebrig. Die dritte
        // ist die wichtigste: **so legt libavutil seine Decoder-Poolen an**
        // (`DECODER|SHADER_RESOURCE`), und genau solche Stapel wuerde der
        // Player bekommen. Ein Video-Format-Stapel OHNE `BIND_DECODER` ist
        // moeglicherweise gar nicht vorgesehen.
        let versuch = |name: &str, bind: u32, misc: u32| {
            let mut t: Option<ID3D11Texture2D> = None;
            let d = D3D11_TEXTURE2D_DESC { BindFlags: bind, MiscFlags: misc, ..desc };
            let ok = unsafe { device.CreateTexture2D(&d, None, Some(&mut t)) }.is_ok();
            format!("\n    {name}: {}", if ok { "geht" } else { "geht nicht" })
        };
        const BIND_DECODER: u32 = 0x200;
        let sr = D3D11_BIND_SHADER_RESOURCE.0 as u32;
        let mut befund = String::new();
        befund.push_str(&versuch("nur Shader-Ansicht, ungeteilt", sr, 0));
        befund.push_str(&versuch("Decoder + Shader-Ansicht, ungeteilt", D3D11_BIND_DECODER.0 as u32 | sr, 0));
        befund.push_str(&versuch(
            "Decoder + Shader-Ansicht, geteilt",
            D3D11_BIND_DECODER.0 as u32 | sr,
            desc.MiscFlags,
        ));
        befund.push_str(&versuch("nur Decoder, ungeteilt", D3D11_BIND_DECODER.0 as u32, 0));
        return Err(format!(
            "CreateTexture2D ({}, geteilt, {schichten} Schicht(en)): {e}\
             \n  Halbierung, welche Bauart dieser Treiber annimmt:{befund}",
            format.name()
        ));
    }
    let textur = textur.ok_or("CreateTexture2D lieferte keine Textur")?;

    // Fuellen ueber eine Ablage-Textur, NICHT ueber `pInitialData`.
    //
    // Der erste Versuch reichte die Bilddaten beim Anlegen mit — und die
    // Rueckprobe fand die Textur komplett auf null. Fuer NV12 traegt der Weg
    // ueber Anfangsdaten hier also nicht (es gibt eine Ebene mit halber Hoehe
    // hinter der ersten; ein einzelner `SysMemPitch` beschreibt das nicht
    // eindeutig). Ueber `Map` steht der echte Zeilenabstand des Treibers zur
    // Verfuegung, und der ist bei 64 Punkten Breite bereits groesser als 64.
    //
    // **Einschichtig, auch wenn das Ziel ein Stapel ist.** Ein Stapel in einem
    // Video-Format braucht das Decoder-Bindungsflag, eine CPU-Ablage darf gar
    // keine Bindungsflags tragen — beides zusammen lehnt D3D11 ab
    // (`E_INVALIDARG`). Also eine Schicht fuellen und je Schicht kopieren.
    let ablage_desc = D3D11_TEXTURE2D_DESC {
        ArraySize: 1,
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
    let (u_wert, v_wert) = chroma_codes(format);
    let b = format.bytes();
    let schreiben = |basis: *mut u8, versatz: usize, code: u32| unsafe {
        let w = format.gespeichert(code);
        match b {
            1 => *basis.add(versatz) = w as u8,
            _ => std::ptr::copy_nonoverlapping(w.to_le_bytes().as_ptr(), basis.add(versatz), 2),
        }
    };
    // Der Schluessel-Mutex muss VOR dem Zugriff auf die geteilte Textur
    // erworben werden — Begruendung unten, wo er frueher stand.
    let mutex: Option<IDXGIKeyedMutex> = if mit_mutex {
        Some(textur.cast().map_err(|e| format!("IDXGIKeyedMutex: {e}"))?)
    } else {
        None
    };
    if let Some(m) = &mutex {
        unsafe { m.AcquireSync(0, u32::MAX) }.map_err(|e| format!("AcquireSync: {e}"))?;
    }
    // Je Schicht: die einschichtige Ablage neu fuellen und an ihren Platz im
    // Stapel kopieren.
    for schicht in 0..schichten {
        let mut abbild = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(&ablage, 0, D3D11_MAP_WRITE, 0, Some(&mut abbild)) }
            .map_err(|e| format!("Map zum Schreiben (Schicht {schicht}): {e}"))?;
        let pitch = abbild.RowPitch as usize;
        let basis = abbild.pData as *mut u8;
        for y in 0..HOEHE as usize {
            for x in 0..BREITE as usize {
                let code = luma_code(format, x as u32, y as u32, schicht);
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
        // **Das Erwerben des Schluessels steht VOR dieser Schleife**, nicht
        // dahinter. Beim ersten Anlauf lag es hinter dem Kopieren — die Textur
        // blieb leer, und zwar ohne jede Fehlermeldung: D3D11 verwirft die
        // Arbeit still, wenn der Aufrufer den Schluessel nicht haelt. Genau die
        // Sorte Fehler, die man ohne Rueckprobe der Vulkan-Seite anlastet.
        unsafe {
            context.CopySubresourceRegion(&textur, schicht, 0, 0, 0, &ablage, 0, None)
        };
    }
    unsafe { context.Flush() };
    if let Some(m) = &mutex {
        unsafe { m.ReleaseSync(0) }.map_err(|e| format!("ReleaseSync: {e}"))?;
    }

    let res: IDXGIResource1 = textur.cast().map_err(|e| format!("IDXGIResource1: {e}"))?;
    // 0x80000000 = GENERIC_READ, 1 = GENERIC_WRITE fuer geteilte DXGI-Ressourcen.
    let handle = unsafe { res.CreateSharedHandle(None, 0x8000_0000 | 1, None) }
        .map_err(|e| format!("CreateSharedHandle: {e}"))?;

    Ok(D3d11Quelle { mit_mutex, format, schichten, device, context, textur, handle })
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

    // Was geprueft wird. Vorgabe ist der bisherige Fall (NV12, Einzeltextur),
    // damit ein nackter Lauf mit den frueheren Messungen vergleichbar bleibt.
    let format = match std::env::var("SPIKE_FORMAT").as_deref() {
        Ok("p010") => Bildformat::P010,
        _ => Bildformat::Nv12,
    };
    let schichten: u32 = std::env::var("SPIKE_SCHICHTEN")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(1);
    // Welche Schicht abgetastet wird. Vorgabe ist die LETZTE, nicht die erste:
    // ein Weg, der immer Schicht 0 liest, faellt sonst gar nicht auf.
    let schicht: u32 = std::env::var("SPIKE_SCHICHT")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|n| *n < schichten)
        .unwrap_or(schichten - 1);

    let f = adapter.features();
    let hat_format = f.contains(format.merkmal());
    let extmem = f.contains(wgpu::Features::VULKAN_EXTERNAL_MEMORY_WIN32);
    println!("Format     {} — {}", format.name(), if hat_format { "ja" } else { "NEIN" });
    println!("ext. Speicher (Win32)  {}", if extmem { "ja" } else { "NEIN" });
    println!("Stapel     {schichten} Schicht(en), geprueft wird Schicht {schicht}");
    if !hat_format || !extmem {
        println!("\nURTEIL: Der Weg ist auf dieser GPU mit diesem Format nicht gangbar.");
        return 1;
    }

    // Bei 10 Bit reicht ein 8-Bit-Ziel nicht: es kappte die unteren zwei Bit
    // und liesse damit genau den Fehler durch, um den es hier geht.
    // `Rgba32Float` ist im Kern von wgpu darstellbar und verlustfrei — ein
    // 16-Bit-Norm-Ziel braeuchte ein weiteres Merkmal.
    let zielformat = match format {
        Bildformat::Nv12 => wgpu::TextureFormat::Rgba8Unorm,
        Bildformat::P010 => wgpu::TextureFormat::Rgba32Float,
    };

    let Ok((device, queue)) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("nv12-import"),
        required_features: format.merkmal() | wgpu::Features::VULKAN_EXTERNAL_MEMORY_WIN32,
        ..Default::default()
    })) else {
        println!("FEHLER: Geraet mit {} + externem Speicher liess sich nicht oeffnen", format.name());
        return 1;
    };

    // Vorgabe: mit Mutex (die vorschriftsmaessige Bauart). SPIKE_MUTEX=0
    // schaltet auf schlichtes Teilen um.
    let mit_mutex = std::env::var("SPIKE_MUTEX").as_deref() != Ok("0");
    println!(
        "\n== Stufe 2: geteilte D3D11-Textur, {} ({}) ==",
        format.name(),
        if mit_mutex { "mit Schluessel-Mutex" } else { "ohne Mutex, schlicht geteilt" }
    );
    let quelle = match d3d11_quelle(mit_mutex, format, schichten) {
        Ok(q) => q,
        Err(e) => {
            println!("FEHLER: {e}");
            return 1;
        }
    };
    println!(
        "angelegt, gefuellt, Handle steht ({}x{}, {}, {} Schicht(en))",
        BREITE,
        HOEHE,
        format.name(),
        schichten
    );
    match d3d11_rueckprobe(&quelle) {
        Ok(0) => println!("Rueckprobe ueber D3D11: Inhalt steht vollstaendig in der Textur"),
        Ok(n) => {
            println!("Rueckprobe ueber D3D11: {n} Werte abweichend");
            println!("\nURTEIL: Der Inhalt kommt schon in D3D11 nicht an — das ist kein");
            println!("        Vulkan-Problem. Fuellweg fuer {} pruefen.", format.name());
            return 1;
        }
        Err(e) => println!("Rueckprobe nicht moeglich ({e}) — Stufe 4 bleibt damit mehrdeutig"),
    }

    println!("\n== Stufe 3: Einblenden in wgpu ==");
    let (ebene0, ebene1) = format.ebenen();
    // `depth_or_array_layers` traegt die Schichtenzahl. wgpus Import reicht den
    // Deskriptor unveraendert an `create_image_without_memory` weiter, das
    // Vulkan-Bild bekommt also `arrayLayers = schichten`. Ob die Speicherlage
    // eines D3D11-Stapels dazu passt, ist genau die Frage dieser Erweiterung.
    let masse =
        wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: schichten };
    let hal_desc = wgpu::hal::TextureDescriptor {
        label: Some("nv12-import"),
        size: masse,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: format.wgpu(),
        // COPY_DST zusaetzlich, damit Stufe 5 in die Textur schreiben kann.
        usage: wgpu::TextureUses::RESOURCE | wgpu::TextureUses::COPY_DST,
        memory_flags: wgpu::hal::MemoryFlags::empty(),
        view_formats: vec![ebene0, ebene1],
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
                size: masse,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: format.wgpu(),
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[ebene0, ebene1],
            },
            zustand,
        )
    };
    println!("eingeblendet in {:.3} ms", einblendzeit.as_secs_f64() * 1000.0);

    // **Die Ansicht zeigt auf GENAU EINE Schicht.** `base_array_layer` waehlt
    // sie, `array_layer_count: 1` macht daraus eine gewoehnliche 2D-Ansicht —
    // sonst waere es eine Feld-Ansicht, und der Shader muesste ein
    // `texture_2d_array` binden. Fuer den Player ist die Einzelansicht der
    // richtige Fall: FFmpeg reicht den Schichtindex je Bild in `data[1]` mit,
    // und der Shader soll davon nichts wissen muessen.
    let ansicht = |name: &'static str, f: wgpu::TextureFormat, a: wgpu::TextureAspect| {
        textur.create_view(&wgpu::TextureViewDescriptor {
            label: Some(name),
            format: Some(f),
            aspect: a,
            dimension: Some(wgpu::TextureViewDimension::D2),
            base_array_layer: schicht,
            array_layer_count: Some(1),
            ..Default::default()
        })
    };
    let y_view = ansicht("y", ebene0, wgpu::TextureAspect::Plane0);
    let uv_view = ansicht("uv", ebene1, wgpu::TextureAspect::Plane1);
    println!("Ebenen-Ansichten angelegt (Plane0 als {ebene0:?}, Plane1 als {ebene1:?}, Schicht {schicht})");

    println!("\n== Stufe 4: abtasten und nachrechnen ==");
    let werte = zeichnen(&device, &queue, &y_view, &uv_view, zielformat);

    // Verglichen wird im ABTASTRAUM [0,1], nicht in Codewerten: nur so ist der
    // Vergleich fuer 8 und 10 Bit derselbe, und die Toleranz bleibt an das
    // Format gebunden statt an das Ziel.
    let (u_soll, v_soll) = chroma_codes(format);
    // Ein Schritt Spielraum: die Abtastung laeuft ueber Gleitkomma-Normierung,
    // das letzte Bit darf wandern. Bei NV12 ist das exakt die alte Toleranz von
    // einem 8-Bit-Schritt — die Zahlen bleiben mit den frueheren Laeufen
    // vergleichbar.
    let toleranz = 1.0 / format.hoechster_code() as f64;
    let mut fehler = 0usize;
    let mut erstes: Option<String> = None;
    for y in 0..HOEHE {
        for x in 0..BREITE {
            let i = ((y * BREITE + x) * 3) as usize;
            let (r, g, b) = (werte[i], werte[i + 1], werte[i + 2]);
            let soll = (
                format.abtastwert(luma_code(format, x, y, schicht)),
                format.abtastwert(u_soll),
                format.abtastwert(v_soll),
            );
            let ok = (r - soll.0).abs() <= toleranz
                && (g - soll.1).abs() <= toleranz
                && (b - soll.2).abs() <= toleranz;
            if !ok {
                fehler += 1;
                let code = |v: f64| (v * format.hoechster_code() as f64).round() as i32;
                erstes.get_or_insert_with(|| {
                    format!(
                        "({x},{y}): gelesen {}/{}/{}, erwartet {}/{}/{} (in Codewerten)",
                        code(r), code(g), code(b),
                        code(soll.0), code(soll.1), code(soll.2)
                    )
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
        // Die Marke wird als GESPEICHERTES Wort geschrieben, nicht als Byte —
        // bei P010 sind das zwei Byte je Abtastwert. Der Code 0xA5 ist bei
        // beiden Formaten darstellbar (255 bzw. 1023 sind die Obergrenzen).
        const MARKE: u32 = 0xA5;
        let b = format.bytes();
        let wort = format.gespeichert(MARKE).to_le_bytes();
        let mut alle = Vec::with_capacity((BREITE * HOEHE) as usize * b);
        for _ in 0..(BREITE * HOEHE) as usize {
            alle.extend_from_slice(&wort[..b]);
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &textur,
                mip_level: 0,
                // Die Schicht, die auch abgetastet wurde — sonst pruefte die
                // Gegenrichtung eine andere als Stufe 4.
                origin: wgpu::Origin3d { x: 0, y: 0, z: schicht },
                aspect: wgpu::TextureAspect::Plane0,
            },
            &alle,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(BREITE * b as u32),
                rows_per_image: Some(HOEHE),
            },
            wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
        );
        queue.submit([]);
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let erwartet_wort = u32::from(format.gespeichert(MARKE));
        match d3d11_luma_lesen(&quelle, schicht, &|_, _| erwartet_wort) {
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

/// Einen Durchgang zeichnen und die drei Kanaele je Bildpunkt zurueckgeben —
/// als Abtastwerte in [0,1], nicht als Rohbytes.
///
/// **Das Zielformat haengt an der Bittiefe der Quelle.** Ein 8-Bit-Ziel kappte
/// bei P010 die unteren zwei Bit und liesse damit genau den Fehler durch, um
/// den es bei 10 Bit geht: einen Weg, der still auf 8 Bit wandelt. Fuer NV12
/// bleibt es beim bisherigen `Rgba8Unorm`, damit die Zahlen mit den frueheren
/// Laeufen vergleichbar bleiben.
fn zeichnen(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    y_view: &wgpu::TextureView,
    uv_view: &wgpu::TextureView,
    zielformat: wgpu::TextureFormat,
) -> Vec<f64> {
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
            targets: &[Some(zielformat.into())],
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
        format: zielformat,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let ziel_view = ziel.create_view(&Default::default());
    // Byte je Bildpunkt am Ziel: 4 bei Rgba8Unorm, 16 bei Rgba32Float. Bei
    // 64 Punkten Breite sind beide Zeilenlaengen (256 bzw. 1024) bereits auf
    // 256 ausgerichtet — die von wgpu geforderte Schranke ist also ohne
    // Zwischenzeile eingehalten.
    let bpp: u32 = if zielformat == wgpu::TextureFormat::Rgba32Float { 16 } else { 4 };
    let puffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (BREITE * HOEHE * bpp) as u64,
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
                bytes_per_row: Some(BREITE * bpp),
                rows_per_image: Some(HOEHE),
            },
        },
        wgpu::Extent3d { width: BREITE, height: HOEHE, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);

    let slice = puffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let roh = slice.get_mapped_range().expect("Puffer nicht lesbar").to_vec();
    let _ = slice;
    puffer.unmap();

    // In den Abtastraum [0,1] umrechnen, drei Kanaele je Bildpunkt. Damit
    // spielt es fuer den Vergleich keine Rolle mehr, welches Ziel gerade
    // gefahren wurde — und die Toleranz laesst sich am QUELL-Format
    // festmachen, wo sie hingehoert.
    let mut werte = Vec::with_capacity((BREITE * HOEHE * 3) as usize);
    for i in 0..(BREITE * HOEHE) as usize {
        for k in 0..3usize {
            let wert = if bpp == 16 {
                let a = i * 16 + k * 4;
                f32::from_le_bytes([roh[a], roh[a + 1], roh[a + 2], roh[a + 3]]) as f64
            } else {
                roh[i * 4 + k] as f64 / 255.0
            };
            werte.push(wert);
        }
    }
    werte
}
