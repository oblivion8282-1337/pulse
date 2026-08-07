//! Die inhaltlichen Kontrollen ueber ein dekodiertes Bild.
//!
//! Getrennt von `lauf.rs` (der Messstrecke), weil das hier reine Pruefungen
//! sind: sie lesen Bilddaten und vergleichen, messen aber nichts. Der Schnitt
//! haelt `lauf.rs` bei der Frage "wie schnell", diese Datei bei "stimmt es".

use anyhow::{bail, Result};
use ffmpeg_next as ffmpeg;
use ffmpeg::ffi::AVPixelFormat;

use crate::cuda::Treiber;
use crate::lauf::Ebene;

/// Ein billiger, positionsabhaengiger Fingerabdruck ueber die Y-Ebene.
///
/// Positionsabhaengig, damit zwei verschiedene Bilder nicht zufaellig gleich
/// herauskommen; billig, damit er die Zeitmessung nicht faelscht — er laeuft
/// deshalb nur ueber die ersten paar Bilder und ausserhalb der Messstrecke.
fn abdruck(daten: &[u8], zeilen: usize, zeilenabstand: usize, bytes_je_zeile: usize) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for y in 0..zeilen {
        let start = y * zeilenabstand;
        let ende = (start + bytes_je_zeile).min(daten.len());
        if start >= daten.len() {
            break;
        }
        for (x, b) in daten[start..ende].iter().enumerate() {
            h ^= (*b as u64).wrapping_mul((x as u64) ^ ((y as u64) << 17) ^ 0x9e3779b9);
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

/// Das Format hinter `AV_PIX_FMT_CUDA` — was tatsaechlich in den Ebenen steht.
///
/// Ohne diese Angabe waere die Bittiefe zu raten, und ein falsch geratener
/// Zeilenanteil liesse die Nagelprobe unten scheitern, ohne dass etwas
/// tatsaechlich falsch waere.
pub fn sw_format_von(frame: &ffmpeg::util::frame::video::Video) -> i32 {
    // SAFETY: gueltiges AVFrame; `hw_frames_ctx` ist bei Hardware-Bildern
    // gesetzt und zeigt auf einen `AVHWFramesContext` (Bindung aus
    // `hwcontext.h`, nicht von Hand nachgebaut).
    unsafe {
        let f = frame.as_ptr();
        if (*f).hw_frames_ctx.is_null() {
            return (*f).format;
        }
        let fc = (*(*f).hw_frames_ctx).data as *const ffmpeg::ffi::AVHWFramesContext;
        (*fc).sw_format as i32
    }
}

/// **Die Nagelprobe zu Frage 2 des Auftrags.**
///
/// Beantwortet nicht „liegt es auf der Karte" (das sagt schon der Zeigertest),
/// sondern: **taugen `data[0]` und `linesize[0]` als Quelle eines
/// CUDA-Kopierbefehls?** Genau das braucht der Umbau, um in ein eingehaengtes
/// Vulkan-Bild zu schreiben.
///
/// Verglichen wird gegen `av_hwframe_transfer_data` — einen zweiten,
/// unabhaengigen Weg zu denselben Bildpunkten. Stimmen beide ueberein, ist
/// ausgeschlossen, dass der Zeiger zwar gueltig, der Zeilenabstand aber ein
/// anderer ist als angegeben. Ein falsch angenommener Zeilenabstand ist der
/// Fehler, der ein schraeg verzerrtes Bild erzeugt und in der Nachbarprobe
/// eigens abgesichert werden musste.
pub fn zeilenkopie_pruefen(
    frame: &ffmpeg::util::frame::video::Video,
    ebenen: &[Ebene],
    sw_format: i32,
    treiber: &Treiber,
) -> Result<bool> {
    // SAFETY: gueltiges AVFrame.
    let (breite, hoehe) = unsafe {
        let f = frame.as_ptr();
        ((*f).width as usize, (*f).height as usize)
    };
    let tiefe = if sw_format == AVPixelFormat::AV_PIX_FMT_P010LE as i32
        || sw_format == AVPixelFormat::AV_PIX_FMT_P016LE as i32
    {
        2
    } else {
        1
    };
    let bytes_je_zeile = breite * tiefe;
    let e0 = &ebenen[0];
    // Gegenprobe zur Nagelprobe: mit `SPIKE_ABSTAND_FALSCH=1` wird der
    // Zeilenabstand absichtlich um 64 Byte verstellt. Der Vergleich MUSS dann
    // scheitern — sonst prueft er nichts und ein "stimmt ueberein" waere
    // wertlos. Genau diese Fehlerklasse (eine Pruefung, die immer zustimmt)
    // hat in diesem Labor schon Befunde gekostet.
    let abstand = e0.zeilenabstand.max(0) as usize;
    let abstand = if std::env::var("SPIKE_ABSTAND_FALSCH").as_deref() == Ok("1") {
        eprintln!("GEGENPROBE: Zeilenabstand absichtlich {abstand} -> {}", abstand + 64);
        abstand + 64
    } else {
        abstand
    };
    let ueber_cuda = treiber.ebene_lesen(e0.adresse, abstand, bytes_je_zeile, hoehe)?;

    let mut wirt = ffmpeg::util::frame::video::Video::empty();
    // SAFETY: beide Bilder gueltig; FFmpeg schreibt nur in `wirt`.
    let rc = unsafe { ffmpeg::ffi::av_hwframe_transfer_data(wirt.as_mut_ptr(), frame.as_ptr(), 0) };
    if rc < 0 {
        bail!("Nagelprobe: av_hwframe_transfer_data scheiterte (rc={rc})");
    }
    // SAFETY: `wirt` hat jetzt Puffer im Hauptspeicher.
    let ueber_ffmpeg = unsafe {
        let f = wirt.as_ptr();
        let abstand = (*f).linesize[0].max(0) as usize;
        std::slice::from_raw_parts((*f).data[0], abstand * hoehe)
            .chunks(abstand)
            .flat_map(|z| z[..bytes_je_zeile.min(z.len())].to_vec())
            .collect::<Vec<u8>>()
    };
    Ok(ueber_cuda == ueber_ffmpeg)
}

/// Fingerabdruck eines Bildes — holt es bei Bedarf vorher von der Karte.
///
/// **Kontrolle B der Probe.** Ein CUDA-Bild, das sich nicht in ein gleiches
/// Bild zurueckverwandeln laesst, waere kein Ergebnis, sondern eine huebsche
/// Adresse ohne Inhalt. Der Vergleich der beiden Arme findet in `main` statt.
pub fn bild_abdruck(frame: &ffmpeg::util::frame::video::Video) -> Result<u64> {
    // SAFETY: gueltiges AVFrame.
    let (format, breite, hoehe) = unsafe {
        let f = frame.as_ptr();
        ((*f).format, (*f).width, (*f).height)
    };
    let im_grafikspeicher = format == AVPixelFormat::AV_PIX_FMT_CUDA as i32
        || format == AVPixelFormat::AV_PIX_FMT_VAAPI as i32;

    let mut wirt = ffmpeg::util::frame::video::Video::empty();
    let quelle = if im_grafikspeicher {
        // SAFETY: beide Bilder sind gueltig; FFmpeg schreibt nur in `wirt`.
        let rc = unsafe {
            ffmpeg::ffi::av_hwframe_transfer_data(wirt.as_mut_ptr(), frame.as_ptr(), 0)
        };
        if rc < 0 {
            bail!("av_hwframe_transfer_data scheiterte (rc={rc})");
        }
        &wirt
    } else {
        frame
    };

    // SAFETY: gueltiges AVFrame mit Puffern im Hauptspeicher.
    unsafe {
        let f = quelle.as_ptr();
        let zeilenabstand = (*f).linesize[0].max(0) as usize;
        if zeilenabstand == 0 || (*f).data[0].is_null() {
            bail!("Bild ohne Y-Ebene");
        }
        let tiefe = if (*f).format == AVPixelFormat::AV_PIX_FMT_P010LE as i32
            || (*f).format == AVPixelFormat::AV_PIX_FMT_P016LE as i32
            || (*f).format == AVPixelFormat::AV_PIX_FMT_YUV420P10LE as i32
        {
            2
        } else {
            1
        };
        let bytes_je_zeile = (breite as usize) * tiefe;
        let laenge = zeilenabstand * (hoehe as usize);
        let daten = std::slice::from_raw_parts((*f).data[0], laenge);
        Ok(abdruck(daten, hoehe as usize, zeilenabstand, bytes_je_zeile))
    }
}
