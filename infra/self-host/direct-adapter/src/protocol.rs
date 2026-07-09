//! Draht-Protokoll des Direktpfads — MUSS mit dem Client-Shim
//! (`web/src/lib/direct/`) synchron bleiben.
//!
//! **Signal-WS (Cloud ⇄ Adapter):**
//! rein: `{"t":"offer","connection_id","sdp"}` · raus: `{"t":"answer","connection_id","sdp"}`
//!
//! **DataChannel "http"** (ein Kanal, multiplexed über `id`):
//! Client→Server `{"t":"req",id,method,path,headers:[[k,v]],fin}` dann
//! 0..n `{"t":"body",id,b64,fin}` · Server→Client `{"t":"res",id,status,headers,fin}`
//! dann 0..n `{"t":"body",id,b64,fin}`. Chunk-Größe ≤ 48 KiB roh (SCTP-Limit).
//!
//! **DataChannel "ws:<pfad?query>"**: 1 Kanal = 1 WebSocket zum Backend;
//! Text/Binary-Frames werden 1:1 durchgereicht, Close propagiert.

use serde::{Deserialize, Serialize};

/// Roh-Chunk-Größe für Bodies (Base64 macht daraus ~64 KiB pro Message —
/// sicher unter dem 256-KiB-SCTP-Limit der Browser).
pub const BODY_CHUNK_BYTES: usize = 48 * 1024;

#[derive(Deserialize)]
#[serde(tag = "t")]
pub enum SignalIn {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "offer")]
    Offer { connection_id: String, sdp: String },
    #[serde(other)]
    Unknown,
}

#[derive(Serialize)]
#[serde(tag = "t")]
pub enum SignalOut<'a> {
    #[serde(rename = "answer")]
    Answer { connection_id: &'a str, sdp: &'a str },
}

#[derive(Deserialize)]
#[serde(tag = "t")]
pub enum HttpFrameIn {
    #[serde(rename = "req")]
    Req {
        id: u64,
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        fin: bool,
    },
    #[serde(rename = "body")]
    Body { id: u64, b64: String, fin: bool },
}

#[derive(Serialize)]
#[serde(tag = "t")]
pub enum HttpFrameOut {
    #[serde(rename = "res")]
    Res {
        id: u64,
        status: u16,
        headers: Vec<(String, String)>,
        fin: bool,
    },
    #[serde(rename = "body")]
    Body { id: u64, b64: String, fin: bool },
    /// Transportfehler VOR einer HTTP-Antwort (Backend nicht erreichbar o.ä.).
    #[serde(rename = "err")]
    Err { id: u64, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn req_frame_parses() {
        let f: HttpFrameIn = serde_json::from_str(
            r#"{"t":"req","id":1,"method":"GET","path":"/api/auth/health","headers":[["accept","*/*"]],"fin":true}"#,
        )
        .unwrap();
        match f {
            HttpFrameIn::Req { id, fin, .. } => {
                assert_eq!(id, 1);
                assert!(fin);
            }
            _ => panic!("falscher Frame-Typ"),
        }
    }

    #[test]
    fn answer_serializes() {
        let s = serde_json::to_string(&SignalOut::Answer { connection_id: "c1", sdp: "v=0" }).unwrap();
        assert_eq!(s, r#"{"t":"answer","connection_id":"c1","sdp":"v=0"}"#);
    }

    #[test]
    fn unknown_signal_tolerated() {
        let f: SignalIn = serde_json::from_str(r#"{"t":"whatever"}"#).unwrap();
        assert!(matches!(f, SignalIn::Unknown));
    }
}
