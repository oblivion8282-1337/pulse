//! Diagnose-Probe: trägt der native D3D12VA-Encoder-Pfad auf dieser GPU?
//!
//! Hintergrund: AMD kann KEIN D3D11-Zero-Copy — `h264_amf` stürzt auf
//! D3D11-Surface-Input reproduzierbar mit Integer-Divide-by-Zero in der
//! AMF-Runtime ab (AMF-Issue #455, `SubmitInput`, Frame 0). Darum läuft AMD
//! aktuell über den CPU-Pfad (VRAM→RAM-Readback + swscale BGRA→NV12).
//!
//! FFmpeg 8.1 hat aber NATIVE D3D12VA-Encoder (`h264_d3d12va` / `hevc_d3d12va`
//! / `av1_d3d12va`), die die D3D12 Video Encode API von Microsoft nutzen —
//! NICHT die AMF-Library. Damit ist der gesamte AMF-Runtime-Pfad (und #455)
//! umgangen. Das ist die tragfähige Basis für eine AMD-GPU-Pipeline; die
//! `streaming-pipeline-analysis.md`-§1-Skizze („D3D12→AMF") wäre dagegen
//! sinnlos — sie landet wieder in derselben AMF-Runtime.
//!
//! Diese Probe klärt — BEVOR wir die volle D3D11→D3D12-Interop-Pipeline bauen
//! (D3D12-Device, Shared-Handle, Fence-Sync, hand-gespiegelte Structs) — das
//! größte Unbekannte: encodet `h264_d3d12va` auf DIESER GPU/diesem Treiber
//! eine D3D12-NV12-Surface ohne Treiber-Crash? (Der D3D12-Encode-Pfad hatte
//! selbst einen AMD-Treiber-Bug, AMF-Issue #474 — laut Tracker gefixt; welche
//! Treiber-Version den Fix trägt, ist offen.)
//!
//! FFmpeg macht hier ALLES: `av_hwdevice_ctx_create(D3D12VA, "<adapter>")`
//! baut das D3D12-Device, `av_hwframe_transfer_data` lädt eine Software-NV12-
//! Frame per Staging-Buffer in die D3D12-Surface hoch. KEIN hand-gespiegelter
//! D3D12-Struct nötig — den braucht erst die echte Interop-Pipeline, nicht die
//! Probe. So bleibt der Test isoliert (rührt `pipeline_hw` nicht an).
//!
//! `cargo run --release --example probe_d3d12_amf [adapter]`
//!
//! Ohne Argument wird die AMD-GPU bevorzugt. Optionales Argument wählt einen
//! anderen Adapter — entweder per Index (`0`/`1`/…) oder Vendor-Slug
//! (`amd`/`nvidia`/`intel`), z.B. `… --example probe_d3d12_amf -- nvidia`.
//!
//! Stürzt der Prozess während „Frame 0 senden" hart ab (Exit 0xC0000094 =
//! Integer-Divide-by-Zero), ist der D3D12-Pfad auf dieser GPU/diesem Treiber
//! NICHT tragfähig. Läuft er bis „VERDICT: PASS" durch, trägt er.

use anyhow::{Context, Result, anyhow};
use ffmpeg::ffi::*;
use ffmpeg::{Dictionary, Rational, codec, format, frame};
use ffmpeg_next as ffmpeg;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIFactory1};

const W: u32 = 1920;
const H: u32 = 1080;
const FPS: i32 = 60;
const FRAMES: i64 = 30;

