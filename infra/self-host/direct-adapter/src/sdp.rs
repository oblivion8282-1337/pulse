//! SDP-Nachbearbeitung: Kandidaten einhängen, die webrtc-rs nicht selbst
//! gathern kann — den srflx der öffentlichen Adresse und (Container-in-VM)
//! Host-Kandidaten für die LAN-IPs des VM-Hosts.
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
//!
//! **Container-in-VM (Win/Mac, podman machine):** Der Container sieht nur die
//! VM-interne Adresse (z.B. 172.28.x — vom ip_filter zu Recht verworfen, aus
//! dem LAN unerreichbar). Damit enthält die Answer OHNE Nachhilfe GAR KEINE
//! Kandidaten — nicht mal den srflx, denn `inject_srflx` hängt sich an
//! Host-Zeilen. Die LAN-IPs des VM-Hosts (dort published podman den Mux-Port)
//! kommen deshalb per `PULSE_DIRECT_EXTRA_HOST_IPS` herein und werden hier als
//! Host-Kandidaten synthetisiert; der srflx hat danach wieder seinen Anker.

use std::net::{IpAddr, Ipv4Addr};

/// Typ-Präferenz 100 (srflx) << 24 | local-pref 65535 << 8 | (256 - component)
fn srflx_priority(component: u32) -> u32 {
    (100 << 24) | (65535 << 8) | (256 - component)
}

/// Priorität injizierter Host-Kandidaten: Typ-Präferenz 126 (host), aber
/// local-pref 65534 — knapp UNTER nativ gegatherten Host-Kandidaten (65535).
/// Wo beide existieren (Linux: Container sieht die LAN-IP selbst), gewinnt
/// weiterhin der native kurze Weg; die injizierten greifen nur als Zusatzweg.
fn injected_host_priority(component: u32) -> u32 {
    (126 << 24) | (65534 << 8) | (256 - component)
}

/// ICE-Komponenten der vorhandenen Host-Kandidaten — oder `[1]`, wenn keine da
/// sind (Container-in-VM: der ip_filter hat alle Interfaces verworfen).
/// DataChannel-Answers sind BUNDLE/rtcp-mux → Komponente 1 genügt dann.
fn host_components(sdp: &str) -> Vec<u32> {
    let mut comps: Vec<u32> = sdp
        .lines()
        .filter(|l| l.starts_with("a=candidate:") && l.contains(" typ host"))
        .filter_map(|l| l.split_whitespace().nth(1)?.parse().ok())
        .collect();
    comps.sort_unstable();
    comps.dedup();
    if comps.is_empty() {
        comps.push(1);
    }
    comps
}

/// Host-IPs, die bereits als Kandidat in der SDP stehen (Dedup-Grundlage).
fn existing_host_ips(sdp: &str) -> Vec<String> {
    sdp.lines()
        .filter(|l| l.starts_with("a=candidate:") && l.contains(" typ host"))
        .filter_map(|l| l.split_whitespace().nth(4).map(str::to_string))
        .collect()
}

