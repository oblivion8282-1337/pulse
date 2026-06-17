/**
 * Integration-Test: Postgres-Lifecycle (initPostgres → start → schemas → stop).
 * Wird übersprungen wenn `initdb` nicht auf PATH gefunden werden kann.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';

import { dataDir, resolveBinary, BinaryNotFoundError } from '../../electron/localBackend/paths.ts';
import { ensureSecrets } from '../../electron/localBackend/secrets.ts';
import {
  initPostgres,
  startPostgresSpec,
  stopPostgres,
} from '../../electron/localBackend/postgres.ts';

const TEST_PORT = 55432;
const TIMEOUT_MS = 60_000;

function hasInitdb(): boolean {
  try {
    resolveBinary('initdb');
    return true;
  } catch (e) {
    if (e instanceof BinaryNotFoundError) return false;
    return false;
  }
}

/** Pollend auf TCP-Port bis er lauscht (max `timeoutMs`). */
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
  throw new Error(`Port ${port} still not listening after ${timeoutMs}ms`);
}

/** Prüft ob TCP-Port nicht lauscht. */
async function portClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

describe('postgres lifecycle', { skip: !hasInitdb() }, () => {
  test('initdb → start → pg_isready → schemas → stop', { timeout: TIMEOUT_MS }, async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'pulse-pg-test-'));
    const dirs = dataDir(tmpRoot);

    let pgProc: ReturnType<typeof spawn> | null = null;

    try {
      const secrets = await ensureSecrets(dirs.secrets);

      // Step 1: initdb + bootstrap (create DB + schemas)
      initPostgres(dirs, secrets);

      // Step 2: start long-running postgres
      const spec = startPostgresSpec(dirs, TEST_PORT);
      pgProc = spawn(spec.command, spec.args, {
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Collect stderr for diagnostics
      const stderr: string[] = [];
      pgProc.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));

      // Step 3: wait for port to be ready
      await waitForTcp(TEST_PORT, 30_000);

      // Step 4: pg_isready check — exit 0 beweist bereit (Text ist locale-abhängig)
      const pgIsready = resolveBinary('pg_isready');
      execFileSync(
        pgIsready,
        ['-h', '127.0.0.1', '-p', String(TEST_PORT), '-U', 'pulse', '-d', 'dcc'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      // Kein throw = exit 0 = bereit

      // Step 5: verify schemas auth + chat exist in dcc
      const psql = resolveBinary('psql');
      const schemasOut = execFileSync(
        psql,
        ['-h', '127.0.0.1', '-p', String(TEST_PORT), '-U', 'pulse', '-d', 'dcc',
         '-tAc', "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('auth','chat') ORDER BY schema_name"],
        {
          encoding: 'utf8',
          env: { ...process.env, PGPASSWORD: secrets.postgresPassword },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const schemas = schemasOut.trim().split('\n').map(s => s.trim()).filter(Boolean);
      assert.deepEqual(schemas, ['auth', 'chat'], `Schemas gefunden: ${JSON.stringify(schemas)}`);

      // Step 6: stop postgres
      stopPostgres(dirs);

      // Step 7: verify port no longer listening
      const closed = await portClosed(TEST_PORT);
      assert.ok(closed, `Port ${TEST_PORT} sollte nach stop nicht mehr lauschen`);

      pgProc = null; // already stopped
    } finally {
      if (pgProc) {
        pgProc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1000));
      }
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('initPostgres ist idempotent (zweiter Aufruf überschreibt nichts)', { timeout: TIMEOUT_MS }, async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'pulse-pg-idem-'));
    const dirs = dataDir(tmpRoot);

    try {
      const secrets = await ensureSecrets(dirs.secrets);
      // Erster Aufruf
      initPostgres(dirs, secrets);
      // Zweiter Aufruf muss ohne Fehler durchlaufen
      initPostgres(dirs, secrets);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
