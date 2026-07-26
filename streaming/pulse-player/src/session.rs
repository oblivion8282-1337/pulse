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
use crate::whep::{self, redact_tokens, Codec, RtpArrival};

/// Wie oft der Jitter-Puffer auf faellige Pakete geprueft wird, wenn gerade
/// nichts hereinkommt. Feiner als die kleinste sinnvolle Zielzeit.
const POLL_INTERVAL: Duration = Duration::from_millis(2);

/// Wie oft die Statistik nach vorne geht. Bewusst grob: die Zahlen werden
/// angezeigt, nicht ausgewertet, und jedes Ereignis weckt den Fenster-Thread.
const STATS_INTERVAL: Duration = Duration::from_millis(250);

/// Wie lange eine Sitzung hoechstens braucht, um das erste Bild zu zeigen.
///
/// Das ist ein Auffangnetz fuer JEDE Ursache, nicht fuer eine bestimmte. Die
/// Einzeltimeouts in `whep.rs` (15 s HTTP, 2 s ICE-Sammeln) decken nur ab, was
/// sie kennen; beobachtet am 2026-07-26 wurde ein Fall, in dem der WHEP-Aufbau
/// gar nicht erst bei MediaMTX ankam — die Sitzung wartete danach still und
/// unbegrenzt auf RTP, und die Kachel im Renderer stand dauerhaft auf
/// "verbinde". Ohne Obergrenze ist jeder unbekannte Aufbaufehler ein Haenger.
///
/// Grosszuegiger als die Summe der Einzelschritte (Aufbau ~1 s, Warten auf den
/// Einstiegspunkt ~1 s gemessen), damit ein langsamer, aber funktionierender
/// Start nicht faelschlich abgebrochen wird.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(20);

/// Laufende Zaehler einer Sitzung, wie sie `stats` nach vorne meldet.
#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct SessionStats {
    pub packets_received: u64,
    pub packets_lost: u64,
    pub packets_reordered: u64,
    pub packets_duplicate: u64,
    pub frames_decoded: u64,
    pub frames_dropped: u64,
    /// Bilder, die verworfen wurden, weil die Darstellung nicht mitkam.
    /// Anders als `frames_dropped` (Paketverlust) ist das kein Netzproblem.
    pub frames_skipped: u64,
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

/// Rueckkanal fuer Aufnahme-Befehle: entweder die Nutzlast der RPC-Antwort
/// oder eine Fehlermeldung.
pub type MediaReply = tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>;

