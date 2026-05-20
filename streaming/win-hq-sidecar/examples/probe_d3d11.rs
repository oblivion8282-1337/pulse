//! Diagnose: welche D3D11-NV12-Texturen akzeptiert die AMD-GPU, und welche
//! taugen als `ID3D11VideoProcessor`-Output? Ground-Truth-Probe für den
//! AMD-Schwarzbild-Fix — kein Raten.
//!
//! `cargo run --release --example probe_d3d11`

use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, D3D11_BIND_DECODER, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BIND_VIDEO_ENCODER, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
    D3D11_TEX2D_ARRAY_VPOV, D3D11_TEX2D_VPIV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2DARRAY, ID3D11Device, ID3D11Resource, ID3D11Texture2D,
    ID3D11VideoDevice, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView,
    ID3D11VideoProcessorOutputView,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1, IDXGIFactory1,
};
use windows::core::Interface;

fn main() {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.expect("CreateDXGIFactory1");
    let mut amd: Option<IDXGIAdapter1> = None;
    let mut idx = 0u32;
    loop {
        let a = match unsafe { factory.EnumAdapters1(idx) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => panic!("EnumAdapters1: {e}"),
        };
        idx += 1;
        let d = unsafe { a.GetDesc1() }.unwrap();
        let name = String::from_utf16_lossy(&d.Description)
            .trim_end_matches('\0')
            .to_string();
        println!("adapter: vendor=0x{:04X} {}", d.VendorId, name);
        if d.VendorId == 0x1002 {
            amd = Some(a);
        }
    }
    let amd = amd.expect("keine AMD-GPU gefunden");

    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            &amd,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
        .expect("D3D11CreateDevice (AMD)");
    }
    let device = device.unwrap();
    println!();

    for (n, f) in [("NV12", DXGI_FORMAT_NV12), ("BGRA", DXGI_FORMAT_B8G8R8A8_UNORM)] {
        let sup = unsafe { device.CheckFormatSupport(f) }.unwrap_or(0);
        // D3D11_FORMAT_SUPPORT: TEXTURE2D=0x20, RENDER_TARGET=0x4000? — wir
        // drucken hex + die zwei relevanten Bits laut d3d11.h.
        let rt = sup & 0x4000 != 0; // D3D11_FORMAT_SUPPORT_RENDER_TARGET
        let sr = sup & 0x80 != 0; // D3D11_FORMAT_SUPPORT_SHADER_SAMPLE
        println!("CheckFormatSupport {n}: 0x{sup:08X}  render_target={rt} shader_sample={sr}");
    }
    println!();

    let combos: [(&str, u32); 9] = [
        ("0", 0),
        ("SHADER_RESOURCE", D3D11_BIND_SHADER_RESOURCE.0 as u32),
        ("RENDER_TARGET", D3D11_BIND_RENDER_TARGET.0 as u32),
        ("VIDEO_ENCODER", D3D11_BIND_VIDEO_ENCODER.0 as u32),
        ("DECODER", D3D11_BIND_DECODER.0 as u32),
        (
            "RENDER_TARGET|VIDEO_ENCODER",
            (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
        ),
        (
            "SHADER_RESOURCE|VIDEO_ENCODER",
            (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
        ),
        (
            "DECODER|VIDEO_ENCODER",
            (D3D11_BIND_DECODER.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
        ),
        (
            "DECODER|RENDER_TARGET",
            (D3D11_BIND_DECODER.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
        ),
    ];

    // VideoProcessor-Enumerator (BGRA 1920x1080 → NV12 1920x1080) für den
    // OutputView-Test.
    let video_device: ID3D11VideoDevice = device.cast().expect("ID3D11VideoDevice");
    let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
        InputWidth: 1920,
        InputHeight: 1080,
        OutputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
        OutputWidth: 1920,
        OutputHeight: 1080,
        Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    };
    let vp_enum: ID3D11VideoProcessorEnumerator =
        unsafe { video_device.CreateVideoProcessorEnumerator(&content) }
            .expect("CreateVideoProcessorEnumerator");

    for arraysize in [1u32, 16] {
        for (name, bits) in combos {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: 1920,
                Height: 1080,
                MipLevels: 1,
                ArraySize: arraysize,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: bits,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut tex: Option<ID3D11Texture2D> = None;
            let create = unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex)) };
            let mut line = format!(
                "NV12 array={arraysize:<2} {name:30} CreateTexture2D={}",
                match &create {
                    Ok(_) => "OK   ".to_string(),
                    Err(e) => format!("0x{:08X}", e.code().0 as u32),
                }
            );
            // OutputView-Test nur wenn die Textur entstand.
            if let (Ok(_), Some(t)) = (&create, &tex) {
                let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
                    Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                        Texture2DArray: D3D11_TEX2D_ARRAY_VPOV {
                            MipSlice: 0,
                            FirstArraySlice: 0,
                            ArraySize: 1,
                        },
                    },
                };
                let res: ID3D11Resource = t.cast().unwrap();
                let mut view: Option<ID3D11VideoProcessorOutputView> = None;
                let ov = unsafe {
                    video_device.CreateVideoProcessorOutputView(
                        &res,
                        &vp_enum,
                        &ovd,
                        Some(&mut view),
                    )
                };
                line.push_str(&match ov {
                    Ok(_) => "  OutputView=OK".to_string(),
                    Err(e) => format!("  OutputView=0x{:08X}", e.code().0 as u32),
                });
            }
            println!("{line}");
        }
    }

    // ── BGRA-Capture-Pool: welche Textur akzeptiert CreateVideoProcessorInputView?
    println!();
    let bgra_combos: [(&str, u32); 4] = [
        ("0", 0),
        ("SHADER_RESOURCE", D3D11_BIND_SHADER_RESOURCE.0 as u32),
        ("RENDER_TARGET", D3D11_BIND_RENDER_TARGET.0 as u32),
        (
            "RENDER_TARGET|SHADER_RESOURCE",
            (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        ),
    ];
    let bgra_fourcc = DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32;
    for arraysize in [1u32, 24] {
        for (name, bits) in bgra_combos {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: 1920,
                Height: 1080,
                MipLevels: 1,
                ArraySize: arraysize,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: bits,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut tex: Option<ID3D11Texture2D> = None;
            let create = unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex)) };
            let mut line = format!(
                "BGRA array={arraysize:<2} {name:30} CreateTexture2D={}",
                match &create {
                    Ok(_) => "OK   ".to_string(),
                    Err(e) => format!("0x{:08X}", e.code().0 as u32),
                }
            );
            if let (Ok(_), Some(t)) = (&create, &tex) {
                let res: ID3D11Resource = t.cast().unwrap();
                for (fc_name, fc) in [("FourCC=0", 0u32), ("FourCC=DXGI", bgra_fourcc)] {
                    let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                        FourCC: fc,
                        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                        Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                            Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
                        },
                    };
                    let mut view: Option<ID3D11VideoProcessorInputView> = None;
                    let iv = unsafe {
                        video_device.CreateVideoProcessorInputView(
                            &res,
                            &vp_enum,
                            &ivd,
                            Some(&mut view),
                        )
                    };
                    line.push_str(&match iv {
                        Ok(_) => format!("  InputView[{fc_name}]=OK"),
                        Err(e) => format!("  InputView[{fc_name}]=0x{:08X}", e.code().0 as u32),
                    });
                }
            }
            println!("{line}");
        }
    }
}
