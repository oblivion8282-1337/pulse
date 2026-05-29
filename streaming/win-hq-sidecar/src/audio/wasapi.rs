//! WASAPI-Capture-Worker für alle vier Audio-Modi.
//!
//! Architektur analog `capture/wgc.rs`: ein Worker-Thread pollt WASAPI-Events,
//! liest Frames in eine `VecDeque<u8>`, schneidet sie in Chunks und sendet
//! `CapturedAudio` per `mpsc::sync_channel` raus. Drop = Stop.
//!
//! Format ist hardcoded auf **32-bit Float, 48 kHz, stereo, interleaved** —
//! das mag FFmpeg-Opus direkt und entspricht der Default-Win11-Audio-Engine.
//! `autoconvert: true` zwingt WASAPI bei Geräten mit anderem Native-Format zu
//! konvertieren (z.B. ein 44.1k-Audio-Interface wird zu 48k upsampled). Ohne
//! das Flag würde `initialize_client` mit AUDCLNT_E_UNSUPPORTED_FORMAT
//! abbrechen.

use anyhow::{Context, Result, anyhow};
use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, Sender, SyncSender, TrySendError, channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

use super::source::AudioSource;

/// PCM-Format der Capture-Pipeline. Festgenagelt — der Encoder kommt damit klar.
#[derive(Debug, Clone, Copy)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    /// Bits pro Sample (32 = float).
    pub bits_per_sample: u16,
}

impl AudioFormat {
    pub const DEFAULT: Self = Self { sample_rate: 48_000, channels: 2, bits_per_sample: 32 };

    pub fn block_align(&self) -> u16 {
        self.channels * (self.bits_per_sample / 8)
    }
}

/// Ein Chunk PCM-Samples (interleaved). Bytes-Layout matches `AudioFormat`.
///
/// Encoder konvertiert in `&[f32]` per `bytemuck::cast_slice` o.ä. — Stage 7.
#[derive(Debug)]
pub struct CapturedAudio {
    pub format: AudioFormat,
    /// Roh-PCM, `frames * block_align` Bytes. Für 32-bit-Float-Stereo ist das
    /// `frames * 8`.
    pub bytes: Vec<u8>,
    /// Anzahl Frames (= Samples pro Channel).
    pub frames: u32,
    /// Wall-clock-Stempel (monotone Uhr) beim Emittieren des Chunks. Fallback-
    /// Anker, wenn keine Hardware-Timestamps verfügbar sind (s. `AudioPipeline`).
    pub captured_at: Instant,
    /// WASAPI-Hardware-Capture-Timestamp (QPC, 100ns) des ERSTEN gelesenen
    /// Samples des Streams (`BufferInfo.timestamp` des ersten Reads); `0` bis ein
    /// echter Read passiert ist. Verankert den Audio-PTS an der echten
    /// Aufnahmezeit auf derselben QPC-Uhr wie der WGC-Video-Timestamp.
    pub qpc: u64,
}

/// Living capture-handle. Drop = stop.
pub struct AudioCapture {
    pub samples: Receiver<CapturedAudio>,
    stop_tx: Sender<()>,
    worker: Option<JoinHandle<Result<(), String>>>,
    format: AudioFormat,
}

impl AudioCapture {
    /// Startet die Capture. `chunk_frames` ist die Frames-pro-Chunk-Granularität
    /// (kleiner = weniger Latenz, höher = weniger Channel-Sends). 1024 @ 48kHz =
    /// ~21ms Chunks — guter Default.
    pub fn start(source: AudioSource, chunk_frames: usize) -> Result<Self> {
        let format = AudioFormat::DEFAULT;
        let (tx, rx) = std::sync::mpsc::sync_channel::<CapturedAudio>(8);
        let (stop_tx, stop_rx) = channel();

        let src = source.clone();
        let worker = thread::Builder::new()
            .name("wasapi-capture".into())
            .spawn(move || -> Result<(), String> {
                match run_capture(src, format, chunk_frames, tx, stop_rx) {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        eprintln!("[wasapi-capture] worker failed: {e:#}");
                        Err(format!("{e:#}"))
                    }
                }
            })
            .context("spawn wasapi-capture thread")?;

        Ok(Self {
            samples: rx,
            stop_tx,
            worker: Some(worker),
            format,
        })
    }

    pub fn format(&self) -> AudioFormat {
        self.format
    }

    pub fn stop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

// ── Worker-Thread ───────────────────────────────────────────────────────────

