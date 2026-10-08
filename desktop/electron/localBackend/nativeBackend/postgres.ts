/**
 * Postgres-Lifecycle für das native Windows-Backend.
 * Portiert von 02-init-postgres.sh / 06-run-migrations.sh, angepasst:
 * Windows hat keine Unix-Sockets → alles über TCP auf 127.0.0.1:NATIVE_PORTS.
 * Migrations laufen gegen den ÜBERWACHTEN Postgres (nicht gegen eine
 * Bootstrap-Instanz — die Reihenfolge im Manager ist: pg zuerst, dann
 * alembic, dann Rest), deshalb KEIN transienter pg_ctl-Zyklus hier.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { pgBin } from './paths.ts';
import { NATIVE_PORTS } from './types.ts';
import type { NativeDataDirs, NativeSecrets } from './types.ts';

/** Obergrenzen je Schritt. Alles läuft asynchron im Electron-Hauptprozess —
 *  vorher hielt spawnSync das Fenster an, ein hängendes alembic für immer.
 *  Migrationen bekommen reichlich Luft (große Bestände, langsame Platten);
 *  die Grenze soll nur das ewige Hängen beenden, nicht knapp messen. */
export const PG_ZEITGRENZEN = {
  initdb: 120_000,
  psql: 30_000,
  pgIsready: 5_000,
  pgCtlStop: 75_000, // pg_ctl -w wartet selbst bis zu 60 s
  migration: 600_000,
} as const;

export interface LaufErgebnis { status: number | null; ausgabe: string; zeitUeberschritten: boolean }

/** Ein Programm asynchron fahren, mit Zeitgrenze. Wirft nie — der Aufrufer
 *  entscheidet anhand von status/ausgabe. */
export function laufeRoh(
  binary: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs: number },
): Promise<LaufErgebnis> {
  return new Promise((resolve) => {
    execFile(binary, args, {
      encoding: 'utf8',
      env: { ...process.env, ...(opts.env ?? {}) },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const ausgabe = `${stderr ?? ''}${stdout ?? ''}`;
      if (!err) { resolve({ status: 0, ausgabe, zeitUeberschritten: false }); return; }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      resolve({
        status: typeof e.code === 'number' ? e.code : null,
        ausgabe: ausgabe || e.message,
        zeitUeberschritten: e.killed === true,
      });
    });
  });
}

/** Wie laufeRoh, wirft aber bei Fehlschlag (außer bei ignoreIfOutput-Treffern). */
export async function laufe(
  binary: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; label?: string; ignoreIfOutput?: string[]; timeoutMs: number; tail?: boolean },
): Promise<void> {
  const r = await laufeRoh(binary, args, opts);
  if (r.status === 0) return;
  const label = opts.label ?? binary;
  if (r.zeitUeberschritten) {
    throw new Error(`[postgres] ${label} nach ${Math.round(opts.timeoutMs / 1000)} s abgebrochen (hängt)`);
  }
  if (opts.ignoreIfOutput?.some((pat) => r.ausgabe.includes(pat))) return;
  const auszug = opts.tail ? r.ausgabe.slice(-1600) : r.ausgabe.slice(0, 800);
  throw new Error(`[postgres] ${label} fehlgeschlagen (exit ${r.status}):\n${auszug}`);
}

function pgEnv(secrets: NativeSecrets): Record<string, string> {
  return { PGPASSWORD: secrets.postgresPassword, PGHOST: '127.0.0.1', PGPORT: String(NATIVE_PORTS.postgres), PGUSER: 'pulse' };
}

/** Idempotentes initdb (PG_VERSION-Check). initdb setzt unter einem
 *  Administrator-Token selbst ein eingeschränktes Token — anders als
 *  postgres.exe, siehe postgresStartFehler. */
