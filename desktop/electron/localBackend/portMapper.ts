import { createSocket } from 'node:dgram';
import { discoverGateway } from './gateway.ts';
import {
  NATPMP_PORT,
  encodeExternalAddressRequest,
  parseExternalAddressResponse,
  encodeMapRequest,
  parseMapResponse,
} from './natpmp.ts';

export const MEDIA_MAP_UDP = [7882, 7883, 7884, 7885, 7886, 7887, 7888, 7889, 7890, 7891, 7892, 8189, 3478];
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

  const mapPort = async (proto: 'udp' | 'tcp', port: number) => {
    const pkt = encodeMapRequest(proto, port, port, lifetime);
    const buf = await udpRequest(gateway, pmPort, pkt, timeoutMs);
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
