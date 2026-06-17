/**
 * Postgres-Lifecycle für den lokalen Self-Host-Stack.
 * Portiert 1:1 von:
 *   infra/self-host/s6/etc/s6-overlay/scripts/02-init-postgres.sh  (initdb + bootstrap)
 *   infra/self-host/s6/etc/s6-overlay/s6-rc.d/postgres/run          (long-running start)
 *
 * Exports:
 *   initPostgres(dirs, secrets) — idempotentes initdb + DB/Schema-Bootstrap
 *   startPostgresSpec(dirs, port) — Spawn-Spec für SupervisedProcess (Task 6)
 *   stopPostgres(dirs) — pg_ctl fast stop
 */

import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { resolveBinary } from './paths.ts';
import type { DataDirs, SpawnSpec } from './types.ts';
import type { Secrets } from './secrets.ts';

export type { SpawnSpec };

// ---------------------------------------------------------------------------
// Interne Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Synchroner Sleep via Atomics (kein async nötig, da der gesamte Stack blockierend ist). */
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Führt ein Binary synchron aus; wirft bei Exit != 0.
 * Loggt nie Secret-Werte.
 * `ignoreIfOutput`: Liste von Strings — kein Fehler wenn die Ausgabe einen davon enthält.
 */
function run(
  binary: string,
  args: string[],
  opts: {
    env?: Record<string, string>;
    label?: string;
    ignoreIfOutput?: string[];
  } = {},
): void {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const out = (result.stderr ?? '') + (result.stdout ?? '');
    if (opts.ignoreIfOutput?.some(pat => out.includes(pat))) return;
    const label = opts.label ?? binary;
    throw new Error(
      `[postgres] ${label} fehlgeschlagen (exit ${result.status}):\n${out}`,
    );
  }
}

