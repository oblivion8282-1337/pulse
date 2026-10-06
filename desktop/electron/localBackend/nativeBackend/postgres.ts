/**
 * Postgres-Lifecycle für das native Windows-Backend.
 * Portiert von 02-init-postgres.sh / 06-run-migrations.sh, angepasst:
 * Windows hat keine Unix-Sockets → alles über TCP auf 127.0.0.1:NATIVE_PORTS.
 * Migrations laufen gegen den ÜBERWACHTEN Postgres (nicht gegen eine
 * Bootstrap-Instanz — die Reihenfolge im Manager ist: pg zuerst, dann
 * alembic, dann Rest), deshalb KEIN transienter pg_ctl-Zyklus hier.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { pgBin } from './paths.ts';
import { NATIVE_PORTS } from './types.ts';
import type { NativeDataDirs, NativeSecrets } from './types.ts';

function run(
  binary: string,
  args: string[],
  opts: { env?: Record<string, string>; label?: string; ignoreIfOutput?: string[] } = {},
): void {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const out = (result.stderr ?? '') + (result.stdout ?? '');
    if (opts.ignoreIfOutput?.some((pat) => out.includes(pat))) return;
    throw new Error(`[postgres] ${opts.label ?? binary} fehlgeschlagen (exit ${result.status}):\n${out.slice(0, 800)}`);
  }
}

function pgEnv(secrets: NativeSecrets): Record<string, string> {
  return { PGPASSWORD: secrets.postgresPassword, PGHOST: '127.0.0.1', PGPORT: String(NATIVE_PORTS.postgres), PGUSER: 'pulse' };
}

/** Idempotentes initdb (PG_VERSION-Check). */
export function ensureInitDb(dirs: NativeDataDirs, secrets: NativeSecrets): void {
  mkdirSync(dirs.pg, { recursive: true });
  if (existsSync(join(dirs.pg, 'PG_VERSION'))) return;
  const initdb = pgBin('initdb');
  const pwFile = join(tmpdir(), `pulse-pg-pw-${randomBytes(6).toString('hex')}.txt`);
  writeFileSync(pwFile, secrets.postgresPassword + '\n', { encoding: 'utf8' });
  try {
    run(initdb, [
      `--pgdata=${dirs.pg}`,
      '--username=pulse',
      '--encoding=UTF8',
      '--locale=C',
      '--auth-host=scram-sha-256',
      `--pwfile=${pwFile}`,
    ], { label: 'initdb' });
  } finally {
    try { unlinkSync(pwFile); } catch { /* ignore */ }
  }
}

/** Spawn-Spec-Argumente für den überwachten Postgres-Longrun. */
export function postgresArgs(dirs: NativeDataDirs): string[] {
  return [
    '-D', dirs.pg,
    '-h', '127.0.0.1',
    '-p', String(NATIVE_PORTS.postgres),
    '-c', 'log_destination=stderr',
    '-c', 'logging_collector=off',
    '-c', 'shared_buffers=128MB',
    '-c', 'max_connections=100',
  ];
}

/** pg_isready-Poll (TCP). pg_isready prüft nur die Bereitschaft, keine Auth —
 *  deshalb braucht er keine Secrets. */
export function waitForPostgres(timeoutMs = 30_000): void {
  const pgIsready = pgBin('pg_isready');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync(pgIsready, ['-h', '127.0.0.1', '-p', String(NATIVE_PORTS.postgres), '-U', 'pulse', '-q'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  throw new Error('[postgres] nicht bereit innerhalb des Timeouts');
}

/** CREATE DATABASE dcc + Schemas auth/chat (idempotent). */
export function ensureDatabases(secrets: NativeSecrets): void {
  const psql = pgBin('psql');
  const env = pgEnv(secrets);
  const dbCheck = spawnSync(psql, ['-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='dcc'"], {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(dbCheck.stdout ?? '').trim()) {
    run(psql, ['-d', 'postgres', '-c', 'CREATE DATABASE dcc OWNER pulse;'], { env, label: 'CREATE DATABASE' });
  }
  run(psql, ['-d', 'dcc', '-c',
    'CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION pulse; CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION pulse;'],
    { env, label: 'CREATE SCHEMA auth/chat' });
}

/** alembic upgrade head für auth + chat-gateway (cwd = Service-Dir, 06-run-migrations). */
export function runMigrations(
  venvPython: string,
  serviceDirs: { auth: string; chat: string },
  secrets: NativeSecrets,
): void {
  // DATABASE_URL explizit — das alembic env.py liest sie (wie im Image, wo
  // env.sh gesourced wird); PGHOST/PGPORT/PGPASSWORD allein reichen nicht.
  const env: Record<string, string> = {
    ...process.env,
    ...pgEnv(secrets),
    DATABASE_URL: `postgresql+asyncpg://pulse:${secrets.postgresPassword}@127.0.0.1:${NATIVE_PORTS.postgres}/dcc`,
  };
  for (const dir of [serviceDirs.auth, serviceDirs.chat]) {
    const r = spawnSync(venvPython, ['-m', 'alembic', 'upgrade', 'head'], {
      encoding: 'utf8', cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      const out = ((r.stderr ?? '') + (r.stdout ?? ''));
      const tail = out.slice(-1600);
      throw new Error(`[migrations] alembic fehlgeschlagen in ${dir}:\n${tail}`);
    }
  }
}

/** Sauberer Stopp via pg_ctl (idempotent) — für gracefulStop des Supervisors. */
export function pgCtlStop(dirs: NativeDataDirs): void {
  run(pgBin('pg_ctl'), ['-D', dirs.pg, '-m', 'fast', '-w', 'stop'], {
    label: 'pg_ctl stop',
    ignoreIfOutput: ['is not running', 'no server running'],
  });
}
