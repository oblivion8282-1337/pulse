// Default-Gateway-Discovery für NAT-PMP/PCP (UDP 5351 zum Gateway).
// Node hat keine Stdlib-API → Plattform-Route-Befehl parsen, Subnetz-Fallback.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';

// Entscheidung 6.6: async statt execFileSync — der Route-Befehl kann auf
// Maschinen mit vielen Adaptern Sekunden dauern; synchron blockierte das
// den MAIN-Prozess (alle Fenster) mitten im Hosting-Start.
const execFileAsync = promisify(execFile);

const RE_DARWIN = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/;
const RE_LINUX = /default\s+via\s+(\d+\.\d+\.\d+\.\d+)/;
const RE_IPV4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

const ROUTE_CMD: Partial<Record<NodeJS.Platform, [string, string[]]>> = {
  darwin: ['route', ['-n', 'get', 'default']],
  linux: ['ip', ['route', 'show', 'default']],
  win32: ['route', ['print', '0.0.0.0']],
};

/** Gateway der Default-Route mit der KLEINSTEN Metrik. Mehrere Default-
 *  Routen sind auf Windows der Normalfall (LAN + WLAN, VPN, Hotspot) — die
 *  erste Zeile von `route print` ist nur die erste in Windows' Tabelle, nicht
 *  die, über die Windows tatsächlich routet (das ist die mit der kleinsten
 *  Metrik). Linux dito bei `ip route show default` mit mehreren Zeilen; ohne
 *  `metric` gilt dort 0 (Kernel-Vorgabe). macOS liefert genau eine Route. */
export function parseGateway(platform: NodeJS.Platform, routeOutput: string): string | null {
  if (platform === 'darwin') {
    const m = routeOutput.match(RE_DARWIN);
    return m ? m[1] : null;
  }
  let best: { gw: string; metric: number } | null = null;
  const nimm = (gw: string, metric: number): void => {
    if (!best || metric < best.metric) best = { gw, metric };
  };
  if (platform === 'linux') {
    for (const line of routeOutput.split('\n')) {
      const m = line.match(RE_LINUX);
      if (!m) continue;
      const metric = line.match(/\bmetric\s+(\d+)/);
      nimm(m[1], metric ? Number(metric[1]) : 0);
    }
  } else if (platform === 'win32') {
    for (const line of routeOutput.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('0.0.0.0')) continue;
      const parts = t.split(/\s+/);
      // 0.0.0.0  0.0.0.0  <gateway>  <interface-IP>  <metric>
      if (parts.length < 3 || !RE_IPV4.test(parts[2]) || parts[2] === '0.0.0.0') continue;
      const metric = Number(parts[4]);
      nimm(parts[2], Number.isFinite(metric) ? metric : Number.MAX_SAFE_INTEGER);
    }
  }
  return (best as { gw: string } | null)?.gw ?? null;
}

function subnetFallbackGateway(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        return a.address.replace(/\.\d+$/, '.1');
      }
    }
  }
  return null;
}

export async function discoverGateway(): Promise<string | null> {
  const spec = ROUTE_CMD[process.platform];
  if (spec) {
    try {
      const [bin, args] = spec;
      const { stdout } = await execFileAsync(bin, args, {
        encoding: 'utf8', timeout: 3000,
      });
      const gw = parseGateway(process.platform, stdout);
      if (gw) return gw;
    } catch { /* fällt auf Subnetz-Heuristik */ }
  }
  return subnetFallbackGateway();
}
