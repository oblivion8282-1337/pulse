//! SDP-Nachbearbeitung: srflx-Kandidat der öffentlichen Adresse einhängen.
//!
//! **Warum von Hand?** webrtc-rs gathert mit einem *gemuxten* UDP-Socket
//! grundsätzlich KEINE server-reflexiven Kandidaten
//! (`agent_gather.rs`: `UDPNetwork::Muxed(_) => continue`), und der
//! `set_nat_1to1_ips(.., Srflx)`-Zweig hängt genau in diesem übersprungenen
//! Arm — er ist im Mux-Betrieb wirkungslos. Die `Host`-Variante wiederum
//! *ersetzt* die LAN-Adresse und nimmt Clients im selben Netz den kurzen Weg.
//!
//! Also: Host-Kandidaten unangetastet lassen und pro Komponente einen srflx
//! mit der per STUN ermittelten Außenadresse anfügen. Eingehende STUN-Checks
//! landen auf demselben Mux-Port und werden über den ufrag zugeordnet.

use std::net::IpAddr;

/// Typ-Präferenz 100 (srflx) << 24 | local-pref 65535 << 8 | (256 - component)
fn srflx_priority(component: u32) -> u32 {
    (100 << 24) | (65535 << 8) | (256 - component)
}

/// Hängt hinter die vorhandenen Host-Kandidaten je Komponente einen
/// srflx-Kandidaten auf `public_ip` an. No-op, wenn die öffentliche Adresse
/// bereits als Host-Kandidat auftaucht (Server mit echter Public-IP).
pub fn inject_srflx(sdp: &str, public_ip: IpAddr) -> String {
    let IpAddr::V4(public_v4) = public_ip else {
        return sdp.to_string(); // IPv6-Außenadressen: kein NAT, kein srflx nötig
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
            port,
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

    #[test]
    fn appends_srflx_for_each_component() {
        let out = inject_srflx(SDP, "46.128.100.64".parse().unwrap());
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
        let out = inject_srflx(&sdp, "46.128.100.64".parse().unwrap());
        assert!(!out.contains("typ srflx"));
    }

    #[test]
    fn srflx_priority_below_host() {
        assert!(srflx_priority(1) < 2130706431);
        assert!(srflx_priority(1) > srflx_priority(2));
    }
}
