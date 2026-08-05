//! Diagnose: **mit wie vielen Bit gibt Windows den Bildschirm heraus?**
//!
//! Die Frage kommt auf, sobald jemand einen 10-bit-Monitor betreibt und wissen
//! will, ob der HQ-Stream davon etwas mitbekommt. Sie zerfällt in zwei, die
//! leicht verwechselt werden — und die Verwechslung führt zu genau der falschen
//! Erwartung:
//!
//! 1. **Was geht über das Kabel?** `DXGI_OUTPUT_DESC1::BitsPerColor`. Das ist
//!    die Zahl, die im Treiber eingestellt wird; sie sagt aber nur, womit die
//!    Grafikkarte das Panel ansteuert.
//! 2. **In welchem Format setzt Windows den Desktop zusammen?** Das ist die
//!    Zahl, die für uns zählt: die Aufnahme (WGC wie Desktop Duplication)
//!    bekommt genau diese Fläche und **nicht mehr**. Sie steht in
//!    `DXGI_OUTDUPL_DESC::ModeDesc::Format`.
//!
//! Ein 10-bit-Signal am Kabel bei 8-bit-Zusammensetzung ist der Regelfall unter
//! SDR: die Karte streckt das fertige 8-bit-Bild auf das breitere Signal (und
//! kann dabei rauschmindern). Für einen Mitschnitt gewinnt das nichts. Erst mit
//! eingeschaltetem HDR („Advanced Color") setzt Windows in
//! `R16G16B16A16_FLOAT` zusammen, und dann ist eine BGRA8-Aufnahme wirklich
//! verlustbehaftet.
//!
//! Deshalb liest diese Probe beides nebeneinander aus, statt eine der beiden
//! Zahlen zu nennen und die andere gemeint zu haben.
//!
//! `cargo run --release --example probe_ausgabe_farbtiefe`

use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{D3D11CreateDevice, D3D11_SDK_VERSION, ID3D11Device};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
    DXGI_COLOR_SPACE_TYPE, DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM,
    DXGI_FORMAT_R10G10B10A2_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_R8G8B8A8_UNORM,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1,
    IDXGIOutput6,
};
use windows::core::Interface;

/// UTF-16-Puffer fester Länge mit Nullterminierung (`Description`,
/// `DeviceName`) — wie `u16s` in `list_outputs.rs`.
fn u16s(b: &[u16]) -> String {
    let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf16_lossy(&b[..n])
}

/// Die Formate, die als Desktop-Fläche überhaupt vorkommen. In der Ausgabe
/// ausgeschrieben statt als Zahl: `28` sagt niemandem etwas,
/// `R8G8B8A8_UNORM (8 bit)` schon.
fn format_name(f: DXGI_FORMAT) -> &'static str {
    match f {
        DXGI_FORMAT_B8G8R8A8_UNORM => "B8G8R8A8_UNORM (8 bit je Kanal)",
        DXGI_FORMAT_R8G8B8A8_UNORM => "R8G8B8A8_UNORM (8 bit je Kanal)",
        DXGI_FORMAT_R10G10B10A2_UNORM => "R10G10B10A2_UNORM (10 bit je Kanal)",
        DXGI_FORMAT_R16G16B16A16_FLOAT => "R16G16B16A16_FLOAT (Gleitkomma, HDR-Zusammensetzung)",
        _ => "unbekannt",
    }
}

/// `DXGI_COLOR_SPACE_TYPE` — nur die beiden, die am Desktop vorkommen.
fn farbraum_name(cs: DXGI_COLOR_SPACE_TYPE) -> &'static str {
    match cs {
        DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 => "RGB_FULL_G22_NONE_P709 (SDR)",
        DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020 => "RGB_FULL_G2084_NONE_P2020 (HDR aktiv)",
        _ => "anderer",
    }
}

fn main() {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.expect("CreateDXGIFactory1");
    let mut ai = 0u32;
    loop {
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(ai) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => {
                eprintln!("EnumAdapters1: {e}");
                break;
            }
        };
        ai += 1;
        let ad = unsafe { adapter.GetDesc1() }.expect("GetDesc1");
        let adapter_name = u16s(&ad.Description);

        let mut oi = 0u32;
        loop {
            let output = match unsafe { adapter.EnumOutputs(oi) } {
                Ok(o) => o,
                Err(_) => break,
            };
            oi += 1;

            let Ok(o6) = output.cast::<IDXGIOutput6>() else { continue };
            let Ok(d1) = (unsafe { o6.GetDesc1() }) else { continue };
            if !d1.AttachedToDesktop.as_bool() {
                continue;
            }
            let geraet = u16s(&d1.DeviceName);
            println!("\n== {geraet}  ({adapter_name})");
            println!(
                "   Signal:         {} bit je Kanal, {}",
                d1.BitsPerColor,
                farbraum_name(d1.ColorSpace)
            );

            // Die Zusammensetzung selbst. Dafür braucht es ein D3D11-Device auf
            // DIESEM Adapter — Desktop Duplication verlangt, dass Device und
            // Ausgang zur selben Karte gehören.
            let mut device: Option<ID3D11Device> = None;
            let hr = unsafe {
                D3D11CreateDevice(
                    &adapter,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    HMODULE::default(),
                    Default::default(),
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    None,
                )
            };
            let (Ok(()), Some(device)) = (hr, device) else {
                println!("   Zusammensetzung: D3D11-Device auf dieser Karte nicht erstellbar");
                continue;
            };
            let Ok(o1) = output.cast::<IDXGIOutput1>() else { continue };
            match unsafe { o1.DuplicateOutput(&device) } {
                Ok(dupl) => {
                    let dd = unsafe { dupl.GetDesc() };
                    println!(
                        "   Zusammensetzung: {}  <- so viel bekommt die Aufnahme",
                        format_name(dd.ModeDesc.Format)
                    );
                }
                // Kein Grund zur Sorge und kein Messfehler: die Vervielfältigung
                // ist exklusiv, und eine zweite Aufnahme (oder eine laufende
                // Pulse-Sitzung) hält sie schon.
                Err(e) => println!("   Zusammensetzung: nicht abfragbar ({e})"),
            }
        }
    }
    println!(
        "\nMerksatz: nur die zweite Zeile zählt für einen Mitschnitt. Ein 10-bit-Signal bei \n\
         8-bit-Zusammensetzung heisst, dass die Karte ein fertiges 8-bit-Bild breiter ausgibt."
    );
}
