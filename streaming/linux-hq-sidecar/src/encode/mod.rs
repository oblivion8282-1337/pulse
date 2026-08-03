//! Encode-Pipeline: HW-Encoder (NVENC/VAAPI) → Muxer → Output (Datei oder RTMPS).
//!
//! Adaptiert von `win-hq-sidecar/src/encode/encoder_hw.rs` (`FfmpegHwEncoder`):
//! ffmpeg-next High-Level-API für Output/Stream/Encoder/Packet, rohes FFI nur
//! für `hw_frames_ctx` am `AVCodecContext` und `avcodec_send_frame`. Statt des
//! Windows-D3D11-Capture-Pools kommt hier der eigene [`hw::HwContext`] (CUDA für
//! Nvidia, VAAPI für AMD/Intel) zum Zug.
//!
//! Phase 4 (diese Datei): Video-only, synthetische Frames → Datei. Audio + der
//! asynchrone Pacing-Loop + RTMPS-Push kommen in Phase 5.

pub mod audio;
pub mod hw;
pub mod mux_writer;
pub mod nv_import;
pub mod nv_p010;
pub mod opts;
pub mod raw_dump;
pub mod va_import;

use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Dictionary, Packet, Rational, codec, format, ffi::*};

use audio::AudioEncoder;
use hw::HwContext;
use mux_writer::MuxWriter;
use crate::redact::redact_url;
use crate::system::drm::Vendor;
use crate::whip::WhipSender;

/// Optionale Audio-Konfiguration für [`VideoEncoder::create_with_audio`].
#[derive(Debug, Clone)]
pub struct AudioParams {
    pub sample_rate: u32,
    pub bitrate_kbps: u32,
}

#[derive(Debug, Clone)]
pub struct EncoderConfig {
    pub vendor: Vendor,
    pub codec: String, // "h264" | "av1"
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub width: u32,
    pub height: u32,
    /// 10 bit je Farbkanal (Eingang P010, s. `nv_p010`). Steuert nur die
    /// FARB-SIGNALISIERUNG hier — die Bittiefe selbst ergibt sich aus dem
    /// `sw_format` des gebundenen Frame-Pools.
    pub ten_bit: bool,
}

/// Wohin die encodierten Pakete gehen.
///
/// Zwei Wege, die sich grundlegend unterscheiden: der Muxer schreibt in einen
/// Container (FLV/MPEG-TS) und braucht dafuer Zeitbasen und Stream-Indizes; der
/// eigene WebRTC-Weg kennt beides nicht — dort ist ein Bild ein Sample, und die
/// Paketierung macht webrtc-rs.
enum Ausgabe {
    Mux(MuxWriter),
    /// Eigener WHIP-Sendeweg (s. [`crate::whip`]). Der einzige Weg, auf dem
    /// eine Vollbild-Anforderung des Zuschauers den Encoder erreicht.
    Whip(Arc<WhipSender>),
}

pub struct VideoEncoder {
    mux: Ausgabe,
    encoder: codec::encoder::Video,
    video_stream_idx: usize,
    encoder_time_base: Rational,
    stream_time_base: Rational,
    /// Wann welcher pts in den Encoder ging — die Gegenprobe zu dem Zeitpunkt,
    /// an dem sein Paket herausfaellt. Ohne diese Zuordnung ist die
    /// Encode-Latenz nicht messbar: NVENC arbeitet asynchron, das Paket zu Bild
    /// N kann erst beim Einschieben von Bild N+2 erscheinen. Die Reihenfolge
    /// bleibt monoton (keine B-Bilder, `bf=0`), deshalb reicht eine Schlange.
    submitted: std::collections::VecDeque<(i64, std::time::Instant)>,
    /// Bildrate — nur fuer die Sperrfrist der Vollbild-Anforderungen
    /// (`take_keyframe_request`) gebraucht, die in Bildern gerechnet ist.
    fps_fuer_keyframes: u32,
    /// Latenz-Posten des Encodierens, je Fenster (s. `take_encode_latency`).
    enc_sum_us: u64,
    enc_count: u64,
    enc_max_us: u64,
}

/// Wartezeit des Muxer-Interleavers in Mikrosekunden (`max_interleave_delta`).
///
/// **Das ist der groesste Einzelposten der Sende-Latenz.** Der FLV-Muxer gibt
/// ein Bild erst frei, wenn Ton mit mindestens so grossem Zeitstempel vorliegt.
/// Der Rueckstand des Tons ist damit 1:1 Bild-Latenz — und dieser Rueckstand
/// ist kein fester Wert, sondern haengt davon ab, wie der PipeWire-Graph beim
/// Start gerade steht: ueber zehn Laeufe am 2026-07-27 zwischen 12 und 34 ms,
/// im Mittel 22. Ohne Deckel wartet also jedes Bild diese Zeit mit.
///
/// Gemessen (2026-07-27, Pruefstand `real-harness.py --e2e`, 1440p, Ton an):
///
/// | Deckel | 60 fps | 144 fps | 280 fps |
/// |---|---|---|---|
/// | 100 ms (vorher) | 99,8 ms | 62,5 ms | 676 ms |
/// | **10 ms** | **82,3 ms** | **52,7 ms** | **301 ms** |
///
/// Bei allen Bildraten besser, kein einziger Schreibfehler, der Ton bleibt
/// lueckenlos (2463 Pakete, Abstand 5,0 ms, groesste Luecke 17 ms).
///
/// **Warum nicht kleiner:** wird ein Bild vor dem Ton geschrieben, kippt die
/// Reihenfolge auf der einzigen FLV-Zeitleiste und der Muxer beendet den
/// Stream. Gemessen 2026-07-26: Delta 1 us starb sofort, Delta 2 ms lief bei
/// 144 fps und starb bei 280 fps. 10 ms haelt zu dieser Kante Abstand und ist
/// bei 280 fps dreimal ueber 16 s ohne Fehler gelaufen; 3 ms und 1 ms brachten
/// bei 60 fps NICHTS mehr (82,9 bzw. 79,6 ms), es gibt also keinen Grund,
/// naeher an die Kante zu gehen.
///
/// Die Ursache selbst — der Ton hinkt dem Bild im Muxer hinterher — bleibt
/// bestehen; der Deckel begrenzt nur, was sie kostet. An der Quelle wurde
/// gesucht und nichts gefunden, das taeglich traegt: eine Latenz-Anforderung am
/// Null-Sink des Routers brachte ueber je fuenf Laeufe 21,3 gegen 22,5 ms, also
/// nichts. Der Mikrofonweg (ohne diesen Sink) haelt nur 9,2 ms — dort liegt der
/// naechste Hebel, falls jemand weitersucht.
const DEFAULT_INTERLEAVE_US: i64 = 10_000;