fn main() {
    ffmpeg::init().expect("ffmpeg::init");
    println!("=== Probe: nativer D3D12VA-Encoder-Pfad ===\n");

    // [1] Sind die D3D12VA-Encoder im gelinkten FFmpeg überhaupt vorhanden?
    // Die BtbN-LGPL-Shared-Distribution baut mit `--enable-d3d12va`; fehlt
    // h264_d3d12va, wurde sie ohne gebaut → D3D12-Pfad braucht erst einen
    // neuen FFmpeg-Build.
    println!("[1] D3D12VA-Encoder im gelinkten FFmpeg:");
    let mut h264_present = false;
    for name in ["h264_d3d12va", "hevc_d3d12va", "av1_d3d12va"] {
        let present = codec::encoder::find_by_name(name).is_some();
        println!("    {name:16} {}", if present { "vorhanden" } else { "FEHLT" });
        if name == "h264_d3d12va" {
            h264_present = present;
        }
    }
    if !h264_present {
        eprintln!(
            "\nABBRUCH: h264_d3d12va fehlt — die gelinkte FFmpeg-Distribution \
             wurde ohne --enable-d3d12va gebaut. D3D12-Pfad ohne neuen \
             FFmpeg-Build nicht möglich."
        );
        std::process::exit(1);
    }
    println!();

    // [2] Adapter wählen. Optionales CLI-Argument (Index oder Vendor-Slug)
    // hat Vorrang; ohne Argument wird die AMD-GPU bevorzugt.
    println!("[2] DXGI-Adapter:");
    let adapters = enumerate_adapters();
    for (idx, vendor_id, name) in &adapters {
        println!(
            "    [{idx}] vendor=0x{vendor_id:04X} ({}) {name}",
            vendor_slug(*vendor_id)
        );
    }
    let (adapter_idx, vendor) = select_adapter(&adapters, std::env::args().nth(1).as_deref());
    println!("    → Probe-Adapter: [{adapter_idx}] ({vendor})\n");

    // [3] Pro Codec: D3D12-Device + Pool bauen, 30 NV12-Frames encoden.
    // Maßgeblich für den Befund ist h264_d3d12va — H.264 ist Pulses
    // Default-Codec. AV1 schlägt auf manchen AMD-Treibern bei der RC-Mode-
    // Negotiation fehl (`open` → EINVAL); das ist KEIN Crash und kein
    // #455/#474-Indiz, sondern separat über `rc_mode` tunebar.
    println!("[3] D3D12-Encode-Probe ({W}x{H}, NV12, {FRAMES} Frames je Codec):");
    let mut h264_pass = false;
    for (codec_name, label) in [
        ("h264_d3d12va", "H.264"),
        ("hevc_d3d12va", "HEVC"),
        ("av1_d3d12va", "AV1"),
    ] {
        if codec::encoder::find_by_name(codec_name).is_none() {
            println!("  {label} ({codec_name}): Encoder fehlt — übersprungen.");
            continue;
        }
        println!("  {label} ({codec_name}):");
        match run_codec_probe(codec_name, adapter_idx) {
            Ok((pkts, bytes)) => {
                println!("    PASS — {pkts} Pakete, {bytes} Bytes, kein Crash.");
                if codec_name == "h264_d3d12va" {
                    h264_pass = true;
                }
            }
            Err(e) => println!("    FAIL — {e:#}"),
        }
    }

    println!("\n=== VERDICT — Adapter [{adapter_idx}] ({vendor}) ===");
    if h264_pass {
        println!(
            "PASS — h264_d3d12va encodet D3D12-NV12-Surfaces auf dieser GPU \
             ohne Crash. Der native d3d12va-Pfad umgeht die AMF-Runtime (und \
             damit #455) und ist eine tragfähige Basis für eine GPU-only-\
             Pipeline auf {vendor}. (Ein FAIL bei AV1 ist oft nur fehlende \
             AV1-Encode-HW oder RC-Mode-Negotiation — kein Crash.)"
        );
    } else {
        println!(
            "FAIL — h264_d3d12va trägt auf dieser GPU ({vendor}) NICHT. \
             Deutung der Fehlerbilder: Exit 0xC0000094 = #455-artiger \
             Integer-Divide-by-Zero; `Encode failed` + HRESULT 0x887A0020 = \
             D3D12-Device-Removal (GPU-TDR im D3D12-Video-Encode-Pfad). \
             ACHTUNG: Nach einem Device-Removal scheitern die Folge-Codecs \
             schon an der Device-Erstellung — deren FAILs sind NICHT \
             unabhängig zu werten, nur der erste Fehler zählt."
        );
    }
}

