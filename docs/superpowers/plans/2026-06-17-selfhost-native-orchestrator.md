# Selfhost ① — Native Orchestrator (Control-Plane Walking Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den echten Pulse-Backend-Stack (Postgres + Redis + MinIO + auth + chat-gateway + media-svc + mediamtx-auth-hook) **Docker-frei als native Prozesse** auf der Dev-Plattform starten, Migrationen laufen lassen und per Smoke-Harness verifizieren — als Fundament des `LocalBackendManager`.

**Architecture:** Ein `LocalBackendManager` im Electron-Main (Node/TS) **portiert die s6-Orchestrierung des `allinone`-Containers** (`infra/self-host/s6/...`): Init-Sequenz (Daten-Dirs → Secrets → initdb/Schema → Config-Rendering → Migrationen → MinIO-Bucket) + abhängigkeits-geordnete Prozess-Supervision mit Health-Gating. Diese Scheibe = nur die HTTP/Control-Plane (keine Medien), auf der Dev-Plattform, headless verifizierbar.

**Tech Stack:** TypeScript (Electron-Main, `desktop/electron/`), Node `child_process`, Vitest (Unit) + ein integratives Smoke-Skript. Backend unverändert (Postgres 15, Redis 7, MinIO, uvicorn-Services, Alembic). Binaries lokal vorausgesetzt (Cross-Platform-Beschaffung = spätere Scheibe).

## Global Constraints

