import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { discoverGateway } from './gateway.ts';
import { hostLanIpv4s } from './hostNetz.ts';
import { MEDIA_MAP_TCP, MEDIA_MAP_UDP } from './medienPorts.ts';
import {
  NATPMP_PORT,
  encodeExternalAddressRequest,
  parseExternalAddressResponse,
  encodeMapRequest,
  parseMapResponse,
  encodePcpMapRequest,
  parsePcpMapResponse,
} from './natpmp.ts';

/** Client-IP für PCP: die Host-Adresse im Subnetz des Gateways (hostNetz.ts).
 *  Vorher die erste nicht-interne IPv4 der Aufzählung — unter Windows gern
 *  ein VirtualBox-/Hotspot-/WSL-Adapter, und der Router lehnt ein Mapping für
 *  eine fremde Client-IP ab (RFC 6887 §11.2: ADDRESS_MISMATCH). */
function localIpv4(gateway: string): string {
  return hostLanIpv4s(undefined, { gateway })[0] ?? '0.0.0.0';
}

export { MEDIA_MAP_TCP, MEDIA_MAP_UDP };

export type MapVerdict = 'mapped' | 'partial' | 'cgnat' | 'unsupported';

export interface MapMediaPortsInput {
  stunIp: string | null;
  gateway?: string;
  natpmpPort?: number;
  lifetime?: number;
  timeoutMs?: number;
}

export interface MapMediaPortsResult {
  verdict: MapVerdict;
  wanIp: string | null;
  openPorts: number[];
  failedPorts: number[];
}

function isPrivateOrCgnat(ip: string): boolean {
  const o = ip.split('.').map(Number);
  const [a, b] = o;
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function udpRequest(gateway: string, port: number, packet: Buffer, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Ein Ausstieg für alle Wege; clearTimeout auf einem bereits gefeuerten
    // Timer ist ein No-op, daher darf finish ihn immer räumen.
    const finish = (result: Buffer | null) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(result);
    };

    timer = setTimeout(() => finish(null), timeoutMs);
    // Nur die Antwort des Gateways zählt — der Socket hängt an einem
    // Zufallsport auf allen Adressen, und jedes andere Paket darauf wäre
    // sonst „die Antwort" (gefälschte WAN-IP, gefälschtes Mapping).
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address === gateway && rinfo.port === port) finish(msg);
    });
    sock.on('error', () => finish(null));
    sock.send(packet, port, gateway, (err) => { if (err) finish(null); });
  });
}

// Entscheidung 6.1 (2026-09-21): PCP/NAT-PMP-Mappings haben eine Lifetime
// (Vorgabe 1 h) und verfielen bislang still — nach einer Stunde lief
// direktes Medien-Routing nur noch über ICE-Pfadauswahl. Ein Intervall
// erneuert die MAPPings bei ~½ Lifetime, solange das Hosting läuft.
let renewalTimer: ReturnType<typeof setTimeout> | null = null;
let letzteMappingEingabe: MapMediaPortsInput | null = null;

/** PCP-Nonce je Mapping (`proto:port`). RFC 6887 §11.1: eine Erneuerung
 *  MUSS dieselbe Nonce tragen — eine neue gilt dem Router als fremder
 *  Client, und er lehnt ab (NOT_AUTHORIZED) oder legt ein zweites Mapping an.
 *  Vorher bekam jede Erneuerung eine frische. */
const pcpNonces = new Map<string, Buffer>();
function nonceFuer(proto: 'udp' | 'tcp', port: number): Buffer {
  const k = `${proto}:${port}`;
  let n = pcpNonces.get(k);
  if (!n) { n = randomBytes(12); pcpNonces.set(k, n); }
  return n;
}

/** Was zuletzt wirklich angelegt wurde — für das Löschen beim Stopp. */
let angelegt: { gateway: string; pmPort: number; clientIp: string; pcp: boolean; udp: number[]; tcp: number[] } | null = null;

/** Stoppt die Erneuerung (App-Shutdown / Hosting-Ende). Die Mappings selbst
 *  bleiben bis zu ihrem Ablauf am Router — dafür ist loescheMappings da. */
