//! Audio-Encoder-Pfad — libopus für FLV/MPEG-TS.
//!
//! Wird aus `encoder.rs` als optionale zweite Spur instantiiert. WASAPI liefert
//! interleaved 32-bit-Float bei 48 kHz Stereo; libopus akzeptiert genau dieses
//! Format direkt (`AV_SAMPLE_FMT_FLT` — siehe `libavcodec/libopusenc.c`).
//! Kein Resampler nötig.
//!
//! 1. Akkumulieren in einem FIFO bis ein Opus-Frame voll ist (s.
//!    [`OPUS_FRAME_MS`])
//! 2. Encode + Packet emittieren in 1/48000-Time-Base
//!
//! Opus-in-FLV ist seit FFmpeg 6.1 nativ unterstützt (Enhanced RTMP) — kein
//! Patch nötig.

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{ChannelLayout, Dictionary, Packet, Rational, codec, format, frame};
use std::collections::VecDeque;
use std::time::Instant;

use crate::audio::CapturedAudio;

/// Länge eines Opus-Pakets in Millisekunden.
///
/// **Wer hier am Ton dreht, dreht am BILD.** FLV/RTMP ist EINE Zeitleiste:
/// `av_interleaved_write_frame` gibt ein Videopaket erst frei, wenn Ton mit
/// passendem Zeitstempel vorliegt. Mit 20-ms-Paketen verlassen die Bilder den
/// Sender also in 20-ms-Bündeln — beim Zuschauer als Ruckeln sichtbar, obwohl
/// Bildzahl, Bitrate und Paketverlust tadellos aussehen.
///
/// 5 ms ist eine für Opus zulässige Länge (2,5/5/10/20/40/60). Kosten: mehr
/// Paket-Overhead auf einer 128-kbit/s-Spur — nichts gegen 25 Mbit/s Video.
/// Auf Linux ist das die Schraube, die gewirkt hat (`OPUS_FRAME_MS = 5` in
/// `streaming/linux-hq-sidecar/src/encode/audio.rs`), und sie wirkt an der
/// QUELLE: bei jeder Bildrate, ohne die Schreibreihenfolge zu gefährden. Der
/// Deckel `max_interleave_delta` (s. `output.rs`) begrenzt nur, was ein
/// Rückstand kostet.
///
/// **Das Raster der Aufnahme muss mitziehen**, sonst bringt es nichts: die
/// WASAPI-Chunk-Größe steht in den Pipelines auf demselben Wert
/// (`AudioCapture::start(src, 240)`); mit 21-ms-Chunks käme der Ton weiterhin
/// in 21-ms-Bündeln beim Muxer an, nur feiner zerlegt.
///
/// Über `PULSE_OPUS_FRAME_MS` veränderbar (nur ganze ms), damit die Wahl
/// messbar bleibt statt geraten zu werden.
const OPUS_FRAME_MS: usize = 5;

/// Chunk-Groesse der WASAPI-Aufnahme in Frames — dasselbe Raster wie ein
/// Opus-Paket (48 kHz fest, s. `AudioFormat::DEFAULT`).
///
/// Muss mitziehen, wenn [`OPUS_FRAME_MS`] sinkt: sonst kommt der Ton weiterhin
/// in 21-ms-Buendeln beim Muxer an, nur feiner zerlegt — und der Muxer gibt
/// die Bilder in genau diesen Buendeln frei.
pub fn capture_chunk_frames() -> usize {
    48 * opus_frame_ms()
}

/// Dieselbe Länge als [`Duration`]. Braucht jeder Sendeweg ohne Container:
/// dort trägt kein Zeitstempel die Paketlänge, sie muss mitgegeben werden
/// (s. `senke.rs`).
pub fn opus_frame_dauer() -> std::time::Duration {
    std::time::Duration::from_millis(opus_frame_ms() as u64)
}

