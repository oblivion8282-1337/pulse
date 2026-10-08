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
    /// LAN-IPs des Hosts (alle Plattformen): der Container sieht im VM-Fall
    /// (Win/Mac podman machine) nur die VM-interne, unter der Docker-Bridge nur
    /// die 172.17er-Adresse, und beide wirft `sdp::strip_unusable_hosts` aus
    /// der Answer — ohne diese Liste enthielte sie dort GAR KEINE
    /// Host-Kandidaten. Die Server-App rendert sie kommagetrennt in
    /// `PULSE_DIRECT_EXTRA_HOST_IPS`; sdp.rs synthetisiert daraus
    /// Host-Kandidaten (auf Linux dedupliziert gegen die nativen).
    pub extra_host_ips: Vec<std::net::Ipv4Addr>,
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let instance_id = std::env::var("PULSE_INSTANCE_ID")
            .map_err(|_| anyhow::anyhow!("PULSE_INSTANCE_ID fehlt"))?;
        // Zwei Auth-Wege: Relay-Instanzen nutzen das Tunnel-Token; Heim-Server
        // ohne Relay (Entscheid 2026-09-27) weisen sich mit den Pairing-Creds
        // aus (client_id + client_secret als Heartbeat-Token). Ohne BEIDES
        // gibt es keine Heartbeat-Auth → Adapter beendet sich sauber (s6: down).
        let relay_token = std::env::var("PULSE_RELAY_TUNNEL_TOKEN")
            .ok()
            .filter(|t| !t.is_empty())
            .or_else(|| {
                let cid = std::env::var("PULSE_CLOUD_CLIENT_ID").ok()?;
                let secret = std::env::var("PULSE_CLOUD_CLIENT_SECRET").ok()?;
                (!cid.is_empty() && !secret.is_empty())
                    .then_some(format!("{cid}\u{1f}{secret}"))
            })
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "weder PULSE_RELAY_TUNNEL_TOKEN noch PULSE_CLOUD_CLIENT_ID/SECRET — \
                     Direktpfad-Adapter deaktiviert"
                )
            })?;
        let stun_servers = env_or(
            "PULSE_DIRECT_STUN_SERVERS",
            "stun.l.google.com:19302,stun.cloudflare.com:3478",
        )
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
        // Unparsebare Einträge still verwerfen — eine kaputte IP darf den
        // Adapter nicht am Start hindern (fail-open wie stun_servers).
        let extra_host_ips = env_or("PULSE_DIRECT_EXTRA_HOST_IPS", "")
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
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
            extra_host_ips,
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
