/**
 * SupervisedProcess — spawn + Health-Gate + Restart-Backoff + graceful stop.
 * Portiert aus der gelöschten nativen Orchestrierung (081520f4^, process.ts),
 * mit einer Windows-Erweiterung: optionale gracefulStop()-Routine (Postgres
 * will pg_ctl stop statt eines harten Kills) und taskkill /T als letzte
 * Stufe, falls ein Prozess nicht auf TerminateProcess reagiert.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { waitFor } from '../health.ts';
import { systemProgramm } from './laufreste.ts';
import type { ServiceSpec } from './types.ts';

type ExitCallback = (code: number | null) => void;
type SpawnCallback = (pid: number) => void;

/** So viele stderr-Zeilen hebt der Supervisor auf — für Startfehler-
 *  Meldungen (postgresStartFehler), nicht als Log. */
const STDERR_ZEILEN = 40;

async function raceWithTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    sleep(ms).then(() => false),
  ]);
}

function killTree(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    execFileSync(systemProgramm('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* best effort */ }
}

export class SupervisedProcess {
  private readonly spec: (ServiceSpec & { gracefulStop?: () => Promise<void> }) & { restartMax: number; gracePeriodMs: number };
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private stopping = false;
  /** Einmal gestoppt bleibt gestoppt: ein bereits angelaufener Restart-Timer
   *  darf nach stop() nicht mehr respawne — sonst entsteht ein Waisenprozess,
   *  der Ports hält, die der Manager nicht mehr kennt. reset nur in start(). */
  private disposed = false;
  private exitCallbacks: ExitCallback[] = [];
  private spawnCallbacks: SpawnCallback[] = [];
  private stderrZeilen: string[] = [];

  constructor(spec: ServiceSpec & { gracefulStop?: () => Promise<void>; gracePeriodMs?: number }) {
    this.spec = { restartMax: 3, gracePeriodMs: 3000, ...spec };
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Spawnt den Prozess und wartet auf healthCheck — wirft bei Early-Exit/Timeout. */
  async start(): Promise<void> {
    this.stopping = false;
    this.disposed = false;
    this.restartCount = 0;
    await this._spawn();

    let earlyExitReject: ((err: Error) => void) | null = null;
    const earlyExit = new Promise<never>((_resolve, reject) => {
      earlyExitReject = reject;
    });
    const earlyExitHandler = (code: number | null, signal: NodeJS.Signals | null): void => {
      earlyExitReject?.(
        new Error(`${this.spec.name} exited during startup (${signal ?? `code ${code}`})`),
      );
    };
    this.child?.once('exit', earlyExitHandler);
    try {
      await Promise.race([waitFor(this.spec.healthCheck, 45_000, 500), earlyExit]);
    } finally {
      this.child?.removeListener('exit', earlyExitHandler);
      earlyExitReject = null;
    }
  }

  /** Graceful stop: gracefulStop() → kill → grace period → taskkill /T. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    const pid = child.pid;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });

    try {
      child.stdin?.end();
    } catch { /* ignore */ }

    if (this.spec.gracefulStop) {
      await this.spec.gracefulStop().catch(() => {});
      if (await raceWithTimeout(exited, 2000)) {
        this.child = null;
        return;
      }
    }

    try { child.kill(); } catch { /* ignore */ }
    if (await raceWithTimeout(exited, this.spec.gracePeriodMs)) {
      this.child = null;
      return;
    }
    if (pid) killTree(pid);
    await raceWithTimeout(exited, 2000);
    this.child = null;
  }

  onExit(cb: ExitCallback): void {
    this.exitCallbacks.push(cb);
  }

  /** Feuert bei JEDEM Spawn mit PID — auch bei Supervisor-Neustarts, damit
   *  die PID-Datei nicht auf einen toten (und später recycelten) Wert zeigt. */
  onSpawn(cb: SpawnCallback): void {
    this.spawnCallbacks.push(cb);
  }

  /** Die letzten stderr-Zeilen (höchstens STDERR_ZEILEN). */
  stderrEnde(): string {
    return this.stderrZeilen.join('\n');
  }

  private async _spawn(): Promise<void> {
    const { name, command, args, env, cwd } = this.spec;
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
    });
    this.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        console.error(`[${name}] ${line}`);
        this.stderrZeilen.push(line);
        if (this.stderrZeilen.length > STDERR_ZEILEN) this.stderrZeilen.shift();
      }
    });
    child.on('error', (err) => {
      console.error(`[${name}] spawn error:`, err);
    });
    child.on('exit', (code, signal) => {
      this._onChildExit(code, signal ?? `code ${code}`);
    });
    if (child.pid) {
      for (const cb of this.spawnCallbacks) {
        try { cb(child.pid); } catch { /* ignore */ }
      }
    }
  }

  private _onChildExit(code: number | null, reason: string): void {
    const { name, restartMax } = this.spec;
    this.child = null;
    for (const cb of this.exitCallbacks) {
      try { cb(code); } catch { /* ignore */ }
    }
    if (this.stopping || this.disposed) return;
    if (this.restartCount < restartMax) {
      this.restartCount++;
      const waitMs = Math.min(500 * Math.pow(2, this.restartCount - 1), 8000);
      console.error(`[${name}] exited (${reason}), restart ${this.restartCount}/${restartMax} in ${waitMs}ms`);
      sleep(waitMs)
        .then(() => {
          if (this.stopping || this.disposed) return;
          return this._spawn().then(() => waitFor(this.spec.healthCheck, 45_000, 500));
        })
        .catch((err) => {
          console.error(`[${name}] restart failed:`, err);
        });
    } else {
      console.error(`[${name}] exited (${reason}), restartMax erreicht — kein weiterer Neustart`);
    }
  }
}
