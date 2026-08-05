//! Probe: wird ein IMPORTIERTES Bild vom Vulkan-Encoder korrekt kodiert?
//!
//! `probe_d3d11_vulkan_import` zeigt, dass der Import gelingt. Das ist nicht
//! dasselbe wie "es funktioniert": ein falsch beschriebener `AVVkFrame`, ein
//! vertauschtes Layout, ein nicht abgewartetes Bild — all das geht durch den
//! Import hindurch und zeigt sich erst am Bild. Und zwar, wie am 2026-07-30
//! auf dem AMD-Zweig, als zerrissenes Bild, das in JEDER Kennzahl besser
//! aussah als der funktionierende Weg.
//!
//! Deshalb prueft diese Probe nicht "laeuft durch", sondern **den Inhalt**:
//! die D3D11-Textur bekommt ein bekanntes Muster (Verlauf in beide Richtungen,
//! Versatz je Bild) und wird importiert und kodiert. Herauskommt
//! `probe-import.mp4`; der Vergleich gegen das Muster laeuft danach von Hand,
//! die Probe schreibt die erwarteten Werte dafuer aus.
//!
//!     cargo run --release --example probe_vulkan_encode_import
//!
//! **Was diese Probe NICHT kann, und was es gekostet hat.** Ihr Muster steht
//! nur in der Luma-Ebene; die Chroma-Ebene ist ueberall derselbe Wert. Der
//! Rueckweg-Vergleich `[2c]` prueft die Chroma-Ebene deshalb gegen ein
//! konstantes Feld — und dagegen ist eine verschobene oder falsch gelesene
//! Ebene grundsaetzlich nicht zu sehen, weil jeder Versatz wieder denselben
//! Wert liefert. Aus einem "Chroma kommt richtig zurueck" wurde am 2026-08-02
//! trotzdem ein Ausschluss, und der hat die Suche nach dem 10-Bit-Fehler zwei
//! Anlaeufe lang in die falsche Richtung gehalten (die Ursache lag am Ende
//! nicht im Import, s. Messakte Abschnitt 11).
//!
//! Fuer die Frage "sieht der Encoder das richtige Bild?" ist deshalb
//! `PULSE_LABOR_BILDABZUG` (`src/bildabzug.rs`) das bessere Werkzeug: es zieht
//! das Bild aus der LAUFENDEN Kette ab, und dort ist die Quelle ein echter
//! Bildschirm statt eines konstanten Feldes.

use std::ffi::c_void;

use anyhow::{Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::ffi::*;
use pulse_win_hq_labor::vkimport::{VK_FORMAT_NV12, VulkanImport};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_FORMAT_P010, DXGI_SAMPLE_DESC};
use windows::Win32::System::Threading::{CRITICAL_SECTION, InitializeCriticalSection};

const BREITE: u32 = 1280;
const HOEHE: u32 = 720;
const BILDER: i64 = 30;

/// Luma-Wert des Musters. Ein Verlauf ueber die Breite plus ein Versatz je
/// Bild: damit faellt sowohl ein vertauschtes Layout auf (waagerecht statt
/// senkrecht) als auch ein stehendes Bild.
fn muster(x: u32, y: u32, n: i64) -> u8 {
    ((x * 200 / BREITE) as i64 + (y * 40 / HOEHE) as i64 + n * 3) as u8
}

/// Y-Ebene von `buf` mit dem Muster fuellen. Die UV-Haelfte dahinter bleibt
/// unberuehrt — sie ist konstant neutral (128) und wird einmal beim Anlegen
/// gesetzt.
/// Schreibt das Muster in die Luma-Ebene.
///
/// **`zehn` ist nicht optional.** P010 hat 16 Bit je Abtastwert und damit den
/// doppelten Zeilenabstand; mit der 8-Bit-Rechnung landet das Muster in der
/// halben Breite und der Rest bleibt stehen. Das sieht im Ergebnis aus wie ein
/// doppeltes Bild mit falschen Farben — also genau wie ein Fehler im Import,
/// den es gar nicht gibt. Am 2026-08-02 bin ich beim Suchen genau darauf
/// hereingefallen.
fn muster_fuellen(buf: &mut [u8], n: i64, zehn: bool) {
    let bpp = if zehn { 2usize } else { 1 };
    let pitch = BREITE as usize * bpp;
    for row in 0..HOEHE as usize {
        for col in 0..BREITE as usize {
            let wert = muster(col as u32, row as u32, n);
            let ab = row * pitch + col * bpp;
            if zehn {
                // P010: 10 Bit in den OBEREN Bits eines 16-Bit-Wortes.
                let zehnbit = (u16::from(wert) << 2) << 6;
                buf[ab..ab + 2].copy_from_slice(&zehnbit.to_le_bytes());
            } else {
                buf[ab] = wert;
            }
        }
    }
}

