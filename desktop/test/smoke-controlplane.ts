/**
 * Smoke-Test: Control-Plane End-to-End.
 *
 * Startet den vollständigen lokalen Stack via LocalBackendManager und
 * durchläuft das Control-Plane-Szenario:
 *   1. Stack starten, auf chat-gateway /health warten
 *   2. Lokalen User registrieren (ALLOW_LOCAL_ACCOUNTS=true, wird vom Manager gesetzt)
 *   3. Einloggen, Access-Token holen
 *   4. Community (Guild) anlegen — erster User ist Bootstrap-Admin, darf immer
 *   5. Kanal anlegen
 *   6. Nachricht posten
 *   7. Stack sauber stoppen
 *
 * Ausführen:
 *   cd desktop && PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH" \
 *     node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/smoke-controlplane.ts
 *
 * Exit 0 = alle Schritte OK. Exit 1 = mindestens ein Schritt fehlgeschlagen.
 *
 * Niemals Secret-Werte loggen — Tokens erscheinen als [REDACTED].
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

import { LocalBackendManager } from '../electron/localBackend/localBackendManager.ts';
import { resolveBinary, BinaryNotFoundError } from '../electron/localBackend/paths.ts';

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

// smoke-controlplane.ts liegt in desktop/test/ → 2 Ebenen hoch → Repo-Root
const REPO_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

type StepResult = { name: string; ok: boolean; detail?: string };
const results: StepResult[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
  console.error(`  FAIL  ${name} — ${detail}`);
}

async function apiCall(
  method: string,
  url: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** Liest ein Feld aus der API-Antwort, wenn der Status stimmt — sonst null. */
