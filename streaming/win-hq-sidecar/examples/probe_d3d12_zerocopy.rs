//! Diagnose-Probe: Cross-API-Brücke + GPU-BGRA→NV12-Converter (AMD Phase 2).
//!
//! Phase 1 des AMD-Pfads ist kein Zero-Copy: VRAM→RAM-Readback + CPU-swscale
//! (~15 ms/Frame). Phase 2 (Plan B2): die Capture bleibt zwangsläufig D3D11
//! (Windows hat keine D3D12-Bildschirmaufnahme), alles danach läuft D3D12-only:
//!
//!   WGC → ID3D11Texture2D (BGRA)
//!     └─ Shared-NT-Handle (BGRA, D3D11→D3D12)
//!          └─ ID3D12Resource (BGRA) → D3D12-Compute BGRA→NV12 → h264_d3d12va
//!
//! Diese Probe validiert zwei Dinge isoliert, bevor die Pipeline integriert
//! wird:
//!   [R1'] BGRA D3D11→D3D12: lässt sich eine in D3D11 erzeugte BGRA-Textur per
//!         Shared-NT-Handle in D3D12 öffnen?
//!   [R2'] `encode::d3d12_convert::Nv12Converter`: rechnet der D3D12-Compute-
//!         Shader eine BGRA-Surface korrekt nach NV12 (Y-Plane-Readback)?
//!
//! `cargo run --release --example probe_d3d12_zerocopy`

use anyhow::{Context as _, Result, anyhow};
use std::mem::ManuallyDrop;

use pulse_win_hq_sidecar::encode::d3d12_convert::Nv12Converter;
use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter, IDXGIFactory1, IDXGIResource1,
};
use windows::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};
use windows::core::{Interface, PCWSTR};

const W: u32 = 1920;
const H: u32 = 1080;
/// BGRA-Testfüllung: Mittelgrau. BT.709-limited → Y ≈ 125.
const GRAY: u8 = 128;

