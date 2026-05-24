/**
 * Playwright globalSetup: brings up the FastAPI services as child
 * processes for the duration of the test run, applies migrations, and
 * waits for both health endpoints to respond. globalTeardown shuts
 * them down again.
 *
 * Postgres + Redis are expected to be running (docker compose up -d
 * from the repo root); we do not manage them here.
 */

import { ChildProcess, spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Detect the container runtime once at setup time. The repo's
 * docker-compose.yml is podman-compose compatible, and ``$COMPOSE_CMD``
 * lets contributors point at any other implementation (e.g. ``nerdctl
 * compose``). We persist the choice in a single ``compose`` variable
 * so every subsequent shell-out picks it up automatically.
 *
 * The CLI binary for ``exec`` calls is also picked up here — podman
 * ships its own ``podman`` for ``exec`` (rather than going through the
 * compose shim), and docker uses ``docker``. We test for ``$DOCKER_CMD``
 * first, then auto-detect.
 */
function detectCompose(): { compose: string; exec: string } {
  if (process.env.COMPOSE_CMD) {
    const cmd = process.env.COMPOSE_CMD;
    const exec = process.env.DOCKER_CMD ?? cmd.split(' ')[0];
    return { compose: cmd, exec };
  }
  try {
    execSync('docker compose version', { stdio: 'ignore' });
    return { compose: 'docker compose', exec: 'docker' };
  } catch {
    // fall through
  }
  try {
    execSync('podman compose version', { stdio: 'ignore' });
    return { compose: 'podman compose', exec: 'podman' };
  } catch {
    // fall through
  }
  try {
    execSync('podman-compose --version', { stdio: 'ignore' });
    return { compose: 'podman-compose', exec: 'podman' };
  } catch {
    throw new Error(
      'No container runtime found. Install docker or podman, or set $COMPOSE_CMD (+ $DOCKER_CMD).'
    );
  }
}

const { compose: COMPOSE, exec: CONTAINER_EXEC } = detectCompose();

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
  // Settings singletons (auth_settings, chat_settings, smtp_settings)
  // survive TRUNCATE because dropping them would violate the singleton
  // CHECK + a missing row breaks code paths that ``session.get(...)`` —
  // we UPDATE them back to the migration defaults instead. Without this
  // any test that mutates an admin setting leaks into the next run
  // (admin.spec.ts DM-limits PATCH was the symptom). smtp_settings MUST
  // reset too: a configured SMTP row activates the email-verification
  // gate, which would bounce every register flow to /verify-email-required.
  const sql = `
    TRUNCATE
      chat.message_attachments,
      chat.admin_audit_log,
      chat.messages,
      chat.guild_members,
      chat.channels,
      chat.guilds,
      auth.admin_audit_log,
      auth.refresh_tokens,
      auth.users
    RESTART IDENTITY CASCADE;
    -- Plugin-Allowlist + Pro-Guild-Toggles dürfen NICHT zwischen Test-
    -- Runs lecken (sonst sieht der nächste plugins.spec.ts schon einen
    -- "tamagotchi"-Allowlist-Eintrag vom letzten Run). Allowlist auf
    -- den Migrations-Seed (hello-only) zurücksetzen; guild_plugins ist
    -- via Cascade von chat.guilds schon weg.
    DELETE FROM chat.instance_plugin_allowlist WHERE plugin_name <> 'hello';
    UPDATE chat.chat_settings SET
      dm_attachment_max_size_bytes = 26214400,
      dm_attachment_max_count_per_message = 4,
      allow_guild_creation = true,
      allow_member_invites = true
    WHERE id = 1;
    UPDATE auth.auth_settings SET
      registration_mode = 'open'
    WHERE id = 1;
    UPDATE auth.smtp_settings SET
      provider = 'custom', host = NULL, port = 587, username = NULL,
      password_encrypted = NULL, from_email = NULL, use_ssl = false,
      configured = false
    WHERE id = 1;
  `;
  await new Promise<void>((resolveP, rejectP) => {
    const p = spawn(
      CONTAINER_EXEC,
      ['exec', '-i', 'dcc_night_postgres', 'psql', '-U', env.POSTGRES_USER ?? 'dcc', '-d', env.POSTGRES_DB ?? 'dcc', '-v', 'ON_ERROR_STOP=1'],
      { stdio: ['pipe', 'inherit', 'inherit'] }
    );
    p.stdin.write(sql);
    p.stdin.end();
    p.on('exit', (code) => (code === 0 ? resolveP() : rejectP(new Error(`truncate exit ${code}`))));
  });
}

function ensureTestDb(postgresUser: string) {
  const cwd = resolve(__dirname, '../../..');
  // CREATE DATABASE has no IF NOT EXISTS — check first, then create.
  const check = execSync(
    `${COMPOSE} exec -T postgres psql -U ${postgresUser} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='dcc_test'"`,
    { cwd }
  )
    .toString()
    .trim();
  if (check !== '1') {
    execSync(
      `${COMPOSE} exec -T postgres psql -U ${postgresUser} -d postgres -c "CREATE DATABASE dcc_test"`,
      { cwd }
    );
  }
  // Alembic stores alembic_version in the service schema, so the schemas
  // must exist before the first migration run.
  execSync(
    `${COMPOSE} exec -T postgres psql -U ${postgresUser} -d dcc_test -c "CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS chat;"`,
    { cwd }
  );
}