/// Synthetisiert Host-Kandidaten für die LAN-IPs des VM-Hosts (`extra_ips`,
/// aus `PULSE_DIRECT_EXTRA_HOST_IPS`) auf dem Mux-Port. Eingefügt wird nach
/// der letzten vorhandenen Kandidaten-Zeile bzw. — wenn (VM-Fall) keine
/// existiert — nach `a=ice-pwd:` (steht in jeder Media-Section). IPs, die
/// schon als Host-Kandidat da sind, werden übersprungen (Linux-No-op).
pub fn inject_extra_hosts(sdp: &str, extra_ips: &[Ipv4Addr], port: u16) -> String {
    if extra_ips.is_empty() {
        return sdp.to_string();
    }
    let present = existing_host_ips(sdp);
    let fresh: Vec<&Ipv4Addr> =
        extra_ips.iter().filter(|ip| !present.contains(&ip.to_string())).collect();
    if fresh.is_empty() {
        return sdp.to_string();
    }
    let comps = host_components(sdp);

    // Anker bestimmen: letzte a=candidate-Zeile, sonst die erste a=ice-pwd.
    let lines: Vec<&str> = sdp.lines().collect();
    let anchor = lines
        .iter()
        .rposition(|l| l.starts_with("a=candidate:"))
        .or_else(|| lines.iter().position(|l| l.starts_with("a=ice-pwd:")));
    let Some(anchor) = anchor else { return sdp.to_string() };

    let mut out: Vec<String> = Vec::with_capacity(lines.len() + fresh.len() * comps.len());
    for (i, line) in lines.iter().enumerate() {
        out.push((*line).to_string());
        if i != anchor {
            continue;
        }
        for ip in &fresh {
            for &component in &comps {
                // Foundation: stabil pro IP, disjunkt von srflx (dort ist das
                // oberste Bit gesetzt) und von webrtc-rs-Foundations.
                let foundation = u32::from(**ip) | 0x4000_0000;
                out.push(format!(
                    "a=candidate:{} {} udp {} {} {} typ host",
                    foundation,
                    component,
                    injected_host_priority(component),
                    ip,
                    port,
                ));
            }
        }
    }
    out.join("\r\n") + "\r\n"
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

    /// VM-Fall (Win/Mac podman machine): ip_filter hat ALLE Interfaces
    /// verworfen — keine Host-Kandidaten, nur ice-ufrag/-pwd in der Section.
    const SDP_NO_HOSTS: &str =
        "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:abcd\r\na=ice-pwd:efgh1234\r\na=setup:passive\r\n";

    #[test]
    fn vm_fall_synthesisiert_host_kandidaten_und_srflx_greift_wieder() {
        let lan: Ipv4Addr = "192.168.178.42".parse().unwrap();
        let with_hosts = inject_extra_hosts(SDP_NO_HOSTS, &[lan], 7900);
        let hosts: Vec<&str> = with_hosts.lines().filter(|l| l.contains("typ host")).collect();
        assert_eq!(hosts.len(), 1, "Komponente 1 synthetisiert:\n{with_hosts}");
        assert!(hosts[0].contains("192.168.178.42 7900 typ host"));
        // Anker: direkt nach a=ice-pwd (keine Kandidaten-Zeile vorhanden).
        let lines: Vec<&str> = with_hosts.lines().collect();
        let pwd = lines.iter().position(|l| l.starts_with("a=ice-pwd:")).unwrap();
        assert!(lines[pwd + 1].contains("typ host"));
        // Und der srflx hat dadurch wieder seinen Anker:
        let full = inject_srflx(&with_hosts, "46.128.100.64".parse().unwrap());
        assert!(full.contains("46.128.100.64 7900 typ srflx raddr 192.168.178.42 rport 7900"));
    }

    #[test]
    fn extra_hosts_dedup_gegen_native_kandidaten() {
        // Linux-Fall: Container sieht die LAN-IP selbst → No-op statt Doppel.
        let lan: Ipv4Addr = "192.168.178.87".parse().unwrap();
        let out = inject_extra_hosts(SDP, &[lan], 7900);
        assert_eq!(out.lines().filter(|l| l.contains("typ host")).count(), 2);
    }

    #[test]
    fn extra_hosts_mit_nativen_kandidaten_haengen_sich_hinten_an() {
        let extra: Ipv4Addr = "10.0.0.9".parse().unwrap();
        let out = inject_extra_hosts(SDP, &[extra], 7900);
        // Native (Komponenten 1+2) bleiben, extra kommt je Komponente dazu.
        assert_eq!(out.lines().filter(|l| l.contains("typ host")).count(), 4);
        assert!(out.contains("10.0.0.9 7900 typ host"));
        // end-of-candidates bleibt hinter allen Kandidaten.
        let lines: Vec<&str> = out.lines().collect();
        let last_cand = lines.iter().rposition(|l| l.starts_with("a=candidate:")).unwrap();
        let eoc = lines.iter().position(|l| l.contains("end-of-candidates")).unwrap();
        assert!(eoc > last_cand);
    }

    #[test]
    fn injected_host_priority_unter_nativen_hosts() {
        assert!(injected_host_priority(1) < 2130706431); // webrtc-rs-Host-Prio
        assert!(injected_host_priority(1) > srflx_priority(1)); // aber über srflx
    }

    #[test]
    fn keine_extra_ips_ist_noop() {
        assert_eq!(inject_extra_hosts(SDP, &[], 7900), SDP);
    }
}
