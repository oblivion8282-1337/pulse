//! Was gibt FFmpeg heraus, wenn man eine VAAPI-Surface als DMA-BUF exportiert?
//!
//! Aufruf: `vaapi-dmabuf-export <datei> [weitere …]`
//!
//! Die Probe dekodiert je Datei ein paar Bilder ueber VAAPI, bildet jedes mit
//! `av_hwframe_map` nach `AV_PIX_FMT_DRM_PRIME` ab und **druckt den
//! Deskriptor**. Sie importiert bewusst nichts.
//!
//! Worauf es bei der Ausgabe ankommt, in dieser Reihenfolge:
//!
//! 1. **`planes` je Layer.** Genau 1 → der fertige Helfer aus wgpu-hal 30
//!    (`texture_from_dmabuf_fd`) traegt. Mehr → er ist raus, es braucht ein
//!    eigenes `VkImage` mit mehreren `plane_layouts`.
//! 2. **`layers`.** Erwartet 2 (Luma, Chroma) — FFmpeg exportiert mit
//!    `VA_EXPORT_SURFACE_SEPARATE_LAYERS`. Bei 1 waere das Bild komponiert und
//!    der Renderer muesste anders abtasten.
//! 3. **`objects`.** Bei 1 teilen sich beide Layer einen Dateideskriptor —
//!    dann ist je Import ein `dup()` noetig, und der zweite Layer traegt einen
//!    Versatz ungleich null (der Punkt, an dem die Speichergroesse klemmen
//!    kann).
//! 4. **`modifier`.** Muss unveraendert an Vulkan durchgereicht werden. Traegt
//!    er Kompressions-Metadaten, faellt Punkt 1 mit ihm.
//! 5. **`format`** je Layer als Fourcc — erwartet R8/GR88 (8 bit) bzw.
//!    R16/GR1616 (10 bit). Das ist die Gegenprobe, ob die Gegenseite dasselbe
//!    Bild meint wie wir.
//!
//! **Das Flag ist `AV_HWFRAME_MAP_READ`, nicht `AV_HWFRAME_MAP_DIRECT`.**
//! `DIRECT` wird auf diesem Weg gar nicht ausgewertet (es gilt nur fuer
//! `vaapi_map_to_memory`); `READ` dagegen setzt `VA_EXPORT_SURFACE_READ_ONLY`
//! **und** loest `vaSyncSurface` aus — die dekodierseitige Synchronisation ist
//! damit erledigt, ohne dass die Bruecke sie selbst bauen muss.

mod import;

use anyhow::{anyhow, bail, Context, Result};
use ffmpeg_next as ffmpeg;
use ffmpeg::ffi;

/// Wie viele Bilder je Datei angesehen werden.
///
/// Mehr als eines, weil der Decoder-Pool rotiert: kaeme der zweite Frame in
/// anderer Gestalt als der erste (anderer Modifier, andere Objektzahl), waere
/// jede Bruecke, die sich die Gestalt einmal merkt, falsch gebaut. Genau das
/// zu sehen ist der Zweck.
const BILDER: usize = 5;

fn fourcc(v: u32) -> String {
    let b = v.to_le_bytes();
    b.iter()
        .map(|&c| {
            if (0x20..0x7f).contains(&c) {
                c as char
            } else {
                '?'
            }
        })
        .collect()
}

/// Der Modifier in der Schreibweise, in der ihn Mesa und die Vulkan-Doku
/// fuehren — plus die Deutung der oberen Bits (Hersteller).
fn modifier_text(m: u64) -> String {
    let hersteller = match m >> 56 {
        0 => "NONE/LINEAR",
        1 => "INTEL",
        2 => "AMD",
        3 => "NVIDIA",
        4 => "SAMSUNG",
        _ => "?",
    };
    if m == 0 {
        "0x0 (LINEAR)".to_string()
    } else {
        format!("{m:#018x} (Hersteller {hersteller})")
    }
}

