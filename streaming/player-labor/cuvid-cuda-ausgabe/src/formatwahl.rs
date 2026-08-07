//! Wer das Ausgabeformat des Decoders waehlt, und der `get_format`-Rueckruf,
//! der das umsetzt.
//!
//! Eigenes Modul, getrennt von der Messstrecke (`lauf.rs`): das hier ist reine
//! FFmpeg-Callback-Mechanik (inklusive der beiden Prozess-globalen Statics,
//! die FFmpeg aus C heraus fuellt), keine Messung.

use anyhow::{bail, Result};
use ffmpeg_next as ffmpeg;
use ffmpeg::ffi::AVPixelFormat;

/// Wer das Ausgabeformat waehlt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Formatwahl {
    /// Kein eigener Rueckruf — Byte fuer Byte der Weg, den `pulse-player`
    /// heute geht. Das ist der Bezugsarm.
    Roh,
    /// Eigener Rueckruf, der die angebotene Liste protokolliert und die
    /// Entscheidung an `avcodec_default_get_format` zurueckgibt.
    ///
    /// **Das ist eine Kontrolle, kein Messarm.** Sie trennt zwei Ursachen: ein
    /// Unterschied zwischen `Roh` und `Standard` kaeme vom Rueckruf selbst,
    /// nicht von der Formatwahl. Ohne sie waere ein Befund aus `Cuda` nicht
    /// eindeutig zuzuordnen.
    Standard,
    /// Eigener Rueckruf, der `AV_PIX_FMT_CUDA` waehlt, wenn es angeboten wird.
    Cuda,
}

impl Formatwahl {
    pub fn aus_text(s: &str) -> Result<Self> {
        Ok(match s {
            "roh" => Self::Roh,
            "standard" => Self::Standard,
            "cuda" => Self::Cuda,
            sonst => bail!("SPIKE_FORMATWAHL kennt nur roh|standard|cuda, nicht {sonst}"),
        })
    }

    pub fn schluessel(self) -> &'static str {
        match self {
            Self::Roh => "roh",
            Self::Standard => "standard",
            Self::Cuda => "cuda",
        }
    }
}

/// Die Liste der Formate, die der Decoder beim Oeffnen angeboten hat.
///
/// **Sie ist der wichtigste Einzelbeleg der ganzen Probe:** steht
/// `AV_PIX_FMT_CUDA` nicht darin, ist die Frage negativ beantwortet und keine
/// Einstellung der Welt aendert das. Steht es darin und wird trotzdem nicht
/// gewaehlt, liegt es an der Auswahlregel — ein ganz anderer Befund mit einem
/// ganz anderen Ausweg.
static ANGEBOTEN: std::sync::Mutex<Vec<i32>> = std::sync::Mutex::new(Vec::new());
/// Was der Rueckruf zurueckgegeben hat.
static GEWAEHLT: std::sync::Mutex<i32> = std::sync::Mutex::new(-1);

/// Vor jedem Durchgang aufzurufen — sonst traegt ein Befund die Reste des
/// vorigen Laufs.
pub fn zuruecksetzen() {
    ANGEBOTEN.lock().unwrap().clear();
    *GEWAEHLT.lock().unwrap() = -1;
}

pub fn angebotene() -> Vec<i32> {
    ANGEBOTEN.lock().unwrap().clone()
}

pub fn gewaehltes() -> i32 {
    *GEWAEHLT.lock().unwrap()
}

/// Traegt den passenden `get_format`-Rueckruf in den Decoder-Kontext ein
/// (`Roh` traegt keinen ein — Bezugsarm).
///
/// # Safety
/// `ctx` muss ein gueltiger, noch nicht geoeffneter `AVCodecContext` sein.
pub unsafe fn eintragen(ctx: *mut ffmpeg::ffi::AVCodecContext, formatwahl: Formatwahl) {
    match formatwahl {
        Formatwahl::Roh => {}
        Formatwahl::Standard => (*ctx).get_format = Some(rueckruf_standard),
        Formatwahl::Cuda => (*ctx).get_format = Some(rueckruf_cuda),
    }
}

/// SAFETY-Vertrag: FFmpeg ruft das aus `avcodec_open2` bzw. aus dem Decode
/// heraus auf, mit gueltigem `ctx` und einer mit `AV_PIX_FMT_NONE`
/// abgeschlossenen Liste.
unsafe extern "C" fn rueckruf_standard(
    ctx: *mut ffmpeg::ffi::AVCodecContext,
    fmt: *const AVPixelFormat,
) -> AVPixelFormat {
    liste_merken(fmt);
    let wahl = ffmpeg::ffi::avcodec_default_get_format(ctx, fmt);
    *GEWAEHLT.lock().unwrap() = wahl as i32;
    wahl
}

/// SAFETY-Vertrag wie oben.
unsafe extern "C" fn rueckruf_cuda(
    ctx: *mut ffmpeg::ffi::AVCodecContext,
    fmt: *const AVPixelFormat,
) -> AVPixelFormat {
    let liste = liste_merken(fmt);
    let wahl = if liste.contains(&(AVPixelFormat::AV_PIX_FMT_CUDA as i32)) {
        AVPixelFormat::AV_PIX_FMT_CUDA
    } else {
        // Nicht angeboten — dann NICHT heimlich etwas anderes nehmen, sondern
        // das tun, was ohne uns geschaehe. Der Unterschied wird oben sichtbar,
        // weil `gewaehlt` protokolliert wird.
        ffmpeg::ffi::avcodec_default_get_format(ctx, fmt)
    };
    *GEWAEHLT.lock().unwrap() = wahl as i32;
    wahl
}

unsafe fn liste_merken(fmt: *const AVPixelFormat) -> Vec<i32> {
    let mut out = Vec::new();
    let mut p = fmt;
    while !p.is_null() && *p != AVPixelFormat::AV_PIX_FMT_NONE {
        out.push(*p as i32);
        p = p.add(1);
        if out.len() > 64 {
            break;
        }
    }
    *ANGEBOTEN.lock().unwrap() = out.clone();
    out
}

pub fn format_name(f: i32) -> String {
    // SAFETY: `av_get_pix_fmt_name` nimmt jeden Wert und gibt bei unbekannten
    // null zurueck.
    let p = unsafe { ffmpeg::ffi::av_get_pix_fmt_name(std::mem::transmute::<i32, AVPixelFormat>(f)) };
    if p.is_null() {
        return format!("<unbekannt {f}>");
    }
    // SAFETY: nicht-null, statischer, nullterminierter String aus FFmpeg.
    unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned()
}
