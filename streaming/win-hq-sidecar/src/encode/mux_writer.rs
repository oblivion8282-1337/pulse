//! Async-Muxer-Writer — entkoppelt `write_interleaved` vom Pacing-Loop.
//!
//! **Problem** (per Trace-Analyse 2026-05-20 belegt): `write_interleaved`
//! schreibt synchron in den RTMPS-Socket. Bei jedem Keyframe (GOP = fps×2 →
//! alle 2 s) ist der I-Frame ein großer Byte-Burst; der sprengt den
//! OS-Send-Buffer, `write()` blockiert 90–150 ms. Weil Encode + Mux +
//! Socket-Write alle inline im Pacing-Loop liefen, fror der ganze Loop ein →
//! ~17 Frames wurden übersprungen → sichtbares Mikro-Stottern beim Viewer.
//!
//! **Lösung**: der Muxer (`AVFormatContext`) lebt auf einem eigenen Thread.
//! Der Pacing-Loop encodet nur noch und schiebt fertige Packets in eine
//! bounded Queue — der Writer-Thread schreibt sie raus. Ein Keyframe-Stall
//! staut sich jetzt in der Queue statt im Pacing-Loop; die Frame-Kadenz bleibt
//! stabil, die Queue leert sich in den ~1,85 s bis zum nächsten Keyframe
//! wieder (der Uplink reicht im Schnitt — es ist rein der Burst).

use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Packet, format};

/// Queue-Tiefe. Muss einen Keyframe-Burst absorbieren (~150 ms Socket-Stall ≈
/// 18 Video-Frames bei 120 fps + Audio). 256 ≈ 2 s Video bei 120 fps —
/// großzügig; bei einem echten >2 s-Netzwerk-Ausfall greift Backpressure
/// (Producer-`send` blockiert), was der `rw_timeout` (10 s) sauber auflöst.
const QUEUE_CAPACITY: usize = 256;

/// `ffmpeg::Packet` ist nicht `Send` (ffmpeg-next markiert es konservativ
/// nicht). Die Thread-Übergabe hier ist trotzdem sound: der Packet wird auf
/// dem Pacing-Thread erzeugt, per *move* über den Channel an genau einen
/// Writer-Thread übergeben und dort konsumiert — kein Aliasing, kein
/// geteilter Zugriff. Der `AVBufferRef`-Refcount im Packet ist atomar.
struct SendPacket(Packet);
unsafe impl Send for SendPacket {}

/// Analog für den `Output`-Context: einmalig per *move* an den Writer-Thread,
/// danach kein Zugriff mehr vom Erzeuger-Thread.
struct SendOutput(format::context::Output);
unsafe impl Send for SendOutput {}

pub struct MuxWriter {
    tx: Option<SyncSender<SendPacket>>,
    worker: Option<JoinHandle<Result<()>>>,
    /// Fehlergrund des Writer-Threads, BEVOR sein JoinHandle eingesammelt ist.
    /// Nötig, weil `send()` einen toten Writer nur als Kanal-Disconnect sieht —
    /// und der Fehlerpfad der Pipeline `finish()` (das echte Join) nie
    /// erreicht: Der User bekäme sonst bei jedem mid-stream Netzwerkabriss
    /// nur „mux-writer thread is gone" statt der tatsächlichen Ursache.
    fail_msg: Arc<Mutex<Option<String>>>,
}

impl MuxWriter {
    /// Übernimmt den fertig konfigurierten Output-Context (`write_header`
    /// bereits gelaufen, alle Streams angelegt) und startet den Writer-Thread.
    pub fn start(output: format::context::Output) -> Result<Self> {
        let (tx, rx) = sync_channel::<SendPacket>(QUEUE_CAPACITY);
        let out = SendOutput(output);
        let fail_msg: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let fail_slot = Arc::clone(&fail_msg);
        let worker = thread::Builder::new()
            .name("mux-writer".into())
            .spawn(move || -> Result<()> {
                let mut output = out.0;
                for pkt in rx {
                    if let Err(e) = pkt.0.write_interleaved(&mut output) {
                        eprintln!("[mux-writer] write_interleaved failed: {e:#}");
                        if let Ok(mut slot) = fail_slot.lock() {
                            *slot = Some(format!("{e:#}"));
                        }
                        return Err(e).context("mux-writer: write_interleaved");
                    }
                }
                // Channel geschlossen = EOF → Trailer schreiben (RTMP/TLS
                // sauber zu). Der anschließende Drop von `output` ist reines
                // Userspace-/Netzwerk-Aufräumen (AVFormatContext-Free +
                // Socket-Close) — kein GPU-Teardown, also unbedenklich (anders
                // als der NVENC-/D3D11-/Audio-Client-Teardown, der weiter
                // bewusst per `mem::forget` umgangen wird).
                output
                    .write_trailer()
                    .context("mux-writer: write_trailer")?;
                Ok(())
            })
            .context("spawn mux-writer thread")?;
        Ok(Self { tx: Some(tx), worker: Some(worker), fail_msg })
    }

    /// Schiebt ein fertiges Packet (Stream-Index gesetzt, Timestamps in
    /// Stream-Timebase rescaled) in die Queue. Blockiert nur, wenn die Queue
    /// voll ist (= Writer hängt an einem toten Socket) — der Backpressure
    /// staut sich dann bis zum `rw_timeout`.
    pub fn send(&self, packet: Packet) -> Result<()> {
        match &self.tx {
            Some(tx) => tx.send(SendPacket(packet)).map_err(|_| {
                // Writer tot → echten Grund aus dem Slot ziehen (s. `fail_msg`).
                let cause = self
                    .fail_msg
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone())
                    .unwrap_or_else(|| "thread beendet ohne hinterlegten Grund".into());
                anyhow!("mux-writer failed: {cause}")
            }),
            None => Err(anyhow!("mux-writer already finished")),
        }
    }

    /// Schließt die Queue, wartet auf den Writer-Thread (der den FLV-Trailer
    /// schreibt = RTMP sauber beendet) und propagiert dessen Ergebnis.
    pub fn finish(&mut self) -> Result<()> {
        self.tx = None; // Sender droppen → Writer-Loop endet auf EOF
        match self.worker.take() {
            Some(w) => match w.join() {
                Ok(result) => result,
                Err(_) => Err(anyhow!("mux-writer thread panicked")),
            },
            None => Ok(()),
        }
    }
}