impl VideoEncoder {
    /// Öffne Output + Encoder mit dem gegebenen HW-Context. `output_path` ist
    /// eine Datei (Phase 4) oder eine `rtmp(s)://`/`srt://`-URL (Phase 5).
    /// `write_header` wird hier gerufen; danach geht jeder `write_interleaved`
    /// asynchron über den MuxWriter-Thread.
    pub fn create(cfg: &EncoderConfig, hw: &HwContext, output_path: &str) -> Result<Self> {
        // SAFETY: Pixelformat und Frames-Kontext kommen aus demselben
        // `HwContext`, passen also zueinander; `hw` ist für den ganzen Aufruf
        // geliehen, der Kontext überlebt damit `write_header`. Deshalb darf
        // dieser Wrapper sicher sein.
        let (enc, _no_audio) = unsafe {
            Self::create_with_audio(cfg, hw.ffmpeg_pixel(), hw.frames_ref(), output_path, None)?
        };
        Ok(enc)
    }

    /// Wie [`create`], aber vom [`HwContext`] entkoppelt (nimmt HW-Pixelformat +
    /// den zu bindenden Frames-Kontext direkt) und mit optionalem Audio-Stream
    /// (libopus). Der NVENC-Pfad übergibt `hw.ffmpeg_pixel()`+`hw.frames_ref()`;
    /// der VAAPI-Pfad übergibt `Pixel::VAAPI` + den NV12-Frames-Kontext vom
    /// `scale_vaapi`-Filter-Ausgang. Der Audio-Stream wird VOR `write_header`
    /// hinzugefügt; der zurückgegebene [`AudioEncoder`] läuft auf einem eigenen
    /// Thread und teilt sich den Ausgang über [`VideoEncoder::ton_senke`].
    ///
    /// # Safety
    ///
    /// `frames_ctx` muss ein gültiger `AVHWFramesContext`-`AVBufferRef` sein,
    /// der `hw_pixel` entspricht, und mindestens bis `write_header` leben. Die
    /// Funktion dereferenziert den Zeiger (`av_buffer_ref` + Zuweisung an
    /// `AVCodecContext::hw_frames_ctx`) — ein ungültiger oder zu früh
    /// freigegebener Zeiger ist undefiniertes Verhalten.
    ///
    /// [`create`]: VideoEncoder::create
    pub unsafe fn create_with_audio(
        cfg: &EncoderConfig,
        hw_pixel: format::Pixel,
        frames_ctx: *mut AVBufferRef,
        output_path: &str,
        audio: Option<AudioParams>,
    ) -> Result<(Self, Option<AudioEncoder>)> {
        ffmpeg::init().context("ffmpeg::init")?;

        warne_bei_intra_refresh_ohne_rueckkanal(output_path);

        // Eigener WebRTC-Sendeweg: kein Container, kein Stream, kein Header.
        // Deshalb VOR dem Oeffnen eines Ausgangs abzweigen — alles Folgende
        // haengt daran.
        if is_whip_url(output_path) {
            // SAFETY: `frames_ctx` und `hw_pixel` kommen unveraendert vom
            // Aufrufer und unterliegen demselben Vertrag wie im Muxer-Weg.
            return unsafe { Self::create_whip(cfg, hw_pixel, frames_ctx, output_path, audio) };
        }

        let mut output = match url_format_hint(output_path) {
            Some(fmt) => {
                let mut o = Dictionary::new();
                if fmt == "whip" {
                    // Der WHIP-Muxer macht sein eigenes I/O (ICE/DTLS/SRTP) —
                    // rw_timeout/tls_verify sind AVIO-Optionen und greifen hier
                    // nicht. handshake_timeout (5s Default) begrenzt den Aufbau.
                    o.set("handshake_timeout", "10000");
                } else {
                    o.set("rw_timeout", "10000000"); // 10s — sonst blockt ein toter Socket ewig
                    // Nagle abschalten. Ohne das sammelt der Kernel kleine
                    // Schreibvorgaenge und wartet auf die Bestaetigung des
                    // vorherigen Pakets — zusammen mit verzoegerten
                    // Bestaetigungen der Gegenseite eine feste Verzoegerung von
                    // bis zu 40 ms, die NICHT an der Datenmenge haengt.
                    // Ueber `PULSE_TCP_NODELAY=0` abschaltbar (Vergleichsmessung).
                    if std::env::var("PULSE_TCP_NODELAY").as_deref() != Ok("0") {
                        o.set("tcp_nodelay", "1");
                    }
                    if output_path.to_ascii_lowercase().starts_with("rtmps://") {
                        o.set("tls_verify", "0"); // self-signed MediaMTX (GnuTLS honoriert das)
                    }
                }
                // Fehlerkontext IMMER über redact_url: `output_path` trägt das
                // Stream-Token, und dieser anyhow-Kontext landet als
                // Event::Error roh im stdio-Protokoll (Renderer-Banner) und
                // auf stderr (sidecar.log) — Kontrakt in `redact.rs`.
                format::output_as_with(output_path, fmt, o).with_context(|| {
                    format!("format::output_as_with({}, {fmt})", redact_url(output_path))
                })?
            }
            None => format::output(output_path)
                .with_context(|| format!("format::output({})", redact_url(output_path)))?,
        };

        // Bilder duerfen NICHT auf den Ton warten.
        //
        // `av_interleaved_write_frame` puffert absichtlich, um die Spuren in
        // DTS-Reihenfolge auszugeben: ein Videopaket bleibt liegen, bis Ton mit
        // passendem Zeitstempel vorliegt. Ton kommt in 20-ms-Haeppchen (Opus),
        // also verliessen die Bilder den Sender in 20-ms-Buendeln — beim
        // Zuschauer als Ruckeln sichtbar, obwohl Bildzahl, Bitrate und
        // Paketverlust tadellos aussahen.
        //
        // Gemessen am 2026-07-26 mit einem Ersatzsender (vorkodierte Datei per
        // `ffmpeg -c copy`, also voellig gleichmaessig) gegen denselben Player,
        // gezaehlt werden zu spaete Ausgabe-Abstaende je 250 ms:
        //   mit Ton, Default-Delta   46-51   Ankunft metronomisch bei 20,0 ms
        //   mit Ton, Delta = 1 us     0-1    Ankunft hoechstens 13,6 ms
        //   ohne Ton                  1-4
        // Der Ton allein verursacht es, und dieser eine Schalter behebt es.
        //
        // Warum direkt am Feld und nicht im Wörterbuch oben: das Wörterbuch von
        // `output_as_with` geht an `avio_open2`, nimmt also nur
        // PROTOKOLL-Optionen (`rw_timeout`, `tls_verify`). `max_interleave_delta`
        // gehoert dem Format-Kontext und wird dort stillschweigend verworfen —
        // daran ist der erste Versuch gescheitert, ohne jede Fehlermeldung.
        //
        // Nicht noch einmal versuchen: `flush_packets = 1` (jedes Paket sofort
        // auf die Leitung, statt im AVIO-Puffer zu sammeln) wurde am 2026-07-27
        // gemessen und brachte NICHTS — Ende zu Ende 86,9 statt 82,5 ms, also
        // innerhalb der Streuung eher schlechter. Die Vermutung war, dass der
        // 32-KB-Ausgabepuffer bei 4000 kbit/s rund 64 ms Inhalt festhaelt; das
        // ist nicht der Fall, libavformat schreibt hier schon durch.
        //
        // Der Wert hat eine UNTERGRENZE, und die haengt am Containerformat: FLV
        // ist eine EINZIGE Tag-Zeitleiste, die Zeitstempel muessen also ueber
        // beide Spuren hinweg aufsteigen. Wird ein Bild sofort geschrieben und
        // trifft danach ein aelteres Tonpaket ein, lehnt der Muxer es ab —
        // gemessen mit Delta 1: `write_interleaved fehlgeschlagen: Invalid
        // argument`, der Stream stirbt beim ersten Tonpaket. (Im ffmpeg-Versuch
        // fiel das nicht auf, weil dort beide Spuren vorsortiert aus einer Datei
        // kamen.) Der Wert muss also gross genug sein, dass der Ton mit seinem
        // 20-ms-Raster noch dazwischenpasst, und klein genug, dass die Bilder
        // nicht in Buendeln herausgehen.
        //
        // Ueber die Umgebung veraenderbar, damit dieser Kompromiss messbar
        // bleibt statt geraten zu werden (Pruefstand: real-harness.py).
        let interleave_us: i64 = std::env::var("PULSE_MUX_INTERLEAVE_US")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_INTERLEAVE_US);
        tracing::info!(target: "mux", interleave_us, "max_interleave_delta gesetzt");
        unsafe {
            (*output.as_mut_ptr()).max_interleave_delta = interleave_us;
        }

