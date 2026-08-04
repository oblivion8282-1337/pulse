//! Hardware-Encoder mit D3D11-Pool-Input (Zero-Copy — NVENC und AMF).
//!
//! Spiegelt `FfmpegEncoder` aus `encoder.rs`, aber:
//! - Input-Frames sind `OwnedHwFrame` (AVFrame mit D3D11-Texture in data[0]).
//! - `pix_fmt = AV_PIX_FMT_D3D11`, `sw_format = AV_PIX_FMT_BGRA` (siehe
//!   `hwctx.rs`). NVENC schluckt die BGRA-D3D11-Frames direkt.
//! - `hw_frames_ctx` muss VOR `avcodec_open2` via FFI an `AVCodecContext`
//!   gehängt werden (ffmpeg-next exponiert das Feld nicht; wir gehen über
//!   `as_mut_ptr`).
//!
//! **Downscale** läuft NICHT mehr hier: der `D3D11Scaler` (siehe
//! `d3d11_scale.rs`) skaliert vor dem Encoder per `VideoProcessorBlt` auf der
//! GPU. Der Encoder bekommt immer fertig dimensionierte D3D11-BGRA-Frames —
//! native aus dem Capture-Pool, downscaled aus dem Scaler-Ziel-Pool. Der
//! Caller übergibt die passende `hw_frames_ctx`-AVBufferRef.
//!
//! Aktiv für `vendor == "nvidia"` (alle Codecs) und für `vendor == "amd"` mit
//! AV1: beide Encoder nehmen BGRA-D3D11-Frames an und rechnen den
//! NV12-Convert selbst auf der GPU. Intel bleibt auf der CPU-Pipeline.
//! Welche Kombination hier landet, entscheidet `pipeline_hw::run`.

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Packet, Rational, codec, format, ffi::*};

use super::audio::AudioPipeline;
use super::encoder::{AudioStreamConfig, VideoCodec};
use super::opts::vendor_encoder_opts;
use super::hwctx::OwnedHwFrame;
use super::latency::EncodeLatency;
use super::mux_writer::MuxWriter;
use super::output::{open_output, warn_unknown_opts};
use super::senke::SenkenAuftrag;
use super::senke_writer::SenkenWriter;
use crate::audio::CapturedAudio;

/// Wohin die fertigen Pakete gehen. Begründung der Gabelung: `senke.rs`.
///
/// Stream-Index und Ziel-Zeitbasis hängen **an der Muxer-Variante**, nicht am
/// Encoder: der fremde Sendeweg kennt beides nicht. Lägen sie oben im Struct,
/// müssten sie dort mit Attrappen belegt werden — und ein Feld, das je nach
/// Variante gültig oder erfunden ist, ist genau das, was ein Enum abschaffen
/// soll.
enum Ausgabe {
    /// Container über einen eigenen Schreib-Faden (RTMPS/FLV, Datei).
    Mux {
        writer: MuxWriter,
        stream_idx: usize,
        /// Zeitbasis, die der Muxer dem Video-Stream zugewiesen hat. Steht
        /// erst nach `write_header` fest.
        stream_tb: Rational,
    },
    /// Ein angemeldeter fremder Sendeweg — heute der WHIP-Weg des Labors.
    /// Ebenfalls über einen eigenen Faden, aus demselben Grund
    /// (s. `senke_writer.rs`).
    Extern(SenkenWriter),
}

#[derive(Debug, Clone)]
pub struct HwEncoderConfig {
    pub codec: VideoCodec,
    pub vendor: String,
    pub fps: u32,
    pub bitrate_kbps: u32,
    /// Encoder-Output-Dimensionen. Bei Downscale = dst-Auflösung (der
    /// `D3D11Scaler` hat dann schon skaliert); bei Native = capture-res.
    pub dst_w: u32,
    pub dst_h: u32,
    /// 10 bit je Farbkanal. Setzt voraus, dass der gebundene Frames-Pool
    /// bereits P010 führt (`pipeline_hw` erzwingt dafür den Scaler) — die
    /// Bittiefe des Ausgangs ergibt sich aus dem Eingangsformat, dieses Flag
    /// steuert nur die Encoder-Option und die Farb-Signalisierung.
    pub ten_bit: bool,
}

