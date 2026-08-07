//! Scanout-Aufnahme (DRM/KMS) → 10-bit-AV1 mit BT.2020/PQ. Der Nachweis, dass
//! auf Linux echter HDR-Inhalt in den Strom kommt — und das Werkzeug, mit dem
//! sich das auf einer anderen Maschine in einem Kommando wiederholen laesst.
//!
//! ```text
//! # Ausgaenge und ihren HDR-Zustand zeigen (braucht keine Rechte):
//! cargo run --release --example kms_hdr_nachweis -- --liste
//!
//! # Aufnehmen (braucht CAP_SYS_ADMIN oder root — s. Modul-Doku capture::kms):
//! sudo -E ./target/release/examples/kms_hdr_nachweis DP-2 /tmp/hdr.ivf 120
//! ```
//!
//! Das Ergebnis ist bewusst **IVF**: ein Container ohne eigene Farbtags. Was
//! `ffprobe` daran meldet, kann nur aus dem AV1-Sequenzkopf stammen und nicht
//! aus einer Container-Angabe, die wir selbst geschrieben haetten.
//!
//! Pruefen:
//! ```text
//! ffprobe -v error -show_entries stream=pix_fmt,color_space,color_transfer,color_primaries /tmp/hdr.ivf
//! ffmpeg -i /tmp/hdr.ivf -vf signalstats -show_entries frame_tags=lavfi.signalstats.YMAX,lavfi.signalstats.YAVG -f null -
//! ```

use std::path::Path;
use std::time::{Duration, Instant};

use ffmpeg_next as ffmpeg;
use ffmpeg::ffi::av_frame_free;

use pulse_linux_hq_sidecar::capture::kms::KmsKarte;
use pulse_linux_hq_sidecar::capture::kms_aufnahme::KmsAufnahme;
use pulse_linux_hq_sidecar::encode::nv_p010::Farbmodell;
use pulse_linux_hq_sidecar::encode::{
    EncoderConfig, VideoEncoder, hdr, hw, nv_import, nv_import::NvDmabufImporter,
};
use pulse_linux_hq_sidecar::system::drm;

