/**
 * LocalBackendManager — orchestriert den vollständigen lokalen Self-Host-Stack.
 *
 * Start-Sequenz:
 *   1. Verzeichnisse anlegen (dataDir)
 *   2. Secrets sicherstellen (ensureSecrets)
 *   3. Env rendern (renderEnv)
 *   4. Postgres initialisieren (initPostgres — idempotent)
 *   5. Postgres starten + health-gaten
 *   6. Migrationen laufen lassen (runMigrations)
 *   7. Redis starten + health-gate
 *   8. MinIO starten + health-gate
 *   9. MinIO-Bucket sicherstellen (init-minio-bucket.py via uv run python)
 *  10. auth-svc starten + health-gate
 *  11. media-svc starten + health-gate
 *  12. mediamtx-auth-hook starten + health-gate
 *  13. chat-gateway starten + health-gate
 *
 * Stop-Sequenz: umgekehrt; Postgres zuletzt über stopPostgres().
 * Bei Fehler während start(): Rollback (alle bereits gestarteten Prozesse stoppen).
 *
 * Keine externen Dependencies — nur Node-Builtins + lokale Module.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { dataDir, resolveUv } from './paths.ts';
import { ensureSecrets } from './secrets.ts';
import { renderEnv } from './renderConfig.ts';
import { initPostgres, startPostgresSpec, stopPostgres } from './postgres.ts';
import { runMigrations } from './migrations.ts';
import { SupervisedProcess } from './process.ts';
import { tcpProbe } from './health.ts';
import { controlPlaneComponents } from './components.ts';
import { tunnelComponent } from './tunnel.ts';

import type { TunnelRelay } from './tunnel.ts';
import type { FixtureIdentity, Ports } from './renderConfig.ts';
import type { ExtendedPorts } from './components.ts';
import type { SupervisedProcessSpec } from './process.ts';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface StartInput {
  /** Electron userData-Verzeichnis (z.B. app.getPath('userData')). */
  userData: string;
  /** Self-Host-Identität für env-Rendering. */
  identity: FixtureIdentity;
  /** Optionale Port-Overrides (für Tests). */
  ports?: Partial<ExtendedPorts>;
  /** Absoluter Pfad zum Repository-Root. Default: aus diesem Modul berechnet. */
  repoRoot?: string;
  /** Zusätzliche Env-Vars, die in jede Service-Env gemergt werden (überschreiben den Basis-Render). */
  extraEnv?: Record<string, string>;
  /** Relay-Tunnel-Konfiguration. Wenn gesetzt, wird frpc nach chat-gateway gestartet. */
  relay?: TunnelRelay;
}

export type ComponentStatus = 'stopped' | 'starting' | 'running' | 'failed';

export interface ManagerStatus {
  state: 'stopped' | 'running' | 'starting' | 'failed';
  components: Record<string, ComponentStatus>;
}

// ---------------------------------------------------------------------------
// Default-Ports (weit oben im ephemeren Bereich, weg von 5432/6379 etc.)
// ---------------------------------------------------------------------------

const DEFAULT_PORTS: ExtendedPorts = {
  postgres: 55540,
  redis: 55541,
  minio: 55542,
  auth: 55543,
  chat: 55544,
  media: 55545,
  mediaAuthHook: 55546,
};

// ---------------------------------------------------------------------------
// Repository-Root-Auflösung
// ---------------------------------------------------------------------------

function resolveRepoRoot(): string {
  if (process.env.PULSE_REPO_ROOT) return process.env.PULSE_REPO_ROOT;
  try {
    // ESM: import.meta.url verfügbar
    // @ts-ignore
    const metaUrl: string = import.meta.url;
    const thisFile = fileURLToPath(metaUrl);
    // localBackendManager.ts → localBackend/ → electron/ → desktop/ → repo-root
    return join(dirname(thisFile), '..', '..', '..', '..');
  } catch {
    // CJS-Fallback
    return join(__dirname, '..', '..', '..', '..');
  }
}

// ---------------------------------------------------------------------------
// MinIO-Bucket-Init via init-minio-bucket.py (best-effort)
// ---------------------------------------------------------------------------

