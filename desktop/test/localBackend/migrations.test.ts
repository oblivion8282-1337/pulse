/**
 * Integration-Test: Alembic-Migrationen (runMigrations).
 * Benötigt: initdb + psql auf PATH (pg keg), uv auf PATH.
 * Übersprungen wenn eine der Voraussetzungen fehlt.
 *
 * Ausführen:
 *   cd desktop && PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH" \
 *     node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test \
 *     test/localBackend/migrations.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import { dataDir, resolveBinary, BinaryNotFoundError } from '../../electron/localBackend/paths.ts';
import { ensureSecrets } from '../../electron/localBackend/secrets.ts';
import {
  initPostgres,
  startPostgresSpec,
  stopPostgres,
} from '../../electron/localBackend/postgres.ts';
import { renderEnv } from '../../electron/localBackend/renderConfig.ts';
import { runMigrations } from '../../electron/localBackend/migrations.ts';

const TEST_PORT = 55433;
const TIMEOUT_MS = 120_000;

// Repo-Root: desktop/test/localBackend/migrations.test.ts → 4 Ebenen hoch → repo root
// migrations.test.ts → localBackend → test → desktop → pulse (repo root)
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

function hasInitdb(): boolean {
  try { resolveBinary('initdb'); return true; }
  catch (e) { if (e instanceof BinaryNotFoundError) return false; throw e; }
}

function hasUv(): boolean {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Pollend auf TCP-Port bis er lauscht (max timeoutMs). */
async function waitForTcp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ port, host: '127.0.0.1' });
        s.once('connect', () => { s.destroy(); resolve(); });
        s.once('error', reject);
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Port ${port} lauscht nicht nach ${timeoutMs}ms`);
}

const skipReason = !hasInitdb() ? 'initdb nicht gefunden' : !hasUv() ? 'uv nicht gefunden' : false;

describe('runMigrations', { skip: skipReason !== false && String(skipReason) }, () => {
  test(
    'auth.users und chat.guilds existieren nach Migrationen',
    { timeout: TIMEOUT_MS },
    async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'pulse-mig-test-'));
      const dirs = dataDir(tmpRoot);
      let pgProc: ReturnType<typeof spawn> | null = null;

      try {
        const secrets = await ensureSecrets(dirs.secrets);

        // Postgres initialisieren (initdb + schemas)
        initPostgres(dirs, secrets);

        // Langlebigen Postgres starten
        const spec = startPostgresSpec(dirs, TEST_PORT);
        pgProc = spawn(spec.command, spec.args, {
          env: { ...process.env, ...spec.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        pgProc.stderr?.on('data', (_d: Buffer) => { /* diagnostic only, ignored */ });

        // Warten bis TCP lauscht
        await waitForTcp(TEST_PORT, 30_000);

        // Env bauen (enthält DATABASE_URL, JWT-Key-Pfade etc.)
        const ports = { postgres: TEST_PORT, redis: 6379, minio: 9000, auth: 8001, chat: 8002, media: 8004 };
        const identity = { hostname: 'test.local', instanceId: '100', ownerId: '1' };
        const env = renderEnv({ dirs, secrets, ports, identity });

        // Migrationen laufen lassen — das ist das, was wir testen
        await runMigrations(REPO_ROOT, env);

        // Tabellen in information_schema prüfen
        const psql = resolveBinary('psql');
        const tablesOut = execFileSync(
          psql,
          [
            '-h', '127.0.0.1', '-p', String(TEST_PORT),
            '-U', 'pulse', '-d', 'dcc',
            '-tAc',
            "SELECT table_schema || '.' || table_name " +
            "FROM information_schema.tables " +
            "WHERE (table_schema = 'auth' AND table_name = 'users') " +
            "   OR (table_schema = 'chat' AND table_name IN ('guilds','channels')) " +
            "ORDER BY 1",
          ],
          {
            encoding: 'utf8',
            env: { ...process.env, PGPASSWORD: secrets.postgresPassword },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        const tables = tablesOut.trim().split('\n').map(s => s.trim()).filter(Boolean);

        assert.ok(
          tables.some(t => t === 'auth.users'),
          `auth.users nicht gefunden. Tabellen: ${JSON.stringify(tables)}`,
        );
        assert.ok(
          tables.some(t => t === 'chat.guilds' || t === 'chat.channels'),
          `chat.guilds/channels nicht gefunden. Tabellen: ${JSON.stringify(tables)}`,
        );

        // Postgres stoppen
        stopPostgres(dirs);
        pgProc = null;
      } finally {
        if (pgProc) {
          pgProc.kill('SIGTERM');
          await new Promise(r => setTimeout(r, 1000));
        }
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    },
  );
});
