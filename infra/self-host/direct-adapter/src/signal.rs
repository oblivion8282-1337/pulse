//! Klingeldraht: dauerhafte WS-Verbindung zum Cloud-Signal-Relay.
//!
//! Auth-Frame zuerst (instance_id + Relay-Token), dann Offers empfangen und
//! Answers zurückschicken. Verbindungsabriss → Reconnect mit Backoff (max
//! 60 s). Der Token geht NUR in den Auth-Frame, nie in Logs.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::config::Config;
use crate::protocol::{SignalIn, SignalOut};
use crate::rtc::RtcFactory;

fn ws_url(cfg: &Config) -> String {
    let origin = cfg.cloud_origin.trim_end_matches('/');
    let ws_origin = if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin.to_string()
    };
    format!("{ws_origin}{}/selfhost/directory/ws", cfg.cloud_api_prefix)
}

pub async fn run(cfg: Config, factory: Arc<RtcFactory>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect_and_serve(&cfg, &factory).await {
            Ok(()) => backoff = Duration::from_secs(1),
            Err(e) => eprintln!("[signal] Verbindung verloren: {e:#}"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

async fn connect_and_serve(cfg: &Config, factory: &Arc<RtcFactory>) -> Result<()> {
    let (stream, _) = tokio_tungstenite::connect_async(ws_url(cfg))
        .await
        .context("Signal-WS-Connect")?;
    let (mut sink, mut source) = stream.split();

    let auth = serde_json::json!({ "instance_id": cfg.instance_id, "token": cfg.relay_token });
    sink.send(WsMessage::Text(auth.to_string().into())).await?;

    // Answers kommen aus spawned Tasks → über einen Kanal in den Sink.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(16);

    loop {
        tokio::select! {
            answer = rx.recv() => {
                let Some(json) = answer else { break };
                sink.send(WsMessage::Text(json.into())).await?;
            }
            msg = source.next() => {
                let msg = msg.context("Signal-WS beendet")??;
                let WsMessage::Text(text) = msg else { continue };
                let Ok(frame) = serde_json::from_str::<SignalIn>(&text) else { continue };
                match frame {
                    SignalIn::Ready => println!("[signal] Klingeldraht steht"),
                    SignalIn::Offer { connection_id, sdp } => {
                        let factory = factory.clone();
                        let tx = tx.clone();
                        tokio::spawn(async move {
                            match factory.answer(sdp).await {
                                Ok(answer_sdp) => {
                                    let out = SignalOut::Answer {
                                        connection_id: &connection_id,
                                        sdp: &answer_sdp,
                                    };
                                    if let Ok(json) = serde_json::to_string(&out) {
                                        let _ = tx.send(json).await;
                                    }
                                }
                                Err(e) => eprintln!("[signal] Answer fehlgeschlagen: {e:#}"),
                            }
                        });
                    }
                    SignalIn::Unknown => {}
                }
            }
        }
    }
    Ok(())
}
