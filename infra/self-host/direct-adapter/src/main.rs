//! pulse-direct-adapter — Direktpfad der Server-App.
//!
//! Aufbau (Plan docs/plans/2026-07-09-direct-path-webrtc.md):
//! 1. UDP-Port binden, EINMAL per STUN die öffentliche Adresse ermitteln
//!    (danach gehört der Socket dem WebRTC-Mux — alle PeerConnections teilen
//!    diesen einen, im Router veröffentlichten Port).
//! 2. Heartbeat-Task: meldet Adresse + DTLS-Fingerprint ans Cloud-Telefonbuch
//!    (IP-Frische über Wegwerf-Socket-Probes; der Port bleibt der von Schritt 1)
//!    und reicht eine neue IP an die Answer-Fabrik weiter (`watch`-Kanal).
//! 3. Signal-Task: Klingeldraht zur Cloud — Offers rein, Answers raus; die
//!    PeerConnections bridgen DataChannels aufs lokale Backend (bridge.rs).
//!
//! Secrets werden NIE geloggt.

mod bridge;
mod config;
mod grenzen;
mod heartbeat;
mod identity;
mod protocol;
mod rtc;
mod sdp;
mod signal;
mod stun_probe;
mod ziel;

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

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let cfg = config::Config::from_env()?;
    let ident = identity::load_or_create(&cfg.data_path)?;
    println!(
        "[direct-adapter] Start: instance={} port={} fingerprint={}",
        cfg.instance_id, cfg.direct_port, ident.fingerprint
    );

    let socket = UdpSocket::bind(("0.0.0.0", cfg.direct_port)).await?;
    // Windows meldet auf einem UDP-Socket, dessen letzter Empfänger weg ist
    // (Peer-Reload/-Close → ICMP Port Unreachable), den NÄCHSTEN recv als
    // WSAECONNRESET. webrtc-ices UDPMux-Readloop bricht bei jedem Fehler ≠
    // TimedOut ab (`udp_mux/mod.rs`: break) — danach beantwortet dieser Port
    // keine STUN-Bindings mehr, jede künftige Session stirbt in `checking`
    // bis zum Prozess-Restart (Prod-E2E 2026-10-03: erste Session ging,
    // danach kam keine einzige mehr durch). SIO_UDP_CONNRESET=FALSE schaltet
    // das OS-Signal an der Quelle ab (pion/libdatachannel machen dasselbe).
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Networking::WinSock::{WSAIoctl, SOCKET};
        const SIO_UDP_CONNRESET: u32 = 0x9800_000C;
        let mut off: u32 = 0; // FALSE
        let mut returned = 0u32;
        let rc = unsafe {
            WSAIoctl(
                socket.as_raw_socket() as SOCKET,
                SIO_UDP_CONNRESET,
                &mut off as *mut u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
                None,
            )
        };
        if rc != 0 {
            eprintln!(
                "[direct-adapter] WARNUNG: SIO_UDP_CONNRESET fehlgeschlagen — \
                 UDPMux kann nach Peer-Trennung verstummen"
            );
        }
    }
    // Fail-open: EIN STUN-Timeout beim Start darf den ganzen Heim-Server nicht
    // mitreissen — so kam es durch (das restart-gate hielt bei seinem Exit
    // sogar Postgres/Redis an, Mac-E2E 2026-09-28). Der Heartbeat korrigiert
    // IP binnen eines Intervalls; bis dahin tragen Host-/LAN-Kandidaten.
    let initial = match stun_probe::discover_public_addr(&socket, &cfg.stun_servers).await {
        Ok(a) => {
            println!("[direct-adapter] öffentliche Adresse: {a}");
            a
        }
        Err(e) => {
            eprintln!(
                "[direct-adapter] initiale STUN-Ermittlung fehlgeschlagen ({e:#}) — starte ohne, Heartbeat korrigiert nach"
            );
            std::net::SocketAddr::new(
                std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
                cfg.direct_port,
            )
        }
    };
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
        // Die Server-App liefert die Host-LAN-IPs auf allen Plattformen; sie
        // werden als Host-Kandidaten in jede Answer injiziert (LAN-Clients).
        // Unverzichtbar im VM-Fall (Win/Mac podman machine: der Container
        // sieht nur die VM-Adresse) und unter der Docker-Bridge (172.17.x).
        println!(
            "[direct-adapter] zusätzliche Host-Kandidaten (Host-LAN): {}",
            cfg.extra_host_ips.iter().map(|ip| ip.to_string()).collect::<Vec<_>>().join(", ")
        );
    }
    // Die Außenadresse teilen sich Herzschlag (schreibt) und Fabrik (liest je
    // Answer) — sonst trüge nach einer Zwangstrennung jede Answer die alte IP.
    let (public_ip_tx, public_ip_rx) = tokio::sync::watch::channel(initial.ip());
    let factory = Arc::new(rtc::RtcFactory::new(
        socket,
        ident.certificate.clone(),
        &cfg.stun_servers,
        public_ip_rx,
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
                Ok(addr) => {
                    public_ip = addr.ip();
                    public_ip_tx.send_replace(public_ip);
                }
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