fn main() {
    println!("=== Probe: BGRA-Brücke + GPU-Converter (AMD Phase 2 / B2) ===\n");
    match run() {
        Ok(()) => println!(
            "\n=== VERDICT: PASS ===\n\
             [R1'] BGRA D3D11→D3D12-Brücke trägt.\n\
             [R2'] Der D3D12-Compute-Converter rechnet BGRA→NV12 korrekt.\n\
             Der Zero-Copy-Pfad kann auf diesen Bausteinen integriert werden."
        ),
        Err(e) => {
            println!("\n=== VERDICT: FAIL ===\n{e:#}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<()> {
    // [1] AMD-Adapter.
    println!("[1] AMD-Adapter");
    let adapter = amd_adapter()?;
    let desc = unsafe { adapter.GetDesc() }.context("GetDesc")?;
    println!(
        "    → {} (0x{:04X})\n",
        String::from_utf16_lossy(&desc.Description).trim_end_matches('\0'),
        desc.VendorId
    );

    // [2] D3D11- + D3D12-Device (selber Adapter).
    println!("[2] D3D11- + D3D12-Device");
    let (d3d11, d3d11_ctx) = create_d3d11_device(&adapter)?;
    let mut d3d12: Option<ID3D12Device> = None;
    unsafe { D3D12CreateDevice(&adapter, D3D_FEATURE_LEVEL_11_1, &mut d3d12) }
        .context("D3D12CreateDevice")?;
    let d3d12 = d3d12.ok_or_else(|| anyhow!("D3D12-Device NULL"))?;
    println!("    ok\n");

    // [3] D3D11-BGRA-Textur, teilbar, mit Mittelgrau gefüllt.
    println!("[3] D3D11-BGRA-Textur (SHARED, Mittelgrau-Füllung)");
    let bgra11 = create_bgra_d3d11(&d3d11)?;
    flush_d3d11(&d3d11, &d3d11_ctx)?; // Füll-Upload GPU-fertig vor dem D3D12-Lesen
    println!("    ok\n");

    // [4] [R1'] BGRA per Shared-NT-Handle in D3D12 öffnen.
    println!("[4] [R1'] BGRA-Shared-Handle → D3D12");
    let dxgi_res: IDXGIResource1 = bgra11.cast().context("BGRA als IDXGIResource1")?;
    let handle: HANDLE =
        unsafe { dxgi_res.CreateSharedHandle(None, GENERIC_ALL.0, PCWSTR::null()) }
            .context("CreateSharedHandle")?;
    let mut bgra12: Option<ID3D12Resource> = None;
    unsafe { d3d12.OpenSharedHandle(handle, &mut bgra12) }
        .context("OpenSharedHandle(BGRA)")?;
    let bgra12 = bgra12.ok_or_else(|| anyhow!("D3D12-BGRA-Resource NULL"))?;
    unsafe { CloseHandle(handle) }.ok();
    println!("    [R1'] PASS — BGRA cross-API in D3D12 geöffnet\n");

    // [5] D3D12-NV12-Zielresource (UAV-fähig — der Compute-Shader schreibt rein).
    println!("[5] D3D12-NV12-Resource (ALLOW_UNORDERED_ACCESS)");
    let nv12 = create_nv12_d3d12(&d3d12)?;
    println!("    ok\n");

    // [6] [R2'] Converter laufen lassen.
    println!("[6] [R2'] Nv12Converter::convert (BGRA→NV12, GPU-Compute)");
    let mut converter = Nv12Converter::new(d3d12.clone(), W, H).context("Nv12Converter::new")?;
    converter.convert(&bgra12, &nv12).context("Nv12Converter::convert")?;
    println!("    convert ok\n");

    // [7] NV12-Y-Plane zurücklesen + prüfen.
    println!("[7] NV12-Y-Plane-Readback (Content-Sanity)");
    let y_mean = readback_y_mean(&d3d12, &nv12)?;
    println!("    Y-Mittelwert = {y_mean:.1} (erwartet ~125 für Mittelgrau)");
    if !(105.0..=145.0).contains(&y_mean) {
        return Err(anyhow!(
            "[R2'] FAIL — Y-Mittelwert {y_mean:.1} außerhalb [105,145]. \
             Compute-Shader rechnete falsch oder schrieb die falsche Surface."
        ));
    }
    println!("    [R2'] PASS — Converter rechnet BGRA→NV12 korrekt");
    Ok(())
}

// ── DXGI / Devices ──────────────────────────────────────────────────────────

fn amd_adapter() -> Result<IDXGIAdapter> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.context("CreateDXGIFactory1")?;
    let mut idx = 0u32;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(idx) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(anyhow!("EnumAdapters1: {e}")),
        };
        let desc = unsafe { adapter.GetDesc1() }.context("GetDesc1")?;
        if desc.VendorId == 0x1002 {
            return Ok(adapter.cast().context("cast IDXGIAdapter")?);
        }
        idx += 1;
    }
    Err(anyhow!("keine AMD-GPU (DXGI-Vendor 0x1002) gefunden"))
}

fn create_d3d11_device(adapter: &IDXGIAdapter) -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    let mut device: Option<ID3D11Device> = None;
    let mut ctx: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_1]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )
    }
    .context("D3D11CreateDevice")?;
    Ok((
        device.ok_or_else(|| anyhow!("D3D11-Device NULL"))?,
        ctx.ok_or_else(|| anyhow!("D3D11-Context NULL"))?,
    ))
}

/// Teilbare D3D11-BGRA-Textur, komplett mit Mittelgrau gefüllt (Init-Daten).
fn create_bgra_d3d11(device: &ID3D11Device) -> Result<ID3D11Texture2D> {
    let pixels = vec![GRAY; (W * H * 4) as usize];
    let desc = D3D11_TEXTURE2D_DESC {
        Width: W,
        Height: H,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
            | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
    };
    let init = D3D11_SUBRESOURCE_DATA {
        pSysMem: pixels.as_ptr() as *const _,
        SysMemPitch: W * 4,
        SysMemSlicePitch: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut tex)) }
        .context("CreateTexture2D(BGRA shared)")?;
    tex.ok_or_else(|| anyhow!("BGRA-Textur NULL"))
}

