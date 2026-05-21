//! Diagnose: welche GPU treibt welchen Monitor (DXGI Adapter → Outputs).

use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput,
};

fn u16s(b: &[u16]) -> String {
    let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf16_lossy(&b[..n])
}

fn main() -> anyhow::Result<()> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut ai = 0u32;
    loop {
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(ai) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(e.into()),
        };
        let desc = unsafe { adapter.GetDesc1()? };
        println!("Adapter {ai}: {}", u16s(&desc.Description));
        let mut oi = 0u32;
        loop {
            let output: IDXGIOutput = match unsafe { adapter.EnumOutputs(oi) } {
                Ok(o) => o,
                Err(_) => break,
            };
            let od = unsafe { output.GetDesc()? };
            let r = od.DesktopCoordinates;
            println!(
                "    Output {oi}: {}  attached_to_desktop={}  {}x{} @ ({},{})",
                u16s(&od.DeviceName),
                od.AttachedToDesktop.as_bool(),
                r.right - r.left,
                r.bottom - r.top,
                r.left,
                r.top,
            );
            oi += 1;
        }
        if oi == 0 {
            println!("    (keine Outputs / treibt kein Display)");
        }
        ai += 1;
    }
    Ok(())
}
