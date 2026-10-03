/**
 * native-e2e-live.mjs — kompletter Lifecycle des nativen Backends gegen die
 * echte Dev-Cloud (Hetzner, pulse.unicutmedia.com): HostLifecycle-Phase Kette
 * (Lochungs-Modus wie die Server-App) → NativeBackendManager → Cloud-
 * Telefonbuch-Poll, bis der direct-adapter als "online" gemeldet ist.
 *
 *   node scripts/native-e2e-live.mjs <creds.json> [stay-seconds]
 *
 * creds.json: { creds: BootstrapCreds, cookie, instance } — erzeugt vom
 * Selbstbedienungs-Muster (heim-server-lauf.py) gegen /api/auth der Dev-Cloud.
 * stay-seconds: wie lange der Stack nach 'live' stehen bleibt (Hetzner-Probes),
 * dann sauberer Stopp. Default 900.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PULSE_NATIVE_ROOT = join(desktop, 'resources-native');

const [credsPath, stayArg] = process.argv.slice(2);
if (!credsPath) {
  console.error('Aufruf: node scripts/native-e2e-live.mjs <creds.json> [stay-seconds]');
  process.exit(1);
}
const staySeconds = Number(stayArg ?? 900);

const { NativeBackendManager } = await import(
  pathToFileURL(join(desktop, 'electron', 'localBackend', 'nativeBackend', 'nativeBackendManager.ts')).href
);
const { HostLifecycle } = await import(
  pathToFileURL(join(desktop, 'electron', 'hostLifecycle.ts')).href
);

const parsed = JSON.parse(readFileSync(credsPath, 'utf8'));
// API liefert snake_case → BootstrapCreds (camelCase) mappen.
const c = parsed.creds;
const CREDS = {
  instanceId: String(c.instance_id),
  ownerId: String(c.owner_user_id),
  hostname: c.hostname,
  clientId: c.client_id,
  clientSecret: c.client_secret,
  cloudOrigin: c.cloud_origin,
  relaySubdomain: c.relay_subdomain ?? null,
  relayServerAddr: c.relay_server_addr ?? null,
  relayTunnelToken: c.relay_tunnel_token ?? null,
};
const cookie = parsed.cookie;
const instance = parsed.instance;
// Dev-Besonderheit: die Dev-Cloud liefert im Bootstrap cloud_origin=howispulse.com
// (Prod-Wert) — der Adapter/Heartbeat muss aber gegen DIE Cloud laufen, die die
// Instanz kennt. Der Runner pinnt daher auf die Bootstrap-Basis (Env-Override).
const CLOUD = process.env.PULSE_E2E_CLOUD ?? 'https://pulse.unicutmedia.com';
CREDS.cloudOrigin = CLOUD;

if (process.platform !== 'win32') {
  console.error('nur Windows');
  process.exit(1);
}

const userData = mkdtempSync(join(tmpdir(), 'pulse-native-live-'));
const manager = new NativeBackendManager();
manager.setzeCreds(CREDS);

const phases = [];
const hl = new HostLifecycle({
  checkPrereqs: async () => (await manager.runtimeAvailable()) ? 'ok' : 'not-possible-here',
  startBackend: async ({ onProgress }) => {
    await manager.start({ userData, creds: CREDS, onProgress });
  },
  stopBackend: () => manager.stop(),
  checkReachability: async () => ({ verdict: 'unreachable', publicIp: null }),
  mapPorts: async () => ({ verdict: 'unsupported', openPorts: [], failedPorts: [] }),
  relayUrl: () => null,
}, { holePunch: true });

const zielPhase = await new Promise((resolve) => {
  const timeout = setTimeout(() => resolve(`timeout(${phases.join(' → ')})`), 6 * 60_000);
  hl.onPhase((e) => {
    phases.push(e.phase + (e.detail?.step ? `(${e.detail.step})` : ''));
    console.log(`  phase: ${e.phase}${e.detail?.step ? ` — ${e.detail.step}` : ''}`);
    if (['live', 'needs-your-help', 'not-possible-here', 'something-paused', 'superseded'].includes(e.phase)) {
      clearTimeout(timeout);
      resolve(e.phase);
    }
  });
  void hl.start();
});

console.log(`→ Lifecycle-Endphase: ${zielPhase}`);
if (zielPhase !== 'live') {
  await manager.stop().catch(() => {});
  process.exit(1);
}

// Telefonbuch-Poll: der direct-adapter heartbeated gegen die Cloud — bis er
// als "online" durchkommt, kann es einen Heartbeat-Takt (120s default) dauern.
const deadline = Date.now() + 6 * 60_000;
let tb = null;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${CLOUD}/api/auth/me/instances/${instance.id}/direct-endpoint`, {
      headers: { Cookie: cookie },
    });
    tb = await r.json();
    if (tb.online) break;
  } catch (e) {
    console.log(`  telefonbuch-poll: ${e.cause?.code ?? e.message}`);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log(`→ Telefonbuch: ${JSON.stringify(tb)}`);

console.log(`→ Stack bleibt ${staySeconds}s stehen (Hetzner-Probes) …`);
await new Promise((r) => setTimeout(r, staySeconds * 1000));

console.log('→ sauberer Stopp …');
await hl.stop();
try { rmSync(userData, { recursive: true, force: true }); } catch {}
console.log(`FERTIG — phases: ${phases.join(' → ')}, telefonbuch: ${JSON.stringify(tb)}`);
process.exit(tb?.online ? 0 : 2);
