//! DataChannel⇄Backend-Brücke.
//!
//! Kanal "http": multiplexte Request/Response-Frames (protocol.rs) →
//! HTTP gegen den Container-Caddy (`http://127.0.0.1:8080`, behind-proxy-
//! Modus: schlichtes HTTP-Routing inkl. WebSocket).
//! Kanal "ws:<pfad>": 1 DataChannel = 1 Backend-WebSocket, Frames 1:1.
//!
//! Secrets in Headern (Session-Tokens) werden NIE geloggt.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::peer_connection::RTCPeerConnection;

use crate::protocol::{BODY_CHUNK_BYTES, HttpFrameIn, HttpFrameOut};

fn backend_base() -> String {
    std::env::var("PULSE_DIRECT_BACKEND").unwrap_or_else(|_| "http://127.0.0.1:8080".into())
}

pub fn wire(pc: &Arc<RTCPeerConnection>) {
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        Box::pin(async move {
            let label = dc.label().to_string();
            if label == "http" {
                wire_http_channel(dc);
            } else if let Some(path) = label.strip_prefix("ws:") {
                wire_ws_channel(dc.clone(), path.to_string());
            } else {
                let _ = dc.close().await;
            }
        })
    }));
}

// ---------------------------------------------------------------------------
// HTTP-Kanal
// ---------------------------------------------------------------------------

struct PendingReq {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn wire_http_channel(dc: Arc<RTCDataChannel>) {
    let pending: Arc<Mutex<HashMap<u64, PendingReq>>> = Arc::new(Mutex::new(HashMap::new()));
    let http = reqwest::Client::new();
    let dc_for_handler = dc.clone();
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let dc = dc_for_handler.clone();
        let pending = pending.clone();
        let http = http.clone();
        Box::pin(async move {
            let Ok(frame) = serde_json::from_slice::<HttpFrameIn>(&msg.data) else {
                return; // kaputter Frame → ignorieren (kein Absturzvektor)
            };
            match frame {
                HttpFrameIn::Req { id, method, path, headers, fin } => {
                    let req = PendingReq { method, path, headers, body: Vec::new() };
                    if fin {
                        tokio::spawn(dispatch(http, dc, id, req));
                    } else {
                        pending.lock().await.insert(id, req);
                    }
                }
                HttpFrameIn::Body { id, b64, fin } => {
                    let mut map = pending.lock().await;
                    let Some(req) = map.get_mut(&id) else { return };
                    let Ok(chunk) = B64.decode(b64) else {
                        map.remove(&id);
                        return;
                    };
                    req.body.extend_from_slice(&chunk);
                    if fin {
                        let req = map.remove(&id).expect("gerade geholt");
                        drop(map);
                        tokio::spawn(dispatch(http, dc, id, req));
                    }
                }
            }
        })
    }));
}

/// Hop-by-hop-/Transport-Header, die nicht durch die Brücke gehören.
fn skip_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "connection" | "content-length" | "transfer-encoding" | "accept-encoding"
            | "keep-alive" | "upgrade" | "te" | "trailer" | "proxy-authorization"
    )
}

async fn dispatch(http: reqwest::Client, dc: Arc<RTCDataChannel>, id: u64, req: PendingReq) {
    let url = format!("{}{}", backend_base(), req.path);
    let Ok(method) = req.method.parse::<reqwest::Method>() else {
        send_err(&dc, id, "invalid method").await;
        return;
    };
    let mut builder = http.request(method, url).header("accept-encoding", "identity");
    if let Ok(hostname) = std::env::var("PULSE_HOSTNAME") {
        builder = builder.header("host", hostname);
    }
    for (k, v) in &req.headers {
        if !skip_header(k) {
            builder = builder.header(k, v);
        }
    }
    if !req.body.is_empty() {
        builder = builder.body(req.body);
    }
    let res = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            // Fehlertext ohne URL/Query loggen (Query kann Tokens tragen).
            eprintln!("[bridge] Backend-Fehler (req {id}): {}", e.without_url());
            send_err(&dc, id, "backend unreachable").await;
            return;
        }
    };

    let status = res.status().as_u16();
    let headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .filter(|(k, _)| !skip_header(k.as_str()) && k.as_str() != "content-encoding")
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect();
    let body = match res.bytes().await {
        Ok(b) => b,
        Err(_) => {
            send_err(&dc, id, "backend body read failed").await;
            return;
        }
    };

    let fin = body.is_empty();
    send_frame(&dc, &HttpFrameOut::Res { id, status, headers, fin }).await;
    let mut sent = 0usize;
    while sent < body.len() {
        let end = (sent + BODY_CHUNK_BYTES).min(body.len());
        let frame = HttpFrameOut::Body {
            id,
            b64: B64.encode(&body[sent..end]),
            fin: end == body.len(),
        };
        send_frame(&dc, &frame).await;
        sent = end;
    }
}

async fn send_frame(dc: &Arc<RTCDataChannel>, frame: &HttpFrameOut) {
    if let Ok(json) = serde_json::to_string(frame) {
        let _ = dc.send_text(json).await;
    }
}

async fn send_err(dc: &Arc<RTCDataChannel>, id: u64, message: &str) {
    send_frame(dc, &HttpFrameOut::Err { id, message: message.into() }).await;
}

// ---------------------------------------------------------------------------
// WS-Kanal
// ---------------------------------------------------------------------------

fn wire_ws_channel(dc: Arc<RTCDataChannel>, path: String) {
    // DataChannel-Frames laufen über einen mpsc in den WS-Sink — die
    // on_message-Closure darf den Sink nicht selbst besitzen (mehrfach klonbar).
    let (tx, mut rx) = mpsc::channel::<WsMessage>(64);

    let dc_in = dc.clone();
    let tx_in = tx.clone();
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let tx = tx_in.clone();
        Box::pin(async move {
            let ws_msg = if msg.is_string {
                match String::from_utf8(msg.data.to_vec()) {
                    Ok(s) => WsMessage::Text(s.into()),
                    Err(_) => return,
                }
            } else {
                WsMessage::Binary(msg.data.clone())
            };
            let _ = tx.send(ws_msg).await;
        })
    }));
    let tx_close = tx.clone();
    dc.on_close(Box::new(move || {
        let tx = tx_close.clone();
        Box::pin(async move {
            let _ = tx.send(WsMessage::Close(None)).await;
        })
    }));

    tokio::spawn(async move {
        let base = backend_base().replacen("http", "ws", 1);
        let url = format!("{base}{path}");
        let Ok((stream, _)) = tokio_tungstenite::connect_async(&url).await else {
            eprintln!("[bridge] Backend-WS nicht erreichbar");
            let _ = dc_in.close().await;
            return;
        };
        let (mut sink, mut source) = stream.split();
        loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(WsMessage::Close(_)) | None => break,
                    Some(m) => { if sink.send(m).await.is_err() { break; } }
                },
                back = source.next() => match back {
                    Some(Ok(WsMessage::Text(s))) => {
                        if dc_in.send_text(s.to_string()).await.is_err() { break; }
                    }
                    Some(Ok(WsMessage::Binary(b))) => {
                        if dc_in.send(&b).await.is_err() { break; }
                    }
                    Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Frame(_))) => {}
                    Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => break,
                },
            }
        }
        let _ = sink.close().await;
        let _ = dc_in.close().await;
    });
}