        let codec_name = opts::encoder_name(cfg.vendor, &cfg.codec)
            .ok_or_else(|| anyhow!("kein Encoder für vendor={:?} codec={}", cfg.vendor, cfg.codec))?;
        let codec_descriptor = codec::encoder::find_by_name(codec_name)
            .ok_or_else(|| anyhow!("encoder '{codec_name}' nicht im gelinkten FFmpeg registriert"))?;

        let global_header = output.format().flags().contains(format::Flags::GLOBAL_HEADER);

        let mut stream = output.add_stream(codec_descriptor).context("add_stream")?;
        let stream_idx = stream.index();

        // SAFETY: `frames_ctx` ist laut Vertrag dieser Funktion gueltig und
        // passt zu `hw_pixel`; die Hilfsfunktion reicht ihn nur weiter.
        let opened = unsafe {
            open_encoder(cfg, hw_pixel, frames_ctx, codec_descriptor, codec_name, global_header)?
        };
        stream.set_parameters(&opened);

        // Audio-Stream VOR write_header hinzufügen (der Video-Stream-Borrow ist
        // nach set_parameters freigegeben). Scheitert der Audio-Encoder
        // (libopus fehlt/Open-Fehler), läuft der Stream VIDEO-ONLY weiter —
        // ein reines Audio-Problem darf das HQ-Streaming nicht killen. Der
        // Track wird dann gar nicht erst angekündigt (ein deklarierter, aber
        // stummer Track ließe den Interleave-Muxer puffern).
        let mut audio_enc = audio.as_ref().and_then(|a| {
            match AudioEncoder::create(&mut output, a.sample_rate, a.bitrate_kbps) {
                Ok(enc) => Some(enc),
                Err(e) => {
                    tracing::warn!(
                        target: "stream",
                        "Audio-Encoder nicht verfügbar ({e:#}) — Stream läuft ohne Ton"
                    );
                    None
                }
            }
        });

        output.write_header().context("write_header")?;

        let stream_time_base = output.stream(stream_idx).unwrap().time_base();
        let encoder_time_base = Rational::new(1, cfg.fps as i32);

        // Vom Muxer zugewiesene Audio-Stream-Timebase nachreichen.
        if let Some(ae) = audio_enc.as_mut() {
            let tb = output.stream(ae.stream_idx()).unwrap().time_base();
            ae.set_stream_time_base(tb);
        }

        let mux = MuxWriter::start(output).context("start mux-writer")?;