pub struct FfmpegHwEncoder {
    /// Ziel der fertigen Pakete. Beim Muxer lebt der `AVFormatContext` auf
    /// einem eigenen Thread und der Encoder reiht nur ein (s. `mux_writer.rs`).
    ausgabe: Ausgabe,
    encoder: codec::encoder::Video,
    encoder_time_base: Rational,
    audio: Option<AudioPipeline>,
    /// Diagnose-Timings des letzten `send_hw`-Calls (µs) — gespeist in den
    /// `TickMonitor` (s. `tick_monitor.rs`) zur Mikro-Stutter-Analyse.
    /// `last_send_us` = `avcodec_send_frame` (NVENC-Submit), `last_mux_us` =
    /// Zeit fürs Einreihen der Packets in die Warteschlange des Schreib-Fadens
    /// — beim Muxer wie beim fremden Sendeweg dieselbe Bedeutung (normal ~0;
    /// ein Spike = Warteschlange voll = der Faden hängt am Socket).
    last_send_us: u64,
    last_mux_us: u64,
    /// Vollbilder auf Anforderung: abholen, zählen, gedrosselt melden
    /// (s. `crate::keyframe::Anforderungen`).
    vollbilder_angefordert: crate::keyframe::Anforderungen,
    /// Einschieben -> Paket, s. `latency.rs`. Das ist der Posten, den
    /// `zerolatency`/`delay` veraendern; `last_send_us` sieht ihn NICHT.
    enc_latency: EncodeLatency,
}