/// Länge eines Opus-Pakets in ms, einmal aus der Umgebung gelesen.
pub fn opus_frame_ms() -> usize {
    static MS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *MS.get_or_init(|| {
        std::env::var("PULSE_OPUS_FRAME_MS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| [5, 10, 20, 40, 60].contains(v))
            .unwrap_or(OPUS_FRAME_MS)
    })
}

pub struct AudioPipeline {
    encoder: codec::encoder::Audio,
    /// Interleaved-FLT-Frame der direkt in den Encoder geht (libopus-Format).
    interleaved_frame: frame::Audio,
    /// Roh-Byte-FIFO — sammelt WASAPI-Chunks bis `frame_samples` erreicht sind.
    /// Bytes-Layout: f32 interleaved Stereo → 8 Bytes pro Frame.
    fifo: VecDeque<u8>,
    /// Samples je Kanal und Opus-Paket (= `sample_rate/1000 * `[`opus_frame_ms`]).
    frame_samples: usize,
    sample_rate: u32,
    channels: u16,
    block_align_in: usize,
    /// PTS für eingehende Frames (= an `send_frame` übergeben). Wächst pro
    /// Chunk um `frame_samples`.
    pts_samples: i64,
    /// PTS für ausgehende Packets (= zum Mux'er). Wird beim Drain bei jedem
    /// emittierten Packet um `frame_samples` erhöht. Brauchen wir separat zu `pts_samples`
    /// weil libopus' Output-Packet-PTS nicht zuverlässig propagiert wird.
    out_pts_samples: i64,
    /// Fester Trim-Offset in Samples (>0 = Audio später). Quelle: UI-Feld
    /// `av_offset_ms` im `start`-Request, Fallback `PULSE_HQ_AV_OFFSET_MS`.
    /// Für den konstanten Rest-Versatz nach der QPC-Verankerung.
    trim_samples: i64,
    pub stream_idx: usize,
    pub encoder_time_base: Rational,
    /// Stream-Timebase des Audio-Streams im Output-Container. Steht erst nach
    /// `output.write_header()` fest — der Caller setzt sie via
    /// `set_stream_time_base`, bevor das erste `send()` läuft.
    stream_time_base: Rational,
    /// Wall-clock-Ursprung der Stream-Timeline (= derselbe `Instant` wie der
    /// Video-PTS-Ursprung). Ist er gesetzt, wird der Audio-PTS beim ersten
    /// `send()` aus `captured_at - stream_origin` verankert — sonst (None)
    /// startet er bei 0 (Alt-Verhalten für die NVENC-/CPU-Pfade).
    stream_origin: Option<Instant>,
    /// QPC-Ursprung (100ns) = WGC-Hardware-Timestamp des ersten Video-Frames.
    /// Wenn gesetzt UND der Audio-Chunk einen QPC trägt, wird der PTS daran
    /// verankert (echte Aufnahmezeit beider Spuren auf derselben QPC-Uhr →
    /// exakter A/V-Offset); sonst Fallback auf den Instant-Anker oben.
    stream_origin_qpc: Option<i64>,
    /// Einmal-Flag: PTS-Origin wurde beim ersten `send()` festgenagelt.
    origin_set: bool,
    /// Einmal-Flag: der Ursprung steht auf einem echten Geräte-Zeitstempel und
    /// nicht mehr auf einer Stille-Füllung (s. `reanchor_on_first_device_stamp`).
    qpc_anchored: bool,
    /// Flankenzustand der Piep-Erkennung am Encoder-Eingang (nur Diagnose).
    probe_in_beep: bool,
    /// Nur fuer die Messung (`PULSE_MUX_LATENCY_LOG=1`): wann zuletzt der
    /// Rueckstand gemeldet wurde. `None` = Messung aus (s. `report_lag`).
    lag_report: Option<Instant>,
}

impl AudioPipeline {
    /// Erstellt den Audio-Encoder + Resampler und fügt einen neuen Stream zum
    /// `output`-Context hinzu. Muss VOR `output.write_header()` aufgerufen
    /// werden (Stream-Anlage modifiziert den Container-Header).
    /// `output` ist `None` für Sendewege **ohne Container** — die führen den
    /// Ton als eigene Spur statt als zweiten Stream in einer Datei
    /// (s. `senke.rs`). Dann entfallen Stream-Anlage und globaler Kopf; alles
    /// andere — Encoder, Sammelpuffer, Zeitverankerung, A/V-Trim — ist
    /// identisch. Deshalb EIN Einstieg mit `Option` und keine zweite Fassung:
    /// eine Kopie liefe bei der nächsten Änderung an der Verankerung
    /// auseinander, und ein Ton, der um Millisekunden verschoben ist, fällt in
    /// keinem Test auf.
    pub fn create(
        output: Option<&mut format::context::Output>,
        sample_rate: u32,
        channels: u16,
        bitrate_kbps: u32,
        av_offset_ms: i32,
    ) -> Result<Self> {
        if channels != 2 {
            // libopus unterstützt 1/2/3/4/5/6/8 Kanäle, aber Pulse streamt
            // hauptsächlich Stereo. Mono könnte später kommen.
            return Err(anyhow!(
                "audio: only stereo (2 channels) supported, got {channels}"
            ));
        }

        let codec_descriptor = codec::encoder::find_by_name("libopus")
            .ok_or_else(|| anyhow!("libopus encoder not registered in linked FFmpeg"))?;

        // Ohne Container: kein globaler Kopf (es gibt keinen, in den er
        // gehörte) und kein Stream-Index.
        let global_header = output
            .as_ref()
            .is_some_and(|o| o.format().flags().contains(format::Flags::GLOBAL_HEADER));

        let mut encoder = codec::context::Context::new_with_codec(codec_descriptor)
            .encoder()
            .audio()?;
        // libopus' encoder sample-fmt-list ist hardcoded auf nur AV_SAMPLE_FMT_FLT
        // (interleaved Float). Siehe `libavcodec/libopusenc.c::sample_fmts[]`.
        encoder.set_format(format::Sample::F32(format::sample::Type::Packed));
        encoder.set_rate(sample_rate as i32);
        encoder.set_channel_layout(ChannelLayout::STEREO);
        encoder.set_bit_rate((bitrate_kbps as usize).saturating_mul(1000));
        encoder.set_time_base(Rational::new(1, sample_rate as i32));

        if global_header {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }

        // Paketlaenge am Encoder setzen — OHNE das bleibt libopus bei seinen
        // 20 ms, und ein 240-Sample-Frame waere dann ein Teilframe.
        let frame_ms = opus_frame_ms();
        let mut opts = Dictionary::new();
        opts.set("frame_duration", &frame_ms.to_string());
        let opened = encoder.open_with(opts).context("open libopus encoder")?;
        let frame_samples = (sample_rate as usize / 1000) * frame_ms;
        // Stream erst JETZT anlegen: `set_parameters` braucht den geöffneten
        // Encoder, und ein Stream ohne Parameter im Container wäre ein Kopf,
        // den kein Abspieler lesen kann.
        let stream_idx = match output {
            Some(o) => {
                let mut stream = o.add_stream(codec_descriptor).context("add_stream audio")?;
                stream.set_parameters(&opened);
                stream.index()
            }
            None => 0,
        };

        let interleaved_frame = frame::Audio::new(
            format::Sample::F32(format::sample::Type::Packed),
            frame_samples,
            ChannelLayout::STEREO,
        );

        let encoder_time_base = Rational::new(1, sample_rate as i32);
        let block_align_in = (channels as usize) * 4; // F32 = 4 Bytes/Sample

        // Optionaler fester A/V-Trim (ms → Samples); >0 verschiebt Audio später.
        // Für den konstanten Rest-Versatz nach der QPC-Verankerung (Opus-Delay,
        // evtl. QPC-Epochen-Differenz). Quelle der Wahrheit ist der UI-Wert
        // (`av_offset_ms`, kommt im `start`-Request mit); ist er 0 (Default/UI
        // neutral), greift `PULSE_HQ_AV_OFFSET_MS` als Entwickler-Fallback.
        let offset_ms = if av_offset_ms != 0 {
            av_offset_ms as f64
        } else {
            std::env::var("PULSE_HQ_AV_OFFSET_MS")
                .ok()
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0)
        };
        let trim_samples = (offset_ms / 1000.0 * sample_rate as f64) as i64;

        // Stream-Timebase NICHT hier cachen: `output.write_header()` läuft erst
        // NACH `AudioPipeline::create`, bis dahin ist sie 0/0 (uninitialized) —
        // ein `rescale_ts` mit 0/0 als Ziel-Rational killt PTS+Duration auf
        // AV_NOPTS_VALUE (FFmpeg loggt dann „Packet with invalid duration …").
        // Der Caller liest sie nach `write_header` aus und setzt sie via
        // `set_stream_time_base`. Platzhalter = FLV-Default (1/1000 ms).
        Ok(Self {
            encoder: opened,
            interleaved_frame,
            fifo: VecDeque::with_capacity(frame_samples * block_align_in * 8),
            frame_samples,
            sample_rate,
            channels,
            block_align_in,
            pts_samples: 0,
            out_pts_samples: 0,
            trim_samples,
            stream_idx,
            encoder_time_base,
            stream_time_base: Rational::new(1, 1000),
            stream_origin: None,
            stream_origin_qpc: None,
            origin_set: false,
            qpc_anchored: false,
            probe_in_beep: false,
            lag_report: crate::env::flag("PULSE_MUX_LATENCY_LOG").then(Instant::now),
        })
    }

    /// Setzt die Stream-Timebase des Audio-Streams. MUSS nach
    /// `output.write_header()` und vor dem ersten `send()` aufgerufen werden.
    pub fn set_stream_time_base(&mut self, time_base: Rational) {
        self.stream_time_base = time_base;
    }

    /// Setzt den Wall-clock-Ursprung der Stream-Timeline (= Video-PTS-Origin).
    /// MUSS vor dem ersten `send()` gesetzt werden. Ohne diesen Aufruf startet
    /// der Audio-PTS bei 0 (Alt-Verhalten — kein A/V-Sync-Anker).
    pub fn set_stream_origin(&mut self, origin: Instant, origin_qpc: Option<i64>) {
        self.stream_origin = Some(origin);
        self.stream_origin_qpc = origin_qpc;
    }

    /// WASAPI-Chunk in den FIFO werfen + so viele Opus-Frames rauspushen wie
    /// gehen. Liefert die fertig encodeten Packets (Stream-Index + Timestamps
    /// gesetzt) zurück — der Caller schreibt sie raus (direkt oder via
    /// `MuxWriter`-Queue). Audio besitzt den Output-Context bewusst NICHT mehr.
    pub fn send(&mut self, captured: &CapturedAudio) -> Result<Vec<Packet>> {
        if captured.format.sample_rate != self.sample_rate
            || captured.format.channels != self.channels
        {
            return Err(anyhow!(
                "audio format mismatch: capture {}Hz/{}ch vs encoder {}Hz/{}ch",
                captured.format.sample_rate,
                captured.format.channels,
                self.sample_rate,
                self.channels
            ));
        }
        // Beim ersten Chunk den PTS-Origin am Wall-clock-Ursprung verankern.
        // `captured_at - stream_origin` ist der Versatz der Audio-Timeline-Null
        // gegenüber dem Video-PTS-Null → ohne das driften die Spuren auseinander.
        let anchored = self.anchor_samples(captured);
        if !self.origin_set {
            if let Some(s) = anchored {
                // KEIN .max(0): Audio, das VOR dem ersten Video-Frame aufgenommen
                // wurde (Capture-Vorlauf), bekommt negativen PTS und wird beim
                // Drain verworfen — statt auf pts 0 gestaucht zu werden, was die
                // ganze Spur nach vorn schöbe (Front-Loading → Ton vor Bild).
                // `trim_samples` verschiebt die Spur um den konstanten Rest.
                self.pts_samples = s + self.trim_samples;
                self.out_pts_samples = s + self.trim_samples;
            }
            self.origin_set = true;
        }
        self.reanchor_on_first_device_stamp(captured);
        self.probe_beep_pts(captured);
        self.report_lag(anchored);

        self.fifo.extend(&captured.bytes);

        let mut packets = Vec::new();
        let chunk_bytes = self.frame_samples * self.block_align_in;
        while self.fifo.len() >= chunk_bytes {
            self.encode_one_chunk(chunk_bytes, &mut packets)?;
        }
        Ok(packets)
    }

    /// Meldet, welchen PTS ein Prüfton-Piep beim EINTRITT in den Encoder bekommt
    /// (`PULSE_HQ_SYNC_PROBE=1`).
    ///
    /// Die Sonde am Geräte-Eingang (`syncprobe.rs`) sagt, wann der Piep
    /// aufgenommen wurde; der Empfänger sagt, wo er im Strom landet. Weichen
    /// beide ab, liegt der Verlust irgendwo dazwischen — und „dazwischen" ist
    /// genau diese Stufe. Ohne diesen Messpunkt bleibt nur Raten, auf welcher
    /// Seite der FIFO-Grenze der Versatz entsteht.
    fn probe_beep_pts(&mut self, captured: &CapturedAudio) {
        if !crate::syncprobe::enabled() {
            return;
        }
        let step = 4 * self.channels as usize;
        if step == 0 || captured.bytes.len() < step {
            return;
        }
        let mono: Vec<f32> = captured
            .bytes
            .chunks_exact(step)
            .map(|f| f32::from_le_bytes([f[0], f[1], f[2], f[3]]))
            .collect();
        let amp = crate::syncprobe::goertzel(&mono, 1000.0, self.sample_rate as f64);
        let ist_piep = amp > 0.1;
        if ist_piep && !self.probe_in_beep {
            eprintln!(
                "[sp] enc_beep pts_samples={} pts_ms={:.1}",
                self.pts_samples,
                self.pts_samples as f64 * 1000.0 / self.sample_rate as f64
            );
        }
        self.probe_in_beep = ist_piep;
    }

    /// Zieht den PTS-Ursprung einmalig auf den **Geräte**-Zeitstempel nach.
    ///
    /// **Warum das nötig ist.** Der Anker wird beim ersten Chunk gesetzt. Der
    /// erste Chunk ist aber nicht zwingend echter Ton: liefert die Audio-Engine
    /// beim Start noch nichts (stiller Desktop, oder das Gerät braucht seinen
    /// Moment), schiebt `audio/wasapi.rs` eine Stille-Füllung ein. Die trägt
    /// keinen Geräte-Zeitstempel (`qpc == 0`) → `anchor_samples` fällt auf die
    /// Wanduhr zurück → verankert wird an `captured_at - stream_origin`.
    ///
    /// Der Aufnahme-Thread startet jedoch **vor** dem Video-Ursprung
    /// (`AudioCapture::start` steht in allen drei Pipelines lange vor dem ersten
    /// Bild), also ist dieser Anker um die Rüstzeit zu klein — und der ganze Ton
    /// läuft dem Bild dauerhaft um diesen Betrag voraus. Am 2026-07-30 gegen die
    /// Aufnahme-Zeitstempel gemessen: **175 ms Vorlauf**, über 19 Prüfmarken auf
    /// ±0,2 ms konstant (Verfahren: `syncprobe.rs`).
    ///
    /// **Warum nur vorwärts.** Ein PTS-Rückschritt ist im Muxer nicht erlaubt.
    /// Der Fehlerfall ist ohnehin einseitig — die Stille verankert immer zu
    /// früh, nie zu spät —, und ein Sprung nach vorn reißt lediglich eine Lücke
    /// in eine Stille, die es real nie gab.
    ///
    /// **Warum die Stille nicht einfach verworfen wird.** Sie hält die
    /// Opus-Spur am Leben; ohne sie hängt der 2-Spur-Muxer bei stillem Desktop
    /// und der Push läuft in den `rw_timeout` (Begründung in `wasapi.rs`).
    fn reanchor_on_first_device_stamp(&mut self, captured: &CapturedAudio) {
        if self.qpc_anchored || captured.qpc == 0 {
            return;
        }
        let Some(origin_qpc) = self.stream_origin_qpc else {
            return;
        };
        self.qpc_anchored = true;
        let soll = ((captured.qpc as i64 - origin_qpc) as f64 / 10_000_000.0
            * self.sample_rate as f64) as i64
            + self.trim_samples;
        if soll <= self.pts_samples {
            return;
        }
        let sprung_ms = (soll - self.pts_samples) as f64 * 1000.0 / self.sample_rate as f64;
        self.pts_samples = soll;
        self.out_pts_samples = soll;
        eprintln!(
            "[audio] Ton-Anker auf den Geraete-Zeitstempel nachgezogen: +{sprung_ms:.1} ms \
             (davor stand er auf einer Stille-Fuellung)"
        );
    }

    /// Wanduhr-Position dieses Batches in Samples seit dem Video-PTS-Ursprung.
    ///
    /// HW-Timestamp-Anker bevorzugt: echte Aufnahmezeit beider Spuren auf
    /// derselben QPC-Uhr -> exakter A/V-Offset, ohne Kalibrierung. Fallback
    /// (QPC-Sync aus ODER beim Start noch kein Read -> qpc==0): Instant-Anker.
    ///
    /// Der Instant-Fallback rechnet MIT Vorzeichen — `saturating_duration_since`
    /// waere genau das `.max(0)`, das beim Verankern verboten ist: Audio-Chunks
    /// von VOR dem Origin (WASAPI startet vor dem ersten Video-Frame und
    /// puffert) wuerden auf „gleichzeitig" gestaucht und die ganze Spur um den
    /// Setup-Versatz nach vorn geschoben.
    fn anchor_samples(&self, captured: &CapturedAudio) -> Option<i64> {
        match (self.stream_origin_qpc, captured.qpc) {
            (Some(origin_qpc), q) if q != 0 => Some(
                ((q as i64 - origin_qpc) as f64 / 10_000_000.0 * self.sample_rate as f64) as i64,
            ),
            _ => self.stream_origin.map(|origin| {
                let secs = if captured.captured_at >= origin {
                    captured.captured_at.duration_since(origin).as_secs_f64()
                } else {
                    -origin.duration_since(captured.captured_at).as_secs_f64()
                };
                (secs * self.sample_rate as f64) as i64
            }),
        }
    }

    /// Meldet je Sekunde, wie weit die Ton-Zeitlinie hinter der Wanduhr
    /// herlaeuft (`PULSE_MUX_LATENCY_LOG=1`).
    ///
    /// **Warum diese Zahl zaehlt:** der FLV-Muxer haelt jedes BILD fest, bis Ton
    /// mit passendem Zeitstempel vorliegt — jede Millisekunde Rueckstand ist
    /// also Bild-Latenz (heute durch `max_interleave_delta` gedeckelt, s.
    /// `output.rs`), und der Ton laeuft dem Bild beim Zuschauer um denselben
    /// Betrag voraus.
    ///
    /// **Nur messen, nicht korrigieren — und das ist Absicht.** Der Linux-Zweig
    /// holt einen anhaltenden Rueckstand am Encoder ein
    /// (`PtsTimeline::align`), weil dort der PipeWire-Null-Sink einen festen
    /// Rueckstand von 27-29 ms einbrachte. Windows korrigiert an der QUELLE:
    /// `wasapi.rs` fuehrt ein Sample-Budget gegen die Wanduhr, schiebt fehlende
    /// Chunks als Stille ein und verwirft reale Chunks, die mehr als 100 ms
    /// vorauslaufen. Ob hier ueberhaupt ein Rueckstand entsteht, ist damit
    /// offen — und eine zweite Korrektur auf Verdacht einzubauen, waere genau
    /// die Aenderung, deren Wirkung man hinterher nicht mehr auseinanderhalten
    /// kann. Erst die Zahl, dann die Entscheidung.
    fn report_lag(&mut self, anchored: Option<i64>) {
        let (Some(anchor), Some(seit)) = (anchored, self.lag_report) else {
            return;
        };
        if seit.elapsed() < std::time::Duration::from_secs(1) {
            return;
        }
        self.lag_report = Some(Instant::now());
        let rueckstand_ms = (anchor - self.pts_samples) as f64 * 1000.0 / self.sample_rate as f64;
        eprintln!(
            "[audio] Ton-Zeitlinie {rueckstand_ms:.1} ms hinter der Wanduhr \
             (jede ms davon haelt der Muxer als Bild-Latenz fest)"
        );
    }

    fn encode_one_chunk(
        &mut self,
        chunk_bytes: usize,
        out: &mut Vec<Packet>,
    ) -> Result<()> {
        // FIFO-Front in den interleaved_frame kopieren (plane 0 hält die
        // gesamten Stereo-interleaved Bytes für F32-Packed).
        {
            let dst = self.interleaved_frame.data_mut(0);
            for (i, slot) in dst.iter_mut().take(chunk_bytes).enumerate() {
                *slot = self.fifo[i];
            }
        }
        self.fifo.drain(..chunk_bytes);

        self.interleaved_frame.set_pts(Some(self.pts_samples));
        self.pts_samples += self.frame_samples as i64;

        self.encoder
            .send_frame(&self.interleaved_frame)
            .context("audio encoder.send_frame")?;
        self.drain_packets(out)?;
        Ok(())
    }

    fn drain_packets(&mut self, out: &mut Vec<Packet>) -> Result<()> {
        loop {
            let mut packet = Packet::empty();
            // EAGAIN/EOF = nichts (mehr) da → Drain fertig; ECHTER Encoder-Fehler
            // wird propagiert statt verschluckt (#9).
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(e) => return Err(e.into()),
            }
            // PTS strikt aus unserem verankerten Sample-Counter (libopus'
            // Output-PTS ist nicht zuverlässig). Pre-Origin-Packets (negativer
            // PTS) werden VERWORFEN — nicht gemuxt, aber der Counter läuft weiter.
            let this_pts = self.out_pts_samples;
            self.out_pts_samples += self.frame_samples as i64;
            if this_pts < 0 {
                continue;
            }
            packet.set_pts(Some(this_pts));
            packet.set_dts(Some(this_pts));
            packet.set_duration(self.frame_samples as i64);
            packet.set_stream(self.stream_idx);
            packet.rescale_ts(self.encoder_time_base, self.stream_time_base);
            out.push(packet);
        }
        Ok(())
    }

    /// Flusht den Encoder (EOF) und liefert die restlichen Packets.
    pub fn flush(&mut self) -> Result<Vec<Packet>> {
        self.encoder.send_eof().context("audio send_eof")?;
        let mut out = Vec::new();
        self.drain_packets(&mut out)?;
        Ok(out)
    }
}
