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
 *
 * Docker-Kontext: `docker --config <leer>` verliert `currentContext` aus der
 * echten config.json — mit rootless Docker oder Docker Desktop for Linux
 * gingen Login und Pull dann an `/var/run/docker.sock`, also an einen
 * ANDEREN Daemon (oder ins Leere). `--context <name>` hilft nicht: der
 * Kontext-Speicher liegt im Config-Verzeichnis, das gerade leer ist. Deshalb
 * fragt `dockerZielArgs` den aktiven Kontext vor dem Wechsel ab (`docker
 * context inspect`, geht auch ohne laufenden Daemon) und reicht dessen
 * Endpunkt als `-H` samt TLS-Dateien durch. Die TLS-Dateien liegen im
 * echten Kontext-Speicher; der Pfad kommt von Docker selbst, gilt also auch
 * auf dem Host hinter flatpak-spawn.
 */

import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { rtExec, type ContainerRuntime } from './containerRuntime.ts';

const AUTH_PRAEFIX = 'registry-auth-';

/** Wegwerf-Verzeichnisse, die DIESER Prozess gerade benutzt — alles andere
 *  unter dem Präfix stammt aus einem abgebrochenen Lauf (App-Ende mitten im
 *  bis zu 15 min langen Pull) und darf weg. */
const aktiveAuthVerzeichnisse = new Set<string>();

/** Verwaiste Wegwerf-Anmeldedateien unter `basis` löschen (best-effort). */
export function raeumeVerwaisteAuth(basis: string): void {
  let namen: string[];
  try { namen = readdirSync(basis); } catch { return; }
  for (const n of namen) {
    const p = join(basis, n);
    if (n.startsWith(AUTH_PRAEFIX) && !aktiveAuthVerzeichnisse.has(p)) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

/** argv für login/pull/logout je Runtime: Podman nimmt `--authfile <datei>`
 *  am Unterbefehl, Docker `--config <verzeichnis>` als globale Option, dazu
 *  `ziel` = der Endpunkt des aktiven Docker-Kontexts (s. dockerZielArgs). */
export function authArgv(
  kind: ContainerRuntime['kind'],
  dir: string,
  befehl: string[],
  ziel: string[] = [],
): string[] {
  if (kind === 'docker') return ['--config', dir, ...ziel, ...befehl];
  return [befehl[0], '--authfile', join(dir, 'auth.json'), ...befehl.slice(1)];
}

/** Dockers TLS-Dateinamen im Kontext-Speicher → globale Option. */
const TLS_OPTION: Record<string, string> = { 'ca.pem': '--tlscacert', 'cert.pem': '--tlscert', 'key.pem': '--tlskey' };

interface KontextInspect {
  Endpoints?: { docker?: { Host?: string; SkipTLSVerify?: boolean } };
  TLSMaterial?: { docker?: string[] };
  Storage?: { TLSPath?: string };
}

/** Reine Übersetzung von `docker context inspect` (aktiver Kontext) in
 *  globale Docker-Optionen. Unlesbar/leer → [] (Docker nimmt dann seine
 *  Vorgabe, wie vor dem Fix). Die TLS-Dateinamen sind Dockers eigene
 *  (`ca.pem`/`cert.pem`/`key.pem` unter `<TLSPath>/docker/`). */
export function dockerZielAusInspect(stdout: string): string[] {
  let k: KontextInspect | undefined;
  try {
    const arr = JSON.parse(stdout) as KontextInspect[];
    k = Array.isArray(arr) ? arr[0] : undefined;
  } catch {
    return [];
  }
  const endpunkt = k?.Endpoints?.docker;
  const host = endpunkt?.Host;
  if (!host) return [];
  const args = ['-H', host];
  const material = k?.TLSMaterial?.docker ?? [];
  const tlsPfad = k?.Storage?.TLSPath;
  if (!material.length || !tlsPfad || tlsPfad.startsWith('<')) return args;
  args.push(endpunkt?.SkipTLSVerify ? '--tls' : '--tlsverify');
  for (const name of material) {
    const option = TLS_OPTION[name];
    if (option) args.push(option, join(tlsPfad, 'docker', name));
  }
  return args;
}

/** Endpunkt des aktiven Docker-Kontexts als argv (Podman: immer []). */
export async function dockerZielArgs(rt: ContainerRuntime): Promise<string[]> {
  if (rt.kind !== 'docker') return [];
  const r = await rtExec(rt, ['context', 'inspect'], { timeoutMs: 15_000 }).catch(() => null);
  return r?.code === 0 ? dockerZielAusInspect(r.stdout) : [];
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
  const dir = mkdtempSync(join(opts.basisVerzeichnis, AUTH_PRAEFIX));
  aktiveAuthVerzeichnisse.add(dir);
  try {
    const ziel = await dockerZielArgs(rt);
    opts.onLogin?.();
    const login = await rtExec(
      rt,
      authArgv(rt.kind, dir, ['login', registry, '-u', opts.benutzer, '--password-stdin'], ziel),
      { stdin: opts.passwort, timeoutMs: 30_000 },
    );
    if (login.code !== 0) return { ok: false, schritt: 'login', code: login.code };
    opts.onPull?.();
    const pull = await rtExec(rt, authArgv(rt.kind, dir, ['pull', image], ziel), { timeoutMs: 15 * 60_000 });
    if (pull.code !== 0) return { ok: false, schritt: 'pull', code: pull.code };
    // Alt-Eintrag aus dem Standard-Speicher (frühere Fassungen) entfernen.
    await rtExec(rt, ['logout', registry], { timeoutMs: 15_000 }).catch(() => null);
    return { ok: true };
  } finally {
    aktiveAuthVerzeichnisse.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}