fn main() -> anyhow::Result<()> {
    let _ = ffmpeg::init();
    pulse_linux_hq_sidecar::logging::init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let karte = KmsKarte::erste_mit_ausgaengen()?;

    if args.first().is_some_and(|a| a == "--liste") {
        for a in karte.ausgaenge()? {
            println!(
                "{:<12} crtc={:<5} {}",
                a.name,
                a.crtc_id,
                match a.hdr {
                    None => "HDR aus (keine HDR_OUTPUT_METADATA)".to_string(),
                    Some(h) if h.ist_pq() => format!(
                        "HDR EIN (PQ) — MaxCLL {} cd/m2, MaxFALL {}, Schirm {}..{} cd/m2",
                        h.max_cll, h.max_fall, h.min_leuchtdichte, h.max_leuchtdichte
                    ),
                    Some(h) => format!("HDR-Angaben da, aber eotf={} (nicht PQ)", h.eotf),
                }
            );
        }
        return Ok(());
    }

    let wunsch = args.first().filter(|a| !a.starts_with("--")).map(String::as_str);
    let ziel = args.get(1).cloned().unwrap_or_else(|| "/tmp/pulse_kms_hdr.ivf".into());
    let bilder: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(120);
    let fps: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(60);
    // Gegenprobe: derselbe Weg ohne HDR-Signalisierung, damit ein Unterschied
    // dem HDR-Zweig zugeordnet werden kann und nicht der Aufnahme.
    let ohne_hdr = args.iter().any(|a| a == "--ohne-hdr");

    let ausgang = karte.ausgang_waehlen(wunsch)?;
    eprintln!(
        "[kms] Ausgang {} (crtc {}), HDR am Ausgang: {}",
        ausgang.name,
        ausgang.crtc_id,
        if ausgang.ist_hdr() { "ja (PQ)" } else { "nein" }
    );

    let (vendor, _node) = drm::detect().ok_or_else(|| anyhow::anyhow!("keine Render-Node"))?;
    if vendor != drm::Vendor::Nvidia {
        anyhow::bail!("dieses Werkzeug prueft den NVENC-Weg; hier laeuft {}", vendor.slug());
    }

    // Die Absage-Tabelle ist Teil des Nachweises: ohne HDR am Ausgang darf hier
    // gar kein Strom entstehen.
    let angaben = if ohne_hdr {
        eprintln!("[kms] Gegenprobe: SDR-Signalisierung auf demselben Aufnahmeweg");
        None
    } else {
        Some(hdr::pruefen(vendor, "av1", &ausgang)?)
    };
    if let Some(a) = angaben {
        eprintln!(
            "[kms] HDR-Angaben des Ausgangs: eotf={} MaxCLL={} MaxFALL={} \
             Primaervalenzen={:?} Weisspunkt={:?}",
            a.eotf, a.max_cll, a.max_fall, a.primaries, a.weisspunkt
        );
    }

    // Ab hier laeuft **derselbe** Aufnahme-Thread wie im ausgelieferten
    // Sidecar (`capture::kms_aufnahme`), nicht eine zweite Schleife daneben —
    // sonst misst das Werkzeug etwas anderes, als der Nutzer bekommt.
    let (frames, _ausgang, mut aufnahme) = KmsAufnahme::start(wunsch, fps)?;
    let erstes = frames
        .wait_take(Duration::from_secs(5))?
        .ok_or_else(|| anyhow::anyhow!("kein Bild vom Scanout in 5 s"))?;
    let (w, h) = (erstes.width, erstes.height);
    eprintln!(
        "[kms] Scanout: {}x{} fourcc={:#010x} ({}) modifier={:#018x}",
        w,
        h,
        erstes.drm_fourcc,
        fourcc_text(erstes.drm_fourcc),
        erstes.modifier
    );

    let hdr_an = angaben.is_some();
    let staging = nv_import::StagingFormat::P010;
    let farbmodell = if hdr_an { Farbmodell::Bt2020Ncl } else { Farbmodell::Bt709 };
    let hw_ctx = hw::HwContext::create(hw::HwDeviceKind::Cuda, None, w, h, staging.av_pix_fmt())?;
    let cfg = EncoderConfig {
        vendor,
        codec: "av1".into(),
        fps,
        bitrate_kbps: 20000,
        width: w,
        height: h,
        ten_bit: true,
        hdr: hdr_an,
    };
    let mut enc = VideoEncoder::create(&cfg, &hw_ctx, &ziel)?;
    let mut importer = NvDmabufImporter::new(w, h, staging, farbmodell)?;

    let start = Instant::now();
    let mut bild = erstes;
    let mut gesendet: u64 = 0;
    loop {
        let mut hw_frame = importer.import(&bild, &hw_ctx)?;
        // SAFETY: frisch aus dem Pool, Format passt zum gebundenen Kontext.
        unsafe { enc.send_hw(hw_frame, gesendet as i64)? };
        unsafe { av_frame_free(&mut hw_frame) };
        gesendet += 1;
        if gesendet >= bilder {
            break;
        }
        bild = match frames.wait_take(Duration::from_secs(5))? {
            Some(f) => f,
            None => anyhow::bail!("Scanout lieferte 5 s lang kein Bild"),
        };
    }
    aufnahme.stop();
    enc.finish()?;

    let dauer = start.elapsed().as_secs_f64();
    eprintln!(
        "[kms] {gesendet} Bilder in {dauer:.1}s ({:.1} fps) → {}",
        gesendet as f64 / dauer.max(0.001),
        ziel
    );
    eprintln!(
        "[kms] pruefen: ffprobe -v error -show_entries \
         stream=pix_fmt,color_space,color_transfer,color_primaries {}",
        Path::new(&ziel).display()
    );
    Ok(())
}

/// DRM-Fourcc als lesbare vier Zeichen (`AB30`, `XR24`).
fn fourcc_text(f: u32) -> String {
    f.to_le_bytes().iter().map(|&b| b as char).collect()
}
