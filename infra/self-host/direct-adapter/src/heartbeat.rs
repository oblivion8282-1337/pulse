//! Heartbeat an das Cloud-Telefonbuch (auth-svc, Phase-1-Endpoint).
//!
//! POST /api/auth/selfhost/directory/heartbeat mit (instance_id, token,
//! candidates, fingerprint). Fehler werden geloggt (OHNE Token) und beim
//! nächsten Intervall erneut versucht — der Adapter stirbt daran nicht.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{bail, Result};
use serde::Serialize;

#[derive(Serialize)]
struct Candidate {
    ip: String,
    port: u16,
    protocol: &'static str,
}

#[derive(Serialize)]
struct HeartbeatBody<'a> {
    instance_id: &'a str,
    token: &'a str,
    // Nur im Pairing-Creds-Fall gesetzt (Heim-Server ohne Relay): die Cloud
    // prüft ``token`` dann als client_secret gegen DIESE Instanz.
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<&'a str>,
    candidates: Vec<Candidate>,
    fingerprint: &'a str,
}

/// Relay-Fall: (tunnel_token, keine client_id). Pairing-Fall: das am
/// U+001F hängende Paar aus config.rs wird zerlegt.
fn split_creds(relay_token: &str) -> (String, Option<String>) {
    match relay_token.split_once('\u{1f}') {
        Some((cid, secret)) => (secret.to_string(), Some(cid.to_string())),
        None => (relay_token.to_string(), None),
    }
}

pub struct HeartbeatClient {
    http: reqwest::Client,
    url: String,
}

impl HeartbeatClient {
    pub fn new(cloud_origin: &str, api_prefix: &str) -> Self {
        // Bughunt Runde 3: reqwest hat default WEDER Connect- noch Request-
        // Timeout — ein Cloud-Worker, der TCP annimmt aber nicht antwortet,
        // hat den Heartbeat-Loop sonst für immer stillgelegt (await ohne
        // Schranke, der Telefonbuch-Eintrag veraltet still).
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client konfigurierbar");
        Self {
            http,
            url: format!(
                "{}{}/selfhost/directory/heartbeat",
                cloud_origin.trim_end_matches('/'),
                api_prefix
            ),
        }
    }

    pub async fn send(
        &self,
        instance_id: &str,
        token: &str,
        public_addr: SocketAddr,
        fingerprint: &str,
    ) -> Result<()> {
        let (token, client_id) = split_creds(token);
        let body = HeartbeatBody {
            instance_id,
            token: &token,
            client_id: client_id.as_deref(),
            candidates: vec![Candidate {
                ip: public_addr.ip().to_string(),
                port: public_addr.port(),
                protocol: "udp",
            }],
            fingerprint,
        };
        let res = self.http.post(&self.url).json(&body).send().await?;
        if !res.status().is_success() {
            // Body verwerfen — Fehlertexte der Cloud sind ok, aber wir halten
            // die Logs minimal; der Statuscode reicht zur Diagnose.
            bail!("Heartbeat abgelehnt: HTTP {}", res.status().as_u16());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_serializes_expected_shape() {
        let body = HeartbeatBody {
            instance_id: "123",
            token: "t",
            client_id: None,
            candidates: vec![Candidate { ip: "1.2.3.4".into(), port: 7900, protocol: "udp" }],
            fingerprint: "sha-256 AB",
        };
        let v: serde_json::Value = serde_json::to_value(&body).unwrap();
        assert_eq!(v["instance_id"], "123");
        assert_eq!(v["candidates"][0]["port"], 7900);
        assert_eq!(v["candidates"][0]["protocol"], "udp");
    }

    #[test]
    fn url_join_handles_trailing_slash() {
        let c = HeartbeatClient::new("https://cloud.example/", "/api/auth");
        assert_eq!(c.url, "https://cloud.example/api/auth/selfhost/directory/heartbeat");
    }
}