/// Ein Bild abbilden und den Deskriptor ausgeben. Liefert die Kurzform fuer
/// den Vergleich zwischen den Bildern.
///
/// # Safety
/// `gpu` muss ein gueltiger, dekodierter Hardware-Frame mit `hw_frames_ctx`
/// sein. Der abgebildete Frame lebt bis zum Ende der Funktion; mit ihm die
/// Dateideskriptoren (FFmpeg schliesst sie im `HWMapDescriptor`).
unsafe fn deskriptor_zeigen(gpu: &ffmpeg::frame::Video, nr: usize) -> Result<String> {
    let mut drm = ffmpeg::frame::Video::empty();
    (*drm.as_mut_ptr()).format = ffi::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;

    let rc = ffi::av_hwframe_map(
        drm.as_mut_ptr(),
        gpu.as_ptr(),
        ffi::AV_HWFRAME_MAP_READ as i32,
    );
    if rc < 0 {
        bail!("av_hwframe_map scheiterte (rc={rc})");
    }

    let desc = (*drm.as_ptr()).data[0] as *const ffi::AVDRMFrameDescriptor;
    if desc.is_null() {
        bail!("av_hwframe_map lieferte einen leeren Deskriptor");
    }
    let d = &*desc;

    println!("  Bild {nr}: objects={} layers={}", d.nb_objects, d.nb_layers);
    for i in 0..d.nb_objects.max(0) as usize {
        let o = &d.objects[i];
        println!(
            "    Objekt {i}: fd={} size={} modifier={}",
            o.fd,
            o.size,
            modifier_text(o.format_modifier)
        );
    }
    let mut kurz = format!("obj={} lay={}", d.nb_objects, d.nb_layers);
    for i in 0..d.nb_layers.max(0) as usize {
        let l = &d.layers[i];
        println!(
            "    Layer {i}: format={} ({:#010x}) planes={}",
            fourcc(l.format),
            l.format,
            l.nb_planes
        );
        kurz.push_str(&format!(" L{i}={}x{}", fourcc(l.format), l.nb_planes));
        for p in 0..l.nb_planes.max(0) as usize {
            let pl = &l.planes[p];
            println!(
                "      Plane {p}: object_index={} offset={} pitch={}",
                pl.object_index, pl.offset, pl.pitch
            );
        }
    }
    Ok(kurz)
}

/// Ein wgpu-Geraet mit dem DMA-BUF-Merkmal. `None`, wenn die Karte es nicht
/// kann — dann ist der ganze Weg hier nicht fahrbar, und das ist die Antwort.
fn wgpu_geraet() -> Result<(wgpu::Device, wgpu::Queue)> {
    let instanz = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle_from_env()
    });
    let adapter = pollster::block_on(instanz.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
        // Vorgabe der Bibliothek (neu in wgpu 30) — Verhalten wie 29.
        apply_limit_buckets: false,
    }))?;
    // `TEXTURE_FORMAT_16BIT_NORM` fuer die 10-bit-Ebenen (R16/Rg16Unorm) — der
    // Player fordert es aus demselben Grund an (`render/setup.rs`).
    let noetig = wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF
        | wgpu::Features::TEXTURE_FORMAT_16BIT_NORM;
    if !adapter.features().contains(noetig) {
        bail!("Adapter kann VULKAN_EXTERNAL_MEMORY_DMA_BUF nicht");
    }
    let (d, q) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("dmabuf-probe"),
        required_features: noetig,
        required_limits: wgpu::Limits::default(),
        memory_hints: Default::default(),
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        trace: wgpu::Trace::Off,
    }))?;
    println!("  wgpu: {} ({:?})", adapter.get_info().name, adapter.get_info().backend);
    Ok((d, q))
}

