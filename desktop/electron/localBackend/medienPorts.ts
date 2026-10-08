/**
 * Medien-Ports des allinone-Containers — EINE Quelle für Publish-Argumente
 * (Linux), Host-Relays (Windows), UDP-Gateway (macOS) und Router-Mapping
 * (portMapper.ts). Bis 2026-10-08 standen die Listen an vier Stellen getrennt,
 * und LiveKits `tcp_port: 7881` (infra/self-host/templates/livekit.yaml.template)
 * fehlte dabei im Publish UND im Windows-Relay, während portMapper und
 * reachability ihn mappten bzw. prüften — die Prüfung war damit immer rot.
 *
 * Die Werte MÜSSEN zu den Container-Configs passen (livekit.yaml.template,
 * 08-init-mediamtx.sh, Direktpfad-Adapter). Keine Electron-Imports.
 */

/** LiveKit-ICE (rtc.port_range_start..end). */
export const LIVEKIT_UDP = [7882, 7883, 7884, 7885, 7886, 7887, 7888, 7889, 7890, 7891, 7892];
/** LiveKit-ICE über TCP (rtc.tcp_port) — Rückfall für Netze, die UDP sperren. */
export const LIVEKIT_TCP = 7881;
/** TURN/STUN (UDP + TCP). */
export const TURN = 3478;
/** Direktpfad-ICE-Mux (WebRTC-DataChannel für Chat ohne Cloud im Datenweg). */
export const DIREKT_MUX = 7900;
/** MediaMTX-WHEP-ICE (Stream-Wiedergabe). */
export const WHEP_ICE = 8189;
/** MediaMTX-RTMPS-Ingest (Owner-Push auf `rtmps://localhost:1936`). */
export const RTMPS = 1936;

/** Alle Medien-UDP-Ports, die der Container bedient (macOS-Gateway-Relay). */
export const UDP_MEDIA_PORTS = [TURN, DIREKT_MUX, WHEP_ICE, ...LIVEKIT_UDP];

/** LiveKit-UDP als Bereich `erster-letzter` für `-p`. */
const LIVEKIT_UDP_BEREICH = `${LIVEKIT_UDP[0]}-${LIVEKIT_UDP[LIVEKIT_UDP.length - 1]}`;

/** Linux-Publish (`-p`): Medien gehen direkt zum Gerät, nicht über den Relay. */
export function mediaPortArgs(): string[] {
  return [
    '-p', `${TURN}:${TURN}/tcp`,
    '-p', `${TURN}:${TURN}/udp`,
    '-p', `${LIVEKIT_UDP_BEREICH}:${LIVEKIT_UDP_BEREICH}/udp`,
    '-p', `${LIVEKIT_TCP}:${LIVEKIT_TCP}/tcp`,
    '-p', `${RTMPS}:${RTMPS}/tcp`,
    '-p', `${WHEP_ICE}:${WHEP_ICE}/udp`,
    '-p', `${DIREKT_MUX}:${DIREKT_MUX}/udp`,
  ];
}

/** macOS (gvproxy): TCP-Publishes; UDP läuft über das Gateway (udpGateway.ts). */
export function macTcpPortArgs(): string[] {
  return [
    '-p', `0.0.0.0:${RTMPS}:${RTMPS}/tcp`,
    '-p', `0.0.0.0:${TURN}:${TURN}/tcp`,
    '-p', `0.0.0.0:${LIVEKIT_TCP}:${LIVEKIT_TCP}/tcp`,
  ];
}

/** UDP-Ports, die der Windows-Host-Relay in die VM spiegelt (udpRelay.ts).
 *  Bis 2026-10-01 war nur 7900 dabei — Voice/WHEP von ANDEREN Geräten an
 *  Win-Hosts blieb tot. Die Ankündigung der Host-LAN-IP passiert im Image
 *  (PULSE_VM_ANNOUNCE_IP → livekit `node_ip` / mediamtx
 *  `webrtcAdditionalHosts`). 3478 fehlt hier wie schon vorher — unverändert
 *  übernommen, ob der VM-Betrieb ihn braucht, ist nicht nachgeprüft. */
export const RELAY_UDP_PORTS = [DIREKT_MUX, ...LIVEKIT_UDP, WHEP_ICE];

/** TCP-Ports Host→VM (Windows, tcpRelay.ts) samt Bind-Adresse:
 *  - 1936 NUR 127.0.0.1: die Owner-Push-URL zeigt auf `localhost`; RTMPS aus
 *    dem LAN ist nicht vorgesehen.
 *  - 7881 auf 0.0.0.0: LiveKit kündigt `node_ip:7881` als TCP-Kandidaten an,
 *    fremde Geräte klopfen also an die Host-LAN-IP. */
export const RELAY_TCP_PORTS: ReadonlyArray<{ port: number; bind: string }> = [
  { port: RTMPS, bind: '127.0.0.1' },
  { port: LIVEKIT_TCP, bind: '0.0.0.0' },
];

/** Router-Mapping (NAT-PMP/PCP, portMapper.ts). */
export const MEDIA_MAP_UDP = [...LIVEKIT_UDP, WHEP_ICE, TURN, DIREKT_MUX];
export const MEDIA_MAP_TCP = [LIVEKIT_TCP, RTMPS];