- **Null Backend-Code-Änderung.** Migrationen/S3/Locking laufen exakt wie in der Cloud — nur orchestrieren, nichts am Backend ändern.
- **Alles bindet `127.0.0.1`** (localhost-only; Erreichbarkeit nach außen = ②).
- **Niemals Secrets/Tokens loggen** (harte CLAUDE.md-Regel).
- **Quelle der Wahrheit für Start-Befehle/Reihenfolge/Env:** `infra/self-host/s6/etc/s6-overlay/` (1:1 portieren, nicht neu erfinden).
- **Branch-/PR-Workflow** (CLAUDE.md): jede Änderung auf Feature-Branch, landen via `bash scripts/ship.sh`.
- **Diese Scheibe = Control-Plane only:** Postgres, Redis, MinIO, auth(8001), chat-gateway(8002), media-svc(8004), mediamtx-auth-hook(8005). **Nicht** dabei: LiveKit/voice-signaling/MediaMTX/coturn (= nächste Scheibe „Medien").

---

## File Structure (neu, unter `desktop/electron/localBackend/`)

- `types.ts` — `ComponentSpec`, `BackendConfig`, `ManagerStatus`, Health-Typen.
- `paths.ts` — Daten-Dir-Layout (`<userData>/pulse-host/data/...`) + Binary-Resolver pro Plattform.
- `secrets.ts` — idempotente Secret-Generierung (Port von `03-init-secrets.sh`).
- `renderConfig.ts` — Env-Map + Config-Files rendern (Port von `07-render-env.sh`).
- `postgres.ts` — `initdb` + DB/Schema-Bootstrap (Port `02-init-postgres.sh`) + start/stop.
- `migrations.ts` — `alembic upgrade head` auth→chat (Port `06-run-migrations.sh`).
- `health.ts` — TCP-Probe + HTTP-`/health` (Port von `pulse-health`).
- `process.ts` — `SupervisedProcess`: spawn + Health-Gate + Restart-Backoff + graceful stop.
- `components.ts` — Komponenten-Inventar (Start-Befehl/Deps/Port/Health) aus dem Blueprint.
- `localBackendManager.ts` — Orchestrierung: Init-Sequenz + abhängigkeits-geordneter Start/Stop.
- `desktop/test/localBackend/*.test.ts` — Unit-Tests; `desktop/test/smoke-controlplane.ts` — Smoke.

---

### Task 1: Daten-Dir-Layout + Binary-Resolver (`paths.ts`)

**Files:**
- Create: `desktop/electron/localBackend/paths.ts`
- Create: `desktop/electron/localBackend/types.ts`
- Test: `desktop/test/localBackend/paths.test.ts`

**Interfaces:**
- Produces: `dataDir(userData: string): DataDirs` mit Feldern `{ root, pg, redis, minio, uploadsAvatars, uploadsGuildIcons, secrets, backups }` (alle absolute Pfade unter `<userData>/pulse-host/data/`).
- Produces: `resolveBinary(name: BinaryName, opts?): string` — sucht Binary über `$PULSE_HOST_BIN/<name>` → `process.resourcesPath/host-bin/<name>` → PATH; wirft `BinaryNotFoundError` wenn nichts gefunden. `BinaryName = 'postgres'|'initdb'|'pg_ctl'|'psql'|'redis-server'|'minio'|'uvicorn'|'alembic'`.

- [ ] **Step 1: Failing test für `dataDir`**

```ts
// desktop/test/localBackend/paths.test.ts
import { describe, it, expect } from 'vitest';
import { dataDir } from '../../electron/localBackend/paths';
describe('dataDir', () => {
  it('legt das Layout unter pulse-host/data ab', () => {
    const d = dataDir('/u');
    expect(d.root).toBe('/u/pulse-host/data');
    expect(d.pg).toBe('/u/pulse-host/data/pg');
    expect(d.secrets).toBe('/u/pulse-host/data/secrets');
    expect(d.minio).toBe('/u/pulse-host/data/minio');
  });
});
```

- [ ] **Step 2: Test laufen lassen, FAIL erwarten**

Run: `cd desktop && pnpm vitest run test/localBackend/paths.test.ts`
Expected: FAIL (`Cannot find module '.../paths'`).

- [ ] **Step 3: `types.ts` + `paths.ts` implementieren**

```ts
// types.ts
export interface DataDirs {
  root: string; pg: string; redis: string; minio: string;
  uploadsAvatars: string; uploadsGuildIcons: string; secrets: string; backups: string;
}
export type BinaryName =
  | 'postgres' | 'initdb' | 'pg_ctl' | 'psql' | 'redis-server' | 'minio' | 'uvicorn' | 'alembic';
```

```ts
// paths.ts
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { DataDirs, BinaryName } from './types';

export function dataDir(userData: string): DataDirs {
  const root = join(userData, 'pulse-host', 'data');
  return {
    root, pg: join(root, 'pg'), redis: join(root, 'redis'), minio: join(root, 'minio'),
    uploadsAvatars: join(root, 'uploads', 'avatars'),
    uploadsGuildIcons: join(root, 'uploads', 'guild-icons'),
    secrets: join(root, 'secrets'), backups: join(root, 'backups'),
  };
}

export class BinaryNotFoundError extends Error {}

export function resolveBinary(name: BinaryName, env = process.env): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const custom = env.PULSE_HOST_BIN ? join(env.PULSE_HOST_BIN, exe) : null;
  const packaged = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ? join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!, 'host-bin', exe)
    : null;
  for (const cand of [custom, packaged].filter(Boolean) as string[]) {
    if (existsSync(cand)) return cand;
  }
  return exe; // Fallback: über PATH (Dev-Maschine hat die Binaries via brew/apt)
}
```

- [ ] **Step 4: Test laufen lassen, PASS erwarten**

Run: `cd desktop && pnpm vitest run test/localBackend/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/localBackend/paths.ts desktop/electron/localBackend/types.ts desktop/test/localBackend/paths.test.ts
git commit -m "feat(selfhost): Daten-Dir-Layout + Binary-Resolver"
```

> **Hinweis Vitest:** Falls `desktop/` noch kein Vitest hat, in Task 1 zusätzlich `vitest` als devDependency aufnehmen (`pnpm add -D vitest` im `desktop`-Workspace) + minimal `vitest.config.ts` (`environment: 'node'`). Das ist Setup, das zum Deliverable von Task 1 gehört.

---

### Task 2: Idempotente Secret-Generierung (`secrets.ts`)

**Files:**
- Create: `desktop/electron/localBackend/secrets.ts`
- Test: `desktop/test/localBackend/secrets.test.ts`
- Referenz (1:1 portieren): `infra/self-host/s6/etc/s6-overlay/scripts/03-init-secrets.sh`

**Interfaces:**
- Produces: `ensureSecrets(secretsDir: string): Promise<Secrets>` — erzeugt fehlende Secrets, lässt vorhandene unangetastet (idempotent), `chmod 600`. `Secrets = { postgresPassword, internalServiceToken, certChallengeSecret, minioUser, minioPassword, jwtPrivateKeyPath, jwtPublicKeyPath, sessionSigningKeyPath }`.

- [ ] **Step 1: Failing test (Idempotenz + chmod)**

```ts
// secrets.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSecrets } from '../../electron/localBackend/secrets';

describe('ensureSecrets', () => {
  it('generiert einmalig und ist danach idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    const a = await ensureSecrets(dir);
    const pwFile = join(dir, 'postgres.password');
    expect(readFileSync(pwFile, 'utf8').length).toBeGreaterThan(32);
    if (process.platform !== 'win32') {
      expect(statSync(pwFile).mode & 0o777).toBe(0o600);
    }
    const b = await ensureSecrets(dir);
    expect(b.postgresPassword).toBe(a.postgresPassword); // nicht neu generiert
  });
});
```

- [ ] **Step 2: Test laufen lassen, FAIL erwarten**

Run: `cd desktop && pnpm vitest run test/localBackend/secrets.test.ts` → FAIL (Modul fehlt).

- [ ] **Step 3: `secrets.ts` implementieren**

Logik exakt wie `03-init-secrets.sh`: `postgres.password` = 64 Hex (`crypto.randomBytes(32).toString('hex')`), `internal_service.token`/`cert_challenge.secret` = url-safe 32B, `minio.user` = `pulse-<8hex>`, `minio.password` = 64 Hex, RSA-2048 JWT-Keypair + Ed25519-Session-Key via `crypto.generateKeyPairSync`. Jede Datei nur schreiben, wenn nicht vorhanden; danach `chmod(0o600)` (skip auf win32).

```ts
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
// ... pro Secret: const f = join(dir,name); if(!existsSync(f)){ writeFileSync(f, value); if(process.platform!=='win32') chmodSync(f,0o600); } return readFileSync(f,'utf8');
```

- [ ] **Step 4: Test laufen lassen, PASS erwarten** — `pnpm vitest run test/localBackend/secrets.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): idempotente Secret-Generierung (Port 03-init-secrets)"`

---

### Task 3: Env-/Config-Rendering (`renderConfig.ts`)

**Files:**
- Create: `desktop/electron/localBackend/renderConfig.ts`
- Test: `desktop/test/localBackend/renderConfig.test.ts`
- Referenz: `infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh`

**Interfaces:**
- Consumes: `DataDirs` (Task 1), `Secrets` (Task 2), `Ports` (Map Komponente→Port), `FixtureIdentity` (`{ hostname, instanceId, ownerId }`).
- Produces: `renderEnv(input): Record<string,string>` — die Env, die jeder uvicorn-Service erbt (`DATABASE_URL=postgresql+asyncpg://pulse:<pw>@127.0.0.1:<pgPort>/dcc`, `REDIS_URL`, `S3_*`, JWT-Pfade, `INTERNAL_SERVICE_SECRET`, `PULSE_INSTANCE_MODE=self-host`, `PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID`, `MEDIA_SVC_URL`, `AUTH_JWKS_URL`, …). Werte 1:1 wie im Blueprint §5.1.

- [ ] **Step 1: Failing test**

```ts
import { renderEnv } from '../../electron/localBackend/renderConfig';
it('baut DATABASE_URL + self-host-Identität', () => {
  const env = renderEnv({
    dirs: { /* ... */ } as any, secrets: { postgresPassword: 'PW', /* ... */ } as any,
    ports: { postgres: 5432, redis: 6379, minio: 9000, auth: 8001, chat: 8002, media: 8004 },
    identity: { hostname: 'host.local', instanceId: '123', ownerId: '999' },
  });
  expect(env.DATABASE_URL).toBe('postgresql+asyncpg://pulse:PW@127.0.0.1:5432/dcc');
  expect(env.REDIS_URL).toBe('redis://127.0.0.1:6379/0');
  expect(env.PULSE_INSTANCE_MODE).toBe('self-host');
  expect(env.PULSE_INSTANCE_ID).toBe('123');
});
```

- [ ] **Step 2: FAIL** — `pnpm vitest run test/localBackend/renderConfig.test.ts`.
- [ ] **Step 3: Implementieren** — reine Funktion, baut die Env-Map aus den Inputs (alle Keys aus Blueprint §5.1, localhost-Endpunkte, dynamische Ports eingesetzt).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): Env-Rendering (Port 07-render-env)"`

