//! STUN-Discovery des Direktpfads: Welche öffentliche Adresse hat ein
//! UDP-Socket dieses Prozesses?
//!
//! Prior-Art: `infra/self-host/direct-adapter/src/stun_probe.rs` — derselbe
//! Aufbau, ein anderer Aufrufer: der Adapter fragt vom MUX-Socket aus (der
//! Port der Antwort ist dann der veröffentlichte), der Sidecar-Probe geht
//! nach Möglichkeit über denselben Port wie der gerade gesammelte
//! Host-Kandidat ([`oeffentliche_adresse`]), damit Port-Preservation des
//! Routers den nachgereichten srflx-Kandidaten vollständig richtig macht
//! (s. [`super::sdp`]).
//!
//! Mehrere Server werden der Reihe nach probiert; der erste Treffer zählt.
//! Heut nur einer (`stun.l.google.com`), die Schleife bleibt: der zweite ist
//! eine Zeile, kein Umbau.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use stun::agent::TransactionId;
use stun::message::{Getter, Message, Setter, BINDING_REQUEST};
use stun::xoraddr::XorMappedAddress;
use tokio::net::UdpSocket;

/// Die STUN-Server der Reihe nach. Hostname, nicht IP — `lookup_host` löst
/// auf und erzwingt IPv4 (der Probe-Socket ist IPv4-gebunden).
const SERVERS: &[&str] = &["stun.l.google.com:19302"];

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

/// Fragt die STUN-Server der Reihe nach über diesen Socket; erster Erfolg
/// gewinnt.
async fn discover_public_addr(socket: &UdpSocket) -> Result<SocketAddr> {
    let mut last_err = None;
    for server in SERVERS {
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

/// Öffentliche Adresse auf `port` ermitteln — oder auf einem Wegwerf-Port,
/// wenn `None`. Ersteres ist der Normalfall der Nachreichung: derselbe Port
/// wie der Host-Kandidat, damit die Außenadresse (bei Port-Preservation des
/// Routers) als GANZES stimmt. Scheitert die Bindung (Port belegt), ruft der
/// Aufrufer mit `None` nach — dann stimmt wenigstens die IP.
pub async fn oeffentliche_adresse(port: Option<u16>) -> Result<SocketAddr> {
    let socket = UdpSocket::bind(("0.0.0.0", port.unwrap_or(0)))
        .await
        .with_context(|| format!("Probe-Socket auf Port {port:?} binden"))?;
    discover_public_addr(&socket).await
}
