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
use tokio::sync::watch;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::{API, APIBuilder};
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice::udp_mux::{UDPMuxDefault, UDPMuxParams};
use webrtc::ice::udp_network::UDPNetwork;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::certificate::RTCCertificate;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// Adressen, die in die ANSWER gehören (SDP-Filter): keine Container-Bridges
/// (Docker/Podman), kein CGNAT/Tailscale, kein IPv6 — ein IPv6-Leak aus
/// Docker-Bridges hat schon bei WHEP minutenlange Verbindungsaufbauten
/// verursacht. Übrig bleibt der LAN-Host-Kandidat; die öffentliche Adresse
/// kommt separat als srflx dazu.
///
/// Gilt NUR fürs, was Clients sehen — NICHT fürs Gathering des Agenten
/// (`is_gatherable_ip`).
fn is_useful_candidate_ip(ip: IpAddr) -> bool {
    let IpAddr::V4(v4) = ip else { return false };
    let [a, b, c, ..] = v4.octets();
    let docker_bridge = a == 172 && (16..=31).contains(&b);
    let cgnat_tailscale = a == 100 && (64..=127).contains(&b);
    // WSL2-DNS-Tunneling legt auf lo eine GLOBALE Pseudo-Adresse (10.255.255.254)
    // — der gather nimmt sie (kein 127.x), aber aus dem LAN ist sie tot, und ihr
    // Kandidat in der Answer multiplizierte den srflx mit identischer Foundation
    // — Firefox's strikter Parser verweigert darauf die ICE-Checks (Windows-E2E
    // 2026-10-01). ponytail: Interface-Namen kommen am IP-Filter nicht an; wird
    // WSL die Range je Version ändern, hier nachziehen.
    let wsl_dns_pseudo = a == 10 && b == 255 && c == 255;
    !(docker_bridge || cgnat_tailscale || wsl_dns_pseudo || v4.is_loopback())
}

/// Filter fürs GATHERING (Agent-intern): Im Container ist die Docker-Bridge-
/// IP die einzige Interface-Adresse. Verwirft man sie hier, gather der Agent
/// NULL Kandidaten — webrtc-rs bricht ab („Candidate IP could not be found",
/// Linux-E2E 2026-09-29), registriert sich nie an der UDPMux und droppt jeden
/// eingehenden Check („Dropping packet from …"). Der Agent gather also ALLE
/// IPv4-Interfaces; was daraus in die Answer geht, entscheiden
/// `sdp::strip_unusable_hosts` + die Injektionen (`is_useful_candidate_ip`).
///
/// Die Mux routet eingehende Checks ohnehin über den ufrag im STUN-USERNAME,
/// nicht über die Kandidaten-IP — die Bridge-IP als interner Kandidat ist
/// also funktional, solange sie nur existiert.
fn is_gatherable_ip(ip: IpAddr) -> bool {
    let IpAddr::V4(v4) = ip else { return false };
    !v4.is_loopback() && !v4.is_unspecified()
}

/// Filter für die von der Server-App INJIZIERTEN Host-LAN-IPs
/// (`PULSE_DIRECT_EXTRA_HOST_IPS`). Bewusst NICHT `is_useful_candidate_ip`:
/// dessen Bereichsregeln (172.16/12, 100.64/10) raten bei selbst gegatherten
/// Container-Adressen, ob es eine Bridge ist. Die Server-App kennt dagegen den
/// Interface-NAMEN und sortiert Bridges dort aus (`hostNetz.ts`,
/// VIRTUELLE_BRUECKE); ein echtes LAN in 172.16–31 oder ein Tailnet-Adapter
/// muss hier durch. Übrig bleibt nur, was nie ein Weg von außen sein kann.
fn is_injectable_host_ip(v4: std::net::Ipv4Addr) -> bool {
    !(v4.is_loopback()
        || v4.is_unspecified()
        || v4.is_link_local()
        || v4.is_multicast()
        || v4.is_broadcast())
}

