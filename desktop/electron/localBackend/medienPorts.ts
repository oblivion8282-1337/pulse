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

/** Host-Port für den behind-proxy-HTTP des Containers (nur 127.0.0.1 —
 *  öffentlicher Zugang läuft über den Relay-Tunnel im Container). Bewusst
 *  hoch/ephemer, analog zu den alten nativen Default-Ports. */
export const HOST_HTTP_PORT = 55580;

/** macOS-Medienpfad (gvproxy): die podman-machine auf macOS published UDP
 *  nicht in die VM (nachgewiesen 2026-10-03: Pakete an published UDP-Ports
 *  kommen nie im Container an, auch nicht nach Outbound-Aktivität). Statt
 *  UDP-Publish deshalb der TCP-Port des UDP-Gateways (s6-Dienst im Image,
 *  nur 127.0.0.1); die Server-App bindet die Medien-UDP-Ports selbst und
 *  kapselt jeden Client-Flow per TCP-Frames dorthin (udpGateway.ts). */
export const UDP_GATEWAY_PORT = 55981;

/** LiveKit-ICE (rtc.port_range_start..end). */
export const LIVEKIT_UDP = [7882, 7883, 7884, 7885, 7886, 7887, 7888, 7889, 7890, 7891, 7892];
/** LiveKit-ICE über TCP (rtc.tcp_port) — Rückfall für Netze, die UDP sperren. */
export const LIVEKIT_TCP = 7881;
/** TURN/STUN (coturn im Image). **Nicht veröffentlicht und nicht gemappt**
 *  (seit 2026-10-08): kein Dienst gibt TURN-Zugangsdaten aus — LiveKit
 *  (livekit.yaml.template) hat keinen `turn`-Block, Web-Klient und
 *  Direktpfad tragen nur STUN-Server (`whep.ts`, `direct/registry.ts`), die
 *  TURN-Route liegt allein auf einem ungemergten P2P-Zweig. Ein offener
 *  3478 war damit eine Tür ohne Haus dahinter. Offener Punkt: wird TURN
 *  verdrahtet, gehört der Port (samt coturn-Relaybereich 49160–49200/udp,
 *  04-init-coturn.sh) wieder in Publish, Gateway und Router-Mapping. Die
 *  Cloud-Diagnose prüft 3478 nur bei VPS-Instanzen, nicht beim Heim-Server
 *  (`routes_selfhost_diagnose.py`, `medien=False` für app_host). */
export const TURN = 3478;
/** Direktpfad-ICE-Mux (WebRTC-DataChannel für Chat ohne Cloud im Datenweg). */
export const DIREKT_MUX = 7900;
/** MediaMTX-WHEP-ICE (Stream-Wiedergabe). */
export const WHEP_ICE = 8189;
/** MediaMTX-RTMPS-Ingest (Owner-Push auf `rtmps://127.0.0.1:1936` —
 *  07-render-env.sh setzt für app_host `MEDIAMTX_INGEST=127.0.0.1`). Nur
 *  Loopback: Gäste publishen per WHIP, RTMPS aus dem LAN/Internet ist nicht
 *  vorgesehen. Gilt auf ALLEN Plattformen (Windows: RELAY_TCP_PORTS). */
export const RTMPS = 1936;

/** Alle Medien-UDP-Ports, die der Container bedient (macOS-Gateway-Relay). */
export const UDP_MEDIA_PORTS = [DIREKT_MUX, WHEP_ICE, ...LIVEKIT_UDP];

/** LiveKit-UDP als Bereich `erster-letzter` für `-p`. */
const LIVEKIT_UDP_BEREICH = `${LIVEKIT_UDP[0]}-${LIVEKIT_UDP[LIVEKIT_UDP.length - 1]}`;

/** Linux-Publish (`-p`): Medien gehen direkt zum Gerät, nicht über den Relay. */
export function mediaPortArgs(): string[] {
  return [
    '-p', `${LIVEKIT_UDP_BEREICH}:${LIVEKIT_UDP_BEREICH}/udp`,
    '-p', `${LIVEKIT_TCP}:${LIVEKIT_TCP}/tcp`,
    '-p', `127.0.0.1:${RTMPS}:${RTMPS}/tcp`,
    '-p', `${WHEP_ICE}:${WHEP_ICE}/udp`,
    '-p', `${DIREKT_MUX}:${DIREKT_MUX}/udp`,
  ];
}

/** macOS (gvproxy): TCP-Publishes; UDP läuft über das Gateway (udpGateway.ts). */
export function macTcpPortArgs(): string[] {
  return [
    '-p', `127.0.0.1:${RTMPS}:${RTMPS}/tcp`,
    '-p', `0.0.0.0:${LIVEKIT_TCP}:${LIVEKIT_TCP}/tcp`,
  ];
}

/** UDP-Ports, die der Windows-Host-Relay in die VM spiegelt (udpRelay.ts).
 *  Bis 2026-10-01 war nur 7900 dabei — Voice/WHEP von ANDEREN Geräten an
 *  Win-Hosts blieb tot. Die Ankündigung der Host-LAN-IP passiert im Image
 *  (PULSE_VM_ANNOUNCE_IP → livekit `node_ip` / mediamtx
 *  `webrtcAdditionalHosts`). 3478 fehlt bewusst (TURN nicht verdrahtet,
 *  s. TURN). */
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

/** Router-Mapping (NAT-PMP/PCP, portMapper.ts). Ohne RTMPS (nur Loopback)
 *  und ohne TURN (nicht verdrahtet, s. dort). */
export const MEDIA_MAP_UDP = [...LIVEKIT_UDP, WHEP_ICE, DIREKT_MUX];
export const MEDIA_MAP_TCP = [LIVEKIT_TCP];
