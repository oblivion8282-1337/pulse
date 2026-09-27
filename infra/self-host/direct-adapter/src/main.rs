//! pulse-direct-adapter — Direktpfad der Server-App.
//!
//! Aufbau (Plan docs/plans/2026-07-09-direct-path-webrtc.md):
//! 1. UDP-Port binden, EINMAL per STUN die öffentliche Adresse ermitteln
//!    (danach gehört der Socket dem WebRTC-Mux — alle PeerConnections teilen
//!    diesen einen, im Router veröffentlichten Port).
//! 2. Heartbeat-Task: meldet Adresse + DTLS-Fingerprint ans Cloud-Telefonbuch
//!    (IP-Frische über Wegwerf-Socket-Probes; der Port bleibt der von Schritt 1).
//! 3. Signal-Task: Klingeldraht zur Cloud — Offers rein, Answers raus; die
//!    PeerConnections bridgen DataChannels aufs lokale Backend (bridge.rs).
//!
//! Secrets werden NIE geloggt.

mod bridge;
mod config;
mod heartbeat;
mod identity;
mod protocol;
mod rtc;
mod sdp;
mod signal;
mod stun_probe;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::net::UdpSocket;

#[tokio::main]
async fn main() -> Result<()> {
    // rustls-Krypto-Provider explizit wählen: reqwest zieht `aws-lc-rs`, webrtc
    // zieht `ring` → rustls findet zwei Kandidaten, rät NICHT und panict erst
    // beim ersten DTLS-Handschlag (nicht beim Start). Muss vor allem anderen laufen.
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("rustls-CryptoProvider bereits installiert"))?;

    let cfg = config::Config::from_env()?;
    let ident = identity::load_or_create(&cfg.data_path)?;
    println!(
        "[direct-adapter] Start: instance={} port={} fingerprint={}",
        cfg.instance_id, cfg.direct_port, ident.fingerprint
    );

    let socket = UdpSocket::bind(("0.0.0.0", cfg.direct_port)).await?;
    let initial = stun_probe::discover_public_addr(&socket, &cfg.stun_servers).await?;
    println!("[direct-adapter] öffentliche Adresse: {initial}");
    if initial.port() != cfg.direct_port {
        // Kein Port-Preservation am Router — ICE (srflx durch den Mux) trägt
        // trotzdem die Wahrheit in der SDP; nur der Telefonbuch-Eintrag hinkt.
        eprintln!(
            "[direct-adapter] Hinweis: Router mappt {} → {} (kein Port-Preservation)",
            cfg.direct_port,
            initial.port()
        );
    }

    // Ab hier gehört der Socket dem WebRTC-Mux.
    if !cfg.extra_host_ips.is_empty() {
        // Win/Mac (podman machine): der Container sieht nur die VM-Adresse —
        // diese Host-LAN-IPs kommen von der Server-App und werden als
        // Host-Kandidaten in jede Answer injiziert (LAN-Clients).
        println!(
            "[direct-adapter] zusätzliche Host-Kandidaten (VM-Host-LAN): {}",
            cfg.extra_host_ips.iter().map(|ip| ip.to_string()).collect::<Vec<_>>().join(", ")
        );
    }
    let factory = Arc::new(rtc::RtcFactory::new(
        socket,
        ident.certificate.clone(),
        &cfg.stun_servers,
        initial.ip(),
        cfg.extra_host_ips.clone(),
        cfg.direct_port,
    ));

    let hb_cfg = cfg.clone();
    let hb_fingerprint = ident.fingerprint.clone();
    let public_port = initial.port();
    let mut public_ip = initial.ip();
    tokio::spawn(async move {
        let hb = heartbeat::HeartbeatClient::new(&hb_cfg.cloud_origin, &hb_cfg.cloud_api_prefix);
        let mut last_reported = None;
        loop {
            // IP-Frische: Wegwerf-Socket reicht (IP ist portunabhängig).
            match stun_probe::discover_public_ip_ephemeral(&hb_cfg.stun_servers).await {
                Ok(addr) => public_ip = addr.ip(),
                Err(e) => eprintln!("[direct-adapter] STUN-Fehler: {e:#}"),
            }
            let report = std::net::SocketAddr::new(public_ip, public_port);
            match hb
                .send(&hb_cfg.instance_id, &hb_cfg.relay_token, report, &hb_fingerprint)
                .await
            {
                Ok(()) => {
                    if last_reported != Some(report) {
                        println!("[direct-adapter] im Telefonbuch: {report}");
                        last_reported = Some(report);
                    }
                }
                Err(e) => eprintln!("[direct-adapter] Heartbeat-Fehler: {e:#}"),
            }
            tokio::time::sleep(Duration::from_secs(hb_cfg.heartbeat_interval_secs)).await;
        }
    });

    signal::run(cfg, factory).await;
    Ok(())
}