/// Eine Codec-Probe: FFmpeg baut das D3D12-Device + den NV12-Pool selbst, wir
/// laden 30 Software-NV12-Frames hoch und schicken sie durch den Encoder.
/// `Ok((pakete, bytes))` bei Erfolg. Bei einem #455-artigen Treiber-Bug stirbt
/// der PROZESS hart (kein `Err` — der Stack-Trail in der Konsole zeigt dann,
/// dass es im `avcodec_send_frame` von Frame 0 war).
fn run_codec_probe(codec_name: &str, adapter: u32) -> Result<(u64, u64)> {
    // ── D3D12-hwdevice — FFmpeg ruft intern IDXGIFactory2::EnumAdapters(idx)
    //    auf; `device` wird per atoi() als Adapter-Index geparst (verifiziert
    //    gegen libavutil/hwcontext_d3d12va.c). Reihenfolge = identisch zu
    //    unserer DXGI-EnumAdapters1-Aufzählung.
    step("D3D12-hwdevice erstellen");
    let dev_str = std::ffi::CString::new(adapter.to_string()).unwrap();
    let mut device_ref: *mut AVBufferRef = std::ptr::null_mut();
    let ret = unsafe {
        av_hwdevice_ctx_create(
            &mut device_ref,
            AVHWDeviceType::AV_HWDEVICE_TYPE_D3D12VA,
            dev_str.as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ret < 0 {
        return Err(anyhow!(
            "av_hwdevice_ctx_create(D3D12VA, adapter={adapter}) failed: {ret}"
        ));
    }

    // ── D3D12-hwframes-Pool, sw_format NV12 (D3D12-Video-Encode akzeptiert nur
    //    NV12/P010 — kein BGRA wie NVENC; die echte Pipeline braucht darum
    //    einen GPU-seitigen BGRA→NV12-Convert vor dem Encoder).
    step("D3D12-hwframes-Pool (NV12) initialisieren");
    let frames_ref = unsafe { av_hwframe_ctx_alloc(device_ref) };
    if frames_ref.is_null() {
        return Err(anyhow!("av_hwframe_ctx_alloc returned NULL"));
    }
    unsafe {
        let hdr = (*frames_ref).data as *mut AVHWFramesContext;
        (*hdr).format = AVPixelFormat::AV_PIX_FMT_D3D12;
        (*hdr).sw_format = AVPixelFormat::AV_PIX_FMT_NV12;
        (*hdr).width = W as i32;
        (*hdr).height = H as i32;
        (*hdr).initial_pool_size = 8;
    }
    let ret = unsafe { av_hwframe_ctx_init(frames_ref) };
    if ret < 0 {
        return Err(anyhow!("av_hwframe_ctx_init failed: {ret}"));
    }

    // ── Encoder. `hw_frames_ctx` MUSS vor `open` an die AVCodecContext —
    //    ffmpeg-next exponiert das Feld nicht, also via FFI (gleiches Muster
    //    wie `encode/encoder_hw.rs`).
    step(&format!("Encoder '{codec_name}' öffnen"));
    let codec_desc = codec::encoder::find_by_name(codec_name)
        .ok_or_else(|| anyhow!("encoder '{codec_name}' not registered"))?;
    let mut encoder = codec::context::Context::new_with_codec(codec_desc)
        .encoder()
        .video()?;
    encoder.set_width(W);
    encoder.set_height(H);
    encoder.set_time_base(Rational::new(1, FPS));
    encoder.set_frame_rate(Some(Rational::new(FPS, 1)));
    encoder.set_bit_rate(6_000_000);
    encoder.set_max_bit_rate(6_000_000);
    encoder.set_gop(FPS as u32 * 2);
    unsafe {
        let ctx = encoder.as_mut_ptr();
        (*ctx).pix_fmt = AVPixelFormat::AV_PIX_FMT_D3D12;
        let new_ref = av_buffer_ref(frames_ref);
        if new_ref.is_null() {
            return Err(anyhow!("av_buffer_ref(frames_ref) returned NULL"));
        }
        (*ctx).hw_frames_ctx = new_ref;
    }
    let mut opened = encoder
        .open_with(Dictionary::new())
        .with_context(|| format!("open encoder '{codec_name}'"))?;
    let enc_ctx = unsafe { opened.as_mut_ptr() };

    // ── Encode-Loop.
    let pkt = unsafe { av_packet_alloc() };
    if pkt.is_null() {
        return Err(anyhow!("av_packet_alloc returned NULL"));
    }
    let mut total_pkts: u64 = 0;
    let mut total_bytes: u64 = 0;

    for i in 0..FRAMES {
        // Software-NV12-Frame mit bewegtem Gradient — echter Content, damit der
        // Encoder nicht-triviale Pakete liefert (ein flaches Bild encodet fast
        // auf 0 Bytes und würde die „0 Pakete = verdächtig"-Prüfung verfälschen).
        let mut sw = frame::Video::new(format::Pixel::NV12, W, H);
        fill_nv12(&mut sw, i as usize);

        // D3D12-Pool-Frame ziehen + Software-Frame hochladen (Staging-Buffer-
        // Copy + D3D12-Copy-Command, FFmpeg-intern).
        let mut hw = unsafe { av_frame_alloc() };
        if hw.is_null() {
            return Err(anyhow!("av_frame_alloc returned NULL"));
        }
        let ret = unsafe { av_hwframe_get_buffer(frames_ref, hw, 0) };
        if ret < 0 {
            unsafe { av_frame_free(&mut hw) };
            return Err(anyhow!("av_hwframe_get_buffer failed: {ret}"));
        }
        let ret = unsafe { av_hwframe_transfer_data(hw, sw.as_ptr(), 0) };
        if ret < 0 {
            unsafe { av_frame_free(&mut hw) };
            return Err(anyhow!(
                "av_hwframe_transfer_data (NV12→D3D12 upload) failed: {ret}"
            ));
        }
        unsafe { (*hw).pts = i };

        // DER kritische Call: bei einem #455-artigen Treiber-Bug terminiert der
        // Prozess HIER hart (Divide-by-Zero). Vorher flushen, damit die
        // Konsole zeigt, wie weit es kam.
        if i == 0 {
            step("Frame 0 an den D3D12-Encoder senden (kritischer Call)");
        }
        let ret = unsafe { avcodec_send_frame(enc_ctx, hw) };
        unsafe { av_frame_free(&mut hw) };
        if ret < 0 {
            return Err(anyhow!("avcodec_send_frame(frame {i}) failed: {ret}"));
        }
        let (p, b) = drain(enc_ctx, pkt);
        total_pkts += p;
        total_bytes += b;
    }

    // Flush: EOF rein, restliche Pakete ziehen.
    step("Encoder flushen (EOF)");
    unsafe { avcodec_send_frame(enc_ctx, std::ptr::null()) };
    let (p, b) = drain(enc_ctx, pkt);
    total_pkts += p;
    total_bytes += b;

    // KEIN Teardown: `opened` (Encoder) + die hw-AVBufferRefs werden bewusst
    // geleakt. Die Probe terminiert gleich danach; `ExitProcess` gibt
    // D3D12-Device / COM / Treiber-Threads sauber frei. Das deckt sich mit der
    // „gar kein Teardown"-Regel aus `pipeline_hw.rs` — ein Encoder-Drop, der
    // einen Treiber-Threadpool-Timer dangling zurücklässt, würde sonst eine
    // bereits bestandene Probe nachträglich crashen lassen.
    std::mem::forget(opened);

    if total_pkts == 0 || total_bytes == 0 {
        return Err(anyhow!(
            "Encoder lief ohne Crash, lieferte aber 0 Pakete/Bytes — \
             verdächtig (Encoder-Stall statt echter Encode?)"
        ));
    }
    Ok((total_pkts, total_bytes))
}

/// Encodete Pakete ziehen, bis `avcodec_receive_packet` mit EAGAIN/EOF (beide
/// negativ) abbricht. Gibt `(anzahl, summe_bytes)` zurück.
fn drain(ctx: *mut AVCodecContext, pkt: *mut AVPacket) -> (u64, u64) {
    let mut pkts: u64 = 0;
    let mut bytes: u64 = 0;
    loop {
        let ret = unsafe { avcodec_receive_packet(ctx, pkt) };
        if ret < 0 {
            break;
        }
        pkts += 1;
        bytes += unsafe { (*pkt).size } as u64;
        unsafe { av_packet_unref(pkt) };
    }
    (pkts, bytes)
}

/// Füllt eine NV12-Frame mit einem pro Tick wandernden Gradienten — Y-Plane
/// diagonaler Verlauf, UV-Plane neutral (128 = grau). Beachtet den Frame-Stride
/// (FFmpeg padded die Zeilen).
fn fill_nv12(f: &mut frame::Video, tick: usize) {
    let w = f.width() as usize;
    let h = f.height() as usize;

    let y_stride = f.stride(0);
    let y = f.data_mut(0);
    for row in 0..h {
        let base = row * y_stride;
        for col in 0..w {
            y[base + col] = ((row + col + tick * 6) & 0xFF) as u8;
        }
    }

    let uv_stride = f.stride(1);
    let uv = f.data_mut(1);
    for row in 0..h / 2 {
        let base = row * uv_stride;
        for col in 0..w {
            uv[base + col] = 128;
        }
    }
}

/// Fortschritts-Zeile + Stdout-Flush — damit ein harter Treiber-Crash einen
/// lesbaren Trail hinterlässt (wie weit kam die Probe?).
fn step(msg: &str) {
    use std::io::Write;
    println!("    … {msg}");
    let _ = std::io::stdout().flush();
}

/// DXGI-Adapter aufzählen → `(index, vendor_id, name)`. Index-Reihenfolge ist
/// stabil und deckt sich mit FFmpegs `IDXGIFactory2::EnumAdapters`.
fn enumerate_adapters() -> Vec<(u32, u32, String)> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.expect("CreateDXGIFactory1");
    let mut out = Vec::new();
    let mut idx = 0u32;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(idx) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => panic!("EnumAdapters1: {e}"),
        };
        let desc = unsafe { adapter.GetDesc1() }.expect("GetDesc1");
        let name = String::from_utf16_lossy(&desc.Description)
            .trim_end_matches('\0')
            .to_string();
        out.push((idx, desc.VendorId, name));
        idx += 1;
    }
    out
}