async function ensureMinioBucket(
  env: Record<string, string>,
  repoRoot: string,
): Promise<void> {
  const scriptPath = join(
    repoRoot,
    'infra', 'self-host', 's6', 'etc', 's6-overlay', 'scripts', 'init-minio-bucket.py',
  );
  if (!existsSync(scriptPath)) {
    console.warn('[manager] init-minio-bucket.py nicht gefunden:', scriptPath);
    return;
  }
  let uv: string;
  try { uv = resolveUv(); } catch { console.warn('[manager] uv fehlt — Bucket-Init übersprungen'); return; }

  await new Promise<void>((resolve) => {
    const proc = spawn(uv, ['run', 'python', scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    proc.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => out.push(d.toString()));
    proc.on('error', (e) => { console.warn('[manager] Bucket-Init Fehler (ignoriert):', e); resolve(); });
    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.warn('[manager] Bucket-Init exit', code, ':', out.join('').slice(0, 500));
      }
      resolve(); // immer best-effort
    });
  });
}

// ---------------------------------------------------------------------------
// LocalBackendManager
// ---------------------------------------------------------------------------

export class LocalBackendManager {
  private _state: ManagerStatus['state'] = 'stopped';
  private _compStatus: Record<string, ComponentStatus> = {};
  // Reihenfolge für Shutdown: in Startsequenz-Reihenfolge gespeichert, reverse beim Stop
  private _startedProcs: Array<{ name: string; proc: SupervisedProcess }> = [];
  private _pgDirs: Parameters<typeof stopPostgres>[0] | null = null;

  // ── Public API ────────────────────────────────────────────────────────────

