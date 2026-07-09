//! pulse-direct-adapter — Direktpfad der Server-App (Phase 2: Grundgerüst).
//!
//! Bindet den WebRTC-UDP-Port, ermittelt per STUN die öffentliche Adresse und
//! meldet sie + den DTLS-Fingerprint im Heartbeat-Takt an das Cloud-Telefonbuch.
//! Die eigentliche WebRTC-Annahme (DataChannel⇄HTTP-Brücke) folgt in Phase 4;
//! das gebundene Socket + Zertifikat sind dafür schon die richtigen.
//!
//! Plan: docs/plans/2026-07-09-direct-path-webrtc.md. Secrets werden NIE geloggt.

mod config;
mod heartbeat;
mod identity;
mod stun_probe;

use std::time::Duration;

use anyhow::Result;
use tokio::net::UdpSocket;

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = config::Config::from_env()?;
    let ident = identity::load_or_create(&cfg.data_path)?;
    println!(
        "[direct-adapter] Start: instance={} port={} fingerprint={}",
        cfg.instance_id, cfg.direct_port, ident.fingerprint
    );

    let socket = UdpSocket::bind(("0.0.0.0", cfg.direct_port)).await?;
    let hb = heartbeat::HeartbeatClient::new(&cfg.cloud_origin, &cfg.cloud_api_prefix);

    let mut last_reported: Option<std::net::SocketAddr> = None;
    loop {
        match stun_probe::discover_public_addr(&socket, &cfg.stun_servers).await {
            Ok(addr) => {
                match hb
                    .send(&cfg.instance_id, &cfg.relay_token, addr, &ident.fingerprint)
                    .await
                {
                    Ok(()) => {
                        if last_reported != Some(addr) {
                            println!("[direct-adapter] im Telefonbuch: {addr}");
                            last_reported = Some(addr);
                        }
                    }
                    Err(e) => eprintln!("[direct-adapter] Heartbeat-Fehler: {e:#}"),
                }
            }
            Err(e) => eprintln!("[direct-adapter] STUN-Fehler: {e:#}"),
        }
        tokio::time::sleep(Duration::from_secs(cfg.heartbeat_interval_secs)).await;
    }
}