impl FfmpegHwEncoder {
    /// `hw_frames_ref` ist die D3D11VA-frames-AVBufferRef, aus der die
    /// Input-Frames stammen — Capture-`HwContext` (native) oder Scaler-
    /// Ziel-`HwContext` (downscale). Der Encoder nimmt eine eigene Referenz.
    ///
    /// # Safety
    ///
    /// `hw_frames_ref` muss eine gültige, noch lebende `AVBufferRef` auf einen
    /// `AVHWFramesContext` sein, dessen Format zu den Bildern passt, die später
    /// über [`send_hw`](Self::send_hw) hereinkommen. Die Funktion nimmt darauf
    /// eine eigene Referenz (`av_buffer_ref`) — der Aufrufer darf seine eigene
    /// danach fallen lassen, aber nicht vorher.
    ///
    /// Als `unsafe` markiert, weil genau das der Vertrag ist und er sonst nur
    /// im Fließtext stünde: ein Zeiger auf einen fremden Kontext, den diese
    /// Funktion dereferenziert.
    pub unsafe fn create(
        cfg: &HwEncoderConfig,
        hw_frames_ref: *mut AVBufferRef,
        audio_cfg: Option<AudioStreamConfig>,
        output_path: &str,
    ) -> Result<Self> {
        ffmpeg::init().context("ffmpeg::init")?;

        // Hat sich jemand für diese URL angemeldet? Wenn ja, entfällt der
        // ganze Container: kein `open_output`, kein Stream, kein Kopf.
        // Verbunden wird erst weiter unten, nach dem Öffnen der Encoder.
        //
        // Output-Öffnung inkl. Protokoll-Optionen (RTMPS/SRT/WHIP) zentral in
        // output.rs::open_output.
        let mut output = if super::senke::zustaendig(output_path) {
            None
        } else {
            Some(open_output(output_path)?)
        };

        let codec_name = cfg.codec.ffmpeg_name(&cfg.vendor)?;
        let codec_descriptor = codec::encoder::find_by_name(codec_name)
            .ok_or_else(|| anyhow!("encoder '{codec_name}' not registered in linked FFmpeg"))?;

        // **Auf dem fremden Weg bewusst KEIN globaler Kopf.** Ein Container wie
        // FLV erwartet die Parametersätze (SPS/PPS bzw. den AV1-Sequenzkopf)
        // einmal im Kopf; über RTP müssen sie dagegen im Strom mitlaufen, weil
        // jeder Zuschauer zu einem beliebigen Zeitpunkt einsteigt und es keinen
        // Kopf gibt, den er nachlesen könnte. Mit globalem Kopf bekäme er nie
        // Parametersätze und sähe dauerhaft nichts — ein Fehler, der wie ein
        // Netzproblem aussieht.
        let global_header = output
            .as_ref()
            .is_some_and(|o| o.format().flags().contains(format::Flags::GLOBAL_HEADER));

        let mut encoder = codec::context::Context::new_with_codec(codec_descriptor)
            .encoder()
            .video()?;
        encoder.set_width(cfg.dst_w);
        encoder.set_height(cfg.dst_h);
        encoder.set_format(format::Pixel::D3D11);
        encoder.set_time_base(Rational::new(1, cfg.fps as i32));
        encoder.set_frame_rate(Some(Rational::new(cfg.fps as i32, 1)));
        encoder.set_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_max_bit_rate((cfg.bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_gop(cfg.fps.saturating_mul(2));
        if global_header {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }

        // hw_frames_ctx an die AVCodecContext hängen — MUSS vor open passieren.
        // Native = Capture-D3D11-Pool (src-res), Downscale = Scaler-Ziel-Pool
        // (dst-res); beide D3D11/BGRA, also derselbe Encoder-Pfad.
        unsafe {
            let ctx_ptr = encoder.as_mut_ptr();
            let new_ref = av_buffer_ref(hw_frames_ref);
            if new_ref.is_null() {
                return Err(anyhow!("av_buffer_ref(hw_frames_ref) returned NULL"));
            }
            (*ctx_ptr).hw_frames_ctx = new_ref;
        }

        // Farb-Signalisierung NUR im 10-bit-Pfad — dieselbe Zurückhaltung wie im
        // Linux-Sidecar: dort wandelt der Encoder im 8-bit-Pfad nach eigener
        // Konvention, und etwas zu behaupten, das wir nicht kontrollieren, würde
        // einen verifiziert korrekten Weg auf Verdacht verstellen.
        if cfg.ten_bit {
            encoder.set_colorspace(ffmpeg::color::Space::BT709);
            encoder.set_color_range(ffmpeg::color::Range::MPEG);
        }

        let opts = vendor_encoder_opts(&cfg.vendor, cfg.codec, cfg.ten_bit);
        warn_unknown_opts(&mut encoder, codec_name, &opts);
        let opened = encoder
            .open_with(opts)
            .with_context(|| format!("open hw encoder '{codec_name}' (vendor={})", cfg.vendor))?;
        super::log_encoder_open(
            codec_name,
            &cfg.vendor,
            cfg.dst_w,
            cfg.dst_h,
            cfg.fps,
            cfg.bitrate_kbps,
        );

        let encoder_time_base = Rational::new(1, cfg.fps as i32);

        // Der Ton MUSS vor dem Verbinden stehen: WHIP kennt keine
        // Nachverhandlung, die Tonspur muss also schon im Angebot liegen. Wer
        // sie später anmelden wollte, müsste die Sitzung neu aufbauen.
        let mut audio = audio_cfg
            .map(|a| {
                AudioPipeline::create(
                    output.as_mut(),
                    a.sample_rate,
                    a.channels,
                    a.bitrate_kbps,
                    a.av_offset_ms,
                )
            })
            .transpose()?;

        let ausgabe = match output {
            Some(mut output) => {
                let mut stream = output.add_stream(codec_descriptor).context("add_stream")?;
                stream.set_parameters(&opened);
                let stream_idx = stream.index();

                output.write_header().context("write_header")?;

                let stream_tb = output.stream(stream_idx).unwrap().time_base();
                // Audio-Stream-Timebase erst JETZT (nach write_header) lesen.
                if let Some(a) = audio.as_mut() {
                    let audio_tb = output.stream(a.stream_idx).unwrap().time_base();
                    a.set_stream_time_base(audio_tb);
                }
                // Output an den Writer-Thread übergeben — ab hier läuft jedes
                // write_interleaved asynchron, der Pacing-Loop blockiert nie
                // am Socket.
                let writer = MuxWriter::start(output).context("start mux-writer")?;
                Ausgabe::Mux { writer, stream_idx, stream_tb }
            }
            None => {
                let senke = super::senke::baue(&SenkenAuftrag {
                    url: output_path,
                    codec: cfg.codec.slug(),
                    fps: cfg.fps,
                })
                .context("fremden Sendeweg aufbauen")?;
                // **Sagen, welcher Weg genommen wurde.** Die beiden Wege sind
                // von außen nicht zu unterscheiden — und ein Stream, der still
                // über den Muxer statt über den angemeldeten Sendeweg läuft,
                // sieht vollkommen gesund aus und beantwortet trotzdem eine
                // andere Frage. Genau diese Verwechslung hat auf der
                // Linux-Seite am 2026-07-30 eine ganze Messreihe entwertet.
                eprintln!("[encode] Ausgabe: angemeldeter Sendeweg (nicht der Muxer)");
                Ausgabe::Extern(SenkenWriter::start(senke, super::audio::opus_frame_dauer())?)
            }
        };

        Ok(Self {
            ausgabe,
            encoder: opened,
            encoder_time_base,
            audio,
            last_send_us: 0,
            last_mux_us: 0,
            vollbilder_angefordert: Default::default(),
            enc_latency: EncodeLatency::default(),
        })
    }

    /// Encode-Latenz seit dem letzten Aufruf: (Summe, Maximum, Anzahl) in us.
    /// Holt und LEERT die Zaehler — der Pacing-Loop reicht sie je Tick an den
    /// `TickMonitor` weiter.
    pub fn take_encode_latency(&mut self) -> (u64, u64, u64) {
        self.enc_latency.take()
    }

    /// NVENC-Submit-Dauer (`avcodec_send_frame`) des letzten `send_hw` in µs.
    pub fn last_send_us(&self) -> u64 {
        self.last_send_us
    }

    /// Queue-Einreih-Dauer (`MuxWriter::send`) des letzten `send_hw` in µs —
    /// summiert über alle gedrainten Pakete. Normal ~0; ein Spike heißt die
    /// Queue ist voll = der Writer-Thread hängt am Socket.
    pub fn last_mux_us(&self) -> u64 {
        self.last_mux_us
    }

    pub fn send_audio(&mut self, captured: &CapturedAudio) -> Result<()> {
        if let Some(audio) = self.audio.as_mut() {
            let packets = audio.send(captured)?;
            for packet in packets {
                Self::ton_ausgeben(&mut self.ausgabe, packet)?;
            }
        }
        Ok(())
    }

    /// Ein fertiges Opus-Paket ans Ziel. Auf dem fremden Weg zählt nur der
    /// rohe Inhalt plus die Paketlänge — der Zeitstempel des Muxers hilft dort
    /// nicht, die Zeit kommt aus der RTP-Uhr.
    ///
    /// Als zugeordnete Funktion statt Methode, damit der Aufrufer `self.audio`
    /// weiter geliehen halten darf, während er hier ausgibt.
    fn ton_ausgeben(ausgabe: &mut Ausgabe, packet: Packet) -> Result<()> {
        match ausgabe {
            Ausgabe::Mux { writer, .. } => writer.send(packet),
            Ausgabe::Extern(w) => w.audio(packet),
        }
    }

    /// Verankert den Audio-PTS am Video-PTS-Ursprung (A/V-Sync). Vor dem
    /// ersten `send_audio` aufrufen — sonst startet der Audio-PTS bei 0 und
    /// die Spuren driften (Audio-Backlog vor `started`).
    pub fn set_audio_origin(&mut self, origin: std::time::Instant, origin_qpc: Option<i64>) {
        if let Some(audio) = self.audio.as_mut() {
            audio.set_stream_origin(origin, origin_qpc);
        }
    }

    /// Schickt einen Pool-Frame in den Encoder. `pts` ist die wall-clock-
    /// abgeleitete Präsentations-Zeit in Encoder-Timebase-Einheiten (1/fps) —
    /// vom Pacing-Loop in `pipeline_hw.rs` vergeben, muss streng monoton sein.
    /// Bei statischem Bild wird derselbe Frame mehrfach mit fortlaufender PTS
    /// gesendet (Duplizierung) — daher PTS als Parameter, kein interner Zähler.
    ///
    /// Der Frame ist immer ein fertig dimensionierter D3D11-BGRA-Frame
    /// (Downscale erledigt der `D3D11Scaler` vorgelagert).
    pub fn send_hw(&mut self, frame: &mut OwnedHwFrame, pts: i64) -> Result<()> {
        frame.set_pts(pts);
        self.send_avframe(frame.as_mut_ptr(), pts)
    }

    fn send_avframe(&mut self, frame_ptr: *mut AVFrame, pts: i64) -> Result<()> {
        // Vollbild auf Anforderung eines Zuschauers (s. `crate::keyframe`).
        //
        // **Vor dem Stempel**, nicht danach: die Meldung schreibt auf stderr,
        // und stderr ist im Laborbetrieb eine Pipe, die jemand liest. Läge der
        // Aufruf im Messfenster, trüge `last_send_us` ausgerechnet auf den
        // interessanten Bildern die Schreibzeit mit — ein Ausreißer genau dort,
        // wo man am genauesten hinsieht.
        let angefordert = self.vollbilder_angefordert.naechstes_bild(pts);
        // VOR dem Einschieben stempeln: mit `delay=0` liefert NVENC das Paket
        // im selben Aufruf zurueck (s. `latency.rs`).
        let t_send = std::time::Instant::now();
        unsafe {
            // **Pro Bild ZURÜCKSETZEN.** Der Frame kommt aus einem Pool und
            // wird wiederverwendet; bliebe `I` nach der ersten Anforderung
            // kleben, wäre JEDES folgende Bild ein Vollbild — bei fester
            // Bitrate bricht damit die Bildqualität zusammen. Deshalb steht
            // hier ein `if/else` und kein `if`.
            (*frame_ptr).pict_type = if angefordert {
                AVPictureType::AV_PICTURE_TYPE_I
            } else {
                AVPictureType::AV_PICTURE_TYPE_NONE
            };
            let ret = avcodec_send_frame(self.encoder.as_mut_ptr(), frame_ptr);
            if ret < 0 {
                return Err(anyhow!("avcodec_send_frame failed: {ret}"));
            }
        }
        self.last_send_us = t_send.elapsed().as_micros() as u64;
        self.enc_latency.submitted(pts, t_send);
        self.drain_video()
    }

    /// Encodete Video-Packets aus dem Encoder ziehen und an das Ziel einreihen
    /// (Muxer oder fremder Sendeweg, beide über einen eigenen Faden).
    /// EAGAIN/EOF = nichts (mehr) da → Drain fertig; ein ECHTER
    /// Encoder-Fehler wird propagiert statt verschluckt (#8).
    ///
    /// **Auf EAGAIN zu warten bringt bei AMF nichts — geprüft.** Naheliegender
    /// Verdacht war, dass „jetzt noch nicht" nur heißt, dass wir zu früh
    /// fragen, und dass das Paket ein paar Millisekunden später bereitläge; wir
    /// es aber erst beim nächsten Tick abholen und so einen ganzen Bildabstand
    /// verschenken. Am 2026-07-30 gemessen: ein Drain, der bis zu 12 ms lang
    /// gezielt auf das Paket zum gerade eingeschobenen Bild nachfragt, ändert
    /// die Encode-Latenz von `av1_amf` um 0,02 ms (17,23 → 17,21). Das Paket
    /// ist wirklich nicht da — FFmpegs AMF-Zweig gibt es erst heraus, wenn das
    /// nächste Bild eingeschoben wird. Nicht noch einmal versuchen; die
    /// Herleitung steht in `docs/plans/2026-07-30-amd-windows-messung.md`.
    fn drain_video(&mut self) -> Result<()> {
        let mut mux_us: u64 = 0;
        loop {
            let mut packet = Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(e.into()),
            }
            // Zuordnen VOR `rescale_ts` — danach steht der pts in der
            // Muxer-Zeitbasis und passt nicht mehr zum vermerkten.
            self.enc_latency.packet(packet.pts());
            // Einreihen/Absenden messen — beim Muxer normal ~0; ein Ausschlag
            // heißt die Queue ist voll = der Writer-Thread hängt am Socket.
            let t_mux = std::time::Instant::now();
            match &mut self.ausgabe {
                Ausgabe::Mux { writer, stream_idx, stream_tb } => {
                    packet.set_stream(*stream_idx);
                    packet.rescale_ts(self.encoder_time_base, *stream_tb);
                    writer.send(packet)?;
                }
                // Kein Umrechnen und kein Stream-Index: der Sendeweg nimmt die
                // rohen Bytes. Die Zeitstempel setzt er selbst aus der
                // RTP-Uhr — ein umgerechneter pts wäre hier nicht nur nutzlos,
                // sondern irreführend.
                Ausgabe::Extern(w) => w.video(packet)?,
            }
            mux_us += t_mux.elapsed().as_micros() as u64;
        }
        self.last_mux_us = mux_us;
        Ok(())
    }

    /// Finalisiert den Stream: EOF an Video (+Audio), restliche Pakete in die
    /// Queue, dann `MuxWriter::finish` — das wartet auf den Writer-Thread, der
    /// den FLV-Trailer schreibt und die RTMP-Verbindung sauber schließt.
    ///
    /// Nimmt `&mut self`, gibt den Encoder also bewusst NICHT frei: der
    /// Encoder-Drop schließt NVENC + entlädt `nvEncodeAPI64.dll`, und genau
    /// dieser Teardown lässt einen treiber-internen Threadpool-Timer dangling
    /// zurück (→ Use-after-free, `0xC0000005` auf einem `TpWaitForTimer`-Thread).
    /// Der Caller `mem::forget`et den Encoder; der Per-Stream-Sidecar endet
    /// direkt nach `stop`, `ExitProcess` gibt alles sauber frei. (Der Muxer-
    /// Teardown im Writer-Thread ist davon unberührt — rein Netzwerk/Userspace.)
    pub fn finish(&mut self) -> Result<()> {
        self.encoder.send_eof().context("video send_eof")?;
        self.drain_video()?;
        if let Some(audio) = self.audio.as_mut() {
            let packets = audio.flush()?;
            for packet in packets {
                Self::ton_ausgeben(&mut self.ausgabe, packet)?;
            }
        }
        match &mut self.ausgabe {
            Ausgabe::Mux { writer, .. } => writer.finish(),
            // Der Faden baut die Sitzung selbst ab, auch im Fehlerfall.
            Ausgabe::Extern(w) => w.finish(),
        }
    }
}
