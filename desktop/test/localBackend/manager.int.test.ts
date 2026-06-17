/**
 * Integration-Test: LocalBackendManager — vollständiger Stack-Start.
 *
 * Ausführen:
 *   cd /Users/michael/Documents/pulse/desktop && \
 *   PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH" \
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     --test --test-timeout=120000 \
 *     test/localBackend/manager.int.test.ts
 *
 * Wird übersprungen, wenn initdb, redis-server, minio oder uv nicht auflösbar.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

import { resolveBinary, BinaryNotFoundError } from '../../electron/localBackend/paths.ts';
import { httpHealth, tcpProbe } from '../../electron/localBackend/health.ts';
import { LocalBackendManager } from '../../electron/localBackend/localBackendManager.ts';

// ---------------------------------------------------------------------------
// Dependency-Guard
// ---------------------------------------------------------------------------

function binsAvailable(): boolean {
  const required = ['initdb', 'redis-server', 'minio'] as const;
  for (const bin of required) {
    try { resolveBinary(bin); } catch (e) {
      if (e instanceof BinaryNotFoundError) {
        console.log(`[manager.int.test] Überspringe: ${bin} nicht gefunden.`);
        return false;
      }
    }
  }
  try {
    execFileSync('uv', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    console.log('[manager.int.test] Überspringe: uv nicht gefunden.');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Freie Ports allozieren
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ---------------------------------------------------------------------------
// Test-Suite
// ---------------------------------------------------------------------------

// REPO_ROOT: von test/localBackend/ → test/ → desktop/ → repo-root
// new URL('.', import.meta.url).pathname = .../desktop/test/localBackend/
// ../../.. → .../pulse/
const REPO_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..');

describe('LocalBackendManager integration', { skip: !binsAvailable() }, () => {
  let tmpDir: string;
  let manager: LocalBackendManager;
  let ports: {
    postgres: number; redis: number; minio: number;
    auth: number; chat: number; media: number; mediaAuthHook: number;
  };

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pulse-mgr-test-'));
    manager = new LocalBackendManager();

    // Alle Ports dynamisch allozieren
    const [pg, redis, minio, auth, chat, media, hook] = await Promise.all([
      getFreePort(), getFreePort(), getFreePort(),
      getFreePort(), getFreePort(), getFreePort(), getFreePort(),
    ]);
    ports = { postgres: pg, redis, minio, auth, chat, media, mediaAuthHook: hook };

    console.log('[test] Ports:', ports);
    console.log('[test] tmpDir:', tmpDir);
    console.log('[test] repoRoot:', REPO_ROOT);

    await manager.start({
      userData: tmpDir,
      identity: {
        hostname: 'pulse-test.local',
        instanceId: '100',
        ownerId: '1',
      },
      ports,
      repoRoot: REPO_ROOT,
    });
  }, { timeout: 120_000 });

  after(async () => {
    try { await manager.stop(); } catch (e) { console.error('[test] stop-Fehler:', e); }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignorieren */ }
  }, { timeout: 30_000 });

  test('chat-gateway /health antwortet 200', async () => {
    const ok = await httpHealth(`http://127.0.0.1:${ports.chat}/health`, 5000);
    assert.ok(ok, 'chat-gateway /health sollte 200 zurückgeben');
  });

  test('manager.status() zeigt alle Komponenten als running', () => {
    const s = manager.status();
    assert.equal(s.state, 'running', `manager state: ${s.state}`);

    const expected = [
      'postgres', 'redis', 'minio', 'auth',
      'media-svc', 'mediamtx-auth-hook', 'chat-gateway',
    ];
    for (const name of expected) {
      assert.equal(
        s.components[name],
        'running',
        `Komponente '${name}' sollte 'running' sein, ist: ${s.components[name]}`,
      );
    }
  });

  test('nach stop() sind Ports nicht mehr erreichbar', async () => {
    await manager.stop();

    // Kurz warten damit die Ports freigegeben werden
    await new Promise(r => setTimeout(r, 500));

    const chatOk = await tcpProbe(ports.chat, '127.0.0.1', 500);
    assert.equal(chatOk, false, 'chat-gateway Port sollte nach stop() nicht mehr lauschen');

    const redisOk = await tcpProbe(ports.redis, '127.0.0.1', 500);
    assert.equal(redisOk, false, 'redis Port sollte nach stop() nicht mehr lauschen');
  });
});
