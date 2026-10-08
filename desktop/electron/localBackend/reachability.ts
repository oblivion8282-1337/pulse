// NAT-Erreichbarkeit: reine Klassifikations-Logik (isCgnatIp/classifyReachability,
// voll unit-testbar) plus die I/O-Orchestrierung (checkReachability).
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { discoverPublicIp } from './stun.ts';

export const PROBE_UDP_PORTS = [7882, 8189];
export const PROBE_TCP_PORTS = [7881, 1936];

export type ReachabilityVerdict = 'reachable' | 'needs-forwarding' | 'cgnat' | 'unknown';
export type ProbeResults = {
  udp: Record<number, boolean>;
  tcp: Record<number, boolean>;
  /** UDP-Ports, die lokal schon belegt waren (EADDRINUSE) — dort kann das
   *  Token nicht bei UNS ankommen, das Ergebnis ist „nicht prüfbar", weder
   *  Erfolg noch Fehlschlag. Fehlt = alle geprüft. */
  nichtPruefbar?: number[];
};

/** true für RFC-6598 Carrier-Grade-NAT (100.64.0.0/10). */
export function isCgnatIp(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return false;
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

export function classifyReachability(
  stunIp: string | null,
  probe: ProbeResults | null,
): ReachabilityVerdict {
  if (stunIp === null || probe === null) return 'unknown';
  if (isCgnatIp(stunIp)) return 'cgnat';
  // Nicht prüfbare Ports zählen weder als Erfolg noch als Fehlschlag. Sind
  // ALLE UDP-Ports belegt (der eigene Container lief über einen App-Absturz
  // weiter, s. checkReachability), entscheidet allein die TCP-Probe — die
  // geht von der Cloud an DIESELBE öffentliche Adresse und denselben Router,
  // ist also ein Beleg für die Weiterleitung, wenn auch nicht für UDP.
  // Bewusst NICHT 'unknown': das führte vor Bughunt Runde 44 in eine
  // Dauerschleife aus 'something-paused'.
  const offen = new Set(probe.nichtPruefbar ?? []);
  const ok =
    PROBE_UDP_PORTS.every((p) => offen.has(p) || probe.udp[p]) &&
    PROBE_TCP_PORTS.every((p) => probe.tcp[p]);
  return ok ? 'reachable' : 'needs-forwarding';
}

export async function checkReachability(input: {
  probeUrl: string;
  discoverIp?: () => Promise<string | null>;
  timeoutMs?: number;
}): Promise<{ verdict: ReachabilityVerdict; publicIp: string | null; probe: ProbeResults | null }> {
  const timeoutMs = input.timeoutMs ?? 4000;
  const publicIp = await (input.discoverIp ?? discoverPublicIp)();
  if (!publicIp) return { verdict: 'unknown', publicIp: null, probe: null };

  const token = randomBytes(16).toString('hex');
  const received = new Set<number>();
  const sockets = PROBE_UDP_PORTS.map((port) => {
    const sock = createSocket('udp4');
    sock.on('message', (msg) => {
      if (msg.toString() === token) received.add(port);
    });
    return { port, sock };
  });
  try {
    // Bughunt Runde 44: EADDRINUSE heißt hier „die Ports hält bereits jemand
    // lokal“ — im App-Hosting-Fall unser EIGENER Container (`restart
    // unless-stopped` überlebt App-Crashs, der userland-proxy/rootlessport
    // hält 7882/8189/udp). Ein solcher Port ist NICHT PRÜFBAR (das Token
    // landet beim Container, nicht bei uns) — bis 2026-10-08 zählte er
    // stattdessen als „empfangen", also als Beleg, den es nie gab. Die
    // Verdikt-Rechnung (classifyReachability) klammert ihn aus.
    const nichtPruefbar: number[] = [];
    await Promise.all(sockets.map(({ port, sock }) =>
      new Promise<void>((resolve) => {
        sock.once('error', () => {
          nichtPruefbar.push(port);
          try { sock.close(); } catch { /* schon zu */ }
          resolve();
        });
        sock.bind(port, '0.0.0.0', () => resolve());
      })));

    let tcp: Record<number, boolean> = {};
    try {
      const resp = await fetch(input.probeUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          udp_ports: PROBE_UDP_PORTS, tcp_ports: PROBE_TCP_PORTS, token, public_ip: publicIp,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) return { verdict: 'unknown', publicIp, probe: null };
      const data = await resp.json() as { tcp: Record<string, boolean> };
      tcp = Object.fromEntries(PROBE_TCP_PORTS.map((p) => [p, !!data.tcp?.[String(p)]]));
    } catch {
      return { verdict: 'unknown', publicIp, probe: null };
    }

    await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 1500))); // auf UDP-Token warten
    const udp = Object.fromEntries(PROBE_UDP_PORTS.map((p) => [p, received.has(p)]));
    const probe: ProbeResults = nichtPruefbar.length ? { udp, tcp, nichtPruefbar } : { udp, tcp };
    return { verdict: classifyReachability(publicIp, probe), publicIp, probe };
  } finally {
    for (const { sock } of sockets) { try { sock.close(); } catch { /* ignore */ } }
  }
}
