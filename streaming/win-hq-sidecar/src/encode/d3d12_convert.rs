//! GPU-Farbraumkonvertierung BGRA→NV12 über einen D3D12-Compute-Shader.
//!
//! Teil des AMD-Zero-Copy-Pfads (Phase 2). Die Capture liefert zwangsläufig
//! D3D11-BGRA (Windows hat keine D3D12-Bildschirmaufnahme); die BGRA-Textur
//! wird per Shared-NT-Handle nach D3D12 gebrückt. Der `h264_d3d12va`-Encoder
//! will aber NV12. Dieser Converter rechnet BGRA→NV12 **auf der GPU** —
//! Compute-Pipeline, kein PCIe-Roundtrip, kein CPU-swscale.
//!
//! Bewusst ein Compute-Shader statt `ID3D12VideoProcessor`: Letzterer ist ein
//! treiber-implementierter Videoblock — dieselbe Risikoklasse wie der
//! AMF-Runtime-Bug (#455), der den AMD-Pfad überhaupt erst nötig machte. Der
//! Compute-Shader läuft auf der generischen Compute-Pipeline (robust) und die
//! Farbgebung (BT.709 limited) steht in *unserem* Code — exakt wie der
//! bisherige swscale-Pfad, kein Farbsprung beim Umschalten Phase 1→2.
//!
//! Downscale: der Shader liest die Quelle über einen Bilinear-Sampler, die
//! Ziel-Auflösung bestimmt das Sampling-Gitter — Resize gratis, gleiche
//! Qualität wie `swscale`-`BILINEAR`.

use anyhow::{Context, Result, anyhow};
use std::mem::ManuallyDrop;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::ID3DBlob;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM,
};
use windows::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};
use windows::core::{Interface, s};

/// BGRA→NV12, BT.709 limited-range. Ein Thread pro 2×2-Luma-Block: schreibt
/// 4 Y-Werte (volle Auflösung) + 1 gemittelten UV-Wert (halbe Auflösung).
const SHADER_HLSL: &str = r#"
Texture2D<float4>   Src   : register(t0);
RWTexture2D<float>  DstY  : register(u0);
RWTexture2D<float2> DstUV : register(u1);
SamplerState        Samp  : register(s0);
cbuffer Params : register(b0) { uint DstW; uint DstH; }

float3 rgb_to_yuv709_limited(float3 rgb) {
    float y = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
    float u = (rgb.b - y) * 0.5389; // 1/1.8556
    float v = (rgb.r - y) * 0.6350; // 1/1.5748
    y = y * (219.0 / 255.0) + (16.0 / 255.0);
    u = u * (224.0 / 255.0) + (128.0 / 255.0);
    v = v * (224.0 / 255.0) + (128.0 / 255.0);
    return float3(y, u, v);
}

[numthreads(8, 8, 1)]
void main(uint3 tid : SV_DispatchThreadID) {
    uint2 blk = tid.xy; // 2x2-Luma-Block
    if (blk.x * 2 >= DstW || blk.y * 2 >= DstH) return;
    float2 inv = float2(1.0 / DstW, 1.0 / DstH);
    float3 sum = float3(0, 0, 0);
    [unroll] for (uint dy = 0; dy < 2; dy++) {
        [unroll] for (uint dx = 0; dx < 2; dx++) {
            uint2 px = uint2(blk.x * 2 + dx, blk.y * 2 + dy);
            float2 uv = (float2(px) + 0.5) * inv;
            float3 yuv = rgb_to_yuv709_limited(Src.SampleLevel(Samp, uv, 0).rgb);
            DstY[px] = yuv.x;
            sum += yuv;
        }
    }
    DstUV[blk] = (sum * 0.25).yz;
}
"#;

/// GPU-BGRA→NV12-Converter. Besitzt Root-Signature, Compute-PSO, einen
/// Descriptor-Heap (3 Slots: SRV + 2 UAVs) und eine eigene Command-Queue +
/// Fence. `convert()` ist synchron (CPU-Wait auf die Fence) — der Stall ist
/// sub-ms, der eingesparte CPU-swscale war ~15 ms.
pub struct Nv12Converter {
    device: ID3D12Device,
    root_sig: ID3D12RootSignature,
    pso: ID3D12PipelineState,
    queue: ID3D12CommandQueue,
    allocator: ID3D12CommandAllocator,
    list: ID3D12GraphicsCommandList,
    heap: ID3D12DescriptorHeap,
    descriptor_size: u32,
    fence: ID3D12Fence,
    fence_event: windows::Win32::Foundation::HANDLE,
    fence_value: u64,
    dst_w: u32,
    dst_h: u32,
}

