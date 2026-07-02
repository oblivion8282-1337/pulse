/**
 * Container-Runtime-Erkennung + Exec-Schicht für das App-Hosting.
 *
 * Findet die leichteste verfügbare Runtime pro Plattform:
 *  - Linux im Flatpak: Host-Podman via `flatpak-spawn --host` (Boxbuddy-Muster;
 *    braucht `--talk-name=org.freedesktop.Flatpak` im Manifest).
 *  - Überall sonst: gebündeltes Podman (resourcesPath, Phase 2/3 Win/Mac) →
 *    Podman im PATH → Docker im PATH.
 *
 * Alle Aufrufe laufen über spawn ohne Shell; stdin (Registry-Passwörter) und
 * gerenderte Env-Dateien werden NIE geloggt.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ContainerRuntime {
  kind: 'podman' | 'docker';
  /** argv-Präfix, z.B. ['flatpak-spawn', '--host', 'podman'] oder ['podman']. */
  argv: string[];
  viaFlatpak: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function inFlatpak(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.FLATPAK_ID) || existsSync('/.flatpak-info');
}

/** Gebündeltes Podman (Phase 2/3: Win/Mac-Installer legen es unter resources/). */
function bundledPodman(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;
  const exe = process.platform === 'win32' ? 'podman.exe' : 'podman';
  const p = join(resourcesPath, 'podman', exe);
  return existsSync(p) ? p : null;
}

export async function rtExec(
  argv: string[],
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], [...argv.slice(1), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      : null;
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.stdin != null) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

async function probe(argv: string[]): Promise<boolean> {
  try {
    // `--version` (Client-only): auf Win/Mac schlägt `version` ohne laufende
    // podman machine fehl — Verfügbarkeit heißt hier "Binary da", das Hochfahren
    // der Machine übernimmt ensureMachine() beim Start.
    const r = await rtExec(argv, ['--version'], { timeoutMs: 15_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Kandidaten in Präferenz-Reihenfolge für die aktuelle Umgebung. */
export function runtimeCandidates(
  env: Record<string, string | undefined> = process.env,
): ContainerRuntime[] {
  const out: ContainerRuntime[] = [];
  if (process.platform === 'linux' && inFlatpak(env)) {
    // Im Flatpak ist nur der Host-Weg tragfähig (nested Podman ist fragil).
    out.push({ kind: 'podman', argv: ['flatpak-spawn', '--host', 'podman'], viaFlatpak: true });
    out.push({ kind: 'docker', argv: ['flatpak-spawn', '--host', 'docker'], viaFlatpak: true });
    return out;
  }
  const bundled = bundledPodman();
  if (bundled) out.push({ kind: 'podman', argv: [bundled], viaFlatpak: false });
  out.push({ kind: 'podman', argv: ['podman'], viaFlatpak: false });
  out.push({ kind: 'docker', argv: ['docker'], viaFlatpak: false });
  return out;
}

/** Erste funktionierende Runtime oder null (UI zeigt dann den Setup-Hinweis). */
export async function detectRuntime(): Promise<ContainerRuntime | null> {
  for (const cand of runtimeCandidates()) {
    if (await probe(cand.argv)) return cand;
  }
  return null;
}

export type MachineAction = 'none' | 'init' | 'start';

/** Reine Entscheidung aus `podman machine inspect`: fehlt die Machine → init,
 *  steht sie → start, läuft sie → none. Exit != 0 heißt "keine Machine". */
export function machineAction(inspectExitCode: number, inspectStdout: string): MachineAction {
  if (inspectExitCode !== 0) return 'init';
  try {
    const arr = JSON.parse(inspectStdout) as Array<{ State?: string }>;
    return arr?.[0]?.State?.toLowerCase() === 'running' ? 'none' : 'start';
  } catch {
    return 'init';
  }
}

/** Win/Mac + Podman: die Linux-VM (`podman machine`) sicherstellen. Linux und
 *  Docker (Desktop verwaltet seine VM selbst) sind No-ops. `init --now` lädt
 *  beim allerersten Mal das Machine-Image (mehrere hundert MB) und startet
 *  direkt; auf Windows setzt es aktiviertes WSL2 voraus — fehlt das, schlägt
 *  init mit Podmans eigener Anleitung fehl (Erststart-Assistent = Phase 2). */
export async function ensureMachine(
  rt: ContainerRuntime,
  onProgress?: (step: string) => void,
): Promise<void> {
  if (rt.kind !== 'podman') return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;

  const insp = await rtExec(rt.argv, ['machine', 'inspect'], { timeoutMs: 30_000 });
  const action = machineAction(insp.code, insp.stdout);
  if (action === 'none') return;

  onProgress?.(action === 'init' ? 'machine-init' : 'machine-start');
  const args = action === 'init' ? ['machine', 'init', '--now'] : ['machine', 'start'];
  const r = await rtExec(rt.argv, args, { timeoutMs: 20 * 60_000 });
  if (r.code !== 0) {
    throw new Error(`podman machine ${action} failed (exit ${r.code}): ${r.stderr.slice(0, 400)}`);
  }
}
