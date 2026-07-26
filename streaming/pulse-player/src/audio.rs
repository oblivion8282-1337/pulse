//! Tonausgabe: Opus dekodieren, auf die Geraeterate bringen, ausgeben.
//!
//! Aufbau, und warum er so aussieht:
//!
//! * `cpal::Stream` ist auf mehreren Plattformen **nicht** `Send`. Er kann
//!   deshalb nicht in der Tokio-Sitzung liegen. Stattdessen laeuft die Ausgabe
//!   auf einem eigenen Thread, der den Stream besitzt; gefuettert wird ueber
//!   einen Kanal.
//! * Zwischen Decode und Geraete-Callback liegt ein Ringpuffer. Der Callback
//!   darf nicht blockieren und nicht allokieren — er kopiert nur heraus und
//!   fuellt bei Unterlauf Stille auf.
//! * `av_offset_ms` wird als Ziel-Fuellstand des Rings umgesetzt: mehr Puffer
//!   heisst spaeterer Ton. Das ist grob, aber ehrlich — eine echte
//!   Zeitstempel-Synchronisierung braeuchte eine gemeinsame Uhr mit dem
//!   Videopfad, die es hier noch nicht gibt.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context as _, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ffmpeg_next as ffmpeg;

/// Obergrenze des Rings. Laeuft die Wiedergabe davon, ist der Ton ohnehin
/// verloren — dann lieber verwerfen als unbegrenzt Speicher fressen.
const MAX_RING_SAMPLES: usize = 48_000 * 2 * 4; // ~4 s Stereo bei 48 kHz

/// Steuerbefehle an den Ausgabe-Thread.
enum AudioCommand {
    Pcm(Vec<f32>),
    Volume(f32),
    OffsetMs(i32),
    Stop,
}

struct Shared {
    ring: VecDeque<f32>,
    volume: f32,
    /// Gewuenschter Fuellstand in Samples, bevor ausgegeben wird.
    target_fill: usize,
    underruns: u64,
    dropped: u64,
}

/// Geraete-Callback. Laeuft im Echtzeit-Kontext: nicht blockieren, nicht
/// allokieren — nur aus dem Ring kopieren und bei Unterlauf Stille auffuellen.
fn fill_output(shared: &Mutex<Shared>, out: &mut [f32]) {
    let Ok(mut s) = shared.lock() else {
        out.fill(0.0);
        return;
    };
    // Erst anlaufen lassen, wenn der Zielfuellstand da ist — sonst startet die
    // Wiedergabe direkt mit Unterlauf.
    if s.ring.len() < s.target_fill {
        out.fill(0.0);
        return;
    }
    let volume = s.volume;
    let written = s.ring.len().min(out.len());
    for (slot, v) in out.iter_mut().zip(s.ring.drain(..written)) {
        *slot = (v * volume).clamp(-1.0, 1.0);
    }
    out[written..].fill(0.0);
    if written < out.len() {
        s.underruns += 1;
    }
}

/// Nimmt Befehle entgegen, bis der Sender weg ist oder `Stop` kommt.
/// `per_ms` = Samples je Millisekunde ueber alle Kanaele.
fn pump_commands(
    rx: &std::sync::mpsc::Receiver<AudioCommand>,
    shared: &Mutex<Shared>,
    per_ms: usize,
) {
    while let Ok(cmd) = rx.recv() {
        let Ok(mut s) = shared.lock() else { break };
        match cmd {
            AudioCommand::Pcm(samples) => {
                let total = s.ring.len() + samples.len();
                if total > MAX_RING_SAMPLES {
                    // Aelteste Daten weg — die sind ohnehin zu spaet.
                    let drop_n = (total - MAX_RING_SAMPLES).min(s.ring.len());
                    s.ring.drain(..drop_n);
                    s.dropped += drop_n as u64;
                }
                s.ring.extend(samples);
            }
            AudioCommand::Volume(v) => s.volume = v,
            AudioCommand::OffsetMs(ms) => {
                // Positiv = Ton spaeter = mehr Vorlauf im Ring.
                s.target_fill = (ms.max(0) as usize) * per_ms;
                if ms < 0 {
                    // Negativ = Ton frueher: vorhandenen Vorlauf kappen.
                    let n = ((-ms) as usize * per_ms).min(s.ring.len());
                    s.ring.drain(..n);
                }
            }
            AudioCommand::Stop => break,
        }
    }
}

/// Griff auf die laufende Ausgabe. Beim Fallenlassen endet der Thread.
pub struct AudioOutput {
    tx: std::sync::mpsc::Sender<AudioCommand>,
    shared: Arc<Mutex<Shared>>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl AudioOutput {
    /// Oeffnet das Standard-Ausgabegeraet. Schlaegt das fehl, ist das kein
    /// Grund, die Sitzung zu beenden — der Aufrufer laeuft dann stumm weiter.
    pub fn new() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| anyhow!("kein Standard-Ausgabegeraet"))?;
        let supported = device
            .default_output_config()
            .context("Standard-Ausgabeformat nicht abfragbar")?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels();
        let config: cpal::StreamConfig = supported.into();

        let shared = Arc::new(Mutex::new(Shared {
            ring: VecDeque::new(),
            volume: 1.0,
            target_fill: 0,
            underruns: 0,
            dropped: 0,
        }));
        let (tx, rx) = std::sync::mpsc::channel::<AudioCommand>();

        let cb_shared = Arc::clone(&shared);
        let thread_shared = Arc::clone(&shared);
        let per_ms = (sample_rate as usize * channels as usize) / 1000;