/// Adapter wählen: CLI-Arg (Index `"1"` oder Vendor-Slug `"nvidia"`/`"amd"`/
/// `"intel"`) hat Vorrang, sonst die AMD-GPU, sonst Adapter 0. `panic!` bei
/// einem Argument, das auf keinen Adapter passt — die Probe soll dann nicht
/// stillschweigend die falsche GPU testen.
fn select_adapter(adapters: &[(u32, u32, String)], arg: Option<&str>) -> (u32, &'static str) {
    if let Some(arg) = arg {
        if let Ok(idx) = arg.parse::<u32>() {
            return adapters
                .iter()
                .find(|(i, _, _)| *i == idx)
                .map(|(i, vid, _)| (*i, vendor_slug(*vid)))
                .unwrap_or_else(|| panic!("Adapter-Index {idx} existiert nicht"));
        }
        let want = arg.to_ascii_lowercase();
        return adapters
            .iter()
            .find(|(_, vid, _)| vendor_slug(*vid) == want)
            .map(|(i, vid, _)| (*i, vendor_slug(*vid)))
            .unwrap_or_else(|| {
                panic!("'{arg}' ist weder ein Adapter-Index noch ein Vendor (amd/nvidia/intel)")
            });
    }
    if let Some((i, vid, _)) = adapters.iter().find(|(_, vid, _)| *vid == 0x1002) {
        return (*i, vendor_slug(*vid));
    }
    let (i, vid, _) = adapters.first().expect("keine GPU gefunden");
    (*i, vendor_slug(*vid))
}

fn vendor_slug(vendor_id: u32) -> &'static str {
    match vendor_id {
        0x10DE => "nvidia",
        0x1002 => "amd",
        0x8086 => "intel",
        _ => "unbekannt",
    }
}
