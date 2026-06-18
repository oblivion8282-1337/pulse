// Default-Gateway-Discovery für NAT-PMP/PCP (UDP 5351 zum Gateway).
// Node hat keine Stdlib-API → Plattform-Route-Befehl parsen, Subnetz-Fallback.
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const RE_DARWIN = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/;
const RE_LINUX = /default\s+via\s+(\d+\.\d+\.\d+\.\d+)/;
const RE_IPV4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

const ROUTE_CMD: Partial<Record<NodeJS.Platform, [string, string[]]>> = {
  darwin: ['route', ['-n', 'get', 'default']],
  linux: ['ip', ['route', 'show', 'default']],
  win32: ['route', ['print', '0.0.0.0']],
};

export function parseGateway(platform: NodeJS.Platform, routeOutput: string): string | null {
  if (platform === 'darwin') {
    const m = routeOutput.match(RE_DARWIN);
    return m ? m[1] : null;
  }
  if (platform === 'linux') {
    const m = routeOutput.match(RE_LINUX);
    return m ? m[1] : null;
  }
  if (platform === 'win32') {
    for (const line of routeOutput.split('\n')) {
      const t = line.trim();
      if (t.startsWith('0.0.0.0')) {
        const parts = t.split(/\s+/);
        // 0.0.0.0  0.0.0.0  <gateway>  <iface>  <metric>
        if (parts.length >= 3 && RE_IPV4.test(parts[2]) && parts[2] !== '0.0.0.0') return parts[2];
      }
    }
    return null;
  }
  return null;
}

export function subnetFallbackGateway(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        return a.address.replace(/\.\d+$/, '.1');
      }
    }
  }
  return null;
}

export function discoverGateway(): string | null {
  const spec = ROUTE_CMD[process.platform];
  if (spec) {
    try {
      const [bin, args] = spec;
      const out = execFileSync(bin, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const gw = parseGateway(process.platform, out);
      if (gw) return gw;
    } catch { /* fällt auf Subnetz-Heuristik */ }
  }
  return subnetFallbackGateway();
}