        Ok((
            Self {
                mux: Ausgabe::Mux(mux),
                encoder: opened,
                video_stream_idx: stream_idx,
                encoder_time_base,
                stream_time_base,
                submitted: std::collections::VecDeque::new(),
                fps_fuer_keyframes: cfg.fps,
                enc_sum_us: 0,
                enc_count: 0,
                enc_max_us: 0,
            },
            audio_enc,
        ))
    }

    /// Encoder + eigener WHIP-Sendeweg, ohne jeden ffmpeg-Ausgang.
    ///
    /// **`global_header` ist hier bewusst `false`.** Ein Container wie FLV
    /// erwartet die Parametersaetze (SPS/PPS bzw. den Sequence-Header) EINMAL
    /// im Kopf; ueber RTP muessen sie dagegen im Strom mitlaufen, weil jeder
    /// Zuschauer zu einem beliebigen Zeitpunkt einsteigt und es keinen Kopf
    /// gibt, den er nachlesen koennte. Mit globalem Kopf bekaeme er nie
    /// Parametersaetze und saehe dauerhaft nichts.
    ///
    /// # Safety
    ///
    /// Wie [`create_with_audio`](Self::create_with_audio).
    unsafe fn create_whip(
        cfg: &EncoderConfig,
        hw_pixel: format::Pixel,
        frames_ctx: *mut AVBufferRef,
        url: &str,
        audio: Option<AudioParams>,
    ) -> Result<(Self, Option<AudioEncoder>)> {
        let codec_name = opts::encoder_name(cfg.vendor, &cfg.codec)
            .ok_or_else(|| anyhow!("kein Encoder fuer {:?}/{}", cfg.vendor, cfg.codec))?;
        let codec_descriptor = ffmpeg::encoder::find_by_name(codec_name)
            .ok_or_else(|| anyhow!("Encoder '{codec_name}' nicht in diesem ffmpeg"))?;

        // SAFETY: siehe Vertrag dieser Funktion.
        let opened = unsafe {
            open_encoder(cfg, hw_pixel, frames_ctx, codec_descriptor, codec_name, false)?
        };

        // Der Ton-Encoder MUSS vor dem Verbinden stehen: WHIP kennt keine
        // Nachverhandlung, die Tonspur muss also schon im Angebot liegen. Wer
        // sie spaeter anmelden wollte, muesste die Sitzung neu aufbauen.
        let audio_enc = audio
            .map(|a| AudioEncoder::create_standalone(a.sample_rate, a.bitrate_kbps))
            .transpose()
            .context("libopus-Encoder fuer den WHIP-Weg")?;

        // Erst NACH dem Oeffnen der Encoder verbinden: schlaegt einer von ihnen
        // fehl, waere eine offene Sitzung beim Server ein Karteileichen-Pfad,
        // den erst ein Zeitablauf aufraeumt.
        let sender = WhipSender::connect(url, &cfg.codec, cfg.fps, cfg.width, cfg.height)
            .with_context(|| format!("WHIP-Aufbau zu {}", redact_url(url)))?;

        let tb = Rational::new(1, cfg.fps as i32);
        Ok((
            Self {
                mux: Ausgabe::Whip(Arc::new(sender)),
                encoder: opened,
                video_stream_idx: 0,
                encoder_time_base: tb,
                // Gleich der Encoder-Zeitbasis: auf diesem Weg wird nicht
                // umgerechnet (s. `drain_video`), das Feld bleibt nur belegt,
                // damit die Struktur eine bleibt.
                stream_time_base: tb,
                submitted: std::collections::VecDeque::new(),
                fps_fuer_keyframes: cfg.fps,
                enc_sum_us: 0,
                enc_count: 0,
                enc_max_us: 0,
            },
            audio_enc,
        ))
    }

    /// Wohin der Ton-Faden seine Pakete schickt.
    ///
    /// Auf dem WHIP-Weg ist es eine eigene Spur in der Peer-Verbindung statt
    /// eines zweiten Streams im Container — der Ton-Faden bekommt dafuer eine
    /// geteilte Referenz auf den Sender.
    pub fn ton_senke(&self) -> Result<audio::TonSenke> {
        match &self.mux {
            Ausgabe::Mux(m) => Ok(audio::TonSenke::Mux(m.sender()?)),
            Ausgabe::Whip(w) => Ok(audio::TonSenke::Whip(Arc::clone(w))),
        }
    }

    /// Schicke einen HW-Frame (CUDA/VAAPI, `*mut AVFrame`) in den Encoder.
    /// `pts` in Encoder-Timebase (1/fps), strikt monoton.
    ///
    /// # Safety
    ///
    /// `frame` muss ein gültiger, noch lebender `AVFrame` sein, dessen
    /// HW-Format zu dem beim Öffnen gebundenen Frames-Kontext passt. Die
    /// Funktion schreibt in den Frame (`pts`) und reicht ihn an
    /// `avcodec_send_frame` weiter.
    pub unsafe fn send_hw(&mut self, frame: *mut AVFrame, pts: i64) -> Result<()> {
        // VOR dem Einschieben stempeln, nicht danach.
        //
        // Das war zuerst falsch und die Korrektur ist der Grund, warum die
        // Zahlen vom 2026-07-26 nachgemessen wurden: mit abgeschaltetem
        // Vorlauf (`zerolatency`/`delay=0`) liefert NVENC das Paket im
        // SELBEN Aufruf, die Rechenzeit steckt also in `avcodec_send_frame`
        // selbst. Ein Stempel danach meldete deshalb 0,0 ms — eine Zahl, die
        // nach vollkommener Latenzfreiheit aussah und schlicht am Messpunkt
        // vorbeiging.
        let mut submitted_at = std::time::Instant::now();
        unsafe {
            (*frame).pts = pts;
            // Vollbild auf Anforderung. `pict_type = I` auf dem Eingabe-Bild
            // verlangt vom Encoder ein IDR — der Weg, den der Windows-Sidecar
            // fuer die Fernsteuerung schon geht.
            //
            // WICHTIG: pro Bild ZURUECKSETZEN. Der Frame stammt aus einem Pool
            // und wird wiederverwendet; ohne das Zuruecksetzen bliebe `I` nach
            // der ersten Anforderung kleben und JEDES Bild waere ein Vollbild —
            // bei fester Bitrate bricht damit die Bildqualitaet zusammen.
            (*frame).pict_type = if take_keyframe_request(self.fps_fuer_keyframes) {
                ffmpeg::ffi::AVPictureType::AV_PICTURE_TYPE_I
            } else {
                ffmpeg::ffi::AVPictureType::AV_PICTURE_TYPE_NONE
            };
            let mut ret = avcodec_send_frame(self.encoder.as_mut_ptr(), frame);
            if ret == AVERROR(libc::EAGAIN) {
                // Encoder-Input voll (kleiner NVENC-Surface-Pool / VAAPI
                // async_depth) — laut send/receive-Kontrakt KEIN Fehler:
                // erst drainen, dann genau einmal nachschieben. Bleibt es
                // EAGAIN, wird der Frame verworfen (CFR dupliziert eh).
                self.drain_video()?;
                // Neu stempeln: das Leeren dazwischen holt Pakete ab, rechnet
                // Zeitstempel um und schreibt in den Muxer. Diese Zeit gehoert
                // nicht zur Verarbeitung DIESES Bildes — mit dem alten Stempel
                // fiele die gemessene Latenz genau bei den Ausreissern zu hoch
                // aus, also dort, wo man am genauesten hinsieht.
                submitted_at = std::time::Instant::now();
                ret = avcodec_send_frame(self.encoder.as_mut_ptr(), frame);
                if ret == AVERROR(libc::EAGAIN) {
                    tracing::debug!(target: "stream", "Encoder-Queue voll — Frame übersprungen");
                    return Ok(());
                }
            }
            if ret < 0 {
                return Err(anyhow!("avcodec_send_frame failed (rc={ret})"));
            }
        }
        // Nur angenommene Bilder vermerken: bei EAGAIN oben wird verworfen, ein
        // Eintrag dafuer wuerde die Zuordnung dauerhaft verschieben.
        self.submitted.push_back((pts, submitted_at));
        self.drain_video()
    }

    fn drain_video(&mut self) -> Result<()> {
        loop {
            let mut packet = Packet::empty();
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(e.into()),
            }
            // VOR dem Umrechnen zuordnen: `rescale_ts` verschiebt den pts in
            // die Muxer-Zeitbasis, danach passt er nicht mehr zum vermerkten.
            if let Some(pts) = packet.pts() {
                while let Some(&(front, at)) = self.submitted.front() {
                    if front > pts {
                        break; // Paket ohne Eintrag — sollte nicht vorkommen
                    }
                    self.submitted.pop_front();
                    if front == pts {
                        let us = at.elapsed().as_micros() as u64;
                        self.enc_sum_us += us;
                        self.enc_count += 1;
                        self.enc_max_us = self.enc_max_us.max(us);
                        break;
                    }
                }
            }
            match &mut self.mux {
                Ausgabe::Mux(m) => {
                    packet.set_stream(self.video_stream_idx);
                    packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
                    m.send(packet)?;
                }
                // Kein Umrechnen und kein Stream-Index: der Sende-Track nimmt
                // die rohen Bytes.
                //
                // Der `pts` geht MIT — in der Encoder-Zeitbasis, der Track
                // rechnet ihn selbst auf die 90-kHz-RTP-Uhr um. Hier stand bis
                // 2026-08-03, webrtc-rs setze die Zeitstempel ohnehin selbst;
                // das gilt aber nur fuer H.264 (`TrackLocalStaticSample`). Der
                // AV1-Weg laeuft ueber `TrackLocalStaticRTP`, und der stempelt
                // NICHT — dort zaehlte stattdessen ein Bildzaehler, der bei
                // jedem ausgelassenen Bild hinter der Wanduhr zurueckfiel.
                // Begruendung in `whip::Av1Zustand::zeitstempel`.
                Ausgabe::Whip(w) => {
                    if let Some(daten) = packet.data() {
                        w.send(daten, packet.pts())?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Encode-Latenz seit dem letzten Aufruf: (Mittel, Ausschlag, Anzahl) in
    /// Mikrosekunden. Holt und LEERT die Zaehler, damit der Aufrufer ein Fenster
    /// je Sekunde ausgeben kann, ohne dass sich alles glatt buegelt.
    ///
    /// Gemessen wird vom `avcodec_send_frame` bis zu dem Paket, das denselben
    /// pts traegt — also die Verzoegerung der Encoder-Kette einschliesslich
    /// ihrer Warteschlange, nicht die reine Rechenzeit eines Bildes. Genau das
    /// ist der Anteil, den ein Zuschauer als Latenz spuert.
    pub fn take_encode_latency(&mut self) -> (u64, u64, u64) {
        let avg = if self.enc_count > 0 { self.enc_sum_us / self.enc_count } else { 0 };
        let out = (avg, self.enc_max_us, self.enc_count);
        self.enc_sum_us = 0;
        self.enc_count = 0;
        self.enc_max_us = 0;
        out
    }

    /// Finalisieren: EOF an Video, restliche Pakete, MuxWriter-Flush (schreibt
    /// den Trailer / sauberen RTMP-Close).
    pub fn finish(&mut self) -> Result<()> {
        self.encoder.send_eof().context("video send_eof")?;
        self.drain_video()?;
        match &mut self.mux {
            Ausgabe::Mux(m) => m.finish(),
            Ausgabe::Whip(w) => {
                w.close();
                Ok(())
            }
        }
    }
}

/// Den Hardware-Encoder aufsetzen und oeffnen — gemeinsam fuer beide Ausgaenge.
///
/// Herausgeloest, damit der WHIP-Weg (`create_whip`) nicht seine eigene Kopie
/// dieser Einstellungen fuehrt: sie sind gemessen, und zwei Fassungen davon
/// wuerden garantiert auseinanderlaufen.
///
/// `global_header` unterscheidet die beiden Aufrufer und ist der einzige echte
/// Unterschied — Begruendung am WHIP-Aufrufer.
///
/// # Safety
///
/// `frames_ctx` muss ein gueltiger `AVBufferRef` auf einen Frames-Kontext sein,
/// dessen Format zu `hw_pixel` passt; er wird nur referenziert, nicht besessen.
unsafe fn open_encoder(
    cfg: &EncoderConfig,
    hw_pixel: format::Pixel,
    frames_ctx: *mut AVBufferRef,
    codec_descriptor: ffmpeg::Codec,
    codec_name: &str,
    global_header: bool,
) -> Result<codec::encoder::Video> {
    let mut encoder = codec::context::Context::new_with_codec(codec_descriptor)
        .encoder()
        .video()?;
    encoder.set_width(cfg.width);
    encoder.set_height(cfg.height);
    encoder.set_format(hw_pixel);
    encoder.set_time_base(Rational::new(1, cfg.fps as i32));
    encoder.set_frame_rate(Some(Rational::new(cfg.fps as i32, 1)));
    let bitrate_bps = (cfg.bitrate_kbps as usize).saturating_mul(1000);
    encoder.set_bit_rate(bitrate_bps);
    encoder.set_max_bit_rate(bitrate_bps);
    encoder.set_gop(keyframe_abstand_bilder(cfg.fps));
    // Low-Latency: kein B-Frame (GSR Performance-Tune).
    encoder.set_max_b_frames(0);
    if global_header {
        encoder.set_flags(codec::Flags::GLOBAL_HEADER);
    }
    // Farb-Signalisierung überall dort, wo WIR die Umwandlung bestimmen:
    //
    // * 10 bit: `nv_p010` rechnet die Matrix selbst (BT.709, begrenzt).
    // * VAAPI, jede Bittiefe: `scale_vaapi` bekommt seit 2026-08-01
    //   `out_color_matrix=bt709:out_range=limited` vorgegeben.
    //
    // Für NVENC in 8 bit bleibt es aus, und das ist keine Nachlässigkeit:
    // dort wandelt der Encoder intern nach eigener Konvention, und etwas
    // zu behaupten, das wir nicht kontrollieren, würde einen verifiziert
    // korrekten Pfad auf Verdacht verstellen.
    //
    // **Warum es für VAAPI nachgezogen wurde:** ohne Vorgabe lieferte Mesa
    // BT.709 im VOLLEN Wertebereich, der Strom sagte aber nichts — und ein
    // Empfänger ohne Angabe nimmt den begrenzten Bereich an und spreizt
    // das Bild. Gemessen am 2026-08-01: weiss Y=255 statt 235, schwarz
    // Y=0 statt 16, rot Y=54 statt 62. Sichtbar, und es traf jeden
    // AMD-Sender.
    if cfg.ten_bit || matches!(cfg.vendor, Vendor::Amd | Vendor::Intel) {
        encoder.set_colorspace(ffmpeg::color::Space::BT709);
        encoder.set_color_range(ffmpeg::color::Range::MPEG);
        unsafe {
            let ctx = encoder.as_mut_ptr();
            (*ctx).color_primaries = AVColorPrimaries::AVCOL_PRI_BT709;
            (*ctx).color_trc = AVColorTransferCharacteristic::AVCOL_TRC_BT709;
        }
    }

    // hw_frames_ctx VOR open an die AVCodecContext hängen (ffmpeg-next
    // exponiert das Feld nicht → `as_mut_ptr`). NVENC/VAAPI brauchen den
    // Frames-Pool als Input-Quelle.
    unsafe {
        let ctx_ptr = encoder.as_mut_ptr();
        let new_ref = av_buffer_ref(frames_ctx);
        if new_ref.is_null() {
            return Err(anyhow!("av_buffer_ref(frames_ctx) returned NULL"));
        }
        (*ctx_ptr).hw_frames_ctx = new_ref;
    }

    let o = opts::vendor_opts(cfg.vendor, &cfg.codec);
    // SAFETY: der Kontext gehört uns, ist noch nicht geöffnet und lebt
    // über den Aufruf hinaus; `warn_unknown` liest ihn nur.
    unsafe { opts::warn_unknown(encoder.as_mut_ptr(), &o) };
    // SAFETY: wie oben — derselbe Kontext, nur gelesen.
    unsafe { opts::intra_refresh_pruefen(encoder.as_mut_ptr(), cfg.vendor, codec_name)? };
    let opened = encoder
        .open_with(o)
        .with_context(|| format!("open hw encoder '{codec_name}' (vendor={:?})", cfg.vendor))?;
    // WELCHER Encoder wirklich offen ist, gehört ins Log.
    //
    // `ops::start` kann den Codec still auf H.264 zurücknehmen (fehlendes
    // AV1, WHIP-Ziel) — bisher stand das nur als `warn!` dort, und was am
    // Ende lief, war nirgends festgehalten. Für eine Messreihe ist das
    // gefährlich: der Prüfstand schreibt seinen WUNSCH in die Messakte, und
    // eine H.264-Messung mit AV1-Etikett sieht vollkommen plausibel aus.
    //
    // Die BETRIEBSART gehoert mit ins Log, nicht nur der Encoder. Sie kommt aus
    // den Start-Parametern ODER aus der Umgebung, und ob sie wirklich
    // angekommen ist, war von aussen bisher gar nicht feststellbar: ein
    // Intra-Refresh-Lauf, bei dem der Wunsch unterwegs verlorenging, sieht in
    // jedem anderen Log genau wie ein Keyframe-Lauf aus. Am 2026-08-02 ist
    // genau das passiert — die Oberflaeche schickte das Feld nicht mit, der
    // Stream lief mit Vollbildern, und nichts sagte es.
    tracing::info!(
        target: "stream", encoder = codec_name, vendor = ?cfg.vendor,
        breite = cfg.width, hoehe = cfg.height, fps = cfg.fps,
        bitrate_kbps = cfg.bitrate_kbps,
        intra_refresh = opts::intra_refresh_gewuenscht(),
        keyframe_abstand_bilder = keyframe_abstand_bilder(cfg.fps),
        "Encoder offen"
    );
    Ok(opened)
}

/// Keyframe-Abstand in Bildern. Vorgabe zwei Sekunden wie bei GSR.
///
/// **Warum das einstellbar ist.** Der Abstand ist der einzige Hebel, den der
/// Sender gegen Paketverlust hat, solange kein Rueckkanal existiert. Am
/// 2026-07-28 gemessen (`verlust-2026-07-28-browser-gegen-nativ.json`): Der
/// native Player wartet nach jeder Luecke auf den naechsten Einstiegspunkt, und
/// bei zwei Sekunden Abstand wird er dadurch unberechenbar — drei identische
/// Laeufe unter 1 % Verlust ergaben Mediane von 38, 190 und 369 ms, mit
/// Ausschlaegen bis 539. Chromium wartet nicht, sondern dekodiert weiter, und
/// liegt deshalb unter Verlust vorn.
///
/// Ein kuerzerer Abstand kostet dabei NICHT Datenrate: die Rate-Control laeuft
/// auf `cbr` mit fester Bitrate. Er kostet Bildqualitaet, weil mehr Bits in die
/// Vollbilder gehen. Beides gehoert gemessen, bevor die Vorgabe sich aendert —
/// deshalb ein Schalter und keine neue Zahl.
fn keyframe_abstand_bilder(fps: u32) -> u32 {
    let sekunden = std::env::var("PULSE_KEYFRAME_SECONDS")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| (0.1..=10.0).contains(v))
        .unwrap_or(2.0);
    // Mindestens ein Bild — ein GOP von 0 hiesse "jedes Bild ein Vollbild" und
    // wuerde von manchen Encodern als "unbegrenzt" gelesen.
    ((fps as f32 * sekunden).round() as u32).max(1)
}

/// Offene Anforderung eines Vollbilds.
///
/// **Wozu.** Ein Zuschauer, der ein Paket verliert, kann erst am naechsten
/// Einstiegspunkt wieder aufsetzen. Ueber den WHIP-Weg erreicht seine
/// RTCP-Anforderung (PLI/FIR) jetzt den Encoder — MediaMTX reicht sie
/// nachweislich durch, es fehlte nur ein Sender, der sie annimmt. Ohne diesen
/// Rueckweg stand das Bild nach einem Verlust bis zum naechsten regulaeren
/// Vollbild, bei zwei Sekunden Abstand also bis zu zwei Sekunden.
///
/// Zweiter Nutzen, und fuer Intra-Refresh der entscheidende: ein neu
/// dazukommender Zuschauer braucht EIN Vollbild zum Einstieg. Ohne das sieht er
/// gar nichts — gemessen 0 Bilder gegen 2228, wenn er vor dem einzigen IDR
/// beitritt.
///
/// Ausgeloest wird sie ausserdem ueber die Operation `keyframe` auf der
/// stdio-Schnittstelle, damit sich die Wirkung ohne Netz messen laesst.
static KEYFRAME_ANGEFORDERT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Zeitpunkt des zuletzt ausgelieferten Vollbilds, als Millisekunden seit
/// Prozessstart.
///
/// `u64::MAX` heisst „noch keins". NICHT 0: `jetzt_ms()` IST in der ersten
/// Millisekunde nach dem Start 0, das Merkmal haette sich also nie geloescht
/// und jede Anforderung waere durchgegangen — genau das, was die Sperrfrist
/// verhindern soll. Vom Test gefunden.
const NIE: u64 = u64::MAX;
static LETZTES_VOLLBILD_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(NIE);

fn jetzt_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

/// Mindestabstand zwischen zwei angeforderten Vollbildern.
///
/// **Warum es den geben MUSS.** Ein Empfaenger, der den Strom aus eigenen
/// Gruenden nicht dekodieren kann, fordert unablaessig Vollbilder an — er hat
/// keinen anderen Hebel. Ohne Untergrenze beantwortet der Sender jede einzelne
/// Anforderung, und bei fester Bitrate besteht der Strom dann aus IDRs. Am
/// 2026-08-02 auf dieser Kette beobachtet: 766 Vollbilder, eins alle 420 ms,
/// sichtbar als Pumpen. Der Ausloeser war ein Chromium, dem 10-bit-AV1 nicht
/// dekodierbar ist — aber die Ursache ist allgemein: die Anforderung eines
/// Zuschauers darf den Strom fuer alle anderen nicht ruinieren.
///
/// **Warum genau dieser Wert.** Der Abstand regulaerer Vollbilder
/// (`PULSE_KEYFRAME_SECONDS`, Vorgabe 2 s) ist die natuerliche Obergrenze: Mit
/// ihr ist der angeforderte Weg NIE schlechter als der alte Betrieb mit festem
/// Takt. Die erste Anforderung nach einer Ruhephase wird sofort beantwortet —
/// gedrosselt wird nur das Nachfassen.
///
/// `PULSE_KEYFRAME_MIN_ABSTAND_MS` setzt ihn fuer Messungen ausser Kraft (0 =
/// jede Anforderung beantworten, das Verhalten vor dieser Aenderung).
fn keyframe_mindestabstand_ms(fps: u32) -> u64 {
    if let Some(v) = std::env::var("PULSE_KEYFRAME_MIN_ABSTAND_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        return v;
    }
    let bilder = keyframe_abstand_bilder(fps) as u64;
    bilder.saturating_mul(1000) / fps.max(1) as u64
}

/// Beim naechsten Bild ein Vollbild erzeugen.
pub fn request_keyframe() {
    KEYFRAME_ANGEFORDERT.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Anforderung abholen — hoechstens eine je [`keyframe_mindestabstand_ms`].
///
/// Die Anforderung wird auch dann geloescht, wenn sie verworfen wird: sie ist
/// damit beantwortet, sobald das naechste Vollbild kommt. Sonst sammelte sich
/// ein Rueckstau an, der nach der Sperrfrist eine Salve ausloeste.
fn take_keyframe_request(fps: u32) -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    if !KEYFRAME_ANGEFORDERT.swap(false, Relaxed) {
        return false;
    }
    let jetzt = jetzt_ms();
    let letztes = LETZTES_VOLLBILD_MS.load(Relaxed);
    let abstand = keyframe_mindestabstand_ms(fps);
    // Die erste Anforderung geht immer durch, sonst saehe ein Zuschauer, der
    // sofort beitritt, bis zum Ablauf einer nie gelaufenen Frist gar nichts.
    if letztes != NIE && jetzt.saturating_sub(letztes) < abstand {
        tracing::debug!(
            target: "stream",
            seit_ms = jetzt.saturating_sub(letztes), mindestens_ms = abstand,
            "Vollbild-Anforderung zusammengefasst"
        );
        return false;
    }
    LETZTES_VOLLBILD_MS.store(jetzt, Relaxed);
    true
}

/// Probe-Auflösung für die Codec-Liste: klein, aber über
/// AV1-Mindestmaßen/Alignment.
///
/// **Sie beantwortet „kann diese Karte den Codec", nicht „bis wohin".** Das ist
/// für die Codec-Liste richtig (die steht, bevor der Wayland-Dialog die Quelle
/// festlegt), reicht aber nicht für den Start: `h264_vaapi` öffnet auf einer
/// Radeon 780M bei 4K und scheitert bei 8K mit `Invalid argument`, während
/// `av1_vaapi` beides trägt (gemessen 2026-08-03). Der Startpfad probt deshalb
/// ein zweites Mal mit der ECHTEN Auflösung — s.
/// `stream_controller::codec_fuer_aufloesung`.
const PROBE_W: u32 = 1280;
const PROBE_H: u32 = 720;

/// Kann DIESE Hardware den Encoder für `codec` (`h264`/`av1`) wirklich öffnen?
///
/// Der EINZIGE verlässliche Test: HW-Frames-Kontext bauen + Encoder öffnen.
/// Dass `find_by_name` den Encoder findet, sagt NICHTS über die GPU — FFmpeg
/// linkt `av1_nvenc` auch auf einer Karte ohne AV1-Encode (z. B. RTX 30xx:
/// AV1 nur decode). NVENC/VAAPI melden erst beim `open`, ob die Hardware den
/// Codec trägt.
///
/// `Ok(true|false)` = Probe lief sauber. `Err` = Device selbst nicht
/// initialisierbar (Treiber fehlt) → Caller behandelt konservativ (nicht
/// anbieten).
/// `ten_bit`: mit dem 10-bit-Eingangsformat proben statt mit dem 8-bit-Pfad —
/// P010 auf beiden Wegen (NVENC bekommt es aus dem Shader, VAAPI aus
/// `scale_vaapi=format=p010`). **Bis 2026-08-01 gab der VAAPI-Zweig hier ohne
/// Probe `false` zurueck**, weil der Filtergraph fest auf NV12 wandelte; dass
/// die Hardware es kann, war damit nie gefragt worden. Auf einer Radeon 780M
/// meldet der Treiber `VA_RT_FORMAT_YUV420_10` fuer AV1-Encode.
pub fn probe_encoder(
    vendor: Vendor,
    render_node: &str,
    codec_id: &str,
    ten_bit: bool,
) -> Result<bool> {
    probe_encoder_at(vendor, render_node, codec_id, ten_bit, PROBE_W, PROBE_H)
}

/// Wie [`probe_encoder`], aber bei einer VORGEGEBENEN Bildgroesse.
///
/// Gebraucht vom Startpfad: „kann die Karte den Codec" (720p) und „kann sie ihn
/// auch bei DIESER Groesse" sind verschiedene Fragen, und die Antworten weichen
/// ab — s. `caps::codec_fuer_aufloesung`.
pub fn probe_encoder_at(
    vendor: Vendor,
    render_node: &str,
    codec_id: &str,
    ten_bit: bool,
    breite: u32,
    hoehe: u32,
) -> Result<bool> {
    let Some(name) = opts::encoder_name(vendor, codec_id) else {
        return Ok(false);
    };
    ffmpeg::init().context("ffmpeg::init")?;
    let Some(desc) = codec::encoder::find_by_name(name) else {
        return Ok(false); // Encoder nicht ins FFmpeg gelinkt
    };

    let kind = hw::kind_for(vendor);
    let (dev_arg, sw) = match vendor {
        // Eingangsformat wie der echte Pfad: NVENC RGB0 (Blit-Ergebnis) bzw.
        // X2BGR10LE im 10-bit-Pfad, VAAPI NV12 (scale_vaapi-Ausgang).
        Vendor::Nvidia if ten_bit => (None, AVPixelFormat::AV_PIX_FMT_P010LE),
        Vendor::Nvidia => (None, AVPixelFormat::AV_PIX_FMT_RGB0),
        Vendor::Amd | Vendor::Intel if ten_bit => {
            (Some(render_node), AVPixelFormat::AV_PIX_FMT_P010LE)
        }
        Vendor::Amd | Vendor::Intel => (Some(render_node), AVPixelFormat::AV_PIX_FMT_NV12),
    };
    let hwctx = HwContext::create(kind, dev_arg, breite, hoehe, sw)?;

    // FFmpeg-Logs während der Probe dämpfen — ein fehlgeschlagener open loggt
    // sonst laute AV_LOG_ERROR-Zeilen in die sidecar.log, obwohl "geht nicht"
    // hier der ERWARTETE Ausgang ist. `av_log_set_level` ist PROZESS-global:
    // (a) parallele Proben serialisiert der Lock (sonst Race beim Restore —
    // eine Probe könnte den FATAL-Wert der anderen als "prev" einfangen);
    // (b) läuft gerade ein Stream, wird NICHT gedämpft — sonst fehlten genau
    // während der Probe die Fehlerlogs eines parallelen Push-Problems.
    static PROBE_LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _serialize = PROBE_LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let quiet = !crate::stream_controller::StreamController::singleton()
        .state()
        .running;
    let prev = unsafe { av_log_get_level() };
    if quiet {
        unsafe { av_log_set_level(AV_LOG_FATAL) };
    }
    let ok = probe_open(desc, &hwctx, vendor, codec_id, breite, hoehe);
    if quiet {
        unsafe { av_log_set_level(prev) };
    }
    Ok(ok)
}

/// Encoder-Context bauen, Frames-Pool binden, `open` versuchen. Kein Muxer,
/// kein Output — nur der Fähigkeits-Test.
fn probe_open(
    desc: ffmpeg::Codec,
    hwctx: &HwContext,
    vendor: Vendor,
    codec: &str,
    breite: u32,
    hoehe: u32,
) -> bool {
    let Ok(mut enc) = codec::context::Context::new_with_codec(desc)
        .encoder()
        .video()
    else {
        return false;
    };
    enc.set_width(breite);
    enc.set_height(hoehe);
    enc.set_format(hwctx.ffmpeg_pixel());
    enc.set_time_base(Rational::new(1, 30));
    enc.set_frame_rate(Some(Rational::new(30, 1)));
    enc.set_bit_rate(2_000_000);
    // Wie der echte Pfad: keine B-Bilder.
    //
    // **Das ist keine Kosmetik.** Die VAAPI-Encoder setzen selbst `bf=2` als
    // Vorgabe (`vaapi_encode_h264.c`), der Live-Pfad ueberschreibt das mit
    // `set_max_b_frames(0)` — die Probe tat es nicht und pruefte damit eine
    // ANDERE Einstellung als die, die spaeter laeuft. Aufgefallen am
    // 2026-08-01: mit `PULSE_INTRA_REFRESH=1` scheiterte der h264-Open in der
    // Probe an "Intra refresh cannot be used together with B-frames", und
    // H.264 verschwand still aus `health.video_codecs` — obwohl der echte
    // Encode-Pfad es problemlos konnte.
    enc.set_max_b_frames(0);
    unsafe {
        let ctx = enc.as_mut_ptr();
        let new_ref = av_buffer_ref(hwctx.frames_ref());
        if new_ref.is_null() {
            return false;
        }
        (*ctx).hw_frames_ctx = new_ref;
    }
    enc.open_with(opts::vendor_defaults(vendor, codec)).is_ok()
}

/// Output-Format-Hint nach URL-Schema: rtmp(s)→flv, srt→mpegts,
/// http(s)→whip (WebRTC-Ingest, Gäste-Publish auf App-gehosteten Instanzen —
/// media-svc mintet dort `https://<host>/whep/<path>/whip?token=…`), sonst None
/// (Datei → auto-detect anhand Erweiterung). Wie mac/win (+WHIP nur Linux).
pub fn url_format_hint(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("rtmp://") || lower.starts_with("rtmps://") {
        Some("flv")
    } else if lower.starts_with("srt://") {
        Some("mpegts")
    } else if lower.starts_with("http://") || lower.starts_with("https://") {
        Some("whip")
    } else {
        None
    }
}

/// Ist die Push-URL ein WHIP-Ziel? (Für den AV1→H.264-Fallback in `ops::start` —
/// der ffmpeg-8.1-WHIP-Muxer kann kein AV1.)
pub fn is_whip_url(url: &str) -> bool {
    url_format_hint(url) == Some("whip")
}

/// Melden, wenn Intra-Refresh über einen Weg ohne RTCP-Rückkanal geht.
///
/// Diese Kombination ist für jeden Zuschauer wertlos: In einem
/// Intra-Refresh-Strom stehen kaum Vollbilder, und ohne Rückkanal kann niemand
/// eins anfordern — der Zuschauer sieht dauerhaft ein schwarzes Bild, während
/// Sender und Server nichts Auffälliges melden.
///
/// **Warum die Warnung existiert** (2026-08-03): Genau das ist passiert, und
/// es war von außen nicht zu sehen. Die Oberfläche schickte ihre Wahl nur mit,
/// wenn sie `true` war; beim Zurückschalten auf den Standardweg fehlte das
/// Feld, der prozessweite Zustand im Sidecar behielt „an", und der Transport
/// fiel korrekt auf RTMPS zurück. Der Encoder lief also in einer Betriebsart,
/// die diesen Transport ausschließt. Beide Seiten für sich waren plausibel —
/// erst zusammen ergaben sie einen unbrauchbaren Strom.
///
/// Nur eine Warnung, kein Abbruch und kein stilles Umschalten: Der Prüfstand
/// fährt den Sidecar ohne Oberfläche und darf diese Kombination messen dürfen.
/// Dateiziele sind ausgenommen — dort gibt es keinen Zuschauer.
fn warne_bei_intra_refresh_ohne_rueckkanal(output_path: &str) {
    let Some(format) = url_format_hint(output_path) else {
        return; // Datei, kein Netz-Ziel
    };
    if format == "whip" || !opts::intra_refresh_gewuenscht() {
        return;
    }
    tracing::warn!(
        target: "stream", format,
        "Intra-Refresh ohne RTCP-Rueckkanal: dieser Weg kann keine Vollbild-Anforderung \
         zustellen, und der Strom enthaelt kaum Vollbilder — Zuschauer sehen ein \
         schwarzes Bild. Intra-Refresh braucht WHIP."
    );
}

#[cfg(test)]
mod format_hint_tests {
    use super::{is_whip_url, url_format_hint};

    #[test]
    fn hints_by_scheme() {
        assert_eq!(url_format_hint("rtmp://h:1935/x"), Some("flv"));
        assert_eq!(url_format_hint("RTMPS://h:1936/x?user=pulse&pass=t"), Some("flv"));
        assert_eq!(url_format_hint("srt://h:8890?streamid=publish:x"), Some("mpegts"));
        assert_eq!(url_format_hint("http://127.0.0.1:8889/channel-1/whip"), Some("whip"));
        assert_eq!(
            url_format_hint("https://host/whep/channel-1-2-abc/whip?token=t"),
            Some("whip")
        );
        assert_eq!(url_format_hint("/tmp/out.mp4"), None);
    }

    #[test]
    fn whip_detection() {
        assert!(is_whip_url("https://host/whep/channel-1/whip?token=t"));
        assert!(!is_whip_url("rtmps://host:1936/channel-1?user=pulse&pass=t"));
        assert!(!is_whip_url("/tmp/out.mp4"));
    }
}

#[cfg(test)]
mod keyframe_sperrfrist_tests {
    use super::*;

    /// Die Sperrfrist ist der Schutz davor, dass EIN Empfaenger den Strom fuer
    /// alle ruiniert (2026-08-02: 766 erzwungene Vollbilder, eins alle 420 ms).
    #[test]
    fn zweite_anforderung_wird_zusammengefasst() {
        unsafe { std::env::set_var("PULSE_KEYFRAME_MIN_ABSTAND_MS", "60000") };
        LETZTES_VOLLBILD_MS.store(NIE, std::sync::atomic::Ordering::Relaxed);

        // Die erste geht durch — ein Zuschauer, der gerade beitritt, soll nicht
        // bis zum Ablauf einer Frist warten, die noch nie gelaufen ist.
        request_keyframe();
        assert!(take_keyframe_request(60), "erste Anforderung muss durchgehen");

        // Die zweite faellt in die Frist und wird verworfen, nicht gestaut.
        request_keyframe();
        assert!(!take_keyframe_request(60), "zweite Anforderung muss zusammengefasst werden");

        // Ohne Anforderung passiert nichts — auch nach Ablauf der Frist.
        unsafe { std::env::set_var("PULSE_KEYFRAME_MIN_ABSTAND_MS", "0") };
        assert!(!take_keyframe_request(60), "ohne Anforderung kein Vollbild");

        // Frist aus: jede Anforderung wird beantwortet (das Verhalten, das der
        // Pruefstand fuer Vergleichsmessungen braucht).
        request_keyframe();
        assert!(take_keyframe_request(60));
        request_keyframe();
        assert!(take_keyframe_request(60));

        unsafe { std::env::remove_var("PULSE_KEYFRAME_MIN_ABSTAND_MS") };
    }
}
