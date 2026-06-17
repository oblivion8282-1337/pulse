/**
 * Control-Plane-Komponenten für den lokalen Self-Host-Stack.
 *
 * Liefert SupervisedProcessSpec-Objekte für alle Dienste ausser Postgres
 * (der läuft separat über postgres.ts + SupervisedProcess in LocalBackendManager).
 *
 * Reihenfolge / Abhängigkeiten:
 *   redis        — kein Upstream
 *   minio        — kein Upstream
 *   auth         — postgres, redis
 *   media-svc    — postgres, redis
 *   mediamtx-auth-hook — redis
 *   chat-gateway — postgres, redis, auth, media-svc, mediamtx-auth-hook (last)
 */

import { join } from 'node:path';

import { resolveBinary, resolveUv } from './paths.ts';
import { tcpProbe, httpHealth } from './health.ts';
import type { SupervisedProcessSpec } from './process.ts';
import type { DataDirs } from './types.ts';
import type { Ports } from './renderConfig.ts';
import type { Secrets } from './secrets.ts';

export type { SupervisedProcessSpec };

// ---------------------------------------------------------------------------
// Hilfsfunktion: uvicorn-Spawn-Argumente
// ---------------------------------------------------------------------------

function uvicornArgs(pkg: string, module: string): string[] {
  return ['run', '--package', pkg, 'uvicorn', module, '--host', '127.0.0.1', '--no-access-log'];
}

// ---------------------------------------------------------------------------
// Ports-Erweiterung: mediaAuthHook
// ---------------------------------------------------------------------------

export interface ExtendedPorts extends Ports {
  mediaAuthHook: number;
}

// ---------------------------------------------------------------------------
// controlPlaneComponents
// ---------------------------------------------------------------------------

/**
 * Erzeugt SupervisedProcessSpec-Objekte für alle Control-Plane-Dienste.
 *
 * @param env     Vollständige Env-Map aus renderEnv().
 * @param dirs    Data-Verzeichnisse aus dataDir().
 * @param ports   Port-Konfiguration (inkl. mediaAuthHook).
 * @param secrets Secrets aus ensureSecrets() — werden nicht geloggt.
 * @param repoRoot Absoluter Pfad zum Repository-Root.
 */
export function controlPlaneComponents(
  env: Record<string, string>,
  dirs: DataDirs,
  ports: ExtendedPorts,
  secrets: Secrets,
  repoRoot: string,
): SupervisedProcessSpec[] {
  const uv = resolveUv();
  const redisBin = resolveBinary('redis-server');
  const minioBin = resolveBinary('minio');

  // ---------------------------------------------------------------------------
  // redis
  // ---------------------------------------------------------------------------
  const redis: SupervisedProcessSpec = {
    name: 'redis',
    command: redisBin,
    args: [
      '--bind', '127.0.0.1',
      '--port', String(ports.redis),
      '--dir', dirs.redis,
      '--appendonly', 'yes',
      '--save', '60', '1000',
      '--maxmemory-policy', 'noeviction',
      '--loglevel', 'notice',
    ],
    env: {},
    healthCheck: () => tcpProbe(ports.redis),
    restartMax: 3,
  };

  // ---------------------------------------------------------------------------
  // minio
  // ---------------------------------------------------------------------------
  const minio: SupervisedProcessSpec = {
    name: 'minio',
    command: minioBin,
    args: ['server', dirs.minio, '--address', `127.0.0.1:${ports.minio}`, '--console-address', ':0'],
    env: {
      MINIO_ROOT_USER: secrets.minioUser,
      MINIO_ROOT_PASSWORD: secrets.minioPassword,
      MINIO_BROWSER: 'off',
    },
    healthCheck: () => tcpProbe(ports.minio),
    restartMax: 3,
  };

  // ---------------------------------------------------------------------------
  // auth-svc
  // ---------------------------------------------------------------------------
  const auth: SupervisedProcessSpec = {
    name: 'auth',
    command: uv,
    args: [...uvicornArgs('dcc-auth', 'dcc_auth.app:app'), '--port', String(ports.auth)],
    cwd: join(repoRoot, 'services', 'auth'),
    env,
    healthCheck: () => httpHealth(`http://127.0.0.1:${ports.auth}/health`),
    restartMax: 3,
  };

  // ---------------------------------------------------------------------------
  // media-svc
  // ---------------------------------------------------------------------------
  const mediaSvc: SupervisedProcessSpec = {
    name: 'media-svc',
    command: uv,
    args: [...uvicornArgs('dcc-media-svc', 'dcc_media_svc.app:app'), '--port', String(ports.media)],
    cwd: join(repoRoot, 'services', 'media-svc'),
    env,
    healthCheck: () => httpHealth(`http://127.0.0.1:${ports.media}/health`),
    restartMax: 3,
  };

  // ---------------------------------------------------------------------------
  // mediamtx-auth-hook
  // ---------------------------------------------------------------------------
  const mediamtxAuthHook: SupervisedProcessSpec = {
    name: 'mediamtx-auth-hook',
    command: uv,
    args: [
      ...uvicornArgs('dcc-mediamtx-auth-hook', 'dcc_mediamtx_auth_hook.app:app'),
      '--port', String(ports.mediaAuthHook),
    ],
    cwd: join(repoRoot, 'services', 'mediamtx-auth-hook'),
    env,
    healthCheck: () => tcpProbe(ports.mediaAuthHook),
    restartMax: 3,
  };

  // ---------------------------------------------------------------------------
  // chat-gateway (last — depends on all others)
  // ---------------------------------------------------------------------------
  const chatGateway: SupervisedProcessSpec = {
    name: 'chat-gateway',
    command: uv,
    args: [
      ...uvicornArgs('dcc-chat-gateway', 'dcc_chat_gateway.app:app'),
      '--port', String(ports.chat),
    ],
    cwd: join(repoRoot, 'services', 'chat-gateway'),
    env,
    healthCheck: () => httpHealth(`http://127.0.0.1:${ports.chat}/health`),
    restartMax: 3,
  };

  return [redis, minio, auth, mediaSvc, mediamtxAuthHook, chatGateway];
}
