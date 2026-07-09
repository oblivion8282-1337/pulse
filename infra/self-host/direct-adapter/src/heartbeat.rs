//! Heartbeat an das Cloud-Telefonbuch (auth-svc, Phase-1-Endpoint).
//!
//! POST /api/auth/selfhost/directory/heartbeat mit (instance_id, token,
//! candidates, fingerprint). Fehler werden geloggt (OHNE Token) und beim
//! nächsten Intervall erneut versucht — der Adapter stirbt daran nicht.

use std::net::SocketAddr;

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
    candidates: Vec<Candidate>,
    fingerprint: &'a str,
}

pub struct HeartbeatClient {
    http: reqwest::Client,
    url: String,
}

impl HeartbeatClient {
    pub fn new(cloud_origin: &str, api_prefix: &str) -> Self {
        Self {
            http: reqwest::Client::new(),
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
        let body = HeartbeatBody {
            instance_id,
            token,
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