/// Steuerbefehle an eine laufende Sitzung.
pub enum SessionCommand {
    Options(Box<PlayerOptions>),
    /// Laufende Aufnahme starten/stoppen bzw. die letzten Sekunden sichern.
    /// Die Antwort geht direkt an den Aufrufer zurueck, damit die
    /// RPC-Antwort das Ergebnis tragen kann.
    /// Antwort ist die JSON-Nutzlast der RPC-Antwort — bei `record` und `clip`
    /// steht dort der tatsaechlich benutzte Pfad, dessen Endung sich nach dem
    /// Codec richtet (AV1 braucht Matroska, H.264 MPEG-TS).
    Record { path: String, reply: MediaReply },
    StopRecord { reply: MediaReply },
    Clip { path: String, seconds: f64, reply: MediaReply },
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
                .send(SessionEvent::Ended { reason: redact_tokens(&format!("{e:#}")), failed: true })
                .await;
            return;
        }
    };

    let target = Duration::from_millis(u64::from(options.jitter_ms.unwrap_or(20)));
    // Video und Audio haben eigene Sequenznummernkreise und brauchen deshalb
    // je einen eigenen Puffer.
    let mut buffers: HashMap<Codec, JitterBuffer> = HashMap::new();
    let mut assemblers: HashMap<Codec, Assembler> = HashMap::new();
    // Leer, solange `PULSE_PLAYER_DUMP_RTP` nicht gesetzt ist (s. `dump`).
    let mut dumps: HashMap<Codec, Option<crate::dump::RtpDump>> = HashMap::new();
    let mut decoder: Option<VideoDecoder> = None;
    let mut media = MediaSink::new();
    media.apply_options(&options);
    // Gemeinsame Zeitbasis fuer den Mitschnitt: Millisekunden seit Sitzungsstart.
    let started = Instant::now();
    let mut stats =
        SessionStats { jitter_target_ms: target.as_millis() as u64, ..Default::default() };
    let mut announced_playing = false;
    let mut last_stats = Instant::now();
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // `failed` unterscheidet "Fenster zu" von "kaputt": nur beim zweiten faellt
    // der Renderer auf das <video>-Element zurueck.
    let (reason, failed) = loop {
        tokio::select! {
            cmd = commands.recv() => match cmd {
                Some(SessionCommand::Stop) | None => break ("closed".to_string(), false),
                Some(SessionCommand::Record { path, reply }) => {
                    let answer = media
                        .start_recording(&path)
                        .map(|used| serde_json::json!({ "path": used }));
                    let _ = reply.send(answer);
                }
                Some(SessionCommand::StopRecord { reply }) => {
                    let _ = reply.send(media.stop_recording().map(|()| serde_json::Value::Null));
                }
                Some(SessionCommand::Clip { path, seconds, reply }) => {
                    // Einsammeln ist ein Speicherkopiervorgang und darf hier
                    // laufen; das Schreiben geht auf einen Blocking-Thread.
                    // Synchron hier haette die Schleife stillgestanden, der
                    // RTP-Kanal waere uebergelaufen und der Strom haette einen
                    // sichtbaren Aussetzer bekommen.
                    match media.clip_snapshot(seconds) {
                        Ok(data) => {
                            tokio::task::spawn_blocking(move || {
                                let result =
                                    crate::recorder::write_clip(std::path::Path::new(&path), &data)
                                        .map(|(units, used)| {
                                            serde_json::json!({
                                                "units": units,
                                                "path": used.to_string_lossy(),
                                            })
                                        })
                                        .map_err(|e| format!("{e:#}"));
                                let _ = reply.send(result);
                            });
                        }
                        Err(e) => {
                            let _ = reply.send(Err(e));
                        }
                    }
                }
                Some(SessionCommand::Options(patch)) => {
                    options.apply(&patch);
                    options.clamp();
                    media.apply_options(&options);
                    // `hwdec` gilt laut proto.rs als zur Laufzeit umschaltbar.
                    // Der Decoder wird aber nur einmal angelegt — ohne dieses
                    // Verwerfen antwortete `set_option` mit `ok: true`, ohne
                    // dass sich etwas aenderte. Der naechste Frame legt ihn mit
                    // der neuen Einstellung neu an.
                    if patch.hwdec.is_some() {
                        decoder = None;
                    }
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
                // Enden die Tracks, BEVOR je ein Bild kam, ist das ein
                // gescheiterter Aufbau und kein regulaeres Ende.
                let Some(arrival) = arrival else {
                    break ("track beendet".to_string(), !announced_playing);
                };
                let codec = arrival.codec;
                buffers
                    .entry(codec)
                    .or_insert_with(|| JitterBuffer::new(target))
                    .push(arrival.packet, arrival.arrived);
            },

            _ = ticker.tick() => {}
        }

        // Auffangnetz gegen jede Art von haengendem Aufbau. Greift nur bis zum
        // ersten Bild; danach ist ein stiller Strom Sache des Senders.
        if !announced_playing && started.elapsed() > FIRST_FRAME_TIMEOUT {
            break (
                format!(
                    "kein Bild nach {} s — Verbindung kam nicht zustande",
                    FIRST_FRAME_TIMEOUT.as_secs()
                ),
                true,
            );
        }

        // Faellige Pakete freigeben und zu Zugriffseinheiten zusammensetzen.
        let now = Instant::now();
        for (codec, buffer) in buffers.iter_mut() {
            let assembler = assemblers
                .entry(*codec)
                .or_insert_with(|| Assembler::for_codec(*codec));
            // Genau einmal je Spur versuchen: `from_env` legt die Datei an,
            // ein Aufruf pro Durchlauf wuerde sie staendig neu leeren.
            dumps
                .entry(*codec)
                .or_insert_with(|| crate::dump::RtpDump::from_env(codec.as_str()));

            for release in buffer.poll(now) {
                let unit = match release {
                    Release::Gap { .. } => {
                        assembler.on_gap();
                        stats.frames_dropped += 1;
                        continue;
                    }
                    Release::Packet(p) => {
                        let marker = p.header.marker;
                        // Diagnose vor der Verarbeitung: der Mitschnitt soll
                        // zeigen, was ANKOMMT, nicht was wir daraus machen.
                        if let Some(d) = dumps.get(codec).and_then(Option::as_ref) {
                            d.write(&p.payload, marker);
                        }
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

                match emit_frames(dec, &unit, &mut stats, &mut announced_playing, &events).await {
                    Ok(()) => {}
                    // Der Fenster-Thread ist weg — die Sitzung hat keinen
                    // Abnehmer mehr. Kein Fehler, nur Ende.
                    Err(EmitError::NoConsumer) => {
                        whep_session.close().await;
                        return;
                    }
                    Err(EmitError::Decoder(reason)) => {
                        let _ = events
                            .send(SessionEvent::Ended {
                                reason: format!("Decoder: {reason}"),
                                failed: true,
                            })
                            .await;
                        whep_session.close().await;
                        return;
                    }
                }
            }
        }

        media.note_dimensions(stats.width, stats.height);
        media.note_ten_bit(stats.ten_bit_source);

        // Ueber ALLE Puffer summieren, nicht je Codec ueberschreiben: Bild und
        // Ton haben eigene Sequenznummernkreise und damit eigene Puffer. Vorher
        // gewann der zuletzt iterierte, und die HashMap-Reihenfolge ist pro
        // Prozess zufaellig — die Zahlen stammten also mal von der Video-, mal
        // von der Tonspur, ohne dass das erkennbar war.
        stats.packets_received = buffers.values().map(|b| b.received).sum();
        stats.packets_lost = buffers.values().map(|b| b.lost).sum();
        stats.packets_reordered = buffers.values().map(|b| b.reordered).sum();
        stats.packets_duplicate = buffers.values().map(|b| b.duplicates).sum();
        stats.buffered_packets = buffers.values().map(|b| b.buffered() as u64).sum();

        // --- Fund C: Statistik nicht bei jedem Schleifendurchlauf senden ---
        // Der Durchlauf wird von JEDEM RTP-Paket und zusaetzlich vom 2-ms-Ticker
        // ausgeloest, also ueber 1000-mal pro Sekunde. Jedes Ereignis weckt den
        // Fenster-Thread, der mit `ControlFlow::Wait` sonst schlafen wuerde —
        // nur um ein Zahlenfeld zu ueberschreiben.
        if last_stats.elapsed() >= STATS_INTERVAL {
            last_stats = Instant::now();
            // Erst hier abfragen: `media.stats()` nimmt die Sperre des
            // Audio-Ringpuffers, auf die auch der Geraete-Callback wartet.
            // Bei jedem Durchlauf waere das ueber 1000-mal pro Sekunde.
            stats.media = media.stats();
            let _ = events.try_send(SessionEvent::Stats(stats));
        }
    };

    // Eine laufende Aufnahme ausdruecklich abschliessen, damit der
    // Matroska-Trailer geschrieben wird. `Recorder` hat dafuer zusaetzlich ein
    // `Drop`-Netz; hier steht es explizit, weil die Absicht sonst nicht
    // erkennbar waere.
    if media.is_recording() {
        if let Err(e) = media.stop_recording() {
            eprintln!("pulse-player: Aufnahme beim Sitzungsende: {e}");
        }
    }
    whep_session.close().await;
    let _ = events.send(SessionEvent::Ended { reason, failed }).await;
}

/// Dekodiert eine Zugriffseinheit und schiebt die fertigen Bilder nach vorne.
/// `Err(())` heisst: der Fenster-Thread nimmt nichts mehr an, die Sitzung endet.
/// Warum das Ausliefern von Bildern abgebrochen ist. Die beiden Faelle
/// verlangen Gegensaetzliches: beim wegfallenden Abnehmer ist die Sitzung
/// ordnungsgemaess zu Ende (das Fenster wurde geschlossen), beim defekten
/// Decoder muss ein Fehler nach draussen — sonst haengt die Kachel im
/// Renderer fuer immer im Zustand "verbinde".
enum EmitError {
    /// Der Fenster-Thread nimmt nichts mehr an.
    NoConsumer,
    /// Der Decoder ist endgueltig hin (s. `decode::VideoDecoder::decode`).
    Decoder(String),
}

async fn emit_frames(
    dec: &mut VideoDecoder,
    unit: &[u8],
    stats: &mut SessionStats,
    announced_playing: &mut bool,
    events: &mpsc::Sender<SessionEvent>,
) -> Result<(), EmitError> {
    let frames = dec.decode(unit).map_err(|e| EmitError::Decoder(format!("{e:#}")))?;

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
        // Bewusst `try_send` statt `send().await`: das hier ist Live-Wiedergabe.
        // Kommt der Fenster-Thread nicht mit, ist das NEUESTE Bild richtig und
        // ein aufgestauter Rueckstand falsch — mit einem blockierenden Send
        // haetten sich Frames im Kanal gesammelt und die Latenz waere
        // mitgewachsen, statt dass Bilder uebersprungen werden. Der
        // Rueckstau haette sich ausserdem bis in den Jitter-Puffer
        // fortgepflanzt, weil die Schleife dann kein RTP mehr abholt.
        match events.try_send(SessionEvent::Frame(Box::new(f))) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                stats.frames_skipped += 1;
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                return Err(EmitError::NoConsumer)
            }
        }
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