function fieldFrom(
  status: number,
  expectedStatus: number,
  data: unknown,
  field: string,
): string | null {
  if (status === expectedStatus && data && typeof data === 'object' && field in data) {
    return String((data as Record<string, unknown>)[field]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependency-Guard
// ---------------------------------------------------------------------------

function binsAvailable(): string | null {
  const required = ['initdb', 'redis-server', 'minio'] as const;
  for (const bin of required) {
    try {
      resolveBinary(bin);
    } catch (e) {
      if (e instanceof BinaryNotFoundError) return bin;
    }
  }
  try {
    execFileSync('uv', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    return 'uv';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Smoke-Szenario
// ---------------------------------------------------------------------------

async function runSmoke(): Promise<void> {
  const missing = binsAvailable();
  if (missing) {
    console.warn(`[smoke] Überspringe: '${missing}' nicht gefunden.`);
    console.warn('[smoke] Installiere initdb (postgresql), redis-server, minio und uv.');
    process.exit(0); // kein Fehler — fehlende Binaries sind ein Setup-Problem
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'pulse-smoke-'));
  const manager = new LocalBackendManager();

  const [pg, redis, minio, auth, chat, media, hook] = await Promise.all([
    getFreePort(), getFreePort(), getFreePort(),
    getFreePort(), getFreePort(), getFreePort(), getFreePort(),
  ]);
  const ports = { postgres: pg, redis, minio, auth, chat, media, mediaAuthHook: hook };

  console.log('[smoke] Ports:', ports);
  console.log('[smoke] tmpDir:', tmpDir);
  console.log('[smoke] repoRoot:', REPO_ROOT);

  const authBase = `http://127.0.0.1:${ports.auth}`;
  const chatBase = `http://127.0.0.1:${ports.chat}`;

  // ── Schritt 1: Stack starten ─────────────────────────────────────────────
  console.log('\n[smoke] Schritt 1: Stack starten...');
  try {
    await manager.start({
      userData: tmpDir,
      identity: {
        hostname: 'smoke-test.local',
        instanceId: '100',
        ownerId: '999',
      },
      ports,
      repoRoot: REPO_ROOT,
    });
    pass('Stack gestartet');
  } catch (err) {
    fail('Stack starten', String(err));
    await cleanup(manager, tmpDir);
    printSummary();
    process.exit(1);
  }

  // ── Schritt 2: chat-gateway /health ──────────────────────────────────────
  console.log('\n[smoke] Schritt 2: chat-gateway /health...');
  try {
    const r = await fetch(`${chatBase}/health`);
    if (r.ok) {
      pass('chat-gateway /health', `HTTP ${r.status}`);
    } else {
      fail('chat-gateway /health', `HTTP ${r.status}`);
    }
  } catch (err) {
    fail('chat-gateway /health', String(err));
  }

  // ── Schritt 3: Registrierung ──────────────────────────────────────────────
  console.log('\n[smoke] Schritt 3: User registrieren...');
  let accessToken: string | null = null;
  try {
    const { status, data } = await apiCall('POST', `${authBase}/register`, {
      username: 'smokeuser',
      email: 'smokeuser@smoke-test.example.com',
      password: 'SmokePassw0rd!',
      display_name: 'Smoke User',
    });
    accessToken = fieldFrom(status, 201, data, 'access_token');
    if (accessToken) {
      pass('Registrierung', `HTTP ${status} — access_token: [REDACTED]`);
    } else {
      fail('Registrierung', `HTTP ${status} — ${JSON.stringify(data)}`);
    }
  } catch (err) {
    fail('Registrierung', String(err));
  }

  if (!accessToken) {
    // Login versuchen (falls User schon existiert)
    console.log('[smoke] Registrierung fehlgeschlagen — Login versuchen...');
    try {
      const { status, data } = await apiCall('POST', `${authBase}/login`, {
        email_or_username: 'smokeuser',
        password: 'SmokePassw0rd!',
      });
      accessToken = fieldFrom(status, 200, data, 'access_token');
      if (accessToken) {
        pass('Login (Fallback)', `HTTP ${status} — access_token: [REDACTED]`);
      } else {
        fail('Login (Fallback)', `HTTP ${status} — ${JSON.stringify(data)}`);
      }
    } catch (err) {
      fail('Login (Fallback)', String(err));
    }
  }

  if (!accessToken) {
    console.error('[smoke] Kein Access-Token — weitere Schritte nicht möglich.');
    await cleanup(manager, tmpDir);
    printSummary();
    process.exit(1);
  }

  // ── Schritt 4: Guild anlegen ──────────────────────────────────────────────
  console.log('\n[smoke] Schritt 4: Community anlegen...');
  let guildId: string | null = null;
  try {
    const { status, data } = await apiCall(
      'POST', `${chatBase}/guilds`,
      { name: 'Smoke Community' },
      accessToken,
    );
    guildId = fieldFrom(status, 201, data, 'id');
    if (guildId) {
      pass('Community anlegen', `HTTP ${status} — guild_id: ${guildId}`);
    } else {
      fail('Community anlegen', `HTTP ${status} — ${JSON.stringify(data)}`);
    }
  } catch (err) {
    fail('Community anlegen', String(err));
  }

  // ── Schritt 5: Kanal anlegen ──────────────────────────────────────────────
  let channelId: string | null = null;
  if (guildId) {
    console.log('\n[smoke] Schritt 5: Kanal anlegen...');
    try {
      const { status, data } = await apiCall(
        'POST', `${chatBase}/guilds/${guildId}/channels`,
        { name: 'general', type: 0, position: 0 },
        accessToken,
      );
      channelId = fieldFrom(status, 201, data, 'id');
      if (channelId) {
        pass('Kanal anlegen', `HTTP ${status} — channel_id: ${channelId}`);
      } else {
        fail('Kanal anlegen', `HTTP ${status} — ${JSON.stringify(data)}`);
      }
    } catch (err) {
      fail('Kanal anlegen', String(err));
    }
  } else {
    fail('Kanal anlegen', 'Guild-ID fehlt — vorheriger Schritt gescheitert');
  }

  // ── Schritt 6: Nachricht senden ───────────────────────────────────────────
  if (channelId) {
    console.log('\n[smoke] Schritt 6: Nachricht senden...');
    try {
      const { status, data } = await apiCall(
        'POST', `${chatBase}/channels/${channelId}/messages`,
        { content: 'Smoke test message — all systems nominal.' },
        accessToken,
      );
      const messageId = fieldFrom(status, 201, data, 'id');
      if (messageId) {
        pass('Nachricht senden', `HTTP ${status} — message_id: ${messageId}`);
      } else {
        fail('Nachricht senden', `HTTP ${status} — ${JSON.stringify(data)}`);
      }
    } catch (err) {
      fail('Nachricht senden', String(err));
    }
  } else {
    fail('Nachricht senden', 'Channel-ID fehlt — vorheriger Schritt gescheitert');
  }

  // ── Aufräumen ─────────────────────────────────────────────────────────────
  console.log('\n[smoke] Stack stoppen...');
  await cleanup(manager, tmpDir);

  printSummary();

  const allOk = results.every(r => r.ok);
  process.exit(allOk ? 0 : 1);
}

async function cleanup(manager: LocalBackendManager, tmpDir: string): Promise<void> {
  try {
    await manager.stop();
  } catch (e) {
    console.error('[smoke] stop() Fehler (ignoriert):', e);
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignorieren */ }
}

function printSummary(): void {
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Smoke-Test Ergebnis: ${passed} PASS, ${failed} FAIL`);
  if (failed > 0) {
    console.log('\nFehlgeschlagene Schritte:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
  }
  console.log('─'.repeat(60));
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

runSmoke().catch((err) => {
  console.error('[smoke] Unbehandelter Fehler:', err);
  process.exit(1);
});
