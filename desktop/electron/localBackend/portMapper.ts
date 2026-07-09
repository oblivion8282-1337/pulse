import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { discoverGateway } from './gateway.ts';
import {
  NATPMP_PORT,
  encodeExternalAddressRequest,
  parseExternalAddressResponse,
  encodeMapRequest,
  parseMapResponse,
  encodePcpMapRequest,
  parsePcpMapResponse,
} from './natpmp.ts';

/** Erste nicht-interne IPv4 des Hosts (PCP braucht die Client-IP). */
function localIpv4(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '0.0.0.0';
}

export const MEDIA_MAP_UDP = [7882, 7883, 7884, 7885, 7886, 7887, 7888, 7889, 7890, 7891, 7892, 8189, 3478, 7900];
export const MEDIA_MAP_TCP = [7881, 1936];

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

    const finish = (result: Buffer | null) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closed */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    sock.on('message', (msg) => {
      clearTimeout(timer);
      finish(msg);
    });

    sock.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    sock.send(packet, port, gateway, (err) => {
      if (err) {
        clearTimeout(timer);
        finish(null);
      }
    });
  });
}

export async function mapMediaPorts(input: MapMediaPortsInput): Promise<MapMediaPortsResult> {
  const unsupported: MapMediaPortsResult = { verdict: 'unsupported', wanIp: null, openPorts: [], failedPorts: [] };

  const gateway = input.gateway ?? discoverGateway();
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
  const clientIp = localIpv4();
  // null = noch nicht erkannt, true = Router spricht PCP, false = nur NAT-PMP.
  // Detektiert beim ersten Port → höchstens EIN PCP-Timeout (nicht 15×).
  let usePcp: boolean | null = null;

  /** PCP-MAP-Versuch: true=gemappt, false=abgelehnt, null=keine PCP-Antwort. */
  const tryPcp = async (proto: 'udp' | 'tcp', port: number): Promise<boolean | null> => {
    const pkt = encodePcpMapRequest({
      clientIp, proto, internalPort: port, externalPort: port, lifetime, nonce: randomBytes(12),
    });
    const buf = await udpRequest(gateway, pmPort, pkt, timeoutMs);
    if (!buf) return null;
    const resp = parsePcpMapResponse(buf);
    if (!resp) return null;
    return resp.resultCode === 0 && resp.externalPort === port;
  };

  const mapPort = async (proto: 'udp' | 'tcp', port: number) => {
    // PCP zuerst (sofern nicht schon als nicht-unterstützt erkannt).
    if (usePcp !== false) {
      const pcp = await tryPcp(proto, port);
      if (pcp !== null) {
        usePcp = true;
        (pcp ? openPorts : failedPorts).push(port);
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
    } else {
      failedPorts.push(port);
    }
  };

  for (const port of MEDIA_MAP_UDP) await mapPort('udp', port);
  for (const port of MEDIA_MAP_TCP) await mapPort('tcp', port);

  const allPorts = [...MEDIA_MAP_UDP, ...MEDIA_MAP_TCP];
  const verdict: MapVerdict = failedPorts.length === 0 && openPorts.length === allPorts.length
    ? 'mapped'
    : 'partial';

  return { verdict, wanIp, openPorts, failedPorts };
}
