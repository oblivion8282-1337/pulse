// NAT-Erreichbarkeits-Verdikt. Reine Logik — getrennt von der I/O-Orchestrierung
// (checkReachability, Task 4), damit voll unit-testbar.

export const PROBE_UDP_PORTS = [7882, 8189];
export const PROBE_TCP_PORTS = [7881, 1936];

export type ReachabilityVerdict = 'reachable' | 'needs-forwarding' | 'cgnat' | 'unknown';
export type ProbeResults = { udp: Record<number, boolean>; tcp: Record<number, boolean> };

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
  const ok =
    PROBE_UDP_PORTS.every((p) => probe.udp[p]) &&
    PROBE_TCP_PORTS.every((p) => probe.tcp[p]);
  return ok ? 'reachable' : 'needs-forwarding';
}
