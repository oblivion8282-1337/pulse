import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { DataDirs, BinaryName } from './types.ts';

export type { DataDirs, BinaryName };

export class BinaryNotFoundError extends Error {
  constructor(name: string) {
    super(`Binary not found: ${name}`);
    this.name = 'BinaryNotFoundError';
  }
}

export function dataDir(userData: string): DataDirs {
  const root = join(userData, 'pulse-host', 'data');
  return {
    root,
    pg: join(root, 'pg'),
    redis: join(root, 'redis'),
    minio: join(root, 'minio'),
    uploadsAvatars: join(root, 'uploads', 'avatars'),
    uploadsGuildIcons: join(root, 'uploads', 'guild-icons'),
    secrets: join(root, 'secrets'),
    backups: join(root, 'backups'),
  };
}

/** Sucht Binary: $PULSE_HOST_BIN/<name> → resourcesPath/host-bin/<name> → PATH. */
export function resolveBinary(
  name: BinaryName,
  env: Record<string, string | undefined> = process.env,
): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;

  const candidates: string[] = [];

  if (env.PULSE_HOST_BIN) {
    candidates.push(join(env.PULSE_HOST_BIN, exe));
  }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(join(resourcesPath, 'host-bin', exe));
  }

  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }

  // PATH-Suche als letzter Fallback
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(which, [exe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env });
    const resolved = result.trim().split('\n')[0].trim();
    if (resolved) return resolved;
  } catch {
    // nicht auf PATH
  }

  throw new BinaryNotFoundError(name);
}