// COM-Pointer sind Heap-Adressen; der Converter wird vom Pacing-Thread allein
// benutzt (kein geteilter Zugriff) — `convert()` nimmt `&mut self`.
unsafe impl Send for Nv12Converter {}

impl Nv12Converter {
    /// Baut die Compute-Pipeline auf `device` (= FFmpegs D3D12-Device, damit
    /// alle Resources auf derselben GPU/demselben Device liegen). `dst_w`/
    /// `dst_h` ist die NV12-Zielauflösung (≤ Capture-Auflösung = Downscale).
    pub fn new(device: ID3D12Device, dst_w: u32, dst_h: u32) -> Result<Self> {
        // Der Compute-Shader rechnet in 2x2-Luma-Blöcken (ein Thread pro Block,
        // s. `SHADER_HLSL` oben) — bei ungeraden Zielmaßen würde der letzte
        // Block über den Puffer hinausschreiben. Alle heutigen Aufrufer runden
        // vorher ab (`fit_within_box`), aber der Konstruktor selbst prüfte das
        // bislang nicht — hier als letzte Verteidigungslinie.
        anyhow::ensure!(
            dst_w % 2 == 0 && dst_h % 2 == 0,
            "NV12 braucht gerade Zielmaße, bekam {dst_w}x{dst_h}"
        );
        let shader = compile_shader()?;
        let root_sig = create_root_signature(&device)?;
        let pso = create_pso(&device, &root_sig, &shader)?;

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
            device.CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, &allocator, &pso)
        }
        .context("CreateCommandList")?;
        unsafe { list.Close() }.context("CommandList::Close (initial)")?;

        let heap: ID3D12DescriptorHeap = unsafe {
            device.CreateDescriptorHeap(&D3D12_DESCRIPTOR_HEAP_DESC {
                Type: D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV,
                NumDescriptors: 3,
                Flags: D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE,
                NodeMask: 0,
            })
        }
        .context("CreateDescriptorHeap")?;
        let descriptor_size =
            unsafe { device.GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV) };

        let fence: ID3D12Fence = unsafe { device.CreateFence(0, D3D12_FENCE_FLAG_NONE) }
            .context("CreateFence")?;
        let fence_event = unsafe { CreateEventW(None, false, false, None) }
            .context("CreateEventW")?;

        Ok(Self {
            device,
            root_sig,
            pso,
            queue,
            allocator,
            list,
            heap,
            descriptor_size,
            fence,
            fence_event,
            fence_value: 0,
            dst_w,
            dst_h,
        })
    }

    /// Konvertiert `bgra` (B8G8R8A8-D3D12-Resource, beliebige Auflösung ≥ dst)
    /// nach `nv12` (NV12-D3D12-Resource in dst-Auflösung). `nv12` MUSS mit
    /// `D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS` erzeugt sein. Synchron:
    /// kehrt erst zurück, wenn die GPU fertig ist (Fence-Wait).
    pub fn convert(&mut self, bgra: &ID3D12Resource, nv12: &ID3D12Resource) -> Result<()> {
        // SRV (BGRA) + 2 UAVs (Y-/UV-Ebene) in die Heap-Slots 0/1/2 schreiben.
        let cpu0 = unsafe { self.heap.GetCPUDescriptorHandleForHeapStart() };
        let slot = |i: u32| D3D12_CPU_DESCRIPTOR_HANDLE {
            ptr: cpu0.ptr + (i * self.descriptor_size) as usize,
        };
        unsafe {
            self.device.CreateShaderResourceView(
                bgra,
                Some(&D3D12_SHADER_RESOURCE_VIEW_DESC {
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    ViewDimension: D3D12_SRV_DIMENSION_TEXTURE2D,
                    Shader4ComponentMapping: D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING,
                    Anonymous: D3D12_SHADER_RESOURCE_VIEW_DESC_0 {
                        Texture2D: D3D12_TEX2D_SRV {
                            MostDetailedMip: 0,
                            MipLevels: 1,
                            PlaneSlice: 0,
                            ResourceMinLODClamp: 0.0,
                        },
                    },
                }),
                slot(0),
            );
            self.device.CreateUnorderedAccessView(
                nv12,
                None,
                Some(&uav_desc(DXGI_FORMAT_R8_UNORM, 0)),
                slot(1),
            );
            self.device.CreateUnorderedAccessView(
                nv12,
                None,
                Some(&uav_desc(DXGI_FORMAT_R8G8_UNORM, 1)),
                slot(2),
            );
        }

        // Command-List aufzeichnen.
        unsafe {
            self.allocator.Reset().context("CommandAllocator::Reset")?;
            self.list
                .Reset(&self.allocator, &self.pso)
                .context("CommandList::Reset")?;

            // bgra → NON_PIXEL_SHADER_RESOURCE, nv12 → UNORDERED_ACCESS.
            let to_compute = [
                transition(bgra, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE),
                transition(nv12, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_UNORDERED_ACCESS),
            ];
            self.list.ResourceBarrier(&to_compute);
            drop_barriers(to_compute);

            self.list.SetComputeRootSignature(&self.root_sig);
            self.list.SetDescriptorHeaps(&[Some(self.heap.clone())]);
            self.list
                .SetComputeRoot32BitConstant(0, self.dst_w, 0);
            self.list
                .SetComputeRoot32BitConstant(0, self.dst_h, 1);
            self.list
                .SetComputeRootDescriptorTable(1, self.heap.GetGPUDescriptorHandleForHeapStart());

            // 8×8 Threads pro Gruppe, ein Thread pro 2×2-Block.
            let groups_x = self.dst_w.div_ceil(2).div_ceil(8);
            let groups_y = self.dst_h.div_ceil(2).div_ceil(8);
            self.list.Dispatch(groups_x, groups_y, 1);

            // Zurück nach COMMON — neutraler Übergabe-Zustand an den Encoder
            // bzw. den nächsten Capture-Schreiber.
            let to_common = [
                transition(bgra, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_COMMON),
                transition(nv12, D3D12_RESOURCE_STATE_UNORDERED_ACCESS, D3D12_RESOURCE_STATE_COMMON),
            ];
            self.list.ResourceBarrier(&to_common);
            drop_barriers(to_common);

            self.list.Close().context("CommandList::Close")?;
        }

        // Ausführen + auf Abschluss warten.
        unsafe {
            let cl: ID3D12CommandList = self.list.cast().context("cast ID3D12CommandList")?;
            self.queue.ExecuteCommandLists(&[Some(cl)]);
            self.fence_value += 1;
            self.queue
                .Signal(&self.fence, self.fence_value)
                .context("CommandQueue::Signal")?;
            if self.fence.GetCompletedValue() < self.fence_value {
                self.fence
                    .SetEventOnCompletion(self.fence_value, self.fence_event)
                    .context("SetEventOnCompletion")?;
                WaitForSingleObject(self.fence_event, INFINITE);
            }
        }
        Ok(())
    }
}

