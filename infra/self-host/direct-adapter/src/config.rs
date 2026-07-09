//! Env-Konfiguration des direct-adapters.
//!
//! Alles kommt aus dem Container-Env (07-render-env.sh bzw. `podman run -e`):
//! dieselben Werte, die auch frpc/die Services nutzen. Kein eigenes Config-File.

use anyhow::{bail, Result};

#[derive(Clone, Debug)]
pub struct Config {
    pub instance_id: String,
    /// Relay-Tunnel-Token — Heartbeat-Auth gegen die Cloud. NIE loggen.
    pub relay_token: String,
    pub cloud_origin: String,
    /// Pfad-Prefix vor den auth-svc-Routen. Prod: "/api/auth" (web-nginx);
    /// Dev gegen einen nackten uvicorn: "" setzen.
    pub cloud_api_prefix: String,
    /// UDP-Port für WebRTC (gebunden + per STUN nach außen gemeldet).
    pub direct_port: u16,
    pub data_path: String,
    pub stun_servers: Vec<String>,
    pub heartbeat_interval_secs: u64,
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let instance_id = std::env::var("PULSE_INSTANCE_ID")
            .map_err(|_| anyhow::anyhow!("PULSE_INSTANCE_ID fehlt"))?;
        let relay_token = match std::env::var("PULSE_RELAY_TUNNEL_TOKEN") {
            Ok(t) if !t.is_empty() => t,
            // Ohne Relay-Token (VPS-Self-Host ohne Relay) gibt es keine
            // Heartbeat-Auth → Adapter beendet sich sauber (s6: down).
            _ => bail!("PULSE_RELAY_TUNNEL_TOKEN fehlt — Direktpfad-Adapter deaktiviert"),
        };
        let stun_servers = env_or(
            "PULSE_DIRECT_STUN_SERVERS",
            "stun.l.google.com:19302,stun.cloudflare.com:3478",
        )
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
        Ok(Self {
            instance_id,
            relay_token,
            cloud_origin: env_or("PULSE_CLOUD_ORIGIN", "https://howispulse.com"),
            cloud_api_prefix: env_or("PULSE_CLOUD_API_PREFIX", "/api/auth"),
            direct_port: env_or("PULSE_DIRECT_PORT", "7900").parse()?,
            data_path: env_or("PULSE_DATA_PATH", "/data"),
            stun_servers,
            heartbeat_interval_secs: env_or("PULSE_DIRECT_HEARTBEAT_SECS", "120").parse()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_or_falls_back() {
        assert_eq!(env_or("PULSE_TEST_DOES_NOT_EXIST_XYZ", "abc"), "abc");
    }
}
