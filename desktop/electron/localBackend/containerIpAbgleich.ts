/**
 * Öffentliche IP ↔ LiveKit im Container (Linux) — die Brücke zwischen der
 * reinen Entscheidung (oeffentlicheIp.ts) und `pulse-livekit-node-ip` im Image
 * (infra/self-host/livekit-node-ip.sh). Begründung beider Teile: dort.
 */

import { rtExec, type ContainerRuntime } from './containerRuntime.ts';
import { containerName } from './containerWelt.ts';
import { discoverPublicIp } from './stun.ts';
import { gleicheOeffentlicheIpAb, taugtAlsOeffentlicheIp, type IpAbgleichErgebnis } from './oeffentlicheIp.ts';

const SKRIPT = '/usr/local/bin/pulse-livekit-node-ip';

/** Für die Container-Env beim Start: die öffentliche IPv4, oder undefined
 *  (dann bleibt LiveKit im STUN-Weg wie bisher). Nur Linux — Windows (VM)
 *  kündigt die LAN-IP an, macOS ist für diesen Weg ungetestet. */
export async function oeffentlicheIpFuerStart(): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  const ip = await discoverPublicIp().catch(() => null);
  return taugtAlsOeffentlicheIp(ip) ? ip : undefined;
}

/** Ein Abgleich gegen den laufenden Container. 'nicht-zustaendig': nicht
 *  Linux, oder ein Image ohne das Skript (älter als 2026-10-08) — dort bleibt
 *  LiveKit beim STUN-Weg. */
export async function gleicheContainerIpAb(
  rt: ContainerRuntime,
): Promise<IpAbgleichErgebnis | 'nicht-zustaendig'> {
  if (process.platform !== 'linux') return 'nicht-zustaendig';
  const zeige = await rtExec(rt, ['exec', containerName(), SKRIPT, '--zeige'], { timeoutMs: 10_000 });
  // 126/127 = Skript fehlt im Image; jeder andere Fehler = Container nicht da.
  if (zeige.code === 126 || zeige.code === 127) return 'nicht-zustaendig';
  return gleicheOeffentlicheIpAb({
    ermittle: () => discoverPublicIp(),
    gesetzte: async () => (zeige.code === 0 ? zeige.stdout.trim() : null),
    setze: async (ip) => {
      const r = await rtExec(rt, ['exec', containerName(), SKRIPT, ip, '--neustart'], { timeoutMs: 20_000 });
      if (r.code !== 0) throw new Error(`LiveKit-Adresse nicht gesetzt (exit ${r.code}): ${r.stderr.slice(0, 200)}`);
    },
  });
}
