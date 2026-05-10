/**
 * Playwright globalSetup: brings up the FastAPI services as child
 * processes for the duration of the test run, applies migrations, and
 * waits for both health endpoints to respond. globalTeardown shuts
 * them down again.
 *
 * Postgres + Redis are expected to be running (docker compose up -d
 * from the repo root); we do not manage them here.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

function loadDotenv(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

async function waitFor(url: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`service not ready: ${url}`);
}

async function applyMigrations(env: NodeJS.ProcessEnv, name: string, cwd: string) {
  await new Promise<void>((resolveP, rejectP) => {
    const p = spawn('uv', ['run', '--package', name, 'alembic', 'upgrade', 'head'], {
      cwd,
      env,
      stdio: 'inherit'
    });
    p.on('error', rejectP);
    p.on('exit', (code) => (code === 0 ? resolveP() : rejectP(new Error(`${name} migrations exit ${code}`))));
  });
}

async function truncateDb(env: NodeJS.ProcessEnv) {
  // Make every test run independent. We don't drop the schemas because
  // re-running migrations would slow things down; instead we wipe rows.
  const sql = `
    TRUNCATE
      chat.messages,
      chat.guild_members,
      chat.channels,
      chat.guilds,
      auth.refresh_tokens,
      auth.users
    RESTART IDENTITY CASCADE;
  `;
  await new Promise<void>((resolveP, rejectP) => {
    const p = spawn(
      'docker',
      ['exec', '-i', 'dcc_night_postgres', 'psql', '-U', env.POSTGRES_USER ?? 'dcc', '-d', env.POSTGRES_DB ?? 'dcc', '-v', 'ON_ERROR_STOP=1'],
      { stdio: ['pipe', 'inherit', 'inherit'] }
    );
    p.stdin.write(sql);
    p.stdin.end();
    p.on('exit', (code) => (code === 0 ? resolveP() : rejectP(new Error(`truncate exit ${code}`))));
  });
}

const procs: ChildProcess[] = [];

function startService(name: string, env: NodeJS.ProcessEnv, port: number, cwd: string) {
  const p = spawn(
    'uv',
    [
      'run',
      '--package',
      name,
      'uvicorn',
      `${name.replace(/-/g, '_')}.app:app`,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--log-level',
      'warning'
    ],
    { cwd, env, stdio: 'inherit' }
  );
  procs.push(p);
}

export default async function globalSetup() {
  const dotenv = loadDotenv(resolve(ROOT, '.env'));
  const baseEnv = {
    ...process.env,
    ...dotenv,
    POSTGRES_HOST: 'localhost',
    POSTGRES_PORT: dotenv.POSTGRES_PORT ?? '5434',
    DATABASE_URL: `postgresql+asyncpg://${dotenv.POSTGRES_USER ?? 'dcc'}:${dotenv.POSTGRES_PASSWORD ?? ''}@localhost:${dotenv.POSTGRES_PORT ?? '5434'}/${dotenv.POSTGRES_DB ?? 'dcc'}`,
    REDIS_URL: dotenv.REDIS_URL ?? 'redis://localhost:6380/0',
    AUTH_JWKS_URL: 'http://127.0.0.1:8001/.well-known/jwks.json',
    JWT_PRIVATE_KEY_FILE: resolve(ROOT, 'secrets/jwt_private.pem'),
    JWT_PUBLIC_KEY_FILE: resolve(ROOT, 'secrets/jwt_public.pem'),
    CORS_ALLOW_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173'
  };

  // Apply migrations + truncate so every test run starts clean.
  await applyMigrations(baseEnv, 'dcc-auth', resolve(ROOT, 'services/auth'));
  await applyMigrations(baseEnv, 'dcc-chat-gateway', resolve(ROOT, 'services/chat-gateway'));
  await truncateDb(baseEnv);

  startService('dcc-auth', baseEnv, 8001, resolve(ROOT, 'services/auth'));
  startService('dcc-chat-gateway', baseEnv, 8002, resolve(ROOT, 'services/chat-gateway'));

  await waitFor('http://127.0.0.1:8001/health');
  await waitFor('http://127.0.0.1:8002/health');

  // Stash pids in env so teardown can stop them even across process boundaries.
  process.env.__DCC_TEST_PIDS = procs.map((p) => p.pid).join(',');
}
