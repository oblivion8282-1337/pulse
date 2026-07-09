//! STUN-Discovery: Welche öffentliche Adresse hat unser UDP-Socket?
//!
//! WICHTIG: Die Anfrage geht vom SELBEN Socket raus, der später WebRTC
//! spricht — nur dann gilt die gemeldete Adresse (Cone-NAT + Port-Preservation
//! der Fritz!Box, bewiesen im App-Hosting-Pivot). Mehrere STUN-Server werden
//! der Reihe nach probiert; der erste Treffer zählt.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use stun::agent::TransactionId;
use stun::message::{Getter, Message, Setter, BINDING_REQUEST};
use stun::xoraddr::XorMappedAddress;
use tokio::net::UdpSocket;

async fn query_one(socket: &UdpSocket, server: &str) -> Result<SocketAddr> {
    // Hostname selbst auflösen und IPv4 erzwingen — `send_to` mit Hostname
    // nimmt sonst den ersten DNS-Treffer (oft IPv6) und scheitert am
    // IPv4-gebundenen Socket ("address family not supported").
    let target = tokio::net::lookup_host(server)
        .await
        .with_context(|| format!("DNS-Auflösung {server}"))?
        .find(SocketAddr::is_ipv4)
        .with_context(|| format!("keine IPv4-Adresse für {server}"))?;

    let mut msg = Message::new();
    msg.set_type(BINDING_REQUEST);
    TransactionId::new().add_to(&mut msg)?;
    msg.encode();

    socket
        .send_to(&msg.raw, target)
        .await
        .with_context(|| format!("STUN-Send an {server}"))?;

    let mut buf = [0u8; 1500];
    let (n, _) = tokio::time::timeout(Duration::from_secs(3), socket.recv_from(&mut buf))
        .await
        .with_context(|| format!("STUN-Timeout ({server})"))??;

    let mut res = Message::new();
    res.raw = buf[..n].to_vec();
    res.decode()?;
    let mut xor = XorMappedAddress::default();
    xor.get_from(&res)?;
    Ok(SocketAddr::new(xor.ip, xor.port))
}

/// Fragt die STUN-Server der Reihe nach; erster Erfolg gewinnt.
pub async fn discover_public_addr(socket: &UdpSocket, servers: &[String]) -> Result<SocketAddr> {
    let mut last_err = None;
    for server in servers {
        match query_one(socket, server).await {
            Ok(addr) => return Ok(addr),
            Err(e) => last_err = Some(e),
        }
    }
    match last_err {
        Some(e) => Err(e.context("alle STUN-Server fehlgeschlagen")),
        None => bail!("keine STUN-Server konfiguriert"),
    }
}
