/**
 * Registry-Login + Pull mit einer WEGWERF-Anmeldedatei.
 *
 * Bis 2026-10-08 lief `podman login` gegen den Standard-Speicher der Runtime:
 * client_id:client_secret der Instanz lagen danach dauerhaft (Base64, nicht
 * verschlüsselt) in Podmans auth.json bzw. Dockers config.json, und der
 * Update-Check verließ sich darauf. Jetzt: Login und Pull teilen sich eine
 * Anmeldedatei in einem 0700-Verzeichnis unter userData, die nach dem Pull
 * gelöscht wird. Ein Alt-Eintrag im Standard-Speicher wird dabei einmal per
 * `logout` entfernt (best-effort).
 *
 * Warum unter userData und nicht os.tmpdir(): im Flatpak läuft Podman über
 * `flatpak-spawn --host` auf dem HOST, das /tmp der Sandbox sieht er nicht;
 * userData (~/.var/app/…) liegt für beide unter demselben Pfad. Aus demselben
 * Grund steht der Pfad im argv (`--authfile` / `docker --config`), nicht in
 * einer Umgebungsvariable — flatpak-spawn reicht die nicht weiter.
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { rtExec, type ContainerRuntime } from './containerRuntime.ts';

/** argv für login/pull/logout je Runtime: Podman nimmt `--authfile <datei>`
 *  am Unterbefehl, Docker `--config <verzeichnis>` als globale Option. */
export function authArgv(
  kind: ContainerRuntime['kind'],
  dir: string,
  befehl: string[],
): string[] {
  if (kind === 'docker') return ['--config', dir, ...befehl];
  return [befehl[0], '--authfile', join(dir, 'auth.json'), ...befehl.slice(1)];
}

export interface PullErgebnis {
  ok: boolean;
  /** Was schiefging — nur für Fehlermeldungen, ohne Geheimnisse. */
  schritt?: 'login' | 'pull';
  code?: number;
}

/** Login mit den Instanz-Creds + Pull, beides gegen eine Wegwerf-Datei. */
export async function pullMitWegwerfLogin(opts: {
  rt: ContainerRuntime;
  image: string;
  benutzer: string;
  passwort: string;
  basisVerzeichnis: string;
  onLogin?: () => void;
  onPull?: () => void;
}): Promise<PullErgebnis> {
  const { rt, image } = opts;
  const registry = image.split('/', 1)[0];
  mkdirSync(opts.basisVerzeichnis, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(opts.basisVerzeichnis, 'registry-auth-'));
  try {
    opts.onLogin?.();
    const login = await rtExec(
      rt,
      authArgv(rt.kind, dir, ['login', registry, '-u', opts.benutzer, '--password-stdin']),
      { stdin: opts.passwort, timeoutMs: 30_000 },
    );
    if (login.code !== 0) return { ok: false, schritt: 'login', code: login.code };
    opts.onPull?.();
    const pull = await rtExec(rt, authArgv(rt.kind, dir, ['pull', image]), { timeoutMs: 15 * 60_000 });
    if (pull.code !== 0) return { ok: false, schritt: 'pull', code: pull.code };
    // Alt-Eintrag aus dem Standard-Speicher (frühere Fassungen) entfernen.
    await rtExec(rt, ['logout', registry], { timeoutMs: 15_000 }).catch(() => null);
    return { ok: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
