/**
 * Server-Name aus der Server-App lesen/setzen (2026-10-08).
 *
 * Die Server-App hat auf ihrem eigenen Server kein Admin-Konto, wohl aber das
 * interne Geheimnis: im Container-Weg über `podman exec` + `pulse-servername`
 * (infra/self-host/servername.py), nativ über die Datei im Datenverzeichnis.
 * Beide sprechen `/internal/instance-name` des chat-gateway an — der verteilt
 * den Namen an verbundene Clients und meldet ihn der Cloud, die ihn in die
 * Server-Leiste aller Mitglieder bringt.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { rtExec, type ContainerRuntime } from './containerRuntime.ts';
import { containerName } from './containerWelt.ts';

/** Gleiche Grenze wie der chat-gateway (`PermissionsPatch.instance_name`). */
export const SERVERNAME_MAX = 60;

const WERKZEUG = '/usr/local/bin/pulse-servername';

export function serverNameContainer(rt: ContainerRuntime): Promise<string | null> {
  return werkzeug(rt, '--zeige');
}

export function setzeServerNameContainer(rt: ContainerRuntime, name: string): Promise<string | null> {
  return werkzeug(rt, name);
}

async function werkzeug(rt: ContainerRuntime, arg: string): Promise<string | null> {
  // argv statt Shell: der Name geht unverändert als ein Argument durch.
  const r = await rtExec(rt, ['exec', containerName(), WERKZEUG, arg], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(fehlerText(r.code, r.stderr));
  return r.stdout.trim() || null;
}

function fehlerText(code: number, stderr: string): string {
  // 126/127: Image älter als das Werkzeug (vor 2026-10-08).
  if (code === 126 || code === 127) return 'Dieser Server-Stand kennt das noch nicht — nach dem nächsten Update erneut versuchen.';
  return `Server-Name nicht gesetzt (exit ${code}): ${stderr.trim().slice(0, 200)}`;
}

/** Nativer Weg: dieselbe Route, direkt auf dem Loopback. */
export async function serverNameNativ(
  geheimnisDir: string,
  chatPort: number,
  name?: string,
): Promise<string | null> {
  const geheimnis = readFileSync(join(geheimnisDir, 'internal_service.token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${chatPort}/internal/instance-name`, {
    method: name === undefined ? 'GET' : 'PUT',
    headers: { 'X-Pulse-Internal-Secret': geheimnis, 'Content-Type': 'application/json' },
    body: name === undefined ? undefined : JSON.stringify({ name }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Server-Name nicht gesetzt (HTTP ${r.status})`);
  return ((await r.json()) as { name: string | null }).name ?? null;
}
