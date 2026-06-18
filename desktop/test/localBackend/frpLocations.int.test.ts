/**
 * Integration-Test: frps Path-Routing via locations.
 *
 * Beweist, dass zwei frpc-Proxies mit unterschiedlichen locations[]
 * durch einen frps-Tunnel korrekt auf zwei verschiedene lokale Stubs routen.
 *
 * Ausführen:
 *   cd /Users/michael/Documents/pulse/desktop && \
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     --test --test-timeout=60000 \
 *     test/localBackend/frpLocations.int.test.ts
 *
 * Wird übersprungen, wenn frps oder frpc nicht auf PATH sind.
 *
 * Hinweis: Node-fetch ignoriert manuelle Host-Header (Security-Restriction).
 * Daher werden alle HTTP-Requests über node:http gestellt, das explizite
 * Host-Header erlaubt.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Skip-Guard
// ---------------------------------------------------------------------------

function frpBinsAvailable(): boolean {
  for (const bin of ['frps', 'frpc']) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.log(`[frpLocations.int.test] Überspringe: ${bin} nicht auf PATH.`);
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
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

/** HTTP GET mit explizitem Host-Header über node:http (fetch ignoriert Host). */
function httpGet(
  hostname: string,
  port: number,
  path: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname, port, path, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function pollUntil200(
  port: number,
  path: string,
  hostHeader: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await httpGet('127.0.0.1', port, path, hostHeader);
      if (status === 200) return true;
    } catch {
      // noch nicht bereit
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function killSafe(proc: ChildProcess | null): void {
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch { /* ignorieren */ }
}

// ---------------------------------------------------------------------------
// Test-Suite
// ---------------------------------------------------------------------------

describe('frps Path-Routing (locations)', { skip: !frpBinsAvailable() }, () => {
  let tmpDir: string;
  let portA: number;
  let portB: number;
  let frpsPort: number;
  let vhostPort: number;

  let stubA: ReturnType<typeof createServer>;
  let stubB: ReturnType<typeof createServer>;
  let frpsProc: ChildProcess | null = null;
  let frpcProc: ChildProcess | null = null;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pulse-frp-loc-test-'));

    [portA, portB, frpsPort, vhostPort] = await Promise.all([
      getFreePort(), getFreePort(), getFreePort(), getFreePort(),
    ]);

    console.log(
      `[test] portA=${portA} portB=${portB} frpsPort=${frpsPort} vhostPort=${vhostPort}`,
    );

    // --- Stub A: antwortet mit "A" ---
    await new Promise<void>((resolve, reject) => {
      stubA = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('A');
      });
      stubA.listen(portA, '127.0.0.1', () => resolve());
      stubA.on('error', reject);
    });

    // --- Stub B: antwortet mit "B" ---
    await new Promise<void>((resolve, reject) => {
      stubB = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('B');
      });
      stubB.listen(portB, '127.0.0.1', () => resolve());
      stubB.on('error', reject);
    });

    // --- frps-Konfiguration ---
    const frpsCfgPath = join(tmpDir, 'frps.toml');
    writeFileSync(frpsCfgPath, [
      `bindPort = ${frpsPort}`,
      `vhostHTTPPort = ${vhostPort}`,
      `subdomainHost = "relay.test"`,
    ].join('\n'));

    // --- frpc-Konfiguration ---
    const frpcCfgPath = join(tmpDir, 'frpc.toml');
    writeFileSync(frpcCfgPath, [
      `serverAddr = "127.0.0.1"`,
      `serverPort = ${frpsPort}`,
      `user = "inst"`,
      ``,
      `[[proxies]]`,
      `name = "path-a"`,
      `type = "http"`,
      `subdomain = "inst"`,
      `localIP = "127.0.0.1"`,
      `localPort = ${portA}`,
      `locations = ["/a"]`,
      ``,
      `[[proxies]]`,
      `name = "path-b"`,
      `type = "http"`,
      `subdomain = "inst"`,
      `localIP = "127.0.0.1"`,
      `localPort = ${portB}`,
      `locations = ["/b"]`,
    ].join('\n'));

    // --- frps starten ---
    frpsProc = spawn('frps', ['-c', frpsCfgPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    frpsProc.stdout?.on('data', (d) => process.stdout.write(`[frps] ${d}`));
    frpsProc.stderr?.on('data', (d) => process.stderr.write(`[frps] ${d}`));

    // Warten bis frps den vhostHTTPPort öffnet (tcp-Poll via httpGet)
    const frpsReady = await pollUntil200(vhostPort, '/', 'probe.relay.test', 5000);
    // frps antwortet 404 (kein Proxy registriert) — trotzdem verbunden; wir brauchen nur TCP
    // pollUntil200 gibt false zurück wenn 404, aber wir wollen nur dass der Port offen ist
    // Daher warten wir einfach mit einem kurzen Sleep nach dem TCP-Verbindungsversuch
    void frpsReady; // 404 ist ok — der Port ist offen

    // Kurz warten damit frps vollständig hochgefahren ist
    await new Promise((r) => setTimeout(r, 500));

    // --- frpc starten ---
    frpcProc = spawn('frpc', ['-c', frpcCfgPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    frpcProc.stdout?.on('data', (d) => process.stdout.write(`[frpc] ${d}`));
    frpcProc.stderr?.on('data', (d) => process.stderr.write(`[frpc] ${d}`));

    // Warten bis der Tunnel bereit ist: Stub A via vhostPort + korrektem Host-Header
    const tunnelReady = await pollUntil200(vhostPort, '/a', 'inst.relay.test', 15000);
    assert.ok(tunnelReady, 'Tunnel hat sich nicht innerhalb von 15 s verbunden');
  }, { timeout: 30_000 });

  after(async () => {
    killSafe(frpcProc);
    killSafe(frpsProc);
    try { await new Promise<void>((r) => stubA?.close(() => r())); } catch { /* ignorieren */ }
    try { await new Promise<void>((r) => stubB?.close(() => r())); } catch { /* ignorieren */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignorieren */ }
  }, { timeout: 10_000 });

  test('GET /a mit Host inst.relay.test → Body "A"', async () => {
    const { status, body } = await httpGet('127.0.0.1', vhostPort, '/a', 'inst.relay.test');
    assert.equal(status, 200, `Erwartet 200, erhalten ${status}`);
    assert.equal(body, 'A', `Erwartet Body "A", erhalten "${body}"`);
  });

  test('GET /b mit Host inst.relay.test → Body "B"', async () => {
    const { status, body } = await httpGet('127.0.0.1', vhostPort, '/b', 'inst.relay.test');
    assert.equal(status, 200, `Erwartet 200, erhalten ${status}`);
    assert.equal(body, 'B', `Erwartet Body "B", erhalten "${body}"`);
  });
});