---

### Task 4: Postgres-Lifecycle (`postgres.ts`)

**Files:**
- Create: `desktop/electron/localBackend/postgres.ts`
- Test (integration): `desktop/test/localBackend/postgres.int.test.ts`
- Referenz: `infra/self-host/s6/etc/s6-overlay/scripts/02-init-postgres.sh` + `s6-rc.d/postgres/run`

**Interfaces:**
- Produces: `initPostgres(dirs, secrets): Promise<void>` (`initdb -D <pg>` falls leer → bootstrap-start → `CREATE DATABASE dcc OWNER pulse` + `CREATE SCHEMA auth/chat` → stop). `startPostgres(dirs, port): SupervisedProcess`-Spec (Befehl: `postgres -D <pg> -k <run> -h 127.0.0.1 -p <port> -c shared_buffers=128MB -c max_connections=100`). `stopPostgres(dirs)` via `pg_ctl -D <pg> -m fast -w stop`.

> Diese Tasks sind **integrations-verifiziert** (echtes Postgres-Binary nötig), nicht reines Unit-TDD — die Orchestrierung lässt sich nur gegen reale Prozesse sinnvoll prüfen.

- [ ] **Step 1: Integration-Test schreiben (skip wenn kein `initdb` auf PATH)**

```ts
import { describe, it, expect } from 'vitest';
import { resolveBinary } from '../../electron/localBackend/paths';
const hasPg = () => { try { return !!resolveBinary('initdb'); } catch { return false; } };
describe.runIf(hasPg())('postgres lifecycle', () => {
  it('initdb → start → pg_isready → stop', async () => {
    // temp dirs + ensureSecrets, initPostgres, startPostgres, await tcpProbe(port), stopPostgres
    // assert: pg_isready exit 0 während laufend; nach stop kein Listener mehr
  });
});
```