/// Sendet einen Chunk, blockiert dabei aber NICHT unkündbar: ist der
/// `SyncSender` voll (der Consumer drained gerade nicht), wird in kurzen
/// Abständen erneut versucht und zwischendurch `stop_rx` geprüft. Liefert
/// `false`, wenn der Consumer weg ist oder Stop signalisiert wurde — der Worker
/// soll dann abbrechen. Ohne das könnte ein blockierendes `send` bei vollem
/// Channel den Worker festnageln → `stop()`/`join()` deadlockt (#10).
fn send_or_stop(
    tx: &SyncSender<CapturedAudio>,
    stop_rx: &Receiver<()>,
    mut item: CapturedAudio,
) -> bool {
    loop {
        match tx.try_send(item) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(returned)) => {
                if stop_rx.try_recv().is_ok() {
                    return false;
                }
                item = returned;
                thread::sleep(Duration::from_millis(2));
            }
        }
    }
}

fn run_capture(
    source: AudioSource,
    format: AudioFormat,
    chunk_frames: usize,
    tx: SyncSender<CapturedAudio>,
    stop_rx: Receiver<()>,
) -> Result<()> {
    // `initialize_mta()` gibt einen windows-rs HRESULT zurück; `.ok()` macht
    // daraus ein `Result<(), windows::core::Error>` das wir mit `anyhow::Context`
    // dann „normal" propagieren.
    initialize_mta()
        .ok()
        .context("CoInitializeEx(MTA) failed")?;

    let wf = WaveFormat::new(
        format.bits_per_sample as usize,
        format.bits_per_sample as usize,
        &SampleType::Float,
        format.sample_rate as usize,
        format.channels as usize,
        None,
    );

    let mut audio_client = open_audio_client(&source)?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0, // use device default
    };
    // Loopback-Magie: für DefaultDesktop geben wir ein Render-Device hinein,
    // sagen `Direction::Capture` → wasapi-rs setzt AUDCLNT_STREAMFLAGS_LOOPBACK.
    // Application-Loopback ist schon im Render-Path eingebaut, braucht ebenfalls
    // Direction::Capture + Shared (per Crate-Doku).
    audio_client
        .initialize_client(&wf, &Direction::Capture, &mode)
        .with_context(|| format!("initialize_client for {source:?}"))?;

    let h_event = audio_client
        .set_get_eventhandle()
        .context("set_get_eventhandle")?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .context("get_audiocaptureclient")?;

    let block_align = format.block_align() as usize;
    let chunk_bytes = chunk_frames * block_align;
    let mut queue: VecDeque<u8> = VecDeque::with_capacity(chunk_bytes * 4);

    audio_client.start_stream().context("start_stream")?;

    // Stille-Fill nach Sample-Budget. Desktop-Loopback liefert NICHTS, wenn die
    // Audio-Engine idle ist (stiller Desktop) — entgegen der früheren Annahme
    // kommen keine Silence-Frames. Ohne Gegenmaßnahme verhungert die FLV-Opus-
    // Spur und der 2-Stream-Muxer stockt (`av_interleaved_write_frame` puffert
    // ewig → kein Push → `rw_timeout`).
    //
    // `emitted_frames` zählt ALLE emittierten Frames (real + Stille). Stille
    // wird nur eingeschoben, wenn ein GANZER Chunk gegenüber der Wall-Clock
    // fehlt. Fließt echtes Audio in Echtzeit, deckt der Sub-Chunk-Rest in der
    // Queue den Verzug ab → die Bilanz holt nie einen vollen Chunk Rückstand
    // ein → es wird KEINE Stille zwischen reale Samples gestottert. Ein früher
    // Timer-Ansatz (Schwelle == realer Chunk-Takt) tat genau das.
    let started = Instant::now();
    let mut emitted_frames: u64 = 0;
    let mut should_stop = false;
    // Vorlauf-Budget für die Drift-Korrektur (#2): ~100 ms. Erst darüber wird
    // ein realer Chunk verworfen — groß genug, dass normale Jitter/Bursts
    // keinen Drop auslösen, nur echte Fast-Clock-Drift der Audio-Geräte-Clock.
    let ahead_limit = (format.sample_rate / 10) as u64;
    // QPC (100ns) des allerersten gelesenen Samples — Audio-Stream-Ursprung für
    // die HW-Timestamp-Verankerung. 0, bis ein echter Read passiert ist.
    let mut first_read_qpc: u64 = 0;
    loop {
        if stop_rx.try_recv().is_ok() {
            should_stop = true;
        }

        // Reale Chunks rauspushen, solange genug Samples gepuffert sind.
        while queue.len() >= chunk_bytes {
            // Bidirektionale Drift-Korrektur (#2): liegt die emittierte Menge
            // mehr als `ahead_limit` vor der wall-clock-fälligen, verwerfen wir
            // reale Chunks statt sie zu emittieren — sonst driftet Audio
            // unbegrenzt VOR das Bild (Fast-Clock-Drift). Gegenstück zur
            // Silence-Fill weiter unten (die Rückstand auffüllt).
            let owed = (started.elapsed().as_secs_f64() * format.sample_rate as f64) as u64;
            if emitted_frames > owed + ahead_limit {
                queue.drain(..chunk_bytes);
                continue;
            }
            let mut chunk = vec![0u8; chunk_bytes];
            for slot in chunk.iter_mut() {
                *slot = queue.pop_front().unwrap();
            }
            let captured = CapturedAudio {
                format,
                bytes: chunk,
                frames: chunk_frames as u32,
                captured_at: Instant::now(),
                qpc: first_read_qpc,
            };
            if !send_or_stop(&tx, &stop_rx, captured) {
                should_stop = true;
                break;
            }
            emitted_frames += chunk_frames as u64;
        }
        if should_stop {
            break;
        }

        // Stille-Fill: nur ganze Chunks, die gegenüber der Wall-Clock fehlen.
        let owed = (started.elapsed().as_secs_f64() * format.sample_rate as f64) as u64;
        while queue.len() < chunk_bytes && emitted_frames + chunk_frames as u64 <= owed {
            let silence = CapturedAudio {
                format,
                bytes: vec![0u8; chunk_bytes],
                frames: chunk_frames as u32,
                captured_at: Instant::now(),
                qpc: first_read_qpc,
            };
            if !send_or_stop(&tx, &stop_rx, silence) {
                should_stop = true;
                break;
            }
            emitted_frames += chunk_frames as u64;
        }
        if should_stop {
            break;
        }

        // Neuen Block vom Device einlesen wenn da was ist.
        match capture_client.get_next_packet_size() {
            Ok(Some(frames)) if frames > 0 => {
                let need = frames as usize * block_align;
                if queue.capacity() - queue.len() < need {
                    queue.reserve(need);
                }
                let info = capture_client
                    .read_from_device_to_deque(&mut queue)
                    .context("read_from_device_to_deque")?;
                // QPC des ersten je gelesenen Samples = Audio-Stream-Ursprung.
                if first_read_qpc == 0 {
                    first_read_qpc = info.timestamp;
                }
            }
            Ok(_) => {}
            Err(e) => {
                return Err(anyhow!("get_next_packet_size: {e}"));
            }
        }

        // Kurzer Wait — klein genug, dass die Stille-Fill ihre ~21ms-Kadenz
        // hält (früher 1s, was den Fill bei idler Audio-Engine verzögerte).
        let _ = h_event.wait_for_event(8);
    }

    let _ = audio_client.stop_stream();
    Ok(())
}

