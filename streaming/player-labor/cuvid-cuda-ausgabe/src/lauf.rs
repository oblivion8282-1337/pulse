//! Ein Decodier-Durchgang: Datei hinein, Bilder heraus, Posten gemessen.
//!
//! Der Durchgang bildet **den Weg des Players** nach, nicht den von
//! `ffmpeg -i`: derselbe Decodername, dasselbe `AV_CODEC_FLAG_LOW_DELAY`,
//! dieselbe Bindung (`ffmpeg-next` 8.1). Was hier gemessen wird, soll dort
//! gelten.
//!
//! Bewusst OHNE Netz, ohne WHEP, ohne Fenster: die Frage ist, was der Decoder
//! herausgibt. Jede weitere Station waere eine zusaetzliche Ursache fuer einen
//! Unterschied, den man dann nicht mehr zuordnen kann.
//!
//! Die inhaltlichen Kontrollen (Fingerabdruck, Nagelprobe) stehen in
//! `pruefungen.rs`, die Formatwahl-Callback-Mechanik in `formatwahl.rs` —
//! diese Datei ist die Messstrecke selbst.

use anyhow::{anyhow, bail, Context, Result};
use ffmpeg_next as ffmpeg;

use crate::cuda::{Lage, Treiber};
use crate::formatwahl::{self, Formatwahl};
use crate::pruefungen::{bild_abdruck, sw_format_von, zeilenkopie_pruefen};

/// Beschreibung einer Ebene des ersten dekodierten Bildes.
#[derive(Debug, Clone)]
pub struct Ebene {
    pub adresse: u64,
    pub zeilenabstand: i32,
    pub lage: Lage,
}

#[derive(Debug, Clone, Default)]
pub struct Zeiten {
    proben: Vec<u64>,
}

impl Zeiten {
    fn dazu(&mut self, ns: u64) {
        self.proben.push(ns);
    }
    pub fn mittel_us(&self) -> f64 {
        if self.proben.is_empty() {
            return 0.0;
        }
        self.proben.iter().sum::<u64>() as f64 / self.proben.len() as f64 / 1000.0
    }
    pub fn median_us(&self) -> f64 {
        self.perzentil_us(50)
    }
    pub fn p95_us(&self) -> f64 {
        self.perzentil_us(95)
    }
    /// Gemeinsame Rechnung fuer `median_us`/`p95_us`: sortieren, an der
    /// Perzentil-Position abgreifen. Fuer `p=50` dieselbe Position wie ein
    /// direktes `len() / 2` (ganzzahlige Division kuerzt hier exakt).
    fn perzentil_us(&self, p: usize) -> f64 {
        if self.proben.is_empty() {
            return 0.0;
        }
        let mut v = self.proben.clone();
        v.sort_unstable();
        let idx = (v.len() * p / 100).min(v.len() - 1);
        v[idx] as f64 / 1000.0
    }
}

/// Was ein Durchgang berichtet.
pub struct Ergebnis {
    pub decoder: String,
    pub hwctx: bool,
    pub formatwahl: Formatwahl,
    pub angeboten: Vec<i32>,
    pub gewaehlt: i32,
    pub bildformat: i32,
    pub breite: i32,
    pub hoehe: i32,
    pub ebenen: Vec<Ebene>,
    /// Das Format hinter `cuda` — was tatsaechlich in den Ebenen steht.
    pub sw_format: i32,
    /// Nagelprobe: liefert ein zeilenweises `cuMemcpyDtoH` von `data[0]` mit
    /// `linesize[0]` dieselbe Y-Ebene wie `av_hwframe_transfer_data`?
    /// `None` = nicht anwendbar (Bild liegt nicht auf der Karte).
    pub zeilenkopie_gleich: Option<bool>,
    pub bilder: usize,
    pub send: Zeiten,
    pub receive: Zeiten,
    /// Nur belegt, wenn `SPIKE_ABHOLEN=1` lief.
    pub abholen: Zeiten,
    pub wanduhr_s: f64,
    pub cpu_s: f64,
    /// Fingerabdruecke der ersten Bilder — Kontrolle B (Inhaltsgleichheit).
    pub abdruecke: Vec<u64>,
}

impl Ergebnis {
    pub fn fps(&self) -> f64 {
        if self.wanduhr_s <= 0.0 {
            0.0
        } else {
            self.bilder as f64 / self.wanduhr_s
        }
    }
    pub fn kerne(&self) -> f64 {
        if self.wanduhr_s <= 0.0 {
            0.0
        } else {
            self.cpu_s / self.wanduhr_s
        }
    }
    /// Die Kernaussage in einem Wort.
    pub fn im_grafikspeicher(&self) -> bool {
        !self.ebenen.is_empty() && self.ebenen.iter().all(|e| e.lage.ist_geraet())
    }
}