  async start(input: StartInput): Promise<void> {
    if (this._state === 'running' || this._state === 'starting') {
      throw new Error('[manager] start() bereits aufgerufen');
    }

    this._state = 'starting';
    this._compStatus = {};
    this._startedProcs = [];

    const repoRoot = input.repoRoot ?? resolveRepoRoot();
    const ports: ExtendedPorts = { ...DEFAULT_PORTS, ...input.ports };
    const dirs = dataDir(input.userData);

    // 1. Verzeichnisse anlegen
    for (const p of Object.values(dirs)) {
      mkdirSync(p, { recursive: true });
    }

    try {
      // 2. Secrets
      const secrets = await ensureSecrets(dirs.secrets);

      // 3. Env rendern
      const basePorts: Ports = {
        postgres: ports.postgres,
        redis: ports.redis,
        minio: ports.minio,
        auth: ports.auth,
        chat: ports.chat,
        media: ports.media,
      };
      const effectiveIdentity: FixtureIdentity = input.relay
        ? { ...input.identity, relaySubdomain: input.relay.subdomain }
        : input.identity;
      const baseEnv = renderEnv({ dirs, secrets, ports: basePorts, identity: effectiveIdentity });

      // Zusätzliche Env-Overrides für lokalen Stack
      const fullEnv: Record<string, string> = {
        ...baseEnv,
        // Lokale Accounts für Self-Host (nötig für Test + echten Self-Host ohne Cloud-Pairing)
        ALLOW_LOCAL_ACCOUNTS: 'true',
        // MediaMTX-Sidecar ist optional — kein Crash wenn nicht vorhanden
        MEDIAMTX_API_URL: `http://127.0.0.1:9997/v3/paths/list`,
        // mediamtx-auth-hook Port für media-svc
        MEDIAMTX_AUTH_HOOK_URL: `http://127.0.0.1:${ports.mediaAuthHook}`,
        // Caller-Overrides (z.B. für Smoke-Tests oder spezielle Deployments)
        ...input.extraEnv,
      };

      // 4. Postgres initialisieren (idempotent)
      console.log('[manager] Schritt 4: Postgres initialisieren...');
      initPostgres(dirs, secrets);

      // 5. Postgres starten
      console.log('[manager] Schritt 5: Postgres starten...');
      const pgSpec = startPostgresSpec(dirs, ports.postgres);
      const pgProc = new SupervisedProcess({
        name: 'postgres',
        ...pgSpec,
        healthCheck: () => tcpProbe(ports.postgres),
        restartMax: 0,
      });
      this._compStatus['postgres'] = 'starting';
      this._pgDirs = dirs;
      await pgProc.start();
      this._startedProcs.push({ name: 'postgres', proc: pgProc });
      this._compStatus['postgres'] = 'running';
      console.log('[manager] Postgres läuft.');

      // 6. Migrationen
      console.log('[manager] Schritt 6: Migrationen...');
      await runMigrations(repoRoot, fullEnv);

      // 7–13. Control-Plane-Komponenten sequenziell starten
      const specs = controlPlaneComponents(fullEnv, dirs, ports, secrets, repoRoot);

      for (const spec of specs) {
        await this._startSpec(spec);
        // Nach MinIO-Start: Bucket sicherstellen
        if (spec.name === 'minio') {
          console.log('[manager] MinIO-Bucket sicherstellen...');
          await ensureMinioBucket(fullEnv, repoRoot);
        }
      }

      // 14. Tunnel starten (optional, nach chat-gateway)
      if (input.relay) {
        await this._startSpec(tunnelComponent({ dirs, relay: input.relay, chatPort: ports.chat }));
      }

      this._state = 'running';
      console.log('[manager] Gesamter Stack läuft.');
    } catch (err) {
      this._state = 'failed';
      console.error('[manager] Startfehler — Rollback:', (err as Error).message);
      await this._rollback();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this._state === 'stopped') return;
    console.log('[manager] Stack wird gestoppt...');

    // Umgekehrte Startreihenfolge (ohne postgres — der kommt am Schluss via pg_ctl)
    const toStop = [...this._startedProcs].reverse().filter(e => e.name !== 'postgres');

    for (const { name, proc } of toStop) {
      console.log(`[manager] ${name} stoppen...`);
      try { await proc.stop(); } catch (e) { console.error(`[manager] ${name} stop-Fehler:`, e); }
      this._compStatus[name] = 'stopped';
    }

    // Postgres via pg_ctl fast stop (saubererer als kill)
    if (this._pgDirs) {
      console.log('[manager] Postgres stoppen (pg_ctl)...');
      try { stopPostgres(this._pgDirs); } catch { /* bereits gestoppt */ }
      // Zusätzlich SupervisedProcess-Instanz beenden (falls noch läuft)
      const pgEntry = this._startedProcs.find(e => e.name === 'postgres');
      if (pgEntry) {
        try { await pgEntry.proc.stop(); } catch { /* ignorieren */ }
      }
      this._compStatus['postgres'] = 'stopped';
      this._pgDirs = null;
    }

    this._startedProcs = [];
    this._state = 'stopped';
    console.log('[manager] Stack gestoppt.');
  }

  status(): ManagerStatus {
    return {
      state: this._state,
      components: { ...this._compStatus },
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async _startSpec(spec: SupervisedProcessSpec): Promise<void> {
    console.log(`[manager] Starte ${spec.name}...`);
    this._compStatus[spec.name] = 'starting';
    const proc = new SupervisedProcess(spec);
    await proc.start();
    this._startedProcs.push({ name: spec.name, proc });
    this._compStatus[spec.name] = 'running';
    console.log(`[manager] ${spec.name} läuft.`);
  }

  private async _rollback(): Promise<void> {
    const toStop = [...this._startedProcs].reverse().filter(e => e.name !== 'postgres');
    for (const { name, proc } of toStop) {
      try { await proc.stop(); } catch { /* ignorieren */ }
      this._compStatus[name] = 'stopped';
    }
    if (this._pgDirs) {
      try { stopPostgres(this._pgDirs); } catch { /* ignorieren */ }
      const pgEntry = this._startedProcs.find(e => e.name === 'postgres');
      if (pgEntry) { try { await pgEntry.proc.stop(); } catch { /* ignorieren */ } }
      this._compStatus['postgres'] = 'stopped';
      this._pgDirs = null;
    }
    this._startedProcs = [];
  }
}
