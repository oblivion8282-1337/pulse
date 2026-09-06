//! SDP-Nachbearbeitung des Direktpfads: srflx-Kandidat der öffentlichen
//! Adresse einhängen, Host-Kandidaten lesen.
//!
//! **Warum von Hand?** webrtc-rs gathert mit einem *gemuxten* UDP-Socket
//! grundsätzlich KEINE server-reflexiven Kandidaten
//! (`agent_gather.rs`: `UDPNetwork::Muxed(_) => continue`), und der
//! `set_nat_1to1_ips(.., Srflx)`-Zweig hängt genau in diesem übersprungenen
//! Arm — er ist im Mux-Betrieb wirkungslos. Prior-Art dafür:
//! `infra/self-host/direct-adapter/src/sdp.rs`.
//!
//! Der Direktpfad des Sidecars läuft bewusst OHNE Mux (jede Sitzung ihr
//! eigener Socket), und dort sammelt webrtc-rs srflx selbst — **solange ein
//! STUN-Server konfiguriert ist**. Diese Datei ist der SICHERHEITSNETZ für
//! den Fall, dass doch keiner im Answer landet (STUN blockiert, Zeitablauf):
//! dann wird die Außenadresse per eigener STUN-Anfrage ermittelt
//! ([`super::stun`]) und der Kandidat hier nachgetragen. Ohne ihn sähe ein
//! Zuschauer außerhalb des Heimnetzes nur unerreichbare LAN-Adressen.
//!
//! **Der Port der Nachreichung ist eine Annahme, keine Messung.** Der Probe
//! geht nach Möglichkeit über denselben Port wie der Host-Kandidat
//! (Port-Preservation der Fritz!Box, im Projekt nachgewiesen) — randomisiert
//! der Router die Ports, ist der nachgereichte Kandidat unbrauchbar, kostet
//! aber nur einen fehlgeschlagenen ICE-Prüflauf; die Host-Kandidaten bleiben
//! unangetastet.

use std::net::{IpAddr, SocketAddr};

/// Typ-Präferenz 100 (srflx) << 24 | local-pref 65535 << 8 | (256 - component)
fn srflx_priority(component: u32) -> u32 {
    (100 << 24) | (65535 << 8) | (256 - component)
}

/// Ein aus dem Answer gelesener Host-Kandidat — alles, was die STUN-Probe
/// braucht: welcher lokale Port gehört zur Sitzung?
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKandidat {
    pub component: u32,
    pub ip: String,
    pub port: u16,
}

/// Liest die Host-Kandidaten (UDP) aus einem SDP-Text.
///
/// Die Form der Zeile ist RFC 8839: `a=candidate:<foundation> <component>
/// <transport> <prio> <ip> <port> typ host …`. Alles andere (srflx, relay,
/// TCP) interessiert hier nicht — der Fallback soll nur da ansetzen, wo gar
/// kein srflx gesammelt wurde.
pub fn host_kandidaten(sdp: &str) -> Vec<HostKandidat> {
    let mut raus = Vec::new();
    for zeile in sdp.lines() {
        if !zeile.starts_with("a=candidate:") || !zeile.contains(" typ host") {
            continue;
        }
        let f: Vec<&str> = zeile.split_whitespace().collect();
        // a=candidate:<foundation> <component> udp <prio> <ip> <port> typ host
        let (Some(component), Some(transport), Some(ip), Some(port)) = (
            f.get(1).and_then(|c| c.parse::<u32>().ok()),
            f.get(2),
            f.get(4),
            f.get(5).and_then(|p| p.parse::<u16>().ok()),
        ) else {
            continue;
        };
        if !transport.eq_ignore_ascii_case("udp") {
            continue;
        }
        raus.push(HostKandidat { component, ip: ip.to_string(), port });
    }
    raus
}

