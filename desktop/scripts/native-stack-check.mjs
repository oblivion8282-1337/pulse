/**
 * native-stack-check.mjs — E2E-leicht: fährt den NATIVEN Stack (Prozessbaum
 * statt Container) mit Dummy-Pairing hoch und prüft die Health-Kette
 * postgres → garnet → weed → caddy → services → chat-gateway am Desktop-Port.
 *
 *   node scripts/native-stack-check.mjs
 *
 * Voraussetzung: resources-native/ (scripts/fetch-win-native.ps1).
 * Windows-only — das native Backend ist der Windows-Pfad.
 * Achtung Dev-Kiste: die internen Ports sind die Container-Ports
 * (8001-8005/5432/6379/9000/7880/9997) — der Dev-Stack (dev-up.fish) muss
 * aus sein, sonst kollidieren die Uvicorn-Services.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PULSE_NATIVE_ROOT = join(desktop, 'resources-native');

if (process.platform !== 'win32') {
  console.error('nur Windows — das native Backend ist der Windows-Pfad');
  process.exit(1);
}

const { NativeBackendManager } = await import(
  pathToFileURL(join(desktop, 'electron', 'localBackend', 'nativeBackend', 'nativeBackendManager.ts')).href
);

const CREDS = {
  instanceId: '1750000000000000001',
  ownerId: '1',
  hostname: 'heim-check.local',
  clientId: 'dev-client-id',
  clientSecret: 'dev-client-secret',
  cloudOrigin: 'https://howispulse.com',
  relaySubdomain: null,
  relayServerAddr: null,
  relayTunnelToken: null,
};

const userData = mkdtempSync(join(tmpdir(), 'pulse-native-e2e-'));
const manager = new NativeBackendManager();
manager.setzeCreds(CREDS);

const fail = async (msg) => {
  console.error(`FAIL: ${msg}`);
  await manager.stop().catch(() => {});
  try { rmSync(userData, { recursive: true, force: true }); } catch {}
  process.exit(1);
};

try {
  console.log('→ start (Erststart: initdb + venv-Startup, kann 1-2 min dauern) …');
  await manager.start({
    userData,
    creds: CREDS,
    onProgress: (step) => console.log(`  [${step}]`),
  });
  console.log('→ Stack steht. Probes …');

  const probe = async (url, label) => {
    const res = await fetch(url).then((r) => `${r.status}`).catch((e) => `ERR ${e.cause?.code ?? e.message}`);
    console.log(`  ${label}: ${res}`);
    return res;
  };
  const chat = await probe(`http://127.0.0.1:55580/api/chat/health`, 'chat-gateway via caddy');
  if (!chat.startsWith('2')) await fail(`chat health antwortet nicht (${chat})`);
  await probe(`http://127.0.0.1:55580/health/setup`, 'setup-health via caddy');
  await probe(`http://127.0.0.1:8001/health`, 'auth direkt');
  await probe(`http://127.0.0.1:8004/health`, 'media-svc direkt');

  console.log('PASS: nativer Stack komplett hochgefahren, Health-Kette grün.');
  await manager.stop();
  console.log('→ sauber gestoppt.');
  try { rmSync(userData, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  await fail(e.message ?? String(e));
}