fn open_audio_client(source: &AudioSource) -> Result<AudioClient> {
    match source {
        AudioSource::DefaultDesktop => {
            // Render-Device → Direction::Render. Direction-Bias zum LOOPBACK-Flag
            // kommt erst beim initialize_client.
            let enumerator = wasapi::DeviceEnumerator::new().context("DeviceEnumerator::new")?;
            let device = enumerator
                .get_default_device(&Direction::Render)
                .context("get_default_device(Render)")?;
            device.get_iaudioclient().context("get_iaudioclient")
        }
        AudioSource::DefaultMicrophone => {
            let enumerator = wasapi::DeviceEnumerator::new().context("DeviceEnumerator::new")?;
            let device = enumerator
                .get_default_device(&Direction::Capture)
                .context("get_default_device(Capture)")?;
            device.get_iaudioclient().context("get_iaudioclient")
        }
        AudioSource::DesktopPlusMicrophone => {
            // Mixing-Path braucht zwei AudioClients gleichzeitig + einen Mixer-
            // Thread. Day-4-Spike fängt mit der primären Quelle (Desktop) an;
            // Mikrofon-Add kommt mit dem Encoder-Mixer in Stage 7.
            Err(anyhow!(
                "AudioSource::DesktopPlusMicrophone not yet wired (needs Stage-7 mixer)"
            ))
        }
        AudioSource::Application { pid, include_tree } => {
            AudioClient::new_application_loopback_client(*pid, *include_tree)
                .map_err(|e| anyhow!("new_application_loopback_client(pid={pid}): {e}"))
        }
    }
}