export function stopMappingRenewal(): void {
  if (renewalTimer !== null) {
    clearTimeout(renewalTimer);
    renewalTimer = null;
  }
  letzteMappingEingabe = null;
}

/** Erneuerung stoppen UND die angelegten Mappings am Router löschen
 *  (Lifetime 0 — RFC 6886 §3.4 / RFC 6887 §15). Vorher blieben die Ports bis
 *  zu einer Stunde nach dem Hosting-Ende offen und zeigten auf ein Gerät, auf
 *  dem niemand mehr lauscht. Best-effort: ohne Antwort bleibt es beim Ablauf. */
export async function loescheMappings(timeoutMs = 1500): Promise<void> {
  stopMappingRenewal();
  const a = angelegt;
  angelegt = null;
  if (!a) return;
  const loesche = async (proto: 'udp' | 'tcp', port: number): Promise<void> => {
    const pkt = a.pcp
      ? encodePcpMapRequest({
        clientIp: a.clientIp, proto, internalPort: port, externalPort: 0, lifetime: 0,
        nonce: nonceFuer(proto, port),
      })
      : encodeMapRequest(proto, port, 0, 0);
    await udpRequest(a.gateway, a.pmPort, pkt, timeoutMs);
  };
  await Promise.all([
    ...a.udp.map((p) => loesche('udp', p)),
    ...a.tcp.map((p) => loesche('tcp', p)),
  ]);
  pcpNonces.clear();
}

/**
 * Erneuert die MAPPings periodisch. Fehlversuche sind best-effort —
 * ein Ausfall des Routers wird beim nächsten Intervall erneut versucht;
 * schlägt eine Runde KOMPLETT fehl, läuft der nächste trotzdem weiter
 * (kein Error-Splitting, kein Callback — die Erreichbarkeits-Diagnose
 * meldet den Zustand eh bei jedem Start).
 */
function starteRenewal(input: MapMediaPortsInput, lifetimeMs: number): void {
  stopMappingRenewal();
  letzteMappingEingabe = input;
  // Der Timer soll die App NICHT am Beenden hindern (Tests hängen sonst
  // am offenen Event-Loop-Handle); feuern tut er trotzdem, solange läuft.
  // unref für JEDEN geplanten Timer, nicht nur den ersten.
  const plane = (): void => {
    renewalTimer = setTimeout(() => { void erneuere(); }, lifetimeMs);
    renewalTimer.unref?.();
  };
  const erneuere = async (): Promise<void> => {
    if (letzteMappingEingabe === null) return;
    try {
      await mapMediaPorts(letzteMappingEingabe);
    } catch {
      /* best-effort — nächstes Intervall versucht wieder */
    }
    plane();
  };
  plane();
}