/// Schritt 2: einhaengen und gegen den heruntergeladenen Frame nachrechnen.
///
/// # Safety
/// `gpu` muss ein gueltiger VAAPI-Frame sein und die Funktion ueberleben.
unsafe fn import_pruefen(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    gpu: &ffmpeg::frame::Video,
) -> Result<()> {
    let mut drm = ffmpeg::frame::Video::empty();
    (*drm.as_mut_ptr()).format = ffi::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;
    let rc = ffi::av_hwframe_map(drm.as_mut_ptr(), gpu.as_ptr(), ffi::AV_HWFRAME_MAP_READ as i32);
    if rc < 0 {
        bail!("av_hwframe_map (rc={rc})");
    }
    let d = &*((*drm.as_ptr()).data[0] as *const ffi::AVDRMFrameDescriptor);
    if d.nb_layers < 2 {
        bail!("weniger als zwei Layer — hier nicht vorgesehen");
    }
    let modifier = d.objects[0].format_modifier;
    let (bb, bh) = ((*gpu.as_ptr()).width as u32, (*gpu.as_ptr()).height as u32);

    // Der langsame Weg als Wahrheit.
    let cpu = import::herunterladen(gpu)?;
    let cpu_ptr = (*cpu.as_ptr()).data[0];
    let cpu_pitch = (*cpu.as_ptr()).linesize[0] as u32;
    let zehn_bit = (*cpu.as_ptr()).format == ffi::AVPixelFormat::AV_PIX_FMT_P010LE as i32;
    let bytes_je_punkt = if zehn_bit { 2 } else { 1 };
    let cpu_daten = std::slice::from_raw_parts(cpu_ptr, (cpu_pitch * bh) as usize);

    // Nur die Luma-Ebene vergleichen: sie traegt die Aussage (Versatz 0), und
    // das Chroma haengt am selben Import — ist Luma richtig und Chroma falsch,
    // sieht man es an dessen eigenem Vergleich unten.
    let l0 = &d.layers[0];
    let luma = import::Layer {
        fourcc: l0.format,
        offset: l0.planes[0].offset as u64,
        pitch: l0.planes[0].pitch as u64,
        breite: bb,
        hoehe: bh,
    };
    let fd = import::fd_kopieren(d.objects[l0.planes[0].object_index as usize].fd)?;
    let tex = import::einhaengen(device, fd, modifier, &luma)?;
    let (gpu_daten, gpu_pitch) = import::zurueck_lesen(device, queue, &tex, bytes_je_punkt)?;
    let (max, anteil) = import::vergleichen(
        &gpu_daten, gpu_pitch, cpu_daten, cpu_pitch, bb * bytes_je_punkt, bh,
    );
    println!(
        "  Luma  : groesste Abweichung {max}, ungleiche Bytes {:.4} %  → {}",
        anteil * 100.0,
        if max == 0 { "BITGENAU" } else { "ABWEICHUNG" }
    );

    // Chroma: halbe Breite und Hoehe, zwei Kanaele.
    let l1 = &d.layers[1];
    let c_bytes = if zehn_bit { 4 } else { 2 };
    let chroma = import::Layer {
        fourcc: l1.format,
        offset: l1.planes[0].offset as u64,
        pitch: l1.planes[0].pitch as u64,
        breite: bb / 2,
        hoehe: bh / 2,
    };
    let fd2 = import::fd_kopieren(d.objects[l1.planes[0].object_index as usize].fd)?;
    match import::einhaengen(device, fd2, modifier, &chroma) {
        Ok(tex2) => {
            let (g2, p2) = import::zurueck_lesen(device, queue, &tex2, c_bytes)?;
            let c_ptr = (*cpu.as_ptr()).data[1];
            let c_pitch = (*cpu.as_ptr()).linesize[1] as u32;
            let c_daten = std::slice::from_raw_parts(c_ptr, (c_pitch * (bh / 2)) as usize);
            let (max2, anteil2) =
                import::vergleichen(&g2, p2, c_daten, c_pitch, (bb / 2) * c_bytes, bh / 2);
            println!(
                "  Chroma: groesste Abweichung {max2}, ungleiche Bytes {:.4} %  → {}",
                anteil2 * 100.0,
                if max2 == 0 { "BITGENAU" } else { "ABWEICHUNG" }
            );
        }
        // Genau der erwartete Fehlermodus, wenn die Allokationsgroesse den
        // Versatz nicht abdeckt. Kein Abbruch: die Luma-Aussage steht schon.
        Err(e) => println!("  Chroma: EINHAENGEN GESCHEITERT — {e:#}"),
    }
    Ok(())
}