/// Hängt hinter die vorhandenen Host-Kandidaten je Komponente einen srflx auf
/// die per STUN ermittelte Außenadresse an. No-op, wenn die öffentliche
/// Adresse bereits als Host-Kandidat auftaucht (Server mit echter Public-IP).
pub fn inject_srflx(sdp: &str, oeffentlich: SocketAddr) -> String {
    let IpAddr::V4(public_v4) = oeffentlich.ip() else {
        // IPv6-Außenadressen: kein NAT, kein srflx nötig
        return sdp.to_string();
    };
    let public = public_v4.to_string();

    let mut out: Vec<String> = Vec::with_capacity(sdp.lines().count() + 2);
    let mut appended = false;
    for line in sdp.lines() {
        out.push(line.to_string());
        if appended || !line.starts_with("a=candidate:") || !line.contains(" typ host") {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        // a=candidate:<foundation> <component> udp <prio> <ip> <port> typ host
        let (Some(component), Some(host_ip), Some(port)) = (
            f.get(1).and_then(|c| c.parse::<u32>().ok()),
            f.get(4),
            f.get(5),
        ) else {
            continue;
        };
        if *host_ip == public {
            appended = true; // öffentlich erreichbar ohne NAT
            continue;
        }
        // Foundation: stabil pro (typ, ip, proto) und verschieden von der des
        // Host-Kandidaten — daher aus der öffentlichen IP abgeleitet.
        let foundation = u32::from(public_v4) | 0x8000_0000;
        out.push(format!(
            "a=candidate:{} {} udp {} {} {} typ srflx raddr {} rport {}",
            foundation,
            component,
            srflx_priority(component),
            public,
            oeffentlich.port(),
            host_ip,
            port,
        ));
    }
    out.join("\r\n") + "\r\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    const SDP: &str = "v=0\r\na=candidate:111 1 udp 2130706431 192.168.178.87 7900 typ host\r\na=candidate:111 2 udp 2130706431 192.168.178.87 7900 typ host\r\na=end-of-candidates\r\n";

    /// Die Komponenten und Ports der Host-Kandidaten — die Eingabe der
    /// STUN-Probe. Getestet gegen denselben SDP-Text wie die Prior-Art.
    #[test]
    fn host_kandidaten_werden_gelesen() {
        let k = host_kandidaten(SDP);
        assert_eq!(
            k,
            vec![
                HostKandidat { component: 1, ip: "192.168.178.87".into(), port: 7900 },
                HostKandidat { component: 2, ip: "192.168.178.87".into(), port: 7900 },
            ]
        );
        assert!(host_kandidaten("v=0\r\n").is_empty());
        assert!(
            host_kandidaten("a=candidate:1 1 tcp 2130706431 10.0.0.2 8 typ host\r\n").is_empty(),
            "TCP-Kandidaten sind nicht Gegenstand der UDP-Probe"
        );
        assert!(
            host_kandidaten("a=candidate:1 1 udp 2130706431 10.0.0.2 8 typ srflx raddr 0.0.0.0 rport 0\r\n").is_empty(),
            "srflx darf nicht als Host gelten"
        );
    }

    #[test]
    fn appends_srflx_for_each_component() {
        let out = inject_srflx(SDP, "46.128.100.64:7900".parse().unwrap());
        let srflx: Vec<&str> = out.lines().filter(|l| l.contains("typ srflx")).collect();
        assert_eq!(srflx.len(), 2, "je Komponente ein srflx:\n{out}");
        assert!(srflx[0].contains("46.128.100.64 7900 typ srflx raddr 192.168.178.87 rport 7900"));
        assert!(srflx[0].contains(" 1 udp "));
        assert!(srflx[1].contains(" 2 udp "));
        // Host-Kandidaten bleiben erhalten (LAN-Weg).
        assert_eq!(out.lines().filter(|l| l.contains("typ host")).count(), 2);
    }

    #[test]
    fn noop_when_public_ip_is_already_host() {
        let sdp = SDP.replace("192.168.178.87", "46.128.100.64");
        let out = inject_srflx(&sdp, "46.128.100.64:7900".parse().unwrap());
        assert!(!out.contains("typ srflx"));
    }

    #[test]
    fn srflx_priority_below_host() {
        assert!(srflx_priority(1) < 2130706431);
        assert!(srflx_priority(1) > srflx_priority(2));
    }
}