export async function ensureInitDb(dirs: NativeDataDirs, secrets: NativeSecrets): Promise<void> {
  mkdirSync(dirs.pg, { recursive: true });
  if (existsSync(join(dirs.pg, 'PG_VERSION'))) return;
  const initdb = pgBin('initdb');
  const pwFile = join(tmpdir(), `pulse-pg-pw-${randomBytes(6).toString('hex')}.txt`);
  writeFileSync(pwFile, secrets.postgresPassword + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    await laufe(initdb, [
      `--pgdata=${dirs.pg}`,
      '--username=pulse',
      '--encoding=UTF8',
      '--locale=C',
      '--auth-host=scram-sha-256',
      `--pwfile=${pwFile}`,
    ], { label: 'initdb', timeoutMs: PG_ZEITGRENZEN.initdb });
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
export async function waitForPostgres(timeoutMs = 30_000): Promise<void> {
  const pgIsready = pgBin('pg_isready');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await laufeRoh(pgIsready, ['-h', '127.0.0.1', '-p', String(NATIVE_PORTS.postgres), '-U', 'pulse', '-q'], {
      timeoutMs: PG_ZEITGRENZEN.pgIsready,
    });
    if (r.status === 0) return;
    await sleep(300);
  }
  throw new Error('[postgres] nicht bereit innerhalb des Timeouts');
}

/** CREATE DATABASE dcc + Schemas auth/chat (idempotent). */
export async function ensureDatabases(secrets: NativeSecrets): Promise<void> {
  const psql = pgBin('psql');
  const env = pgEnv(secrets);
  const dbCheck = await laufeRoh(psql, ['-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='dcc'"], {
    env, timeoutMs: PG_ZEITGRENZEN.psql,
  });
  if (dbCheck.status !== 0) {
    throw new Error(`[postgres] Datenbank-Prüfung fehlgeschlagen (exit ${dbCheck.status}):\n${dbCheck.ausgabe.slice(0, 800)}`);
  }
  if (!dbCheck.ausgabe.trim()) {
    await laufe(psql, ['-d', 'postgres', '-c', 'CREATE DATABASE dcc OWNER pulse;'], {
      env, label: 'CREATE DATABASE', timeoutMs: PG_ZEITGRENZEN.psql,
    });
  }
  await laufe(psql, ['-d', 'dcc', '-c',
    'CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION pulse; CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION pulse;'],
    { env, label: 'CREATE SCHEMA auth/chat', timeoutMs: PG_ZEITGRENZEN.psql });
}

/** alembic upgrade head für auth + chat-gateway (cwd = Service-Dir, 06-run-migrations). */
export async function runMigrations(
  venvPython: string,
  serviceDirs: { auth: string; chat: string },
  secrets: NativeSecrets,
  timeoutMs: number = PG_ZEITGRENZEN.migration,
): Promise<void> {
  // DATABASE_URL explizit — das alembic env.py liest sie (wie im Image, wo
  // env.sh gesourced wird); PGHOST/PGPORT/PGPASSWORD allein reichen nicht.
  const env: Record<string, string> = {
    ...pgEnv(secrets),
    DATABASE_URL: `postgresql+asyncpg://pulse:${secrets.postgresPassword}@127.0.0.1:${NATIVE_PORTS.postgres}/dcc`,
  };
  for (const dir of [serviceDirs.auth, serviceDirs.chat]) {
    await laufe(venvPython, ['-m', 'alembic', 'upgrade', 'head'], {
      env, cwd: dir, label: `alembic in ${dir}`, timeoutMs, tail: true,
    });
  }
}

/** Sauberer Stopp via pg_ctl (idempotent) — für gracefulStop des Supervisors. */
export async function pgCtlStop(dirs: NativeDataDirs): Promise<void> {
  await laufe(pgBin('pg_ctl'), ['-D', dirs.pg, '-m', 'fast', '-w', 'stop'], {
    label: 'pg_ctl stop',
    ignoreIfOutput: ['is not running', 'no server running'],
    timeoutMs: PG_ZEITGRENZEN.pgCtlStop,
  });
}

/**
 * postgres.exe verweigert den Start, wenn das Prozess-Token Administrator-
 * rechte trägt (eingebautes Administrator-Konto, oder Pulse „als
 * Administrator ausgeführt“). initdb und pg_ctl legen sich dafür selbst ein
 * eingeschränktes Token an, postgres.exe nicht.
 *
 * Bewusst KEIN Start über `pg_ctl start`: pg_ctl löst den Postmaster vom
 * eigenen Prozess und beendet sich danach — der Supervisor verlöre Exit-
 * Ereignisse, Neustarts und die PID (sie stünde nur noch in postmaster.pid).
 * Stattdessen wird der Fall erkannt und klar benannt.
 */
export function postgresStartFehler(original: Error, stderrEnde: string): Error {
  if (/administrative permissions/i.test(stderrEnde)) {
    return new Error(
      'Postgres startet nicht mit Administratorrechten. Pulse bitte ohne ' +
      '„Als Administrator ausführen“ starten (und nicht im eingebauten ' +
      'Administrator-Konto) — ein normales Benutzerkonto genügt.',
    );
  }
  return stderrEnde.trim()
    ? new Error(`${original.message}\n${stderrEnde.slice(-800)}`)
    : original;
}