- [ ] **Step 2: FAIL** (Funktionen fehlen).
- [ ] **Step 3: `postgres.ts` implementieren** — Befehle 1:1 aus dem Blueprint (`initdb`, `pg_ctl` bootstrap-start auf temp-socket, `psql` CREATE DATABASE/SCHEMA, `pg_ctl stop`); `startPostgres` liefert die Supervised-Spec für Task 8.
- [ ] **Step 4: PASS** (gegen lokales Postgres).
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): Postgres initdb/bootstrap/start/stop (Port 02-init-postgres)"`

---

### Task 5: Migrations-Runner (`migrations.ts`)

**Files:**
- Create: `desktop/electron/localBackend/migrations.ts`
- Test: in `postgres.int.test.ts` erweitert
- Referenz: `infra/self-host/s6/etc/s6-overlay/scripts/06-run-migrations.sh`

**Interfaces:**
- Consumes: laufendes Postgres (Task 4), `env` (Task 3).
- Produces: `runMigrations(repoRoot, env): Promise<void>` — `alembic upgrade head` in `services/auth`, danach `services/chat-gateway`, mit `DATABASE_URL` aus `env`. Nutzt das vorhandene uv-Venv (`uv run --package dcc-auth alembic upgrade head`).

- [ ] **Step 1: Test** — nach `initPostgres`+`startPostgres`+`runMigrations`: `psql -d dcc -c "\dt auth.*"` zeigt `auth.users`; `chat.guilds` existiert.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implementieren** — sequenziell `auth` dann `chat-gateway`, Fehler propagieren (kein halb-migrierter Start).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): Alembic-Migrationen auth→chat (Port 06-run-migrations)"`

---

### Task 6: Health-Probes + Supervised-Prozess (`health.ts`, `process.ts`)

**Files:**
- Create: `desktop/electron/localBackend/health.ts`, `desktop/electron/localBackend/process.ts`
- Test: `desktop/test/localBackend/process.test.ts`
- Referenz: `infra/self-host/s6/usr/local/bin/pulse-health` + `web/tests/e2e/_globalSetup.ts` (waitFor-Muster) + `desktop/electron/sidecar.ts` (SIGTERM→SIGKILL-Staffel)

**Interfaces:**
- Produces: `tcpProbe(port, host='127.0.0.1', timeoutMs): Promise<boolean>`, `httpHealth(url, timeoutMs): Promise<boolean>`, `waitFor(check, totalMs): Promise<void>`.
- Produces: `class SupervisedProcess { constructor(spec); start(): Promise<void> /*spawn + waitFor(health)*/; stop(): Promise<void> /*SIGTERM→(grace)→SIGKILL*/; onExit(cb) }` mit Restart-Backoff (max N).

- [ ] **Step 1: Test** — `SupervisedProcess` mit Spec, die `node -e "require('http').createServer((_,r)=>r.end('ok')).listen(PORT)"` startet + `httpHealth`-Check: `start()` resolved erst nach Health-OK; `stop()` beendet den Prozess (danach `tcpProbe` false). Restart: Prozess killen → wird ≤N-mal neu gestartet.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implementieren** — `health.ts` (net.Socket-Probe + fetch mit AbortController); `process.ts` (`child_process.spawn`, Health-Gate beim Start, Exit-Listener mit Backoff-Restart, graceful stop wie `sidecar.ts`).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): Health-Probes + SupervisedProcess"`

---

### Task 7: Komponenten-Inventar + Orchestrierung (`components.ts`, `localBackendManager.ts`)

**Files:**
- Create: `desktop/electron/localBackend/components.ts`, `desktop/electron/localBackend/localBackendManager.ts`
- Test (integration): `desktop/test/localBackend/manager.int.test.ts`
- Referenz: Blueprint §3 (Dependency-Graph) + §4 (Start-Befehle)