/// Prozessorzeit dieses Prozesses in Sekunden, aus `/proc/self/schedstat`.
///
/// Nicht `/proc/self/stat`: das zaehlt in Uhrenticks (10 ms) und waere bei
/// Laeufen von wenigen Sekunden zu grob. `schedstat` liefert Nanosekunden.
fn cpu_sekunden() -> f64 {
    std::fs::read_to_string("/proc/self/schedstat")
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse::<u64>().ok())
        .map(|ns| ns as f64 / 1e9)
        .unwrap_or(0.0)
}

pub struct Konfig {
    pub datei: String,
    pub decoder: Option<String>,
    pub bilder: usize,
    pub aufwaermen: usize,
    pub low_delay: bool,
    pub abdruecke: usize,
    /// Jedes gemessene Bild ausdruecklich in den Hauptspeicher zurueckholen.
    ///
    /// **Das ist die Bezugsgroesse, ohne die der Tempogewinn nichts wert
    /// waere.** Ein CUDA-Arm, der die Bilder nie anfasst, koennte schneller
    /// aussehen, weil NVDEC im Hintergrund weiterlaeuft und die Schleife
    /// vorauseilt — dann waere der Gewinn eine Verschiebung und keine
    /// Ersparnis. Mit diesem Schalter macht der CUDA-Arm genau die Arbeit, die
    /// der Bezugsarm ohnehin tut (`av_hwframe_transfer_data`). Landet er dann
    /// wieder beim Bezugsarm, ist die Differenz nachweislich die Kopie.
    pub abholen: bool,
    /// `flags` fuer `av_hwdevice_ctx_create` (`libavutil/hwcontext_cuda.h`):
    /// 0 = FFmpeg legt einen eigenen Kontext an, 1 =
    /// `AV_CUDA_USE_PRIMARY_CONTEXT`, 2 = `AV_CUDA_USE_CURRENT_CONTEXT`.
    ///
    /// **Fuer den Umbau ist das der entscheidende Schalter, nicht bloss eine
    /// Feinheit.** Bei 0 haette der Player zwei CUDA-Kontexte auf derselben
    /// Karte — seinen eigenen fuer das eingehaengte Vulkan-Bild und FFmpegs
    /// fuer die Bilder. Bei 2 benutzt FFmpeg den Kontext, den der Player schon
    /// aktuell gemacht hat; das ist die Form, die der Umbau braucht.
    pub cuda_flags: i32,
    /// So viele Bilder gleichzeitig festhalten (`av_frame_ref`).
    ///
    /// **Die wahrscheinlichste Stolperstelle des Umbaus.** Heute besitzt jedes
    /// `DecodedFrame` im Player eigene Puffer im Hauptspeicher — es kann
    /// beliebig lange in der Warteschlange liegen. Ein CUDA-Bild ist dagegen
    /// eine der wenigen NVDEC-Oberflaechen; wer zu viele festhaelt, legt den
    /// Decoder still. Der Schalter misst, wo diese Grenze liegt, statt sie zu
    /// schaetzen.
    pub halten: usize,
}

