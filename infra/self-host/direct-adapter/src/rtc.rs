//! WebRTC-Annahme: EIN UDP-Port (Mux) für alle PeerConnections, Antworten
//! mit vollständigem ICE-Gathering (non-trickle — die Answer geht als ganzer
//! Block über das Signal-Relay zurück).
//!
//! Öffentliche Erreichbarkeit: der Mux-Pfad gathert KEINE srflx-Kandidaten
//! (siehe `sdp::inject_srflx`) — die per STUN ermittelte Außenadresse wird der
//! Answer nachträglich angehängt. Host-Kandidaten bleiben für LAN-Clients.

use std::net::IpAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::net::UdpSocket;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::{API, APIBuilder};
use webrtc::ice::udp_mux::{UDPMuxDefault, UDPMuxParams};
use webrtc::ice::udp_network::UDPNetwork;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::certificate::RTCCertificate;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// Adressen, die als ICE-Kandidat nur Zeit kosten: Container-Bridges
/// (Docker/Podman), CGNAT/Tailscale und **jedes IPv6** — ein IPv6-Leak aus
/// Docker-Bridges hat schon bei WHEP minutenlange Verbindungsaufbauten
/// verursacht. Übrig bleibt der LAN-Host-Kandidat; die öffentliche Adresse
/// kommt separat als srflx dazu.
fn is_useful_candidate_ip(ip: IpAddr) -> bool {
    let IpAddr::V4(v4) = ip else { return false };
    let [a, b, ..] = v4.octets();
    let docker_bridge = a == 172 && (16..=31).contains(&b);
    let cgnat_tailscale = a == 100 && (64..=127).contains(&b);
    !(docker_bridge || cgnat_tailscale || v4.is_loopback())
}

pub struct RtcFactory {
    api: API,
    certificate: RTCCertificate,
    stun_urls: Vec<String>,
    public_ip: IpAddr,
}

impl RtcFactory {
    /// `public_ip`: die per STUN ermittelte Außenadresse. Sie wird der Answer
    /// als srflx-Kandidat angehängt (`sdp::inject_srflx`) — der Mux-Pfad von
    /// webrtc-rs gathert selbst keinen srflx, ohne diesen Schritt sähe ein
    /// Client im Internet nur unerreichbare LAN-Adressen.
    pub fn new(
        socket: UdpSocket,
        certificate: RTCCertificate,
        stun_servers: &[String],
        public_ip: IpAddr,
    ) -> Self {
        let mut se = SettingEngine::default();
        se.set_udp_network(UDPNetwork::Muxed(UDPMuxDefault::new(UDPMuxParams::new(socket))));
        se.set_ip_filter(Box::new(is_useful_candidate_ip));
        let api = APIBuilder::new().with_setting_engine(se).build();
        let stun_urls = stun_servers.iter().map(|s| format!("stun:{s}")).collect();
        Self { api, certificate, stun_urls, public_ip }
    }

    /// Beantwortet einen Client-Offer: PeerConnection + Brücke verdrahten,
    /// Answer mit fertigem ICE-Gathering zurückgeben.
    pub async fn answer(&self, offer_sdp: String) -> Result<String> {
        let config = RTCConfiguration {
            certificates: vec![self.certificate.clone()],
            ice_servers: vec![RTCIceServer {
                urls: self.stun_urls.clone(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let pc = Arc::new(self.api.new_peer_connection(config).await?);
        crate::bridge::wire(&pc);
        monitor_lifecycle(&pc);

        pc.set_remote_description(RTCSessionDescription::offer(offer_sdp)?)
            .await
            .context("Offer unbrauchbar")?;
        let answer = pc.create_answer(None).await?;
        let mut gathered = pc.gathering_complete_promise().await;
        pc.set_local_description(answer).await?;
        let _ = gathered.recv().await;
        let local = pc
            .local_description()
            .await
            .context("keine local description nach Gathering")?;
        Ok(crate::sdp::inject_srflx(&local.sdp, self.public_ip))
    }
}

/// Hält die PeerConnection am Leben und räumt sie bei Failed/Closed ab —
/// ohne Registry: der Task besitzt das Arc, der Watcher weckt ihn.
fn monitor_lifecycle(pc: &Arc<RTCPeerConnection>) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<RTCPeerConnectionState>(4);
    pc.on_peer_connection_state_change(Box::new(move |st| {
        let tx = tx.clone();
        Box::pin(async move {
            let _ = tx.send(st).await;
        })
    }));
    let pc = pc.clone();
    tokio::spawn(async move {
        while let Some(st) = rx.recv().await {
            match st {
                RTCPeerConnectionState::Connected => log_selected_pair(&pc).await,
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                    let _ = pc.close().await;
                    return;
                }
                _ => {}
            }
        }
    });
}

/// Adressen aus dem eigenen Netz (RFC1918 / link-local / loopback). Nur für die
/// Klartext-Einordnung im Log — ein Client von außen hat keine davon.
fn is_lan_address(addr: &str) -> bool {
    match addr.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_private() || v4.is_link_local() || v4.is_loopback(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => false,
    }
}

/// Schreibt das gewählte ICE-Kandidatenpaar ins Log, sobald die Verbindung
/// steht. Genau hier entscheidet sich, ob der Direktpfad wirklich über das
/// Internet läuft: ist der Gegenpart **kein** LAN-Kandidat, hat der srflx-Weg
/// (öffentliche Adresse, `sdp::inject_srflx`) getragen. Im LAN gewinnt dagegen
/// immer der Host-Kandidat — der Beweis ist also nur ein Extern-Test wert.
///
/// Das Paar steht kurz nach `Connected` manchmal noch nicht bereit, deshalb ein
/// paar kurze Versuche statt einer einzelnen Abfrage.
async fn log_selected_pair(pc: &Arc<RTCPeerConnection>) {
    let dtls = pc.sctp().transport();
    let ice = dtls.ice_transport();
    for _ in 0..10 {
        if let Some(pair) = ice.get_selected_candidate_pair().await {
            let weg = if is_lan_address(&pair.remote.address) {
                "LAN (Host-Kandidat)"
            } else {
                "Internet (srflx trägt)"
            };
            println!(
                "[direct-adapter] verbunden über {weg}: \
                 lokal {}:{} [{}] <-> Gegenstelle {}:{} [{}]",
                pair.local.address,
                pair.local.port,
                pair.local.typ,
                pair.remote.address,
                pair.remote.port,
                pair.remote.typ,
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    eprintln!("[direct-adapter] verbunden, aber kein Kandidatenpaar abfragbar");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_adressen_werden_erkannt() {
        for lan in ["192.168.178.42", "10.0.0.5", "172.16.0.1", "169.254.1.1", "127.0.0.1"] {
            assert!(is_lan_address(lan), "{lan} sollte als LAN gelten");
        }
    }

    #[test]
    fn oeffentliche_adressen_gelten_als_internet() {
        // u.a. eine typische Mobilfunk-Adresse (CGNAT) — sie ist aus Sicht des
        // Servers eine Gegenstelle von außen, kein LAN-Kandidat.
        for wan in ["100.64.12.7", "159.195.150.54", "8.8.8.8"] {
            assert!(!is_lan_address(wan), "{wan} sollte als Internet gelten");
        }
    }
}
