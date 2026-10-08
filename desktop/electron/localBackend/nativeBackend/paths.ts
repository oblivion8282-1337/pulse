/**
 * Pfade + Binary-Auflösung für das native Windows-Backend.
 *
 * Layout (gepackt): <resourcesPath>/native/
 *   native-bin/   — caddy.exe, garnet-server/, weed.exe, livekit/, mediamtx/,
 *                   pg/bin/, direct-adapter.exe
 *   python/       — eingebettete CPython-venv (uv, bei Build-Zeit befüllt)
 *   services/     — Python-Quellen der Services (dcc_auth, dcc_chat_gateway, …)
 *   templates/    — Caddyfile.template (aus infra/self-host übernommen)
 *
 * Dev: PULSE_NATIVE_ROOT zeigt auf ein vorbereitetes Verzeichnis
 * (desktop/scripts/fetch-win-native.ps1 baut desktop/resources-native/).
 *
 * Gepackt gelten weder PULSE_NATIVE_ROOT noch der PATH-Rückfall: beide
 * würden sonst Binaries von außerhalb der Installation starten (eine
 * Umgebungsvariable oder ein `postgres.exe` irgendwo im PATH genügte), und
 * der Server liefe mit fremden Programmen unter Pulses Namen.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as electron from 'electron';

import type { NativeDataDirs } from './types.ts';

type ElectronWithResources = { resourcesPath?: string; app?: { isPackaged?: boolean } };

/** Gepackter Build? Unter bare Node (Unit-Tests) liefert der electron-Import
 *  keinen app-Export → false. Namespace-Zugriff aus demselben Grund wie in
 *  nativeRoot (kein .default im esbuild-Interop). */
export function istGepackt(): boolean {
  try {
    return (electron as unknown as ElectronWithResources).app?.isPackaged === true;
  } catch {
    return false;
  }
}

/** Root des nativen Ressourcen-Baums (native-bin/python/services/templates). */
export function nativeRoot(
  env: Record<string, string | undefined> = process.env,
  gepackt: boolean = istGepackt(),
): string {
  if (env.PULSE_NATIVE_ROOT && !gepackt) return env.PULSE_NATIVE_ROOT;
  // KEIN Default-Import: electron exportiert __esModule:true (seit 28), der
  // esbuild-Interop baut dann KEIN .default — `import electron from` +
  // `.resourcesPath` war im gepackten Build undefined → TypeError →
  // runtimeAvailable false → misleading Podman-Fehler (0.1.93-Deploy, hier
  // nie aufgefallen, weil Dev immer mit PULSE_NATIVE_ROOT lief). Der
  // Namespace-Zugriff greift auf die echten Exports durch.
  let resourcesPath: string | undefined;
  try {
    resourcesPath = (electron as unknown as ElectronWithResources).resourcesPath;
  } catch {
    resourcesPath = undefined;
  }
  if (resourcesPath && existsSync(join(resourcesPath, 'native'))) {
    return join(resourcesPath, 'native');
  }
  // Gepackt NIE relativ zum Arbeitsverzeichnis (das kann irgendwo liegen) —
  // fehlt der Baum, scheitert die Binary-Suche danach mit klarer Meldung.
  if (gepackt) return join(resourcesPath ?? '', 'native');
  // Ungepackte Dev-Läufe: fetch-win-native.ps1 legt das hier an.
  return join(process.cwd(), 'resources-native');
}

export function datenDirs(dataRoot: string): NativeDataDirs {
  const root = dataRoot;
  return {
    root,
    pg: join(root, 'pg'),
    redis: join(root, 'redis'),
    weedMaster: join(root, 'weed', 'master'),
    weedVolume: join(root, 'weed', 'volume'),
    weedFiler: join(root, 'weed', 'filer'),
    uploadsAvatars: join(root, 'uploads', 'avatars'),
    uploadsGuildIcons: join(root, 'uploads', 'guild-icons'),
    secrets: join(root, 'jwt_keys'),
    certs: join(root, 'certs'),
    backups: join(root, 'backups'),
    run: join(root, 'run'),
  };
}

/** Native Binary suchen: native-bin/ → (nur ungepackt) PATH. name OHNE .exe angeben. */
export function resolveNativeBin(
  name: string,
  env: Record<string, string | undefined> = process.env,
  gepackt: boolean = istGepackt(),
): string {
  const exe = name.endsWith('.exe') ? name : `${name}.exe`;
  const candidate = join(nativeRoot(env, gepackt), 'native-bin', exe);
  if (existsSync(candidate)) return candidate;
  if (gepackt) {
    throw new Error(`[native] Binary fehlt in der Installation: ${candidate}`);
  }
  try {
    const result = execFileSync('where', [exe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env });
    const resolved = result.trim().split('\n')[0].trim();
    if (resolved) return resolved;
  } catch {
    // nicht auf PATH
  }
  throw new Error(`[native] Binary nicht gefunden: ${exe} (unter ${join(nativeRoot(env, gepackt), 'native-bin')} oder PATH)`);
}

/** pg_ctl/initdb/psql/pg_isready aus dem gebündelten Postgres. */
export function pgBin(name: string, env: Record<string, string | undefined> = process.env): string {
  const exe = `${name}.exe`;
  const candidate = join(nativeRoot(env), 'native-bin', 'pg', 'bin', exe);
  if (existsSync(candidate)) return candidate;
  // System-Postgres als Fallback (wenn auf PATH) — gepackt wirft
  // resolveNativeBin stattdessen, siehe Dateikopf.
  return resolveNativeBin(name, env);
}

/** venv-Python (resources-native/python) — wirft, wenn der Python-Baum fehlt.
 *  uv-venvs unter Windows: python.exe liegt in Scripts/, nicht im Root. */
export function venvPython(env: Record<string, string | undefined> = process.env): string {
  const root = join(nativeRoot(env), 'python');
  for (const cand of [join(root, 'Scripts', 'python.exe'), join(root, 'python.exe')]) {
    if (existsSync(cand)) return cand;
  }
  throw new Error('[native] gebündeltes Python fehlt (resources-native/python) — fetch-win-native.ps1 ausführen.');
}

/** Service-Quellen-Baum (dcc_auth, dcc_chat_gateway, … als Verzeichnisse). */
export function servicesDir(env: Record<string, string | undefined> = process.env): string {
  return join(nativeRoot(env), 'services');
}

/** Einzelnes Service-Verzeichnis (Enthält src/dcc_*, alembic.ini). */
export function serviceDir(name: string, env: Record<string, string | undefined> = process.env): string {
  return join(servicesDir(env), name);
}

/** Template-Verzeichnis (Caddyfile.template). */
export function templatesDir(env: Record<string, string | undefined> = process.env): string {
  return join(nativeRoot(env), 'templates');
}

/** PYTHONPATH für die Services: alle src-Verzeichnisse + shared. */
export function servicePythonPath(env: Record<string, string | undefined> = process.env): string {
  const svc = servicesDir(env);
  return [
    join(svc, 'auth', 'src'),
    join(svc, 'chat-gateway', 'src'),
    join(svc, 'media-svc', 'src'),
    join(svc, 'voice-signaling', 'src'),
    join(svc, 'mediamtx-auth-hook', 'src'),
    join(svc, 'shared', 'src'),
  ].join(';');
}
