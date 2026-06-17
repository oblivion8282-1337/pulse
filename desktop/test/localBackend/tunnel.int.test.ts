/**
 * Integrationstest: chat-gateway ist durch einen rathole-Tunnel erreichbar.
 *
 * Ausführen:
 *   cd /Users/michael/Documents/pulse/desktop && \
 *   PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH" \
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     --test --test-timeout=120000 \
 *     test/localBackend/tunnel.int.test.ts
 *
 * Wird übersprungen, wenn initdb, redis-server, minio, uv oder rathole fehlen.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';

import { resolveBinary, BinaryNotFoundError } from '../../electron/localBackend/paths.ts';
import { httpHealth, tcpProbe, waitFor } from '../../electron/localBackend/health.ts';
import { LocalBackendManager } from '../../electron/localBackend/localBackendManager.ts';
import { RATHOLE_TUNNEL_NAME } from '../../electron/localBackend/tunnel.ts';

// ---------------------------------------------------------------------------
// Dependency-Guard
// ---------------------------------------------------------------------------

function binsAvailable(): boolean {
  const required = ['initdb', 'redis-server', 'minio', 'rathole'] as const;
  for (const bin of required) {
    try { resolveBinary(bin); } catch (e) {
      if (e instanceof BinaryNotFoundError) {
        console.log(`[tunnel.int.test] Überspringe: ${bin} nicht gefunden.`);
        return false;
      }
    }
  }
  try {
    execFileSync('uv', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    console.log('[tunnel.int.test] Überspringe: uv nicht gefunden.');
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
// rathole-Server-Konfiguration schreiben + starten
// ---------------------------------------------------------------------------

function writeRatholeServerConfig(
  configPath: string,
  relayPort: number,
  exposedPort: number,
): void {
  const toml = [
    '[server]',
    `bind_addr = "127.0.0.1:${relayPort}"`,
    '',
    `[server.services.${RATHOLE_TUNNEL_NAME}]`,
    'type = "tcp"',
    `bind_addr = "127.0.0.1:${exposedPort}"`,
    'token = "T"',
    '',
  ].join('\n');
  writeFileSync(configPath, toml, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Test-Suite
// ---------------------------------------------------------------------------

// REPO_ROOT: von test/localBackend/ → test/ → desktop/ → repo-root
const REPO_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..');

describe('Tunnel-Integration: chat-gateway durch rathole erreichbar', { skip: !binsAvailable() }, () => {
  let tmpDir: string;
  let manager: LocalBackendManager;
  let ratholeServer: ChildProcess | null = null;
  let relayPort: number;
  let exposedPort: number;
  let ports: {
    postgres: number; redis: number; minio: number;
    auth: number; chat: number; media: number; mediaAuthHook: number;
  };

  before(async () => {
    // Kurzes Präfix: Unix-Socket-Pfad darf max 103 Zeichen haben
    tmpDir = mkdtempSync(join(tmpdir(), 'pt-'));
    manager = new LocalBackendManager();

    // Alle Ports dynamisch allozieren
    const [pg, redis, minio, auth, chat, media, hook, relay, exposed] = await Promise.all([
      getFreePort(), getFreePort(), getFreePort(),
      getFreePort(), getFreePort(), getFreePort(), getFreePort(),
      getFreePort(), getFreePort(),
    ]);
    ports = { postgres: pg, redis, minio, auth, chat, media, mediaAuthHook: hook };
    relayPort = relay;
    exposedPort = exposed;

    console.log('[test] Ports:', { ...ports, relayPort, exposedPort });
    console.log('[test] tmpDir:', tmpDir);
    console.log('[test] repoRoot:', REPO_ROOT);
    console.log('[test] RATHOLE_TUNNEL_NAME:', RATHOLE_TUNNEL_NAME);

    // rathole-Server-Config schreiben
    const serverConfigPath = join(tmpDir, 'rathole-server.toml');
    writeRatholeServerConfig(serverConfigPath, relayPort, exposedPort);

    // rathole-Server starten (vor manager.start)
    const ratholeBin = resolveBinary('rathole');
    ratholeServer = spawn(ratholeBin, ['--server', serverConfigPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ratholeServer.stdout?.on('data', (d: Buffer) =>
      console.log('[rathole-server]', d.toString().trim()),
    );
    ratholeServer.stderr?.on('data', (d: Buffer) =>
      console.log('[rathole-server]', d.toString().trim()),
    );
    ratholeServer.on('error', (e) => console.error('[rathole-server] Fehler:', e));

    // Warten bis rathole-Server auf relayPort lauscht
    console.log(`[test] Warte auf rathole-Server (Port ${relayPort})...`);
    await waitFor(() => tcpProbe(relayPort, '127.0.0.1', 500), 15_000, 300);
    console.log('[test] rathole-Server bereit.');

    // ① Stack + rathole-Client starten
    await manager.start({
      userData: tmpDir,
      identity: {
        hostname: 'pulse-test.local',
        instanceId: '100',
        ownerId: '1',
      },
      ports,
      repoRoot: REPO_ROOT,
      relay: {
        serverAddr: `127.0.0.1:${relayPort}`,
        authToken: 'T',
        subdomain: 'inst-test.local',
      },
    });

    console.log('[test] Stack + Tunnel gestartet. Warte auf Tunnel-Verbindung...');
    // Kurz warten, damit der Tunnel-Client sich verbinden kann
    await waitFor(() => httpHealth(`http://127.0.0.1:${exposedPort}/health`, 1500), 20_000, 500);
    console.log('[test] Tunnel etabliert.');
  }, { timeout: 120_000 });

  after(async () => {
    try { await manager.stop(); } catch (e) { console.error('[test] stop-Fehler:', e); }
    try {
      if (ratholeServer && !ratholeServer.killed) {
        ratholeServer.kill('SIGTERM');
      }
    } catch { /* ignorieren */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignorieren */ }
  }, { timeout: 30_000 });

  test('chat-gateway /health ist durch den Tunnel (exposedPort) erreichbar', async () => {
    const ok = await httpHealth(`http://127.0.0.1:${exposedPort}/health`, 5000);
    assert.ok(ok, `chat-gateway /health sollte durch Tunnel (Port ${exposedPort}) 200 zurückgeben`);
  });

  test('Tunnel reconnect: Client-Prozess killen → SupervisedProcess restartet → wieder 200', async () => {
    // rathole-Client-Prozess killen (der Manager findet ihn über den Config-Pfad)
    const clientConfigPath = join(tmpDir, 'pulse-host', 'data', 'rathole-client.toml');
    try {
      // Voller Config-Pfad → trifft nur diesen Client (parallel-run-sicher)
      execFileSync('pkill', ['-f', clientConfigPath], { stdio: 'ignore' });
    } catch {
      // pkill gibt exit 1 wenn kein Prozess gefunden — ignorieren
    }
    console.log('[test] rathole-Client gekilled. Warte auf Reconnect...');

    // SupervisedProcess (restartMax 5) restartet den Client automatisch.
    // Wir pollen bis der exposed Port wieder HTTP 200 liefert (max 30 s).
    await waitFor(
      () => httpHealth(`http://127.0.0.1:${exposedPort}/health`, 1500),
      30_000,
      1000,
    );

    const ok = await httpHealth(`http://127.0.0.1:${exposedPort}/health`, 5000);
    assert.ok(ok, `chat-gateway /health sollte nach Tunnel-Reconnect (Port ${exposedPort}) wieder 200 zurückgeben`);
  });
});