**Interfaces:**
- `components.ts` Produces: `controlPlaneComponents(env, dirs, ports): ComponentSpec[]` — die Specs für redis, minio, auth, chat-gateway, media-svc, mediamtx-auth-hook (jeweils Befehl/Args/cwd/env/healthCheck/dependsOn), Befehle 1:1 Blueprint §4. Postgres wird separat (Task 4) vor den Supervised-Komponenten gestartet.
- `localBackendManager.ts` Produces: `class LocalBackendManager { start(input): Promise<void>; stop(): Promise<void>; status(): ManagerStatus }`. `start()` führt die Init-Sequenz aus (dirs → ensureSecrets → renderEnv → initPostgres → startPostgres → runMigrations → minio + Bucket → Supervised-Komponenten in Abhängigkeits-Reihenfolge mit Health-Gate). `stop()` umgekehrt + `stopPostgres`.

- [ ] **Step 1: Integration-Test** — `manager.start({ userData: tmp, identity: fixture })` → danach: `httpHealth('http://127.0.0.1:<chat>/health')` true; `manager.status()` zeigt alle Komponenten `running`. `manager.stop()` → alle Ports tot.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implementieren** — Orchestrierung exakt nach Blueprint-Reihenfolge; MinIO-Bucket-Init via vorhandenes `init-minio-bucket.py`-Äquivalent (oder `mc`/HTTP). Rollback bei Start-Fehler (gestartete Prozesse stoppen).
- [ ] **Step 4: PASS** (gegen lokale Binaries; Test mit `describe.runIf` auf Binary-Verfügbarkeit).
- [ ] **Step 5: Commit** — `git commit -m "feat(selfhost): LocalBackendManager Control-Plane-Orchestrierung"`

---

### Task 8: Smoke-Harness (End-to-End Control-Plane)

**Files:**
- Create: `desktop/test/smoke-controlplane.ts` (Node-Skript, kein Vitest)
- Referenz: Erfolgskriterien der Spec §7

**Interfaces:**
- Consumes: `LocalBackendManager` (Task 7).

- [ ] **Step 1: Smoke-Skript schreiben** — `manager.start(fixture)` → auf Health warten → via HTTP: einen Cert-Login-Fixture durchspielen (oder, falls Cert-Flow zu schwer für die Scheibe, `ALLOW_LOCAL_ACCOUNTS=true` in der Fixture-Env + `POST /register` → `POST /login`) → `POST /api/chat/guilds` (Community anlegen) → `POST .../messages` → presigned Attachment-Upload zu MinIO → assert 2xx überall → `manager.stop()`.
- [ ] **Step 2: Laufen lassen** — `cd desktop && pnpm tsx test/smoke-controlplane.ts`; Expected: alle Schritte 2xx, sauberer Shutdown, Exit 0.
- [ ] **Step 3: Doku** — kurze `desktop/electron/localBackend/README.md`: was läuft, wie man den Smoke startet, welche Binaries lokal nötig sind.
- [ ] **Step 4: Commit** — `git commit -m "feat(selfhost): Control-Plane Smoke-Harness + README"`

---

## Nächste Plan-Scheiben (nicht in diesem Plan)

- **Scheibe „Medien":** LiveKit + voice-signaling + MediaMTX + coturn ergänzen; Smoke um Voice-Call + HQ-Stream erweitern.
- **Scheibe „Cross-Platform-Binaries":** Postgres-15-/Python-Beschaffung pro Plattform (§9 der Spec), Bündelung ins on-demand-Modul.
- **Scheibe „Electron-Integration":** `LocalBackendManager` an Electron-Main/IPC + „Instanz hosten"-UI (= Sub-Projekt ③).

## Self-Review

- **Spec-Coverage:** §3 Komponenten → Tasks 4/7; §6 Init-Sequenz/Lifecycle → Tasks 2–7; §6 Fehler/Rollback → Task 7 Step 3; §7 Smoke → Task 8; §5 „s6 portieren" → Tasks 2–7 (mit Referenz-Skripten). Medien (§3) + Cross-Platform (§5.2) + Daten-Dir-Upgrade (§5.3) bewusst spätere Scheiben — markiert.
- **Platzhalter:** keine „TBD"; integrations-verifizierte Tasks (4/5/7) sind als solche gekennzeichnet (reines Unit-TDD passt für Prozess-Orchestrierung nicht — ehrliche Abweichung von der TDD-Ideallinie).
- **Typ-Konsistenz:** `DataDirs`/`Secrets`/`ComponentSpec`/`SupervisedProcess` durchgängig gleich benannt über Tasks 1→7.