fn main() -> Result<()> {
    println!("== Probe: importiertes Bild durch den Vulkan-Encoder ==\n");
    ffmpeg::init()?;
    // Einmal lesen, nicht je Bild: `env::var` nimmt einen prozessweiten Lock
    // und legt einen String an.
    let init_muster = std::env::var("PULSE_PROBE_INIT_MUSTER").is_ok();
    // FFmpeg soll sagen, WARUM es ablehnt - sonst bleibt nur die Fehlernummer.
    ffmpeg::util::log::set_level(ffmpeg::util::log::Level::Debug);

    // ── D3D11-Geraet ──────────────────────────────────────────────────────
    let mut device: Option<ID3D11Device> = None;
    let mut ctx: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            windows::Win32::Foundation::HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )
    }?;
    let device = device.ok_or_else(|| anyhow!("kein D3D11-Device"))?;
    let ctx = ctx.ok_or_else(|| anyhow!("kein D3D11-Context"))?;

    // ── Eine teilbare NV12-Textur je Bild-Slot. Der Encoder haelt eine
    //    Referenz, solange er das Bild verarbeitet — eine einzige Textur waere
    //    ueberschrieben, bevor er fertig ist. Vier reichen fuer den Vorlauf.
    // `PULSE_PROBE_P010=1` prueft denselben Weg in 10 bit.
    let zehn = std::env::var("PULSE_PROBE_P010").is_ok();
    const SLOTS: usize = 4;
    let mut texturen: Vec<ID3D11Texture2D> = Vec::new();
    for _ in 0..SLOTS {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: BREITE,
            Height: HOEHE,
            MipLevels: 1,
            ArraySize: 1,
            Format: if zehn { DXGI_FORMAT_P010 } else { DXGI_FORMAT_NV12 },
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            // NTHANDLE|SHARED — NICHT KEYEDMUTEX (Begruendung in vkimport.rs).
            MiscFlags: 0x800 | 0x2,
        };
        // Anfangsinhalt. Mit `PULSE_PROBE_INIT_MUSTER=1` steht das Muster schon
        // HIER drin — dann kann ein leeres Ergebnis kein Zeitproblem sein,
        // sondern nur heissen, dass der Encoder den Texturinhalt nicht sieht.
        let bpp = if zehn { 2usize } else { 1usize };
        let mut roh = vec![128u8; (BREITE * HOEHE) as usize * 3 / 2 * bpp];
        if init_muster {
            muster_fuellen(&mut roh, 0, zehn);
        }
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: roh.as_ptr() as *const c_void,
            SysMemPitch: BREITE * bpp as u32,
            SysMemSlicePitch: 0,
        };
        let mut t: Option<ID3D11Texture2D> = None;
        unsafe { device.CreateTexture2D(&desc, Some(&init), Some(&mut t)) }
            .map_err(|e| anyhow!("CreateTexture2D(NV12, geteilt): {e}"))?;
        texturen.push(t.ok_or_else(|| anyhow!("CreateTexture2D lieferte nichts"))?);
    }
    println!("  [1] {SLOTS} teilbare Texturen {BREITE}x{HOEHE}");

    // ── Importer ──────────────────────────────────────────────────────────
    // Eigene Section: dieser Prüfstand hat keinen Pool, dessen Lock er teilen
    // könnte, und er ist einfädig. Der Importer verlangt sie trotzdem, weil er
    // Befehle auf dem immediate Kontext gibt — hier ist sie unumstritten.
    let mut cs = std::mem::MaybeUninit::<CRITICAL_SECTION>::uninit();
    unsafe { InitializeCriticalSection(cs.as_mut_ptr()) };
    let lock_ptr = cs.as_mut_ptr();
    // SAFETY: `cs` lebt bis zum Ende von `main`, also länger als der Importer.
    let vk_format = if zehn { pulse_win_hq_labor::vkimport::VK_FORMAT_P010 } else { VK_FORMAT_NV12 };
    println!("  [0] Format: {}", if zehn { "P010 (10 bit)" } else { "NV12 (8 bit)" });
    let mut importer =
        unsafe {
            VulkanImport::new(
                &device, &ctx, lock_ptr, BREITE, HOEHE, vk_format,
                pulse_win_hq_labor::vkimport::Videocodec::Av1,
            )
        }?;
    println!("  [2] Vulkan-Import bereit");

    // ── Encoder auf dem importierten Frames-Kontext ────────────────────────
    // Was erwartet FFmpeg eigentlich? Einen Frame vom eigenen Pool anlegen
    // lassen und ansehen - das ist die einzige verlaessliche Vorlage. Raten,
    // wie viele Bilder ein NV12-Frame hat, ist genau die Sorte Annahme, die
    // hier als Absturz endet.
    {
        use pulse_win_hq_labor::vkimport::AVVkFrame;
        let mut probe = ffmpeg::frame::Video::empty();
        unsafe {
            let p = probe.as_mut_ptr();
            (*p).hw_frames_ctx = av_buffer_ref(importer.frames_ref());
            let rc = av_hwframe_get_buffer(importer.frames_ref(), p, 0);
            if rc < 0 {
                return Err(anyhow!("av_hwframe_get_buffer rc={rc}"));
            }
            let vk = (*p).data[0] as *const AVVkFrame;
            let bilder = (0..8).filter(|i| (*vk).img[*i] != 0).count();
            let speicher = (0..8).filter(|i| (*vk).mem[*i] != 0).count();
            let semas = (0..8).filter(|i| (*vk).sem[*i] != 0).count();
            println!(
                "  [2b] FFmpegs eigener Frame: {bilder} VkImage, {speicher} Speicher, {semas} Semaphore, \
                 tiling={} layout[0]={} queue_family[0]={:#x} internal={:?}",
                (*vk).tiling, (*vk).layout[0], (*vk).queue_family[0], (*vk).internal
            );
            // Die Ebenen-Versaetze und -Groessen. Bleiben sie 0, rechnet FFmpeg
            // sie selbst aus; steht dort etwas, muessen wir es nachbilden.
            let offs: [isize; 4] = std::ptr::read(&raw const (*vk).offset).map(|o| o)[..4]
                .try_into()
                .unwrap();
            let grs: [usize; 4] = std::ptr::read(&raw const (*vk).size).map(|s| s)[..4]
                .try_into()
                .unwrap();
            println!(
                "  [2b] offset={offs:?}  size={grs:?}  flags={:#x}  access[0]={}",
                (*vk).flags,
                (*vk).access[0]
            );
        }
    }
    let desc = ffmpeg::codec::encoder::find_by_name("av1_vulkan")
        .ok_or_else(|| anyhow!("av1_vulkan fehlt im gelinkten FFmpeg"))?;
    let mut enc = ffmpeg::codec::context::Context::new_with_codec(desc).encoder().video()?;
    enc.set_width(BREITE);
    enc.set_height(HOEHE);
    enc.set_format(ffmpeg::format::Pixel::VULKAN);
    enc.set_time_base(ffmpeg::Rational::new(1, 60));
    enc.set_frame_rate(Some(ffmpeg::Rational::new(60, 1)));
    enc.set_bit_rate(6_000_000);
    enc.set_max_b_frames(0);
    unsafe {
        let p = enc.as_mut_ptr();
        (*p).hw_frames_ctx = av_buffer_ref(importer.frames_ref());
    }
    let mut opened = enc.open_with(ffmpeg::Dictionary::new())?;
    println!("  [3] av1_vulkan offen, gebunden an den Import-Kontext");

    // ── Kodieren ──────────────────────────────────────────────────────────
    let mut aus = ffmpeg::format::output(&"probe-import.mp4".to_string())?;
    let mut stream = aus.add_stream(desc)?;
    let idx = stream.index();
    stream.set_parameters(&opened);
    aus.write_header()?;
    let stream_tb = aus.stream(idx).unwrap().time_base();

    let mut geschrieben = 0;
    // Einmal anlegen, je Bild nur die Y-Ebene ueberschreiben.
    let mut voll = vec![128u8; (BREITE * HOEHE) as usize * 3 / 2 * if zehn { 2 } else { 1 }];
    for n in 0..BILDER {
        let tex = &texturen[n as usize % SLOTS];
        // Muster in die Textur schreiben (Y-Ebene; UV bleibt neutral). Der
        // Puffer liegt VOR der Schleife: er ist 3,2 MB gross, und ihn je Bild
        // neu anzulegen waere die Vorlage, die spaeter in den echten Sendeweg
        // wandert.
        muster_fuellen(&mut voll, n, zehn);
        // Schreiben laeuft INNERHALB der Uebergabe: davor wartet der Importer
        // auf den Encoder (sonst ueberschreiben wir ein Bild, das gerade
        // kodiert wird), danach auf D3D11 (sonst liest der Encoder halb).
        //
        // SAFETY: die Textur gehoert zu diesem Importer (Format und Masse
        // stimmen) und lebt bis zum Ende der Schleife.
        let vkf = unsafe {
            importer.mit_bild(tex, || {
                if !init_muster {
                    ctx.UpdateSubresource(tex, 0, None, voll.as_ptr() as *const c_void, BREITE * if zehn { 2 } else { 1 }, 0);
                }
                Ok(())
            })?
        };

        let mut frame = ffmpeg::frame::Video::empty();
        unsafe {
            let f = frame.as_mut_ptr();
            (*f).format = AVPixelFormat::AV_PIX_FMT_VULKAN as i32;
            (*f).width = BREITE as i32;
            (*f).height = HOEHE as i32;
            (*f).data[0] = vkf as *mut u8;
            unsafe extern "C" fn nichts_freigeben(_: *mut c_void, _: *mut u8) {}
            (*f).buf[0] = av_buffer_create(
                vkf as *mut u8,
                std::mem::size_of::<pulse_win_hq_labor::vkimport::AVVkFrame>(),
                Some(nichts_freigeben),
                std::ptr::null_mut(),
                AV_BUFFER_FLAG_READONLY,
            );
            (*f).hw_frames_ctx = av_buffer_ref(importer.frames_ref());
            (*f).pts = n;

            // **Das importierte Bild einmal ZURUECKHOLEN und ansehen.**
            //
            // Trennt zwei Verdaechtige, die sich sonst nicht trennen lassen:
            // kommt hier schon Unsinn heraus, liegt es am Import; kommt es
            // richtig heraus, am Encoder. Nur beim ersten Bild — es ist eine
            // volle Kopie ueber den PCIe-Bus.
            if n == 0 {
                let mut cpu = ffmpeg::frame::Video::empty();
                let rc = av_hwframe_transfer_data(cpu.as_mut_ptr(), f, 0);
                if rc < 0 {
                    println!("  [2c] Rueckweg scheiterte (rc={rc}) — dazu sagt die Probe nichts");
                } else {
                    let c = cpu.as_ptr();
                    let bpp = if zehn { 2usize } else { 1 };
                    // Ein Wert aus der Mitte je Ebene. Erwartet: Y = Muster,
                    // UV = neutral (bei 8 bit 128, bei 10 bit 0x8080).
                    let lies = |ebene: usize, x: usize, y: usize| -> u32 {
                        let p = (*c).data[ebene];
                        let ls = (*c).linesize[ebene] as usize;
                        let ab = p.add(y * ls + x * bpp);
                        if zehn { u32::from(u16::from_le_bytes([*ab, *ab.add(1)])) } else { u32::from(*ab) }
                    };
                    let erwartet_y = if zehn {
                        u32::from((u16::from(muster(640, 360, 0)) << 2) << 6)
                    } else {
                        u32::from(muster(640, 360, 0))
                    };
                    let erwartet_uv = if zehn { 0x8080 } else { 128 };
                    println!(
                        "  [2c] Rueckweg: Format={:?} linesize=[{}, {}]  \
                         Y(640,360)={} (erwartet {})  UV(320,180)={},{} (erwartet {})",
                        (*c).format,
                        (*c).linesize[0],
                        (*c).linesize[1],
                        lies(0, 640, 360),
                        erwartet_y,
                        lies(1, 320, 180),
                        lies(1, 321, 180),
                        erwartet_uv
                    );
                }
            }

            let rc = avcodec_send_frame(opened.as_mut_ptr(), f);
            if rc < 0 {
                return Err(anyhow!("avcodec_send_frame rc={rc} bei Bild {n}"));
            }
        }
        loop {
            let mut pkt = ffmpeg::Packet::empty();
            match opened.receive_packet(&mut pkt) {
                Ok(()) => {
                    // Groesse VOR dem Schreiben lesen - danach ist das Paket
                    // geleert und meldet 0.
                    let groesse = pkt.size();
                    pkt.set_stream(idx);
                    pkt.rescale_ts(ffmpeg::Rational::new(1, 60), stream_tb);
                    pkt.write_interleaved(&mut aus)?;
                    geschrieben += 1;
                    if geschrieben <= 4 {
                        println!("      Paket {geschrieben}: {groesse} Bytes");
                    }
                }
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(e.into()),
            }
        }
    }
    opened.send_eof()?;
    loop {
        let mut pkt = ffmpeg::Packet::empty();
        match opened.receive_packet(&mut pkt) {
            Ok(()) => {
                pkt.set_stream(idx);
                pkt.rescale_ts(ffmpeg::Rational::new(1, 60), stream_tb);
                pkt.write_interleaved(&mut aus)?;
                geschrieben += 1;
            }
            _ => break,
        }
    }
    aus.write_trailer()?;
    println!("  [4] {geschrieben} Pakete geschrieben -> probe-import.mp4");

    println!(
        "\n  Naechster Schritt: `ffprobe probe-import.mp4` und den Inhalt gegen\n  \
         das Muster rechnen (heilung.exe oder ffmpeg psnr).\n"
    );
    Ok(())
}