/// Wartet (CPU) bis alle D3D11-GPU-Befehle fertig sind.
fn flush_d3d11(device: &ID3D11Device, ctx: &ID3D11DeviceContext) -> Result<()> {
    let device5: ID3D11Device5 = device.cast().context("cast ID3D11Device5")?;
    let ctx4: ID3D11DeviceContext4 = ctx.cast().context("cast ID3D11DeviceContext4")?;
    let mut fence: Option<ID3D11Fence> = None;
    unsafe { device5.CreateFence(0, D3D11_FENCE_FLAG_NONE, &mut fence) }
        .context("ID3D11Device5::CreateFence")?;
    let fence = fence.ok_or_else(|| anyhow!("D3D11-Fence NULL"))?;
    let event = unsafe { CreateEventW(None, false, false, None) }.context("CreateEventW")?;
    unsafe {
        ctx4.Signal(&fence, 1).context("D3D11 Signal")?;
        ctx.Flush();
        fence.SetEventOnCompletion(1, event).context("SetEventOnCompletion")?;
        WaitForSingleObject(event, INFINITE);
        CloseHandle(event).ok();
    }
    Ok(())
}

// ── D3D12-Hilfen ────────────────────────────────────────────────────────────

fn default_heap(heap_type: D3D12_HEAP_TYPE) -> D3D12_HEAP_PROPERTIES {
    D3D12_HEAP_PROPERTIES {
        Type: heap_type,
        CPUPageProperty: D3D12_CPU_PAGE_PROPERTY_UNKNOWN,
        MemoryPoolPreference: D3D12_MEMORY_POOL_UNKNOWN,
        CreationNodeMask: 0,
        VisibleNodeMask: 0,
    }
}

/// NV12-D3D12-Resource in W×H, UAV-fähig (der Compute-Shader schreibt rein).
fn create_nv12_d3d12(device: &ID3D12Device) -> Result<ID3D12Resource> {
    let desc = D3D12_RESOURCE_DESC {
        Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
        Alignment: 0,
        Width: W as u64,
        Height: H,
        DepthOrArraySize: 1,
        MipLevels: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
        Flags: D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS,
    };
    let mut res: Option<ID3D12Resource> = None;
    unsafe {
        device.CreateCommittedResource(
            &default_heap(D3D12_HEAP_TYPE_DEFAULT),
            D3D12_HEAP_FLAG_NONE,
            &desc,
            D3D12_RESOURCE_STATE_COMMON,
            None,
            &mut res,
        )
    }
    .context("CreateCommittedResource(NV12) — ALLOW_UNORDERED_ACCESS auf NV12 abgelehnt?")?;
    res.ok_or_else(|| anyhow!("NV12-Resource NULL"))
}