/** Polling-Schleife: prüft pg_isready auf einem Unix-Socket-Verzeichnis. */
function waitForBootstrapSocket(pgIsready: string, socketDir: string, timeoutMs = 15_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync(pgIsready, ['-h', socketDir, '-U', 'pulse', '-q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    if (r.status === 0) return;
    sleepMs(300);
  }
  throw new Error('[postgres] Bootstrap-Postgres wurde nicht bereit innerhalb des Timeouts');
}

/** Schreibt das Passwort in eine temporäre Datei und gibt den Pfad zurück. */
function writeTempPwfile(password: string): string {
  const path = join(tmpdir(), `pulse-pg-pw-${randomBytes(6).toString('hex')}.txt`);
  writeFileSync(path, password + '\n', { encoding: 'utf8', mode: 0o600 });
  return path;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Idempotentes initdb + Bootstrap:
 *   1. initdb -D <pg> wenn PG_VERSION fehlt
 *   2. pg_ctl start auf temp Unix-Socket
 *   3. CREATE DATABASE dcc OWNER pulse (wenn nötig)
 *   4. ALTER ROLE pulse WITH PASSWORD '…'
 *   5. CREATE SCHEMA IF NOT EXISTS auth/chat AUTHORIZATION pulse
 *   6. pg_ctl stop
 */
export function initPostgres(dirs: DataDirs, secrets: Secrets): void {
  mkdirSync(dirs.pg, { recursive: true });

  const pgCtl = resolveBinary('pg_ctl');
  const psql = resolveBinary('psql');
  const pgIsready = resolveBinary('pg_isready');

  // Schritt 1: initdb (idempotent via PG_VERSION-Check)
  if (!existsSync(join(dirs.pg, 'PG_VERSION'))) {
    const initdb = resolveBinary('initdb');
    const pwFile = writeTempPwfile(secrets.postgresPassword);
    try {
      run(initdb, [
        `--pgdata=${dirs.pg}`,
        '--username=pulse',
        '--encoding=UTF8',
        '--locale=C',
        '--auth-local=trust',
        '--auth-host=scram-sha-256',
        `--pwfile=${pwFile}`,
      ], { label: 'initdb' });
    } finally {
      try { unlinkSync(pwFile); } catch { /* ignorieren */ }
    }
  }

  // Schritt 2: Bootstrap-Start auf Unix-Socket (kein TCP, kein Port-Konflikt)
  // Gemeinsames Token für Socket-Verzeichnis und Log-Datei derselben Bootstrap-Session.
  const bootToken = randomBytes(4).toString('hex');
  const bootstrapSocket = join(tmpdir(), `pulse-pg-boot-${bootToken}`);
  mkdirSync(bootstrapSocket, { recursive: true, mode: 0o700 });
  const bootstrapLog = join(tmpdir(), `pulse-pg-boot-${bootToken}.log`);

  try {
    run(pgCtl, [
      '-D', dirs.pg,
      '-o', `-k ${bootstrapSocket} -h '' -p 5432`,
      '-l', bootstrapLog,
      '-w',
      'start',
    ], { label: 'pg_ctl bootstrap start' });

    // Schritt 2b: Zusätzlicher Ready-Poll (pg_ctl -w sollte bereits blockieren, aber zur Sicherheit)
    waitForBootstrapSocket(pgIsready, bootstrapSocket);

    const pgEnv = { PGPASSWORD: secrets.postgresPassword };

    // Schritt 3: CREATE DATABASE dcc (idempotent)
    const dbCheck = spawnSync(psql, [
      '-h', bootstrapSocket, '-U', 'pulse', '-d', 'postgres',
      '-tAc', "SELECT 1 FROM pg_database WHERE datname='dcc'",
    ], { encoding: 'utf8', env: { ...process.env, ...pgEnv }, stdio: ['ignore', 'pipe', 'pipe'] });

    if (!(dbCheck.stdout ?? '').trim()) {
      run(psql, [
        '-h', bootstrapSocket, '-U', 'pulse', '-d', 'postgres',
        '-c', 'CREATE DATABASE dcc OWNER pulse;',
      ], { env: pgEnv, label: 'CREATE DATABASE' });
    }

    // Schritt 4: Passwort setzen (idempotent) — via PGPASSWORD, nie geloggt
    run(psql, [
      '-h', bootstrapSocket, '-U', 'pulse', '-d', 'postgres',
      '-c', `ALTER ROLE pulse WITH PASSWORD '${secrets.postgresPassword}';`,
    ], { env: pgEnv, label: 'ALTER ROLE' });

    // Schritt 5: Schemas anlegen (idempotent)
    run(psql, [
      '-h', bootstrapSocket, '-U', 'pulse', '-d', 'dcc',
      '-c',
      'CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION pulse; CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION pulse;',
    ], { env: pgEnv, label: 'CREATE SCHEMA auth/chat' });

  } finally {
    // Schritt 6: Bootstrap stoppen (auch bei Fehler versuchen)
    try {
      run(pgCtl, ['-D', dirs.pg, '-m', 'fast', '-w', 'stop'], { label: 'pg_ctl bootstrap stop' });
    } catch (e) {
      // Wenn bereits gestoppt oder fehlgeschlagen — best-effort
      console.error('[postgres] Bootstrap-Stop fehlgeschlagen (ignoriert):', e);
    }
  }
}

/**
 * Gibt die Spawn-Spec für den langlebigen Postgres-Prozess zurück.
 * Portiert von s6-rc.d/postgres/run.
 * Wird von SupervisedProcess (Task 6) verwendet.
 */
export function startPostgresSpec(dirs: DataDirs, port: number): SpawnSpec {
  const postgres = resolveBinary('postgres');
  return {
    command: postgres,
    args: [
      '-D', dirs.pg,
      '-k', dirs.root,           // Unix-Socket im data root
      '-h', '127.0.0.1',
      '-p', String(port),
      '-c', 'log_destination=stderr',
      '-c', 'logging_collector=off',
      '-c', 'shared_buffers=128MB',
      '-c', 'max_connections=100',
    ],
    env: {},
  };
}

/**
 * Stoppt den laufenden Postgres-Prozess via pg_ctl fast stop.
 * Idempotent: kein Fehler wenn Postgres nicht läuft.
 */
export function stopPostgres(dirs: DataDirs): void {
  const pgCtl = resolveBinary('pg_ctl');
  run(pgCtl, ['-D', dirs.pg, '-m', 'fast', '-w', 'stop'], {
    label: 'pg_ctl stop',
    ignoreIfOutput: ['is not running', 'no server running'],
  });
}
