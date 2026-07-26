//! Eine Wiedergabe-Sitzung: WHEP -> Jitter-Puffer -> Depacketisierung ->
//! Decode. Laeuft vollstaendig im Tokio-Kontext und schickt fertige Bilder an
//! den Fenster-Thread.
//!
//! Die Reihenfolge ist der Kern des Ganzen. Chromium versteckt Puffer und
//! Decoder-Wahl; hier ist beides sichtbar und zur Laufzeit einstellbar.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::decode::{DecodedFrame, VideoDecoder};
use crate::depacket::Assembler;
use crate::jitter::{JitterBuffer, Release};
use crate::mediasink::{MediaSink, MediaStats};
use crate::proto::PlayerOptions;
use crate::whep::{self, Codec, RtpArrival};

/// Wie oft der Jitter-Puffer auf faellige Pakete geprueft wird, wenn gerade
/// nichts hereinkommt. Feiner als die kleinste sinnvolle Zielzeit.
const POLL_INTERVAL: Duration = Duration::from_millis(2);

/// Laufende Zaehler einer Sitzung, wie sie `stats` nach vorne meldet.
#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct SessionStats {
    pub packets_received: u64,
    pub packets_lost: u64,
    pub packets_reordered: u64,
    pub packets_duplicate: u64,
    pub frames_decoded: u64,
    pub frames_dropped: u64,
    pub buffered_packets: u64,
    pub jitter_target_ms: u64,
    pub width: u32,
    pub height: u32,
    pub ten_bit_source: bool,
    /// Ton- und Aufnahme-Zaehler.
    #[serde(flatten)]
    pub media: MediaStats,
}

/// Was der Fenster-Thread von einer Sitzung zu sehen bekommt.
pub enum SessionEvent {
    Frame(Box<DecodedFrame>),
    Stats(SessionStats),
    /// Verbindung steht und der erste Frame ist dekodiert.
    Playing { decoder: String, hardware: bool },
    Ended { reason: String, failed: bool },
}