function killPort(port: number, knownTestPids: Set<number>) {
  // Only kill the previously-tracked test-server PIDs (from the last run's
  // pid file). If the port is held by something else (e.g. the user's own
  // dev server), leave it alone — spawn will fail loudly so the user knows.
  if (knownTestPids.size === 0) return;
  try {
    const pids = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) {
      const n = Number(pid);
      if (knownTestPids.has(n)) {
        try { process.kill(n); } catch { /* already gone */ }
      }
    }
  } catch { /* lsof exits 1 when nothing found */ }
}

/**
 * Hard-fail if a port is still occupied after the kill pass. The e2e suite
 * starts its own auth/chat-gateway on 8001/8002 wired to the dcc_test DB.
 * killPort deliberately spares the user's own dev servers, and startService
 * runs with stdio:'ignore' which *swallows* the EADDRINUSE — so a dev stack
 * left running on these ports would silently shadow the test services and
 * the whole suite would run against (and pollute) the dcc dev database.
 * Fail loudly with an actionable message instead.
 */
function assertPortFree(port: number): void {
  let held = '';
  try {
    held = execSync(`lsof -ti :${port} -sTCP:LISTEN`, {
      stdio: ['pipe', 'pipe', 'ignore']
    })
      .toString()
      .trim();
  } catch {
    return; // lsof exits 1 when nothing is listening → port is free
  }
  if (held) {
    throw new Error(
      `Port ${port} is already in use (PID ${held.split(/\s+/).join(', ')}).\n` +
        `The e2e suite starts its own auth/chat-gateway on 8001/8002 against the\n` +
        `dcc_test database. A process already bound here — most likely your local\n` +
        `dev stack — would silently shadow them, and the suite would run against\n` +
        `the dcc dev DB instead. Stop the dev stack before running e2e.`
    );
  }
}

const procs: ChildProcess[] = [];

function startService(name: string, env: NodeJS.ProcessEnv, port: number, cwd: string) {
  // detached + own stdio so the child has its own session and survives the
  // Playwright worker process exiting. Teardown kills it explicitly via the
  // pid file. unref() lets Node exit without waiting for the child.
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
    { cwd, env, stdio: 'ignore', detached: true }
  );
  p.unref();
  procs.push(p);
}

export default async function globalSetup() {
  const dotenv = loadDotenv(resolve(ROOT, '.env'));
  const pgUser = dotenv.POSTGRES_USER ?? 'dcc';
  const pgPort = dotenv.POSTGRES_PORT ?? '5434';
  const pgPassword = dotenv.POSTGRES_PASSWORD ?? '';

  // Ensure the dedicated test database exists (never touches dcc).
  ensureTestDb(pgUser);

  const baseEnv = {
    ...process.env,
    ...dotenv,
    POSTGRES_HOST: 'localhost',
    POSTGRES_PORT: pgPort,
    POSTGRES_DB: 'dcc_test',
    DATABASE_URL: `postgresql+asyncpg://${pgUser}:${pgPassword}@localhost:${pgPort}/dcc_test`,
    REDIS_URL: 'redis://localhost:6380/1',
    AUTH_JWKS_URL: 'http://127.0.0.1:8001/.well-known/jwks.json',
    JWT_PRIVATE_KEY_FILE: resolve(ROOT, 'secrets/jwt_private.pem'),
    JWT_PUBLIC_KEY_FILE: resolve(ROOT, 'secrets/jwt_public.pem'),
    CORS_ALLOW_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
    // Default register limit (5/min) gets hit when the suite runs all three
    // specs back-to-back — chat + invite + watch-party register 6+ users
    // from 127.0.0.1 within one minute. Loosen to keep the suite reliable;
    // production stays on the default 5/min.
    RATE_LIMIT_REGISTER: '1000/minute',
    RATE_LIMIT_LOGIN: '1000/minute'
  };

  // Apply migrations + truncate so every test run starts clean.
  await applyMigrations(baseEnv, 'dcc-auth', resolve(ROOT, 'services/auth'));
  await applyMigrations(baseEnv, 'dcc-chat-gateway', resolve(ROOT, 'services/chat-gateway'));
  await truncateDb(baseEnv);

  // Kill only previously-spawned test services (from the last run's pid file).
  // This cleans up stale test processes after a crash without touching the
  // user's dev servers. If the port is still held afterwards, assertPortFree
  // (below) aborts the run with an actionable message.
  const pidFile = resolve(ROOT, 'node_modules/.dcc-e2e-pids.json');
  let lastPids: Set<number> = new Set();
  try {
    lastPids = new Set(JSON.parse(readFileSync(pidFile, 'utf8')) as number[]);
  } catch { /* no prior run or file missing — nothing to clean up */ }
  killPort(8001, lastPids);
  killPort(8002, lastPids);
  if (lastPids.size > 0) {
    await new Promise((r) => setTimeout(r, 500)); // brief settle after kill
  }

  // Pre-flight: the ports must be free now. If not (a dev stack is running),
  // abort with a clear message rather than silently testing the wrong DB.
  assertPortFree(8001);
  assertPortFree(8002);

  startService('dcc-auth', baseEnv, 8001, resolve(ROOT, 'services/auth'));
  startService('dcc-chat-gateway', baseEnv, 8002, resolve(ROOT, 'services/chat-gateway'));

  await waitFor('http://127.0.0.1:8001/health');
  await waitFor('http://127.0.0.1:8002/health');

  // Update pid file with the freshly-spawned test-server PIDs for teardown.
  writeFileSync(pidFile, JSON.stringify(procs.map((p) => p.pid).filter(Boolean)));
}