fn datei_pruefen(pfad: &str) -> Result<()> {
    println!("\n=== {pfad}");
    let mut input = ffmpeg::format::input(&pfad).with_context(|| format!("oeffnen: {pfad}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| anyhow!("kein Videostrom"))?;
    let stream_index = stream.index();
    let par = stream.parameters();

    // Decoder von Hand aufbauen, damit das VAAPI-Geraet VOR dem Oeffnen haengt
    // — genau wie im Player (`decode.rs::hw_geraet_anhaengen`).
    unsafe {
        let ctx = ffi::avcodec_alloc_context3(std::ptr::null());
        if ctx.is_null() {
            bail!("avcodec_alloc_context3");
        }
        let rc = ffi::avcodec_parameters_to_context(ctx, par.as_ptr());
        if rc < 0 {
            bail!("avcodec_parameters_to_context (rc={rc})");
        }

        let mut geraet: *mut ffi::AVBufferRef = std::ptr::null_mut();
        let pfad_c = std::ffi::CString::new("/dev/dri/renderD128")?;
        let rc = ffi::av_hwdevice_ctx_create(
            &mut geraet,
            ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
            pfad_c.as_ptr(),
            std::ptr::null_mut(),
            0,
        );
        if rc < 0 {
            bail!("av_hwdevice_ctx_create VAAPI (rc={rc})");
        }
        (*ctx).hw_device_ctx = ffi::av_buffer_ref(geraet);
        ffi::av_buffer_unref(&mut geraet);

        // **Den Decoder benennen, nicht den Standard nehmen.** Fuer AV1 liefert
        // `avcodec_find_decoder` `libdav1d` — und das kennt keine hwaccel, der
        // VAAPI-Weg kaeme nie zustande. Der Player waehlt aus demselben Grund
        // benannte Kandidaten (`decode.rs::candidates_mit`: `nativ_hw("av1")`).
        let name = match (*ctx).codec_id {
            ffi::AVCodecID::AV_CODEC_ID_AV1 => Some("av1"),
            ffi::AVCodecID::AV_CODEC_ID_H264 => Some("h264"),
            ffi::AVCodecID::AV_CODEC_ID_HEVC => Some("hevc"),
            _ => None,
        };
        let codec = match name {
            Some(n) => {
                let c = std::ffi::CString::new(n)?;
                ffi::avcodec_find_decoder_by_name(c.as_ptr())
            }
            None => ffi::avcodec_find_decoder((*ctx).codec_id),
        };
        if codec.is_null() {
            bail!("kein Decoder");
        }
        let rc = ffi::avcodec_open2(ctx, codec, std::ptr::null_mut());
        if rc < 0 {
            bail!("avcodec_open2 (rc={rc})");
        }

            let geraet = wgpu_geraet().ok();
        let mut gesehen = 0usize;
        let mut kurzformen: Vec<String> = Vec::new();
        let mut frame = ffmpeg::frame::Video::empty();
        'aussen: for (s, packet) in input.packets() {
            if s.index() != stream_index {
                continue;
            }
            if ffi::avcodec_send_packet(ctx, { use ffmpeg::codec::packet::traits::Ref; packet.as_ptr() }) < 0 {
                continue;
            }
            loop {
                let rc = ffi::avcodec_receive_frame(ctx, frame.as_mut_ptr());
                if rc < 0 {
                    break;
                }
                let fmt = (*frame.as_ptr()).format;
                if gesehen == 0 {
                    println!(
                        "  Decoder-Format: {} ({}x{})",
                        if fmt == ffi::AVPixelFormat::AV_PIX_FMT_VAAPI as i32 {
                            "AV_PIX_FMT_VAAPI"
                        } else {
                            "NICHT VAAPI — Hardware-Weg kam nicht zustande"
                        },
                        (*frame.as_ptr()).width,
                        (*frame.as_ptr()).height
                    );
                    if fmt != ffi::AVPixelFormat::AV_PIX_FMT_VAAPI as i32 {
                        ffi::avcodec_free_context(&mut (ctx as *mut _));
                        return Ok(());
                    }
                }
                gesehen += 1;
                match deskriptor_zeigen(&frame, gesehen) {
                    Ok(k) => kurzformen.push(k),
                    Err(e) => println!("  Bild {gesehen}: FEHLER {e:#}"),
                }
                // Der Inhaltsvergleich einmal je Datei — er ist teuer (zwei
                // Rueckwege ueber den Hauptspeicher) und die Aussage haengt
                // nicht an der Bildnummer.
                if gesehen == 1 {
                    if let Some((dev, q)) = geraet.as_ref() {
                        if let Err(e) = import_pruefen(dev, q, &frame) {
                            println!("  Import: FEHLER {e:#}");
                        }
                    }
                }
                if gesehen >= BILDER {
                    break 'aussen;
                }
            }
        }

        ffi::avcodec_free_context(&mut (ctx as *mut _));

        // Die eigentliche Aussage: bleibt die Gestalt ueber die Bilder gleich?
        // Eine Bruecke, die sich Format und Objektzahl je Ringplatz merkt,
        // haengt daran.
        let alle_gleich = kurzformen.windows(2).all(|w| w[0] == w[1]);
        println!(
            "  → {} Bilder, Gestalt {}",
            kurzformen.len(),
            if alle_gleich {
                "ueber alle Bilder GLEICH"
            } else {
                "WECHSELT zwischen den Bildern"
            }
        );
        if let Some(k) = kurzformen.first() {
            println!("  → {k}");
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    ffmpeg::init()?;
    let dateien: Vec<String> = std::env::args().skip(1).collect();
    if dateien.is_empty() {
        bail!("Aufruf: vaapi-dmabuf-export <datei> [weitere …]");
    }
    for d in &dateien {
        if let Err(e) = datei_pruefen(d) {
            println!("  FEHLER: {e:#}");
        }
    }
    Ok(())
}
