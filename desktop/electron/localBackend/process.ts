/**
 * SupervisedProcess — spawn + Health-Gate + Restart-Backoff + graceful stop.
 *
 * Portiert das s6-overlay-Supervisor-Modell in einen einzigen TypeScript-
 * Wrapper für den lokalen Self-Host-Orchestrator.
 *
 * Shutdown-Sequenz (analog sidecar.ts):
 *   close stdin → SIGTERM → grace period → SIGKILL
 *
 * Restart-Backoff (nach unerwartetem Exit):
 *   Versuch 1 sofort, danach exponentiell (500 ms, 1 s, 2 s, …) bis restartMax.
 *   Nach restartMax Neustarts wird kein weiterer Versuch gestartet; der Fehler
 *   wird über onExit surfaced (code = null, letzter Exit-Code wird übergeben).
 *
 * Keine externen Dependencies — nur Node-Builtins.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SpawnSpec } from './types.ts';
import { waitFor } from './health.ts';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface SupervisedProcessSpec extends SpawnSpec {
  /** Anzeigename für Logs. */
  name: string;
  /** Gibt true zurück, wenn der Prozess healthy ist. */
  healthCheck: () => Promise<boolean>;
  /** Maximale Anzahl automatischer Neustarts nach unerwartetem Exit. Default: 3 */
  restartMax?: number;
  /** Wartezeit zwischen SIGTERM und SIGKILL in ms. Default: 3000 */
  gracePeriodMs?: number;
}

type ExitCallback = (code: number | null) => void;

// ---------------------------------------------------------------------------
// Hilfsfunktion: Wartet auf p oder gibt false zurück wenn ms abläuft.
// ---------------------------------------------------------------------------
async function raceWithTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    sleep(ms).then(() => false),
  ]);
}

// ---------------------------------------------------------------------------
// SupervisedProcess
// ---------------------------------------------------------------------------

export class SupervisedProcess {
  private readonly spec: Required<SupervisedProcessSpec>;
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private stopping = false;
  private exitCallbacks: ExitCallback[] = [];

  constructor(spec: SupervisedProcessSpec) {
    this.spec = {
      restartMax: 3,
      gracePeriodMs: 3000,
      ...spec,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Spawnt den Prozess und wartet, bis healthCheck() true zurückgibt.
   * Wirft sofort, wenn der Prozess während des Startups exitiert (kein 30-s-Hang).
   * Wirft bei Timeout (30 s).
   */
  async start(): Promise<void> {
    this.stopping = false;
    this.restartCount = 0;
    await this._spawn();

    // Early-exit promise: rejects immediately if the child exits during startup.
    // Uses a one-shot listener that is NOT part of the normal restart path.
    let earlyExitReject: ((err: Error) => void) | null = null;
    const earlyExit = new Promise<never>((_resolve, reject) => {
      earlyExitReject = reject;
    });

    const earlyExitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      const reason = signal ?? `code ${code}`;
      earlyExitReject?.(
        new Error(`${this.spec.name} exited during startup before becoming healthy (${reason})`),
      );
    };

    this.child?.once('exit', earlyExitHandler);

    try {
      await Promise.race([
        waitFor(this.spec.healthCheck, 30_000, 250),
        earlyExit,
      ]);
    } finally {
      // Always clean up the listener — prevents leak and double-reject.
      this.child?.removeListener('exit', earlyExitHandler);
      earlyExitReject = null;
    }
  }

  /**
   * Graceful shutdown: stdin schließen → SIGTERM → grace period → SIGKILL.
   * Idempotent: tut nichts, wenn kein Prozess läuft.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });

    // 1) stdin schließen — sauberer EOF-Weg
    try { child.stdin?.end(); } catch { /* ignore */ }

    if (await raceWithTimeout(exited, 1000)) {
      this.child = null;
      return;
    }

    // 2) SIGTERM
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    if (await raceWithTimeout(exited, this.spec.gracePeriodMs)) {
      this.child = null;
      return;
    }

    // 3) SIGKILL
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await raceWithTimeout(exited, 1000);
    this.child = null;
  }

  /**
   * Registriert einen Callback, der bei jedem (erwarteten oder unerwarteten) Exit
   * aufgerufen wird — auch nach Neustarts.
   */
  onExit(cb: ExitCallback): void {
    this.exitCallbacks.push(cb);
  }

  /**
   * Test-Hilfsmethode: sendet SIGKILL an den aktuellen Kind-Prozess, ohne
   * `stopping` zu setzen → löst den Restart-Pfad aus.
   * Nicht für Produktion bestimmt.
   */
  killForTest(): void {
    try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async _spawn(): Promise<void> {
    const { name, command, args, env } = this.spec;

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      detached: false,
    });
    this.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) console.error(`[${name}] ${line}`);
      }
    });

    child.on('error', (err) => {
      console.error(`[${name}] spawn error:`, err);
    });

    child.on('exit', (code, signal) => {
      const reason = signal ?? `code ${code}`;
      this._onChildExit(code, reason);
    });
  }

  private _onChildExit(code: number | null, reason: string): void {
    const { name, restartMax } = this.spec;
    this.child = null;

    for (const cb of this.exitCallbacks) {
      try { cb(code); } catch { /* ignore */ }
    }

    if (this.stopping) return; // erwarteter Exit durch stop()

    if (this.restartCount < restartMax) {
      this.restartCount++;
      const waitMs = Math.min(500 * Math.pow(2, this.restartCount - 1), 8000);
      console.error(`[${name}] exited (${reason}), restart ${this.restartCount}/${restartMax} in ${waitMs}ms`);
      sleep(waitMs)
        .then(() => {
          if (this.stopping) return;
          return this._spawn().then(() => waitFor(this.spec.healthCheck, 30_000, 250));
        })
        .catch((err) => {
          console.error(`[${name}] restart failed:`, err);
        });
    } else {
      console.error(`[${name}] exited (${reason}), restartMax (${restartMax}) erreicht — kein weiterer Neustart`);
    }
  }
}