/// Faehrt einen Durchgang.
///
/// `treiber` wird gebraucht, um die Ebenen-Adressen des ERSTEN gemessenen
/// Bildes beim Treiber einzuordnen.
pub fn fahren(
    k: &Konfig,
    hwctx: bool,
    formatwahl: Formatwahl,
    treiber: &Treiber,
) -> Result<Ergebnis> {
    ffmpeg::init().context("FFmpeg-Initialisierung")?;
    formatwahl::zuruecksetzen();

    let mut ictx = ffmpeg::format::input(&k.datei).with_context(|| format!("{} oeffnen", k.datei))?;
    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| anyhow!("kein Videostrom in {}", k.datei))?;
    let stream_index = stream.index();
    let par = stream.parameters();

    let decoder_name = match &k.decoder {
        Some(n) => n.clone(),
        None => {
            // SAFETY: `par` gehoert zum Strom und lebt so lange wie `ictx`.
            let id = unsafe { (*par.as_ptr()).codec_id };
            match id {
                ffmpeg::ffi::AVCodecID::AV_CODEC_ID_AV1 => "av1_cuvid".to_string(),
                ffmpeg::ffi::AVCodecID::AV_CODEC_ID_H264 => "h264_cuvid".to_string(),
                sonst => bail!("kein cuvid-Decoder fuer {sonst:?} vorgesehen"),
            }
        }
    };

    let codec = ffmpeg::decoder::find_by_name(&decoder_name)
        .ok_or_else(|| anyhow!("Decoder {decoder_name} gibt es in diesem FFmpeg nicht"))?;
    let mut ctx = ffmpeg::codec::context::Context::new_with_codec(codec);
    // SAFETY: der Kontext ist frisch angelegt und ungeoeffnet; `par` ist
    // gueltig. `avcodec_parameters_to_context` schreibt nur in den Kontext.
    let rc = unsafe { ffmpeg::ffi::avcodec_parameters_to_context(ctx.as_mut_ptr(), par.as_ptr()) };
    if rc < 0 {
        bail!("avcodec_parameters_to_context scheiterte (rc={rc})");
    }
    if k.low_delay {
        ctx.set_flags(ffmpeg::codec::Flags::LOW_DELAY);
    }

    // SAFETY: Kontext gehoert uns, ist ungeoeffnet; es wird je ein Feld gesetzt.
    unsafe {
        let p = ctx.as_mut_ptr();
        if hwctx {
            let mut geraet: *mut ffmpeg::ffi::AVBufferRef = std::ptr::null_mut();
            // `AV_CUDA_USE_PRIMARY_CONTEXT` (Bit 0, `libavutil/hwcontext_cuda.h`).
            //
            // **Fuer den Umbau ist das der wichtigere Schalter, nicht bloss
            // eine Feinheit.** Ohne ihn legt FFmpeg einen EIGENEN CUDA-Kontext
            // an; der Player haette dann zwei auf derselben Karte — seinen
            // eigenen fuer das eingehaengte Vulkan-Bild und FFmpegs fuer die
            // Bilder. Mit dem Schalter benutzen beide den primaeren Kontext des
            // Geraets, denselben, den auch `../cuda-vulkan-import` nimmt.
            //
            // Der Nachbau von `AVCUDADeviceContext` (um an FFmpegs Kontext
            // heranzukommen) entfaellt damit — und das ist wertvoll, weil
            // `ffmpeg-sys-next` dafuer KEINE Bindung erzeugt: `hwcontext_cuda.h`
            // steht nicht in den Bindungen (nachgeprueft in `bindings.rs`,
            // 0 Treffer), man muesste die Struktur von Hand nachbauen.
            let flags = k.cuda_flags;
            let rc = ffmpeg::ffi::av_hwdevice_ctx_create(
                &mut geraet,
                ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA,
                std::ptr::null(),
                std::ptr::null_mut(),
                flags,
            );
            if rc < 0 || geraet.is_null() {
                bail!("CUDA-Geraet liess sich nicht anlegen (rc={rc})");
            }
            (*p).hw_device_ctx = geraet;
        }
        formatwahl::eintragen(p, formatwahl);
    }

    let mut decoder = ctx
        .decoder()
        .video()
        .with_context(|| format!("Decoder {decoder_name} liess sich nicht oeffnen"))?;

    // --- Decodierschleife ---------------------------------------------------
    let mut frame = ffmpeg::util::frame::video::Video::empty();
    let mut wirt_ziel = ffmpeg::util::frame::video::Video::empty();
    let mut send = Zeiten::default();
    let mut receive = Zeiten::default();
    let mut abholen = Zeiten::default();
    let mut gehalten: std::collections::VecDeque<ffmpeg::util::frame::video::Video> =
        std::collections::VecDeque::new();
    let mut ebenen: Vec<Ebene> = Vec::new();
    let mut abdruecke: Vec<u64> = Vec::new();
    let mut bilder_gesamt = 0usize;
    let mut bilder_gemessen = 0usize;
    let mut bildformat = -1i32;
    let mut sw_format = -1i32;
    let mut zeilenkopie_gleich: Option<bool> = None;
    let (mut breite, mut hoehe) = (0i32, 0i32);
    let mut wand_start = std::time::Instant::now();
    let mut cpu_start = cpu_sekunden();
    let mut messung_laeuft = false;

    'aussen: for (s, packet) in ictx.packets() {
        if s.index() != stream_index {
            continue;
        }
        let t0 = std::time::Instant::now();
        let sende_ok = decoder.send_packet(&packet).is_ok();
        let t1 = std::time::Instant::now();
        if !sende_ok {
            continue;
        }
        if messung_laeuft {
            send.dazu(t1.duration_since(t0).as_nanos() as u64);
        }
        loop {
            let t2 = std::time::Instant::now();
            let holen = decoder.receive_frame(&mut frame);
            let t3 = std::time::Instant::now();
            if holen.is_err() {
                break;
            }
            if messung_laeuft {
                receive.dazu(t3.duration_since(t2).as_nanos() as u64);
                bilder_gemessen += 1;
            }
            bilder_gesamt += 1;

            // Gegenprobe: dieselbe Arbeit wie der Bezugsarm, aber sichtbar
            // als eigener Posten. Laeuft auch im Hauptspeicher-Arm — dort ist
            // sie ein billiger Fehlschlag (kein Hardware-Bild), und genau das
            // muss sie sein, damit der Schalter nicht selbst einen
            // Unterschied zwischen den Armen erzeugt.
            if k.abholen {
                let t4 = std::time::Instant::now();
                // SAFETY: beide Bilder sind gueltig; FFmpeg schreibt nur in
                // `wirt_ziel`. Der Puffer wird wiederverwendet.
                let rc = unsafe {
                    ffmpeg::ffi::av_hwframe_transfer_data(
                        wirt_ziel.as_mut_ptr(),
                        frame.as_ptr(),
                        0,
                    )
                };
                let t5 = std::time::Instant::now();
                if rc >= 0 && messung_laeuft {
                    abholen.dazu(t5.duration_since(t4).as_nanos() as u64);
                }
            }

            if bildformat < 0 {
                // SAFETY: `frame` haelt ein gueltiges AVFrame.
                unsafe {
                    let f = frame.as_ptr();
                    bildformat = (*f).format;
                    breite = (*f).width;
                    hoehe = (*f).height;
                    for i in 0..3usize {
                        let a = (*f).data[i] as u64;
                        if a == 0 {
                            continue;
                        }
                        ebenen.push(Ebene {
                            adresse: a,
                            zeilenabstand: (*f).linesize[i],
                            lage: treiber.lage(a),
                        });
                    }
                    sw_format = sw_format_von(&frame);
                }
                if ebenen.iter().all(|e| e.lage.ist_geraet()) && !ebenen.is_empty() {
                    zeilenkopie_gleich = Some(zeilenkopie_pruefen(
                        &frame,
                        &ebenen,
                        sw_format,
                        treiber,
                    )?);
                }
            }
            if k.halten > 0 {
                let mut kopie = ffmpeg::util::frame::video::Video::empty();
                // SAFETY: `av_frame_ref` nimmt eine Referenz auf dieselben
                // Puffer — genau das, was der Player mit einem Bild taete, das
                // er in die Warteschlange legt. Kein Datenkopieren.
                let rc = unsafe {
                    ffmpeg::ffi::av_frame_ref(kopie.as_mut_ptr(), frame.as_ptr())
                };
                if rc < 0 {
                    bail!("av_frame_ref scheiterte (rc={rc})");
                }
                gehalten.push_back(kopie);
                while gehalten.len() > k.halten {
                    gehalten.pop_front();
                }
            }
            if abdruecke.len() < k.abdruecke {
                abdruecke.push(bild_abdruck(&frame)?);
            }

            // Ab hier zaehlt es: die Aufwaermbilder sind durch, der Decoder
            // laeuft eingeschwungen. Uhren werden JETZT gestellt, damit das
            // Oeffnen und die ersten Bilder nicht in den Schnitt eingehen.
            if !messung_laeuft && bilder_gesamt >= k.aufwaermen {
                messung_laeuft = true;
                wand_start = std::time::Instant::now();
                cpu_start = cpu_sekunden();
            }
            if bilder_gemessen >= k.bilder {
                break 'aussen;
            }
        }
    }

    let wanduhr_s = wand_start.elapsed().as_secs_f64();
    let cpu_s = cpu_sekunden() - cpu_start;

    if bilder_gemessen == 0 {
        bail!(
            "kein einziges Bild gemessen (insgesamt dekodiert: {bilder_gesamt}) — \
             Datei zu kurz fuer SPIKE_AUFWAERMEN={} plus SPIKE_BILDER={}?",
            k.aufwaermen,
            k.bilder
        );
    }

    Ok(Ergebnis {
        decoder: decoder_name,
        hwctx,
        formatwahl,
        angeboten: formatwahl::angebotene(),
        gewaehlt: formatwahl::gewaehltes(),
        bildformat,
        breite,
        hoehe,
        ebenen,
        sw_format,
        zeilenkopie_gleich,
        bilder: bilder_gemessen,
        send,
        receive,
        abholen,
        wanduhr_s,
        cpu_s,
        abdruecke,
    })
}
