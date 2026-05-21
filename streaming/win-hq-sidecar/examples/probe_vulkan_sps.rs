//! Vulkan-SPS-Probe — Ground-Truth für die AMD-Vulkan-Encode-Analyse.
//!
//! FFmpeg lehnt `h264_vulkan` auf der AMD-iGPU ab mit:
//!
//!     rbsp_stop_one_bit out of range: 0, but must be in [1,1]
//!     Failed to read unit 0 (type 7) — Unable to parse feedback units, bad drivers
//!
//! Die Frage: liefert der Treiber ein nicht-konformes SPS (Treiber-Bug), oder
//! gibt es nur einen Parser-/Versions-Mismatch? Diese Probe ruft
//! `vkGetEncodedVideoSessionParametersKHR` DIREKT auf — also exakt den Aufruf,
//! über den auch FFmpeg die SPS/PPS-Header vom Treiber holt — und dumpt die
//! zurückgegebenen Roh-Bytes. Sie läuft über JEDE GPU mit Encode-Queue
//! (NVIDIA + AMD), damit man die beiden SPS-Bitstreams direkt vergleichen kann.
//!
//! `cargo run --example probe_vulkan_sps`
//!
//! Kein Vulkan-SDK nötig — `ash` lädt `vulkan-1.dll` zur Laufzeit.

use anyhow::{Result, anyhow};
use ash::vk;
use ash::vk::native;
use std::ffi::{CStr, c_void};
use std::ptr;

// Test-Auflösung — identisch zum FFmpeg-Trace (1280x720, High Profile).
const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;