pub struct RtcFactory {
    api: API,
    certificate: RTCCertificate,
    stun_urls: Vec<String>,
    /// Die per STUN ermittelte Außenadresse, laufend nachgeführt vom
    /// Herzschlag in main.rs (Sender dort). Bis 2026-10-08 ein fester Wert vom
    /// Start: nach einer Zwangstrennung (neue Heim-IP) trug jede Answer die
    /// alte Adresse als srflx, während das Telefonbuch schon die neue kannte.
    public_ip: watch::Receiver<IpAddr>,
    /// Host-LAN-IPs von der Server-App (alle Plattformen, s. config.rs) — als
    /// Host-Kandidaten in jede Answer injiziert (`sdp::inject_extra_hosts`);
    /// ohne sie enthielte die Answer im VM-Fall und unter der Docker-Bridge
    /// gar keine Host-Kandidaten (`strip_unusable_hosts` wirft sie aus).
    extra_host_ips: Vec<std::net::Ipv4Addr>,
    /// Der gemuxte UDP-Port — Ziel-Port der injizierten Host-Kandidaten
    /// (podman published ihn 1:1 auf dem VM-Host).
    mux_port: u16,
}

impl RtcFactory {
    /// `public_ip`: die per STUN ermittelte Außenadresse, je Answer frisch
    /// gelesen. Sie wird der Answer als srflx-Kandidat angehängt
    /// (`sdp::inject_srflx`) — der Mux-Pfad von webrtc-rs gathert selbst
    /// keinen srflx, ohne diesen Schritt sähe ein Client im Internet nur
    /// unerreichbare LAN-Adressen.
    pub fn new(
        socket: UdpSocket,
        certificate: RTCCertificate,
        stun_servers: &[String],
        public_ip: watch::Receiver<IpAddr>,
        mut extra_host_ips: Vec<std::net::Ipv4Addr>,
        mux_port: u16,
    ) -> Self {
        // Defense-in-Depth gegen einen Bug im Zulieferer (Server-App): keine
        // Loopback-/Link-local-Adressen in die Answer. Bridges sortiert die
        // Server-App selbst aus (s. `is_injectable_host_ip`).
        extra_host_ips.retain(|ip| is_injectable_host_ip(*ip));
        let mut se = SettingEngine::default();
        // mDNS-Fernkandidaten AUSWERFEN (Linux-E2E 2026-09-29): Chrome bietet
        // Host-Kandidaten als <uuid>.local an. Der Agent löst den Namen per
        // System-Resolver auf — auf Linux-Heimserver mit Docker/Podman-Bridges
        // liefert der BRIDGE-Adressen (z. B. 172.26.0.1), die UDPMux registriert
        // genau diese falsche Route, und Chromes STUN-Responses (ohne USERNAME —
        // Responses haben nie einen) werden von der Mux als nicht zuordenbar
        // gedroppt → checking → disconnected, ohne eine Antwort. Disabled wirft
        // entfernte .local-Kandidaten weg; die Paare laufen über srflx/host-
        // Kandidaten mit echter Adresse, deren Checks die Mux per USERNAME
        // zuordnen kann. Mac E2E fuhr zufällig durch (keine Bridges im
        // mDNS-Record).
        se.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
        se.set_udp_network(UDPNetwork::Muxed(UDPMuxDefault::new(UDPMuxParams::new(socket))));
        se.set_ip_filter(Box::new(is_gatherable_ip));
        let api = APIBuilder::new().with_setting_engine(se).build();
        let stun_urls = stun_servers.iter().map(|s| format!("stun:{s}")).collect();
        Self { api, certificate, stun_urls, public_ip, extra_host_ips, mux_port }
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
        // Bughunt Runde 3: Deadline wie in den Schwester-Implementierungen
        // (pulse-whip 5 s, Player 2 s) — webrtc-rs hängt gelegentlich beim
        // Kandidaten-Sammeln, und ohne Schranke parkt der Answer-Task für
        // immer und die gecachte PeerConnection wird nie geräumt.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            gathered.recv(),
        )
        .await;
        let local = pc
            .local_description()
            .await
            .context("keine local description nach Gathering")?;
        // Reihenfolge zählt: erst die nativ gegatherten, aber unbrauchbaren
        // Host-Kandidaten (Container-Bridge, CGNAT) aus der Answer werfen — der
        // Agent nutzt sie intern weiter (Mux-Registrierung), Clients sehen sie
        // nicht (aus LAN/Internet unerreichbar). Dann die VM-Host-LAN-Kandidaten
        // (stellen im VM-Fall überhaupt erst Host-Zeilen her), dann den srflx
        // anhängen (der sich an Host-Zeilen verankert).
        let usable = crate::sdp::strip_unusable_hosts(&local.sdp, is_useful_candidate_ip);
        let with_hosts =
            crate::sdp::inject_extra_hosts(&usable, &self.extra_host_ips, self.mux_port);
        Ok(crate::sdp::inject_srflx(&with_hosts, self.aktuelle_public_ip()))
    }

    /// Der jüngste Wert des Herzschlags (oder der vom Start).
    fn aktuelle_public_ip(&self) -> IpAddr {
        *self.public_ip.borrow()
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

    /// Der Linux-E2E-Kernbug (2026-09-29): im Container muss die Bridge-IP
    /// gegathert werden dürfen, sonst hat der Agent null Kandidaten.
    #[test]
    fn gathering_nimmt_bridge_ip_nicht_loopback() {
        assert!(is_gatherable_ip("172.17.0.2".parse().unwrap()));
        assert!(is_gatherable_ip("192.168.178.72".parse().unwrap()));
        assert!(!is_gatherable_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_gatherable_ip("::1".parse().unwrap()));
    }

    /// In die Answer gehören umgekehrt nur brauchbare Adressen.
    #[test]
    fn sdp_filter_verwirft_bridge_behaelt_lan() {
        assert!(!is_useful_candidate_ip("172.17.0.2".parse().unwrap()));
        assert!(!is_useful_candidate_ip("100.77.12.9".parse().unwrap()));
        assert!(is_useful_candidate_ip("192.168.178.72".parse().unwrap()));
    }

    /// WSL2-DNS-Tunneling (Windows-E2E 2026-10-01): auf lo liegt eine GLOBALE
    /// Pseudo-Adresse — gather-tauglich (intern nötig), aber nie in die Answer.
    #[test]
    fn sdp_filter_verwirft_wsl_dns_pseudoadresse() {
        assert!(is_gatherable_ip("10.255.255.254".parse().unwrap()));
        assert!(!is_useful_candidate_ip("10.255.255.254".parse().unwrap()));
        // Echtes 10/8-LAN bleibt brauchbar (manche Heimnetze fahren 10.x).
        assert!(is_useful_candidate_ip("10.0.0.5".parse().unwrap()));
    }

    /// Injizierte Host-LAN-IPs: die Server-App hat Bridges schon am
    /// Interface-Namen aussortiert — ein echtes LAN in 172.16/12 und ein
    /// Tailnet-Adapter müssen durch, Loopback/Link-local nicht.
    #[test]
    fn injizierte_ips_behalten_172er_lan_und_tailnet() {
        for ok in ["172.20.1.9", "172.16.0.10", "100.77.12.9", "192.168.178.87"] {
            assert!(is_injectable_host_ip(ok.parse().unwrap()), "{ok} muss durch");
        }
        for weg in ["127.0.0.1", "0.0.0.0", "169.254.3.4", "224.0.0.1", "255.255.255.255"] {
            assert!(!is_injectable_host_ip(weg.parse().unwrap()), "{weg} muss raus");
        }
    }

    async fn fabrik(
        public_ip: watch::Receiver<IpAddr>,
        extra: Vec<std::net::Ipv4Addr>,
    ) -> RtcFactory {
        let socket = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
        let cert = RTCCertificate::from_key_pair(rcgen::KeyPair::generate().unwrap()).unwrap();
        RtcFactory::new(socket, cert, &[], public_ip, extra, 7900)
    }

    /// Befund 2026-10-08: die Fabrik muss den Wert lesen, den der Herzschlag
    /// ZULETZT gemeldet hat, nicht den vom Start.
    #[tokio::test]
    async fn fabrik_sieht_neue_oeffentliche_ip_vom_herzschlag() {
        let (tx, rx) = watch::channel::<IpAddr>("46.128.100.64".parse().unwrap());
        let f = fabrik(rx, vec![]).await;
        assert_eq!(f.aktuelle_public_ip(), "46.128.100.64".parse::<IpAddr>().unwrap());
        tx.send_replace("84.10.20.30".parse().unwrap());
        assert_eq!(f.aktuelle_public_ip(), "84.10.20.30".parse::<IpAddr>().unwrap());
    }

    #[tokio::test]
    async fn fabrik_behaelt_injiziertes_172er_lan() {
        let (_tx, rx) = watch::channel::<IpAddr>("46.128.100.64".parse().unwrap());
        let extra = vec!["172.20.1.9".parse().unwrap(), "127.0.0.1".parse().unwrap()];
        let f = fabrik(rx, extra).await;
        assert_eq!(f.extra_host_ips, vec!["172.20.1.9".parse::<std::net::Ipv4Addr>().unwrap()]);
    }
}