/// Kopiert die NV12-Y-Plane in einen Readback-Buffer und mittelt sie.
fn readback_y_mean(device: &ID3D12Device, nv12: &ID3D12Resource) -> Result<f64> {
    let nv12_desc = unsafe { nv12.GetDesc() };
    let mut footprint = D3D12_PLACED_SUBRESOURCE_FOOTPRINT::default();
    let mut num_rows = 0u32;
    let mut row_size = 0u64;
    let mut total = 0u64;
    unsafe {
        device.GetCopyableFootprints(
            &nv12_desc,
            0, // Subresource 0 = Y-Plane
            1,
            0,
            Some(&mut footprint),
            Some(&mut num_rows),
            Some(&mut row_size),
            Some(&mut total),
        );
    }

    // Readback-Buffer.
    let buf_desc = D3D12_RESOURCE_DESC {
        Dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
        Alignment: 0,
        Width: total,
        Height: 1,
        DepthOrArraySize: 1,
        MipLevels: 1,
        Format: DXGI_FORMAT_UNKNOWN,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
        Flags: D3D12_RESOURCE_FLAG_NONE,
    };
    let mut readback: Option<ID3D12Resource> = None;
    unsafe {
        device.CreateCommittedResource(
            &default_heap(D3D12_HEAP_TYPE_READBACK),
            D3D12_HEAP_FLAG_NONE,
            &buf_desc,
            D3D12_RESOURCE_STATE_COPY_DEST,
            None,
            &mut readback,
        )
    }
    .context("CreateCommittedResource(readback)")?;
    let readback = readback.ok_or_else(|| anyhow!("Readback-Buffer NULL"))?;

    // Command-List für die Kopie.
    let queue: ID3D12CommandQueue = unsafe {
        device.CreateCommandQueue(&D3D12_COMMAND_QUEUE_DESC {
            Type: D3D12_COMMAND_LIST_TYPE_DIRECT,
            Priority: 0,
            Flags: D3D12_COMMAND_QUEUE_FLAG_NONE,
            NodeMask: 0,
        })
    }
    .context("CreateCommandQueue")?;
    let allocator: ID3D12CommandAllocator =
        unsafe { device.CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT) }
            .context("CreateCommandAllocator")?;
    let list: ID3D12GraphicsCommandList = unsafe {
        device.CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, &allocator, None)
    }
    .context("CreateCommandList")?;

    let dst = D3D12_TEXTURE_COPY_LOCATION {
        pResource: ManuallyDrop::new(Some(readback.clone())),
        Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
        Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { PlacedFootprint: footprint },
    };
    let src = D3D12_TEXTURE_COPY_LOCATION {
        pResource: ManuallyDrop::new(Some(nv12.clone())),
        Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
        Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { SubresourceIndex: 0 },
    };
    unsafe {
        list.ResourceBarrier(&[transition(
            nv12,
            D3D12_RESOURCE_STATE_COMMON,
            D3D12_RESOURCE_STATE_COPY_SOURCE,
        )]);
        list.CopyTextureRegion(&dst, 0, 0, 0, &src, None);
        list.ResourceBarrier(&[transition(
            nv12,
            D3D12_RESOURCE_STATE_COPY_SOURCE,
            D3D12_RESOURCE_STATE_COMMON,
        )]);
        list.Close().context("CommandList::Close")?;
        let cl: ID3D12CommandList = list.cast().context("cast ID3D12CommandList")?;
        queue.ExecuteCommandLists(&[Some(cl)]);
    }
    // Fence-Wait.
    let fence: ID3D12Fence =
        unsafe { device.CreateFence(0, D3D12_FENCE_FLAG_NONE) }.context("CreateFence")?;
    let event = unsafe { CreateEventW(None, false, false, None) }.context("CreateEventW")?;
    unsafe {
        queue.Signal(&fence, 1).context("Queue::Signal")?;
        fence.SetEventOnCompletion(1, event).context("SetEventOnCompletion")?;
        WaitForSingleObject(event, INFINITE);
        CloseHandle(event).ok();
    }

    // Map + Y-Plane mitteln.
    let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    unsafe {
        readback
            .Map(0, Some(&D3D12_RANGE { Begin: 0, End: total as usize }), Some(&mut ptr))
            .context("Map(readback)")?;
    }
    let pitch = footprint.Footprint.RowPitch as usize;
    let (mut sum, mut n) = (0u64, 0u64);
    unsafe {
        let base = ptr as *const u8;
        for row in (0..num_rows as usize).step_by(16) {
            for col in (0..row_size as usize).step_by(16) {
                sum += *base.add(row * pitch + col) as u64;
                n += 1;
            }
        }
        readback.Unmap(0, None);
    }
    Ok(sum as f64 / n.max(1) as f64)
}

/// Transition-Barrier (geklonter `pResource`-Ref wird in dieser One-Shot-Probe
/// bewusst geleakt — der Prozess endet gleich danach).
fn transition(
    resource: &ID3D12Resource,
    before: D3D12_RESOURCE_STATES,
    after: D3D12_RESOURCE_STATES,
) -> D3D12_RESOURCE_BARRIER {
    D3D12_RESOURCE_BARRIER {
        Type: D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
        Flags: D3D12_RESOURCE_BARRIER_FLAG_NONE,
        Anonymous: D3D12_RESOURCE_BARRIER_0 {
            Transition: ManuallyDrop::new(D3D12_RESOURCE_TRANSITION_BARRIER {
                pResource: ManuallyDrop::new(Some(resource.clone())),
                Subresource: D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                StateBefore: before,
                StateAfter: after,
            }),
        },
    }
}