/// Steuerbefehle an eine laufende Sitzung.
pub enum SessionCommand {
    Options(Box<PlayerOptions>),
    /// Laufende Aufnahme starten/stoppen bzw. die letzten Sekunden sichern.
    /// Die Antwort geht direkt an den Aufrufer zurueck, damit die
    /// RPC-Antwort das Ergebnis tragen kann.
    Record { path: String, reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    StopRecord { reply: tokio::sync::oneshot::Sender<Result<(), String>> },
    Clip {
        path: String,
        seconds: f64,
        reply: tokio::sync::oneshot::Sender<Result<u64, String>>,
    },
    Stop,
}

/// Fuehrt eine Sitzung von Anfang bis Ende. Kehrt zurueck, wenn die Sitzung
/// endet (regulaer oder mit Fehler).
pub async fn run(
    url: String,
    ice: Vec<String>,
    mut options: PlayerOptions,
    events: mpsc::Sender<SessionEvent>,
    mut commands: mpsc::Receiver<SessionCommand>,
) {
    let (rtp_tx, mut rtp_rx) = mpsc::channel::<RtpArrival>(1024);

    let mut whep_session = match whep::connect(&url, &ice, rtp_tx).await {
        Ok(s) => s,
        Err(e) => {
            let _ = events
                .send(SessionEvent::Ended { reason: format!("{e:#}"), failed: true })
                .await;
            return;
        }
    };

    let target = Duration::from_millis(u64::from(options.jitter_ms.unwrap_or(20)));
    // Video und Audio haben eigene Sequenznummernkreise und brauchen deshalb
    // je einen eigenen Puffer.
    let mut buffers: HashMap<Codec, JitterBuffer> = HashMap::new();
    let mut assemblers: HashMap<Codec, Assembler> = HashMap::new();
    let mut decoder: Option<VideoDecoder> = None;
    let mut media = MediaSink::new();
    media.apply_options(&options);
    // Gemeinsame Zeitbasis fuer den Mitschnitt: Millisekunden seit Sitzungsstart.
    let started = Instant::now();
    let mut stats =
        SessionStats { jitter_target_ms: target.as_millis() as u64, ..Default::default() };
    let mut announced_playing = false;
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let reason = loop {
        tokio::select! {
            cmd = commands.recv() => match cmd {
                Some(SessionCommand::Stop) | None => break "closed".to_string(),
                Some(SessionCommand::Record { path, reply }) => {
                    let _ = reply.send(media.start_recording(&path));
                }
                Some(SessionCommand::StopRecord { reply }) => {
                    let _ = reply.send(media.stop_recording());
                }
                Some(SessionCommand::Clip { path, seconds, reply }) => {
                    let _ = reply.send(media.save_clip(&path, seconds));
                }
                Some(SessionCommand::Options(patch)) => {
                    options.apply(&patch);
                    options.clamp();
                    media.apply_options(&options);
                    if let Some(ms) = options.jitter_ms {
                        let t = Duration::from_millis(u64::from(ms));
                        stats.jitter_target_ms = ms.into();
                        for b in buffers.values_mut() {
                            b.set_target(t);
                        }
                    }
                }
            },

            arrival = rtp_rx.recv() => {
                let Some(arrival) = arrival else { break "track beendet".to_string() };
                let codec = arrival.codec;
                buffers
                    .entry(codec)
                    .or_insert_with(|| JitterBuffer::new(target))
                    .push(arrival.packet, arrival.arrived);
            },

            _ = ticker.tick() => {}
        }

        // Faellige Pakete freigeben und zu Zugriffseinheiten zusammensetzen.
        let now = Instant::now();
        for (codec, buffer) in buffers.iter_mut() {
            let assembler = assemblers
                .entry(*codec)
                .or_insert_with(|| Assembler::for_codec(*codec));

            for release in buffer.poll(now) {
                let unit = match release {
                    Release::Gap { .. } => {
                        assembler.on_gap();
                        stats.frames_dropped += 1;
                        continue;
                    }
                    Release::Packet(p) => {
                        let marker = p.header.marker;
                        assembler.push(&p.payload, marker)
                    }
                };
                let Some(unit) = unit else { continue };

                // Jede Einheit geht an den Medien-Sink: Ton wird dort
                // dekodiert und ausgegeben, und beide Spuren laufen in den
                // Ringpuffer fuer Aufnahme und Clip.
                let ts_ms = started.elapsed().as_millis() as i64;
                media.handle_unit(*codec, &unit, ts_ms);

                if !codec.is_video() {
                    continue;
                }

                let dec = match decoder.as_mut() {
                    Some(d) => d,
                    None => match VideoDecoder::new(*codec, options.hwdec) {
                        Ok(d) => decoder.insert(d),
                        Err(e) => {
                            let reason = format!("Decoder: {e:#}");
                            let _ = events
                                .send(SessionEvent::Ended { reason, failed: true })
                                .await;
                            whep_session.close().await;
                            return;
                        }
                    },
                };

                let emitted =
                    emit_frames(dec, &unit, &mut stats, &mut announced_playing, &events).await;
                if emitted.is_err() {
                    // Der Fenster-Thread ist weg — die Sitzung hat keinen
                    // Abnehmer mehr.
                    whep_session.close().await;
                    return;
                }
            }

            stats.packets_received = buffer.received;
            stats.packets_lost = buffer.lost;
            stats.packets_reordered = buffer.reordered;
            stats.packets_duplicate = buffer.duplicates;
            stats.buffered_packets = buffer.buffered() as u64;
        }

        // Einmal je Durchgang, nicht je Spur: beides haengt nicht am Puffer,
        // und `media.stats()` nimmt jedes Mal die Sperre des Ausgabe-Rings.
        media.note_dimensions(stats.width, stats.height);
        stats.media = media.stats();

        let _ = events.try_send(SessionEvent::Stats(stats));
    };

    whep_session.close().await;
    let _ = events.send(SessionEvent::Ended { reason, failed: false }).await;
}

/// Dekodiert eine Zugriffseinheit und schiebt die fertigen Bilder nach vorne.
/// `Err(())` heisst: der Fenster-Thread nimmt nichts mehr an, die Sitzung endet.
async fn emit_frames(
    dec: &mut VideoDecoder,
    unit: &[u8],
    stats: &mut SessionStats,
    announced_playing: &mut bool,
    events: &mpsc::Sender<SessionEvent>,
) -> Result<(), ()> {
    let frames = match dec.decode(unit) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("pulse-player: Decode: {e:#}");
            return Ok(());
        }
    };

    for f in frames {
        stats.frames_decoded += 1;
        stats.width = f.width;
        stats.height = f.height;
        stats.ten_bit_source = f.ten_bit;
        if !*announced_playing {
            *announced_playing = true;
            let event =
                SessionEvent::Playing { decoder: dec.name.clone(), hardware: dec.hardware };
            let _ = events.send(event).await;
        }
        events.send(SessionEvent::Frame(Box::new(f))).await.map_err(|_| ())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unerreichbare_url_meldet_fehler_statt_zu_haengen() {
        let (tx, mut rx) = mpsc::channel(8);
        let (_cmd_tx, cmd_rx) = mpsc::channel(1);
        // Port 1 ist reserviert und antwortet nicht.
        run(
            "http://127.0.0.1:1/whep".to_string(),
            vec![],
            PlayerOptions::defaults(),
            tx,
            cmd_rx,
        )
        .await;

        let ev = rx.recv().await.expect("ein Ereignis erwartet");
        match ev {
            SessionEvent::Ended { failed, reason } => {
                assert!(failed, "muss als Fehler gemeldet werden: {reason}");
            }
            _ => panic!("erstes Ereignis muss Ended sein"),
        }
    }
}
