//! Async muxer-writer — decouples `write_interleaved` from the pacing loop.
//!
//! Ported verbatim from `streaming/win-hq-sidecar/src/encode/mux_writer.rs`
//! (platform-agnostic). The muxer (`AVFormatContext`) lives on its own thread;
//! the pacing loop only encodes and pushes finished packets into a bounded
//! queue. A keyframe socket-stall then backs up in the queue instead of
//! freezing the capture/encode cadence.

use std::sync::mpsc::{SyncSender, sync_channel};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result, anyhow};
use ffmpeg_next as ffmpeg;
use ffmpeg::{Packet, format};

/// Queue depth — must absorb a keyframe burst without blocking the encoder.
/// On a real >2s network outage the producer `send` blocks (backpressure),
/// which the muxer's `rw_timeout` (10s) resolves cleanly.
const QUEUE_CAPACITY: usize = 256;

/// `ffmpeg::Packet` isn't `Send` (ffmpeg-next marks it conservatively). The
/// hand-off is sound: the packet is created on the pacing thread, *moved* over
/// the channel to exactly one writer thread and consumed there — no aliasing,
/// no shared access. The `AVBufferRef` refcount is atomic.
struct SendPacket(Packet);
// SAFETY: see above.
unsafe impl Send for SendPacket {}

/// Same for the `Output` context: moved once to the writer thread, never
/// touched by the producer afterwards.
struct SendOutput(format::context::Output);
// SAFETY: see above.
unsafe impl Send for SendOutput {}

pub struct MuxWriter {
    tx: Option<SyncSender<SendPacket>>,
    worker: Option<JoinHandle<Result<()>>>,
}

impl MuxWriter {
    /// Takes the fully-configured output context (`write_header` already run,
    /// all streams added) and starts the writer thread.
    pub fn start(output: format::context::Output) -> Result<Self> {
        let (tx, rx) = sync_channel::<SendPacket>(QUEUE_CAPACITY);
        let out = SendOutput(output);
        let worker = thread::Builder::new()
            .name("mux-writer".into())
            .spawn(move || -> Result<()> {
                let mut output = out.0;
                for pkt in rx {
                    if let Err(e) = pkt.0.write_interleaved(&mut output) {
                        eprintln!("[mux-writer] write_interleaved failed: {e:#}");
                        return Err(e).context("mux-writer: write_interleaved");
                    }
                    // Push the bytes onto the wire after every packet (live
                    // low-latency). AVFMT_FLAG_FLUSH_PACKETS is unreliable for the
                    // FLV/RTMP path, so flush the AVIO context explicitly.
                    unsafe {
                        let ctx = output.as_mut_ptr();
                        let pb = (*ctx).pb;
                        if !pb.is_null() {
                            ffmpeg::ffi::avio_flush(pb);
                        }
                    }
                }
                // Channel closed = EOF → write the FLV trailer (clean RTMP/TLS close).
                output.write_trailer().context("mux-writer: write_trailer")?;
                Ok(())
            })
            .context("spawn mux-writer thread")?;
        Ok(Self { tx: Some(tx), worker: Some(worker) })
    }

    /// Push a finished packet (stream index set, timestamps rescaled to the
    /// stream timebase). Blocks only when the queue is full (= writer stuck on a
    /// dead socket); the backpressure then resolves via `rw_timeout`.
    pub fn send(&self, packet: Packet) -> Result<()> {
        match &self.tx {
            Some(tx) => tx
                .send(SendPacket(packet))
                .map_err(|_| anyhow!("mux-writer thread is gone")),
            None => Err(anyhow!("mux-writer already finished")),
        }
    }

    /// Close the queue, wait for the writer thread (which writes the FLV trailer)
    /// and propagate its result.
    pub fn finish(&mut self) -> Result<()> {
        self.tx = None; // drop sender → writer loop ends on EOF
        match self.worker.take() {
            Some(w) => match w.join() {
                Ok(result) => result,
                Err(_) => Err(anyhow!("mux-writer thread panicked")),
            },
            None => Ok(()),
        }
    }
}