impl Drop for Nv12Converter {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.fence_event);
        }
    }
}

/// UAV-Desc für eine NV12-Plane (`plane` 0 = Y/R8, 1 = UV/R8G8).
fn uav_desc(format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT, plane: u32)
    -> D3D12_UNORDERED_ACCESS_VIEW_DESC {
    D3D12_UNORDERED_ACCESS_VIEW_DESC {
        Format: format,
        ViewDimension: D3D12_UAV_DIMENSION_TEXTURE2D,
        Anonymous: D3D12_UNORDERED_ACCESS_VIEW_DESC_0 {
            Texture2D: D3D12_TEX2D_UAV { MipSlice: 0, PlaneSlice: plane },
        },
    }
}

/// Transition-Barrier. Der `pResource`-Slot ist ein `ManuallyDrop<Option<…>>`
/// mit einem geklonten (AddRef'd) Ref — nach `ResourceBarrier` per
/// `drop_barriers` freigeben, sonst COM-Leak pro Frame.
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

/// Gibt die geklonten `pResource`-Refs der Barrier frei (s. `transition`).
fn drop_barriers<const N: usize>(barriers: [D3D12_RESOURCE_BARRIER; N]) {
    for b in barriers {
        unsafe {
            let mut t = ManuallyDrop::into_inner(b.Anonymous.Transition);
            ManuallyDrop::drop(&mut t.pResource);
        }
    }
}