        // Der Stream lebt auf diesem Thread und stirbt mit ihm.
        std::thread::Builder::new()
            .name("pulse-player-audio".into())
            .spawn(move || {
                let stream = device.build_output_stream(
                    &config,
                    move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        fill_output(&cb_shared, out);
                    },
                    |err| eprintln!("pulse-player: Audio-Stream: {err}"),
                    None,
                );
                let stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("pulse-player: Ausgabestrom liess sich nicht bauen: {e}");
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    eprintln!("pulse-player: Ausgabe startet nicht: {e}");
                    return;
                }
                pump_commands(&rx, &thread_shared, per_ms);
            })
            .context("Audio-Thread liess sich nicht starten")?;

        Ok(Self { tx, shared, sample_rate, channels })
    }

    pub fn push(&self, samples: Vec<f32>) {
        if samples.is_empty() {
            return;
        }
        let _ = self.tx.send(AudioCommand::Pcm(samples));
    }

    pub fn set_volume(&self, v: f32) {
        let _ = self.tx.send(AudioCommand::Volume(v.clamp(0.0, 4.0)));
    }

    pub fn set_offset_ms(&self, ms: i32) {
        let _ = self.tx.send(AudioCommand::OffsetMs(ms.clamp(-2000, 2000)));
    }

    /// (Unterlaeufe, verworfene Samples, aktueller Fuellstand) fuer die Statistik.
    pub fn counters(&self) -> (u64, u64, usize) {
        self.shared
            .lock()
            .map(|s| (s.underruns, s.dropped, s.ring.len()))
            .unwrap_or((0, 0, 0))
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        let _ = self.tx.send(AudioCommand::Stop);
    }
}

/// Opus-Dekoder samt Umrechnung auf das Format des Ausgabegeraets.
pub struct OpusDecoder {
    decoder: ffmpeg::decoder::Audio,
    resampler: Option<ffmpeg::software::resampling::Context>,
    out_rate: u32,
    out_channels: u16,
}

impl OpusDecoder {
    pub fn new(out_rate: u32, out_channels: u16) -> Result<Self> {
        ffmpeg::init().ok();
        let codec = ffmpeg::decoder::find_by_name("libopus")
            .or_else(|| ffmpeg::decoder::find_by_name("opus"))
            .ok_or_else(|| anyhow!("kein Opus-Decoder in diesem FFmpeg-Build"))?;

        let mut context = ffmpeg::codec::context::Context::new_with_codec(codec);
        // Opus ueber RTP ist immer 48 kHz; die Kanalzahl steht im TOC-Byte, der
        // Decoder braucht aber eine gesetzte Ausgangs-Konfiguration. ffmpeg-next
        // hat dafuer keinen sicheren Setter — deshalb direkt am Kontext.
        unsafe {
            let ptr = context.as_mut_ptr();
            (*ptr).sample_rate = 48_000;
            ffmpeg::ffi::av_channel_layout_default(&raw mut (*ptr).ch_layout, 2);
        }
        let decoder = context.decoder().audio().context("Opus-Decoder oeffnen")?;

        Ok(Self { decoder, resampler: None, out_rate, out_channels })
    }

    /// Dekodiert ein Opus-Paket und liefert verschraenkte f32-Samples in der
    /// Rate und Kanalzahl des Ausgabegeraets.
    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<f32>> {
        let pkt = ffmpeg::codec::packet::Packet::copy(packet);
        if let Err(e) = self.decoder.send_packet(&pkt) {
            // Ein kaputtes Paket nach einer Luecke darf den Ton nicht beenden.
            eprintln!("pulse-player: Opus send_packet: {e}");
            return Ok(Vec::new());
        }

        let mut out = Vec::new();
        let mut frame = ffmpeg::util::frame::audio::Audio::empty();
        while self.decoder.receive_frame(&mut frame).is_ok() {
            let converted = self.resample_for_device(&frame)?;
            out.extend_from_slice(&converted);
        }
        Ok(out)
    }

    fn resample_for_device(&mut self, frame: &ffmpeg::util::frame::audio::Audio) -> Result<Vec<f32>> {
        use ffmpeg::util::format::sample::{Sample, Type};

        let target_layout =
            ffmpeg::util::channel_layout::ChannelLayout::default(self.out_channels.into());
        let target_format = Sample::F32(Type::Packed);

        if self.resampler.is_none() {
            self.resampler = Some(
                ffmpeg::software::resampling::Context::get(
                    frame.format(),
                    frame.channel_layout(),
                    frame.rate(),
                    target_format,
                    target_layout,
                    self.out_rate,
                )
                .context("Resampler")?,
            );
        }
        let resampler = self.resampler.as_mut().expect("gerade gesetzt");

        let mut converted = ffmpeg::util::frame::audio::Audio::empty();
        resampler.run(frame, &mut converted).context("Resampling")?;

        // Verschraenktes f32: eine Ebene, alle Kanaele nacheinander.
        let samples = converted.samples() * self.out_channels as usize;
        Ok(converted.plane::<f32>(0)[..samples].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Opus-Decoder muss auf jeder Maschine oeffnen — sonst waere der
    /// Tonpfad von der FFmpeg-Konfiguration abhaengig, ohne es zu merken.
    #[test]
    fn opus_decoder_laesst_sich_oeffnen() {
        let d = OpusDecoder::new(48_000, 2);
        assert!(d.is_ok(), "Opus-Decoder fehlt: {:?}", d.err());
    }

    /// Muell darf nicht panisch werden — nach einer Luecke kommen kaputte Pakete.
    #[test]
    fn kaputtes_paket_beendet_den_decoder_nicht() {
        let mut d = OpusDecoder::new(48_000, 2).expect("Decoder");
        let out = d.decode(&[0xFF, 0x00, 0x13, 0x37]);
        assert!(out.is_ok(), "kaputtes Paket darf keinen Fehler werfen");
    }
}
