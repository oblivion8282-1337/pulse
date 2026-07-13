/**
 * Erreichbarkeits-Selbsttest NACH dem Container-Start (Diagnose-only).
 *
 * Der holePunch-Modus der Server-App überspringt das Erreichbarkeits-Gate vor
 * dem Start bewusst (Medien lochen sich per ICE selbst) — eine blockierende
 * Firewall bleibt damit unsichtbar: der Server sieht grün aus, aber niemand
 * kann sprechen/streamen. Dieser Test fragt denselben Cloud-Prüfdienst wie die
 * Vor-Start-Diagnose (POST /api/auth/selfhost/reachability/probe,
 * routes_reachability.py) — aber im Live-Betrieb und NUR TCP:
 *
 *  - UDP-Probes brauchen einen lokalen Bind auf den Medien-Ports, um das Token
 *    zu empfangen — die hält im Live-Betrieb der Container (EADDRINUSE), und
 *    selbst bei freiem Bind würde eine DNAT-Regel externe Pakete am eigenen
 *    Socket vorbei in den Container leiten → falsche Alarme. TCP prüft die
 *    Cloud dagegen selbst (SYN-Connect), kein lokaler Bind nötig.
 *  - Vom Container-Port-Mapping (containerBackendManager.ts MEDIA_PORT_ARGS:
 *    3478 tcp/udp, 7882-7892 udp, 1936 tcp, 8189 udp, 7900 udp) liegt nur
 *    1936/tcp auch in der Cloud-Allowlist (ALLOWED_TCP={7881,1936}; 7881 mappt
 *    der App-Host-Container gar nicht). Ein nicht-allowlisteter Port lehnt der
 *    Dienst als Ganzes ab (400) → Portliste hier bewusst schmal halten.
 *
 * Ergebnis blockiert NICHTS — reine Anzeige in server.html. Netzwerk-/Dienst-
 * fehler → 'unavailable' (neutrale Zeile, kein Alarm). Keine Electron-Imports.
 */

import { randomBytes } from 'node:crypto';
import { discoverPublicIp } from './stun.ts';

/** Testbare Ports = Container-Mapping ∩ Cloud-Allowlist (Begründung oben). */
export const SELFTEST_TCP_PORTS = [1936];

/** Klartext-Gruppen für die Warn-Zeile — deckt die GESAMTE App-Host-Portliste
 *  ab (nicht nur die heute testbaren), damit eine erweiterte Cloud-Allowlist
 *  hier keinen Codewechsel braucht. Reihenfolge = Anzeige-Reihenfolge. */
const PORT_GROUPS: Array<{ label: string; match: (p: number) => boolean }> = [
  { label: 'Voice', match: (p) => p === 7881 || (p >= 7882 && p <= 7892) },
  { label: 'Streaming', match: (p) => p === 1936 || p === 8189 },
  { label: 'Verbindungsaufbau', match: (p) => p === 3478 || p === 7900 },
];

/** Betroffene Port-Gruppen in Klartext (dedupliziert, stabile Reihenfolge). */
export function portGroups(ports: number[]): string[] {
  return PORT_GROUPS
    .filter((g) => ports.some(g.match))
    .map((g) => g.label);
}

export type SelfTestStatus = 'ok' | 'blocked' | 'unavailable';

export interface SelfTestResult {
  status: SelfTestStatus;
  failedPorts: number[];
  /** Klartext-Gruppen der betroffenen Ports — für die Warn-Zeile im UI. */
  groups: string[];
}

/** Reine Entscheidung aus der Probe-Antwort (null = Prüfung nicht möglich). */
export function classifySelfTest(tcp: Record<number, boolean> | null): SelfTestResult {
  if (tcp === null) return { status: 'unavailable', failedPorts: [], groups: [] };
  const failed = SELFTEST_TCP_PORTS.filter((p) => !tcp[p]);
  return {
    status: failed.length ? 'blocked' : 'ok',
    failedPorts: failed,
    groups: portGroups(failed),
  };
}

/** Führt den Selbsttest aus. Jeder Fehler (kein STUN, Dienst down, non-2xx)
 *  landet fail-safe in 'unavailable' — nie ein throw Richtung IPC. */
export async function runSelfTest(input: {
  probeUrl: string;
  discoverIp?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SelfTestResult> {
  try {
    const publicIp = await (input.discoverIp ?? discoverPublicIp)();
    if (!publicIp) return classifySelfTest(null);

    // token ist Pflichtfeld des Prüfdiensts (UDP-Pfad) — hier ohne Funktion,
    // weil udp_ports leer bleibt (Begründung im Modul-Docstring).
    const resp = await (input.fetchImpl ?? fetch)(input.probeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        udp_ports: [],
        tcp_ports: SELFTEST_TCP_PORTS,
        token: randomBytes(16).toString('hex'),
        public_ip: publicIp,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 8000),
    });
    if (!resp.ok) return classifySelfTest(null);
    const data = await resp.json() as { tcp?: Record<string, boolean> };
    const tcp = Object.fromEntries(
      SELFTEST_TCP_PORTS.map((p) => [p, !!data.tcp?.[String(p)]]),
    );
    return classifySelfTest(tcp);
  } catch {
    return classifySelfTest(null);
  }
}