fn main() {
    let entry = match unsafe { ash::Entry::load() } {
        Ok(e) => e,
        Err(e) => {
            eprintln!("Vulkan-Loader (vulkan-1.dll) nicht ladbar: {e}");
            std::process::exit(1);
        }
    };

    let app = vk::ApplicationInfo::default()
        .application_name(c"pulse-vulkan-sps-probe")
        .api_version(vk::make_api_version(0, 1, 3, 0));
    let instance_ci = vk::InstanceCreateInfo::default().application_info(&app);
    let instance =
        unsafe { entry.create_instance(&instance_ci, None) }.expect("vkCreateInstance");

    let pds = unsafe { instance.enumerate_physical_devices() }.expect("enumerate devices");
    println!("{} Vulkan-GPU(s) gefunden.\n", pds.len());

    for pd in pds {
        let props = unsafe { instance.get_physical_device_properties(pd) };
        let name = unsafe { CStr::from_ptr(props.device_name.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        println!("══════════════════════════════════════════════════════════════");
        println!(" GPU: {name}  (vendor 0x{:04x})", props.vendor_id);
        println!("══════════════════════════════════════════════════════════════");
        match probe(&entry, &instance, pd, &name) {
            Ok(()) => {}
            Err(e) => println!("  ⚠ übersprungen: {e:#}\n"),
        }
    }

    unsafe { instance.destroy_instance(None) };
}

fn probe(
    entry: &ash::Entry,
    instance: &ash::Instance,
    pd: vk::PhysicalDevice,
    gpu_name: &str,
) -> Result<()> {
    // ── 1. Encode-Queue-Family suchen ───────────────────────────────────────
    let qfams = unsafe { instance.get_physical_device_queue_family_properties(pd) };
    let encode_qfi = qfams
        .iter()
        .position(|q| q.queue_flags.contains(vk::QueueFlags::VIDEO_ENCODE_KHR))
        .ok_or_else(|| anyhow!("keine VIDEO_ENCODE-Queue-Family (GPU kann nicht HW-encoden)"))?
        as u32;

    // ── 2. H.264-Encode-Profil beschreiben ──────────────────────────────────
    // Dieses Profil hängt an mehreren Calls (Caps-Query, Session-Create) →
    // muss am Leben bleiben bis die Session steht.
    let mut h264_profile = vk::VideoEncodeH264ProfileInfoKHR::default()
        .std_profile_idc(native::StdVideoH264ProfileIdc_STD_VIDEO_H264_PROFILE_IDC_HIGH);
    let profile = vk::VideoProfileInfoKHR::default()
        .video_codec_operation(vk::VideoCodecOperationFlagsKHR::ENCODE_H264)
        .chroma_subsampling(vk::VideoChromaSubsamplingFlagsKHR::TYPE_420)
        .luma_bit_depth(vk::VideoComponentBitDepthFlagsKHR::TYPE_8)
        .chroma_bit_depth(vk::VideoComponentBitDepthFlagsKHR::TYPE_8)
        .push_next(&mut h264_profile);

    // ── 3. Video-Capabilities abfragen (liefert u.a. std_header_version) ─────
    // ash 0.38 wrappt die Video-Extensions nicht — wir rufen die rohen
    // FFI-Funktionszeiger via `.fp()` selbst auf.
    let vq_instance = ash::khr::video_queue::Instance::new(entry, instance);
    let mut h264_caps = vk::VideoEncodeH264CapabilitiesKHR::default();
    let mut enc_caps = vk::VideoEncodeCapabilitiesKHR::default();
    let mut caps = vk::VideoCapabilitiesKHR::default()
        .push_next(&mut enc_caps)
        .push_next(&mut h264_caps);
    unsafe {
        (vq_instance.fp().get_physical_device_video_capabilities_khr)(pd, &profile, &mut caps)
    }
    .result()
    .map_err(|e| anyhow!("vkGetPhysicalDeviceVideoCapabilities: {e:?}"))?;

    let std_hdr = caps.std_header_version;
    let hdr_name = unsafe { CStr::from_ptr(std_hdr.extension_name.as_ptr()) }.to_string_lossy();
    println!(
        "  Encode-Queue-Family: {encode_qfi}   Std-Header: {hdr_name} v{}",
        std_hdr.spec_version
    );

    // ── 4. Logisches Device mit den drei Video-Encode-Extensions ────────────
    let prio = [1.0f32];
    let qci = [vk::DeviceQueueCreateInfo::default()
        .queue_family_index(encode_qfi)
        .queue_priorities(&prio)];
    let exts = [
        ash::khr::video_queue::NAME.as_ptr(),
        ash::khr::video_encode_queue::NAME.as_ptr(),
        ash::khr::video_encode_h264::NAME.as_ptr(),
    ];
    let dci = vk::DeviceCreateInfo::default()
        .queue_create_infos(&qci)
        .enabled_extension_names(&exts);
    let device = unsafe { instance.create_device(pd, &dci, None) }
        .map_err(|e| anyhow!("vkCreateDevice: {e:?}"))?;
    let dev_h = device.handle();
    let vq_device = ash::khr::video_queue::Device::new(instance, &device);
    let ve_device = ash::khr::video_encode_queue::Device::new(instance, &device);
    let vqf = vq_device.fp();
    let vef = ve_device.fp();

    // ── 5. Video-Session anlegen + Memory binden ────────────────────────────
    let fmt = vk::Format::G8_B8R8_2PLANE_420_UNORM; // = NV12
    let session_ci = vk::VideoSessionCreateInfoKHR::default()
        .queue_family_index(encode_qfi)
        .video_profile(&profile)
        .picture_format(fmt)
        .max_coded_extent(vk::Extent2D { width: WIDTH, height: HEIGHT })
        .reference_picture_format(fmt)
        .max_dpb_slots(caps.max_dpb_slots.clamp(1, 16))
        .max_active_reference_pictures(caps.max_active_reference_pictures.clamp(1, 16))
        .std_header_version(&std_hdr);
    let mut session = vk::VideoSessionKHR::null();
    unsafe { (vqf.create_video_session_khr)(dev_h, &session_ci, ptr::null(), &mut session) }
        .result()
        .map_err(|e| anyhow!("vkCreateVideoSession: {e:?}"))?;

    let mut req_count = 0u32;
    unsafe {
        (vqf.get_video_session_memory_requirements_khr)(
            dev_h,
            session,
            &mut req_count,
            ptr::null_mut(),
        )
    }
    .result()
    .map_err(|e| anyhow!("get_video_session_memory_requirements (count): {e:?}"))?;
    let mut reqs =
        vec![vk::VideoSessionMemoryRequirementsKHR::default(); req_count as usize];
    unsafe {
        (vqf.get_video_session_memory_requirements_khr)(
            dev_h,
            session,
            &mut req_count,
            reqs.as_mut_ptr(),
        )
    }
    .result()
    .map_err(|e| anyhow!("get_video_session_memory_requirements (data): {e:?}"))?;
    let mem_props = unsafe { instance.get_physical_device_memory_properties(pd) };
    let mut allocated: Vec<vk::DeviceMemory> = Vec::new();
    let mut binds: Vec<vk::BindVideoSessionMemoryInfoKHR> = Vec::new();
    for r in &reqs {
        let mr = r.memory_requirements;
        let mem_type = (0..mem_props.memory_type_count)
            .find(|&i| (mr.memory_type_bits & (1 << i)) != 0)
            .ok_or_else(|| anyhow!("kein passender Memory-Type"))?;
        let ai = vk::MemoryAllocateInfo::default()
            .allocation_size(mr.size)
            .memory_type_index(mem_type);
        let mem = unsafe { device.allocate_memory(&ai, None) }
            .map_err(|e| anyhow!("vkAllocateMemory: {e:?}"))?;
        allocated.push(mem);
        binds.push(
            vk::BindVideoSessionMemoryInfoKHR::default()
                .memory_bind_index(r.memory_bind_index)
                .memory(mem)
                .memory_offset(0)
                .memory_size(mr.size),
        );
    }
    unsafe {
        (vqf.bind_video_session_memory_khr)(
            dev_h,
            session,
            binds.len() as u32,
            binds.as_ptr(),
        )
    }
    .result()
    .map_err(|e| anyhow!("vkBindVideoSessionMemory: {e:?}"))?;

    // ── 6. SPS + PPS als Std-Structs füllen ─────────────────────────────────
    // Bewusst minimal: nur was eine konforme High-Profile-1280x720-SPS braucht.
    // Die Feldwerte sind für die Frage egal — entscheidend ist, wie der TREIBER
    // sie in Bits serialisiert. Ein Bug im RBSP-Serializer schlägt bei jeder
    // sinnvollen SPS durch.
    // VUI — genau hier liegt der Verdacht. Ein minimales SPS OHNE VUI
    // serialisieren NVIDIA und AMD byte-identisch (verifiziert). FFmpegs
    // h264_vulkan hängt aber eine VUI an (Timing-Info + Bitstream-Restriction).
    // Die VUI ist der komplexeste SPS-Teil — wenn der AMD-Serializer hier
    // patzt, reproduziert das FFmpegs `rbsp_stop_one_bit`-Fehler.
    // HRD-Parameter — die komplexeste Sub-Bitstream-Struktur einer SPS.
    // FFmpegs HW-H.264-Encoder hängen bei gesetzter Bitrate praktisch immer
    // HRD an. Wenn der AMD-Serializer hier patzt, landet das Stop-Bit falsch.
    let mut hrd: native::StdVideoH264HrdParameters = unsafe { std::mem::zeroed() };
    hrd.cpb_cnt_minus1 = 0; // 1 CPB
    hrd.bit_rate_scale = 4;
    hrd.cpb_size_scale = 4;
    hrd.bit_rate_value_minus1[0] = 5_999; // ~6 Mbit bei scale 4
    hrd.cpb_size_value_minus1[0] = 11_999;
    hrd.cbr_flag[0] = 0;
    hrd.initial_cpb_removal_delay_length_minus1 = 23;
    hrd.cpb_removal_delay_length_minus1 = 23;
    hrd.dpb_output_delay_length_minus1 = 23;
    hrd.time_offset_length = 24;

    let mut vui_flags: native::StdVideoH264SpsVuiFlags = unsafe { std::mem::zeroed() };
    vui_flags.set_timing_info_present_flag(1);
    vui_flags.set_fixed_frame_rate_flag(1);
    vui_flags.set_nal_hrd_parameters_present_flag(1);
    vui_flags.set_bitstream_restriction_flag(1);
    let mut vui: native::StdVideoH264SequenceParameterSetVui = unsafe { std::mem::zeroed() };
    vui.flags = vui_flags;
    vui.num_units_in_tick = 1;
    vui.time_scale = 120; // 60 fps  → time_scale / (2 * num_units_in_tick)
    vui.max_num_reorder_frames = 0;
    vui.max_dec_frame_buffering = 1;
    vui.pHrdParameters = &hrd;

    let mut sps_flags: native::StdVideoH264SpsFlags = unsafe { std::mem::zeroed() };
    sps_flags.set_frame_mbs_only_flag(1);
    sps_flags.set_direct_8x8_inference_flag(1);
    sps_flags.set_vui_parameters_present_flag(1);

    let mut sps: native::StdVideoH264SequenceParameterSet = unsafe { std::mem::zeroed() };
    sps.flags = sps_flags;
    sps.profile_idc = native::StdVideoH264ProfileIdc_STD_VIDEO_H264_PROFILE_IDC_HIGH;
    sps.level_idc = native::StdVideoH264LevelIdc_STD_VIDEO_H264_LEVEL_IDC_3_1;
    sps.chroma_format_idc = native::StdVideoH264ChromaFormatIdc_STD_VIDEO_H264_CHROMA_FORMAT_IDC_420;
    sps.pic_order_cnt_type = native::StdVideoH264PocType_STD_VIDEO_H264_POC_TYPE_0;
    sps.max_num_ref_frames = 1;
    sps.pic_width_in_mbs_minus1 = WIDTH / 16 - 1;
    sps.pic_height_in_map_units_minus1 = HEIGHT / 16 - 1;
    sps.pSequenceParameterSetVui = &vui;

    let pps_flags: native::StdVideoH264PpsFlags = unsafe { std::mem::zeroed() };
    let mut pps: native::StdVideoH264PictureParameterSet = unsafe { std::mem::zeroed() };
    pps.flags = pps_flags;

    // ── 7. Session-Parameters mit SPS+PPS anlegen ───────────────────────────
    let sps_arr = [sps];
    let pps_arr = [pps];
    let add = vk::VideoEncodeH264SessionParametersAddInfoKHR::default()
        .std_sp_ss(&sps_arr)
        .std_pp_ss(&pps_arr);
    let mut h264_params_ci = vk::VideoEncodeH264SessionParametersCreateInfoKHR::default()
        .max_std_sps_count(1)
        .max_std_pps_count(1)
        .parameters_add_info(&add);
    let params_ci = vk::VideoSessionParametersCreateInfoKHR::default()
        .video_session(session)
        .push_next(&mut h264_params_ci);
    let mut params = vk::VideoSessionParametersKHR::null();
    unsafe {
        (vqf.create_video_session_parameters_khr)(dev_h, &params_ci, ptr::null(), &mut params)
    }
    .result()
    .map_err(|e| anyhow!("vkCreateVideoSessionParameters: {e:?}"))?;

    // ── 8. DER eigentliche Aufruf: vkGetEncodedVideoSessionParametersKHR ─────
    // Genau das, was FFmpegs h264_vulkan macht, um die SPS/PPS-Header zu holen.
    let mut h264_get = vk::VideoEncodeH264SessionParametersGetInfoKHR::default()
        .write_std_sps(true)
        .write_std_pps(true)
        .std_sps_id(0)
        .std_pps_id(0);
    let get_info = vk::VideoEncodeSessionParametersGetInfoKHR::default()
        .video_session_parameters(params)
        .push_next(&mut h264_get);
    let mut feedback = vk::VideoEncodeSessionParametersFeedbackInfoKHR::default();
    let mut data_size = 0usize;
    unsafe {
        (vef.get_encoded_video_session_parameters_khr)(
            dev_h,
            &get_info,
            &mut feedback,
            &mut data_size,
            ptr::null_mut(),
        )
    }
    .result()
    .map_err(|e| anyhow!("vkGetEncodedVideoSessionParameters (size): {e:?}"))?;
    let mut data = vec![0u8; data_size];
    unsafe {
        (vef.get_encoded_video_session_parameters_khr)(
            dev_h,
            &get_info,
            &mut feedback,
            &mut data_size,
            data.as_mut_ptr() as *mut c_void,
        )
    }
    .result()
    .map_err(|e| anyhow!("vkGetEncodedVideoSessionParameters (data): {e:?}"))?;
    data.truncate(data_size);

    println!(
        "  → {} Bytes zurückgeliefert  (feedback.has_overrides = {})\n",
        data.len(),
        feedback.has_overrides != 0
    );
    analyze(&data);

    // Roh-Bytes als Annex-B-Datei ablegen — für einen Gegencheck mit FFmpegs
    // eigenem CBS-Parser (`ffmpeg -bsf:v trace_headers`).
    let safe: String = gpu_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let out = format!("target/probe-h264-{safe}.bin");
    if std::fs::write(&out, &data).is_ok() {
        println!("  (Roh-Bytes geschrieben: {out})");
    }

    // ── 9. Aufräumen ────────────────────────────────────────────────────────
    unsafe {
        (vqf.destroy_video_session_parameters_khr)(dev_h, params, ptr::null());
        (vqf.destroy_video_session_khr)(dev_h, session, ptr::null());
        for m in allocated {
            device.free_memory(m, None);
        }
        device.destroy_device(None);
    }
    Ok(())
}

// ── Analyse der Roh-Bytes ───────────────────────────────────────────────────

fn analyze(data: &[u8]) {
    hexdump(data);
    println!();

    // NAL-Units anhand der Annex-B-Startcodes (00 00 01 / 00 00 00 01) zerlegen.
    let nals = split_nals(data);
    if nals.is_empty() {
        println!("  ⚠ keine Annex-B-Startcodes gefunden — Bytes liegen evtl. in einem");
        println!("    anderen Framing vor. Voller Hexdump siehe oben.");
        return;
    }
    for (i, nal) in nals.iter().enumerate() {
        let nal_type = nal[0] & 0x1f;
        let ref_idc = (nal[0] >> 5) & 0x03;
        let kind = match nal_type {
            7 => "SPS",
            8 => "PPS",
            _ => "?",
        };
        println!(
            "  NAL #{i}: type {nal_type} ({kind}), nal_ref_idc {ref_idc}, {} Bytes RBSP",
            nal.len()
        );
        println!("    Bytes: {}", hex_inline(nal));
        check_trailing_bits(nal);
        println!();
    }
}

/// Zerlegt einen Annex-B-Bytestrom in NAL-Units (ohne Startcode, ohne die
/// RBSP-Emulation-Prevention rückgängig zu machen — fürs Trailing-Bit reicht's).
fn split_nals(data: &[u8]) -> Vec<Vec<u8>> {
    let mut starts: Vec<usize> = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (idx, &s) in starts.iter().enumerate() {
        // Ende = vor dem nächsten Startcode (dessen führende Nullen abziehen).
        let mut end = starts.get(idx + 1).copied().unwrap_or(data.len());
        if idx + 1 < starts.len() {
            end -= 3;
            while end > s && data[end - 1] == 0 {
                end -= 1; // 4-Byte-Startcode bzw. trailing zero bytes
            }
        }
        if end > s {
            out.push(data[s..end].to_vec());
        }
    }
    out
}

/// Byte-Ebenen-Plausibilitätscheck der `rbsp_trailing_bits()`. Das letzte Byte
/// MUSS das `rbsp_stop_one_bit` tragen → es darf nicht 0x00 sein. Ob der
/// Bit-Cursor nach dem Parsen aller Syntax-Elemente exakt auf dem Stop-Bit
/// landet (= FFmpegs eigentlicher Check), lässt sich byte-weise NICHT
/// entscheiden — dafür den Annex-B-Dump mit `ffmpeg -bsf:v trace_headers`
/// gegenchecken.
fn check_trailing_bits(nal: &[u8]) {
    let Some(&last) = nal.last() else {
        println!("    ⚠ leere NAL-Unit");
        return;
    };
    if last == 0x00 {
        println!("    ✗ NICHT-KONFORM: letztes Byte ist 0x00 — das");
        println!("      rbsp_stop_one_bit fehlt im letzten Byte.");
    } else {
        let stop_pos = 7 - last.trailing_zeros();
        println!(
            "    letztes Byte 0x{last:02x} — niedrigstes gesetztes Bit @ Pos {stop_pos} \
             (Stop-Bit-Kandidat)"
        );
    }
}

fn hexdump(data: &[u8]) {
    for (off, chunk) in data.chunks(16).enumerate() {
        let hex: Vec<String> = chunk.iter().map(|b| format!("{b:02x}")).collect();
        let ascii: String = chunk
            .iter()
            .map(|&b| if (0x20..0x7f).contains(&b) { b as char } else { '.' })
            .collect();
        println!("  {:04x}  {:<48}  {}", off * 16, hex.join(" "), ascii);
    }
}

fn hex_inline(data: &[u8]) -> String {
    data.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}