export async function mapMediaPorts(input: MapMediaPortsInput): Promise<MapMediaPortsResult> {
  const unsupported: MapMediaPortsResult = { verdict: 'unsupported', wanIp: null, openPorts: [], failedPorts: [] };

  const gateway = input.gateway ?? (await discoverGateway());
  if (!gateway) return unsupported;

  const pmPort = input.natpmpPort ?? NATPMP_PORT;
  const lifetime = input.lifetime ?? 3600;
  const timeoutMs = input.timeoutMs ?? 3000;

  // Get WAN IP via NAT-PMP external address request
  const addrBuf = await udpRequest(gateway, pmPort, encodeExternalAddressRequest(), timeoutMs);
  if (!addrBuf) return unsupported;

  const addrResp = parseExternalAddressResponse(addrBuf);
  if (!addrResp || addrResp.resultCode !== 0) return unsupported;

  const wanIp = addrResp.externalIp;

  // CGNAT check
  if (isPrivateOrCgnat(wanIp) || (input.stunIp != null && wanIp !== input.stunIp)) {
    return { verdict: 'cgnat', wanIp, openPorts: [], failedPorts: [] };
  }

  const openPorts: number[] = [];
  const failedPorts: number[] = [];
  const clientIp = localIpv4(gateway);
  // Kleinste vom Router GEWÄHRTE Laufzeit (s). Router kürzen die angefragte
  // gern (RFC 6887 §15: der Server darf sie verkürzen) — eine Erneuerung
  // nach der angefragten Hälfte käme dann zu spät.
  let gewaehrt = lifetime;
  const openUdp: number[] = [];
  const openTcp: number[] = [];
  // null = noch nicht erkannt, true = Router spricht PCP, false = nur NAT-PMP.
  // Detektiert beim ersten Port → höchstens EIN PCP-Timeout (nicht 15×).
  let usePcp: boolean | null = null;

  /** PCP-MAP-Versuch: true=gemappt, false=abgelehnt, null=keine PCP-Antwort. */
  const tryPcp = async (proto: 'udp' | 'tcp', port: number): Promise<boolean | null> => {
    const pkt = encodePcpMapRequest({
      clientIp, proto, internalPort: port, externalPort: port, lifetime, nonce: nonceFuer(proto, port),
    });
    const buf = await udpRequest(gateway, pmPort, pkt, timeoutMs);
    if (!buf) return null;
    const resp = parsePcpMapResponse(buf);
    if (!resp) return null;
    const ok = resp.resultCode === 0 && resp.externalPort === port;
    if (ok && resp.lifetime > 0) gewaehrt = Math.min(gewaehrt, resp.lifetime);
    return ok;
  };

  const mapPort = async (proto: 'udp' | 'tcp', port: number) => {
    // PCP zuerst (sofern nicht schon als nicht-unterstützt erkannt).
    if (usePcp !== false) {
      const pcp = await tryPcp(proto, port);
      if (pcp !== null) {
        usePcp = true;
        (pcp ? openPorts : failedPorts).push(port);
        if (pcp) (proto === 'udp' ? openUdp : openTcp).push(port);
        return;
      }
      if (usePcp === null) usePcp = false;  // Erst-Erkennung: kein PCP → NAT-PMP-Fallback
      else { failedPorts.push(port); return; }  // PCP lief, dieser Port still → fehlgeschlagen
    }
    // NAT-PMP-Fallback.
    const buf = await udpRequest(gateway, pmPort, encodeMapRequest(proto, port, port, lifetime), timeoutMs);
    if (!buf) { failedPorts.push(port); return; }
    const resp = parseMapResponse(buf);
    if (resp && resp.resultCode === 0 && resp.externalPort === port) {
      openPorts.push(port);
      (proto === 'udp' ? openUdp : openTcp).push(port);
      if (resp.lifetime > 0) gewaehrt = Math.min(gewaehrt, resp.lifetime);
    } else {
      failedPorts.push(port);
    }
  };

  for (const port of MEDIA_MAP_UDP) await mapPort('udp', port);
  for (const port of MEDIA_MAP_TCP) await mapPort('tcp', port);

  // openPorts/failedPorts bilden eine Partition aller Ports — 'mapped'
  // heißt also genau: alle durch.
  const allPorts = [...MEDIA_MAP_UDP, ...MEDIA_MAP_TCP];
  const verdict: MapVerdict = openPorts.length === allPorts.length ? 'mapped' : 'partial';

  // Erneuerung nur anwerfen, wenn überhaupt gemappt wurde; bei 'partial'
  // werden die offenen Ports mit erneuert, die fehlgeschlagenen versuchen
  // es erneut (ein Router, der einen Port ablehnte, lehnt ihn meist
  // weiter — schadet nicht).
  if (openPorts.length) {
    angelegt = { gateway, pmPort, clientIp, pcp: usePcp === true, udp: openUdp, tcp: openTcp };
  }
  if (verdict === 'mapped' || verdict === 'partial') {
    // ~½ der GEWÄHRTEN Lifetime (Faktor im Blockkommentar oben), mind. 30 s.
    starteRenewal(input, Math.max(30_000, gewaehrt * 500));
  } else {
    stopMappingRenewal();
  }

  return { verdict, wanIp, openPorts, failedPorts };
}