/// Compiliert den HLSL-Compute-Shader zur Laufzeit (`d3dcompiler`).
fn compile_shader() -> Result<ID3DBlob> {
    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let hr = unsafe {
        D3DCompile(
            SHADER_HLSL.as_ptr() as *const _,
            SHADER_HLSL.len(),
            s!("nv12_convert"),
            None,
            None,
            s!("main"),
            s!("cs_5_0"),
            0,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    if hr.is_err() {
        let msg = errors
            .map(|e| unsafe {
                let p = e.GetBufferPointer() as *const u8;
                let n = e.GetBufferSize();
                String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned()
            })
            .unwrap_or_default();
        return Err(anyhow!("D3DCompile (nv12_convert) failed: {hr:?} — {msg}"));
    }
    code.ok_or_else(|| anyhow!("D3DCompile lieferte kein Bytecode-Blob"))
}

/// Root-Signature: Param 0 = 2 Root-Konstanten (DstW/DstH @ b0), Param 1 =
/// Descriptor-Table (1 SRV @ t0 + 2 UAVs @ u0-u1), 1 statischer Bilinear-
/// Sampler @ s0.
fn create_root_signature(device: &ID3D12Device) -> Result<ID3D12RootSignature> {
    let ranges = [
        D3D12_DESCRIPTOR_RANGE {
            RangeType: D3D12_DESCRIPTOR_RANGE_TYPE_SRV,
            NumDescriptors: 1,
            BaseShaderRegister: 0,
            RegisterSpace: 0,
            OffsetInDescriptorsFromTableStart: 0,
        },
        D3D12_DESCRIPTOR_RANGE {
            RangeType: D3D12_DESCRIPTOR_RANGE_TYPE_UAV,
            NumDescriptors: 2,
            BaseShaderRegister: 0,
            RegisterSpace: 0,
            OffsetInDescriptorsFromTableStart: 1,
        },
    ];
    let params = [
        D3D12_ROOT_PARAMETER {
            ParameterType: D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS,
            Anonymous: D3D12_ROOT_PARAMETER_0 {
                Constants: D3D12_ROOT_CONSTANTS {
                    ShaderRegister: 0,
                    RegisterSpace: 0,
                    Num32BitValues: 2,
                },
            },
            ShaderVisibility: D3D12_SHADER_VISIBILITY_ALL,
        },
        D3D12_ROOT_PARAMETER {
            ParameterType: D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE,
            Anonymous: D3D12_ROOT_PARAMETER_0 {
                DescriptorTable: D3D12_ROOT_DESCRIPTOR_TABLE {
                    NumDescriptorRanges: ranges.len() as u32,
                    pDescriptorRanges: ranges.as_ptr(),
                },
            },
            ShaderVisibility: D3D12_SHADER_VISIBILITY_ALL,
        },
    ];
    let sampler = D3D12_STATIC_SAMPLER_DESC {
        Filter: D3D12_FILTER_MIN_MAG_MIP_LINEAR,
        AddressU: D3D12_TEXTURE_ADDRESS_MODE_CLAMP,
        AddressV: D3D12_TEXTURE_ADDRESS_MODE_CLAMP,
        AddressW: D3D12_TEXTURE_ADDRESS_MODE_CLAMP,
        MipLODBias: 0.0,
        MaxAnisotropy: 0,
        ComparisonFunc: D3D12_COMPARISON_FUNC_NEVER,
        BorderColor: D3D12_STATIC_BORDER_COLOR_OPAQUE_BLACK,
        MinLOD: 0.0,
        MaxLOD: 0.0,
        ShaderRegister: 0,
        RegisterSpace: 0,
        ShaderVisibility: D3D12_SHADER_VISIBILITY_ALL,
    };
    let desc = D3D12_ROOT_SIGNATURE_DESC {
        NumParameters: params.len() as u32,
        pParameters: params.as_ptr(),
        NumStaticSamplers: 1,
        pStaticSamplers: &sampler,
        Flags: D3D12_ROOT_SIGNATURE_FLAG_NONE,
    };

    let mut blob: Option<ID3DBlob> = None;
    let mut err: Option<ID3DBlob> = None;
    unsafe {
        D3D12SerializeRootSignature(
            &desc,
            D3D_ROOT_SIGNATURE_VERSION_1,
            &mut blob,
            Some(&mut err),
        )
    }
    .context("D3D12SerializeRootSignature")?;
    let blob = blob.ok_or_else(|| anyhow!("Root-Signature-Blob NULL"))?;
    let bytes =
        unsafe { std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize()) };
    unsafe { device.CreateRootSignature(0, bytes) }.context("CreateRootSignature")
}

/// Compute-PSO aus Root-Signature + Shader-Bytecode.
fn create_pso(
    device: &ID3D12Device,
    root_sig: &ID3D12RootSignature,
    shader: &ID3DBlob,
) -> Result<ID3D12PipelineState> {
    let desc = D3D12_COMPUTE_PIPELINE_STATE_DESC {
        pRootSignature: unsafe { std::mem::transmute_copy(root_sig) },
        CS: D3D12_SHADER_BYTECODE {
            pShaderBytecode: unsafe { shader.GetBufferPointer() },
            BytecodeLength: unsafe { shader.GetBufferSize() },
        },
        NodeMask: 0,
        CachedPSO: D3D12_CACHED_PIPELINE_STATE::default(),
        Flags: D3D12_PIPELINE_STATE_FLAG_NONE,
    };
    unsafe { device.CreateComputePipelineState(&desc) }.context("CreateComputePipelineState")
}
