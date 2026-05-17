/**
 * Pulse desktop — Python GSR-sidecar manager (Electron, E1b).
 *
 * Spawns `streaming/gsr-sidecar/control.py` as a child process the first time
 * any caller needs it (lazy — someone who never streams never starts Python)
 * and bridges the newline-JSON protocol:
 *
 *   request  `{"op": ..., "id": <n>, ...}`            (one JSON object per stdin line)
 *   response `{"id": <n>, "ok": <bool>, ...}`         (id mirrored from the request)
 *   event    `{"ev": ..., ...}`                       (async, no id/ok — forwarded via onEvent)
 *
 * This is the Electron-side equivalent of the old Tauri Rust bridge
 * (`desktop/src-tauri/src/streaming/`, removed in E1c): same request-id routing,
 * same event-forwarding idea — `main.ts` registers an `onEvent` callback that
 * relays events to the renderer over `webContents.send('gsr:event', ev)`.
 *
 * The Python sidecar itself is unchanged — it just speaks newline-JSON on stdio
 * regardless of who spawns it.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Config ──────────────────────────────────────────────────────────────────

const PYTHON_BIN = process.env.PULSE_PYTHON ?? 'python3';

/** Per-op request timeout (ms). `start` opens the Wayland portal dialog so it
 *  needs a long fuse; `stop` escalates through SIGINT→SIGTERM→SIGKILL inside
 *  the controller (≤5 s) plus slack. Everything else is a quick stdio round-trip. */
const DEFAULT_TIMEOUT_MS = 10_000;
const OP_TIMEOUT_MS: Record<string, number> = {
  start: 60_000,
  stop: 15_000,
};

/** How long to wait for the sidecar to exit naturally after we close its stdin
 *  (its loop ends on EOF and stops a running GSR) before sending SIGTERM. */
const SHUTDOWN_EOF_GRACE_MS = 1_500;
/** How long to wait after SIGTERM before escalating to SIGKILL. */
const SHUTDOWN_SIGTERM_GRACE_MS = 2_000;

// ── Sidecar script path resolver ────────────────────────────────────────────

/**
 * Locate `control.py`.
 *
 * Order:
 *   1. `$PULSE_SIDECAR_PY` override (absolute path to control.py).
 *   2. Walk up from this module's directory looking for
 *      `<X>/streaming/gsr-sidecar/control.py`. In dev the bundled `main.cjs`
 *      lives at `desktop/electron/dist/`, so `../../../streaming/...` from there
 *      hits the repo root; the walk-up also tolerates other layouts.
 *   3. TODO(T6 Flatpak): `/app/share/pulse/gsr-sidecar/control.py` — not needed
 *      for E1b (dev path + the env override cover development).
 */
function resolveScriptPath(): string {
  const override = process.env.PULSE_SIDECAR_PY;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`PULSE_SIDECAR_PY points at a non-existent file: ${override}`);
    }
    return override;
  }

  const rel = path.join('streaming', 'gsr-sidecar', 'control.py');
  let dir = __dirname;
  // Walk up to (but not past) the filesystem root.
  for (;;) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // TODO(T6): Flatpak default — /app/share/pulse/gsr-sidecar/control.py
  const flatpakDefault = '/app/share/pulse/gsr-sidecar/control.py';
  if (fs.existsSync(flatpakDefault)) return flatpakDefault;

  throw new Error(
    'Could not locate streaming/gsr-sidecar/control.py (walked up from ' +
      `${__dirname}). Set PULSE_SIDECAR_PY to override.`,
  );
}

/** Resolve to `true` if `p` settles within `ms`, else `false` (without
 *  rejecting — `p`'s own rejection, if any, is swallowed). */
async function raceWithTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = p.then(
    () => true,
    () => true,
  );
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return result;
}

// ── Types ───────────────────────────────────────────────────────────────────

/** A parsed sidecar response (`{"id":..,"ok":..,...}`) or event (`{"ev":..,...}`). */
type SidecarMessage = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: SidecarMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventCallback = (ev: SidecarMessage) => void;

// ── Manager ─────────────────────────────────────────────────────────────────

class SidecarManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private eventCb: EventCallback | null = null;

  /** Register the event callback (set once by main.ts → relays to the renderer).
   *  Does NOT spawn the sidecar; spawning stays lazy on first `call()`. */
  onEvent(cb: EventCallback): void {
    this.eventCb = cb;
  }

  /** Send `{op, id, ...params}` to the sidecar and resolve with the full response
   *  JSON. Spawns the sidecar on first use. Rejects on timeout, on a non-object
   *  response, on `ok === false`, or if the sidecar dies before replying. */
  async call(op: string, params?: unknown): Promise<SidecarMessage> {
    const child = this.ensureSpawned();
    const id = this.nextId++;
    const req: Record<string, unknown> = {
      op,
      id,
      ...(params && typeof params === 'object' ? (params as Record<string, unknown>) : {}),
    };

    const timeoutMs = OP_TIMEOUT_MS[op] ?? DEFAULT_TIMEOUT_MS;

    return new Promise<SidecarMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gsr sidecar: '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (msg) => {
          if (msg.ok === false) {
            reject(new Error(`gsr sidecar: '${op}' failed: ${String(msg.error ?? 'ok=false')}`));
            return;
          }
          resolve(msg);
        },
        reject,
        timer,
      });

      try {
        child.stdin.write(JSON.stringify(req) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Graceful shutdown. Best-effort, resolves even if the child was never
   *  spawned. Sequence: close stdin (the sidecar's loop ends on EOF and stops a
   *  running GSR) → wait briefly for a clean exit → SIGTERM → SIGKILL after a
   *  short grace. (Closing stdin first avoids the sidecar's signal handler
   *  hitting a reentrant `sys.stdin.close()` while it's blocked reading stdin.) */
  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;

    // Reject anything still in flight so callers don't hang.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('gsr sidecar shutting down'));
      this.pending.delete(id);
    }

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });

    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }

    // 1) Give EOF a chance to land and let the loop exit cleanly.
    if (await raceWithTimeout(exited, SHUTDOWN_EOF_GRACE_MS)) {
      this.cleanupChild();
      return;
    }
    // 2) Still alive → SIGTERM (the sidecar's handler stops a running GSR).
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    if (await raceWithTimeout(exited, SHUTDOWN_SIGTERM_GRACE_MS)) {
      this.cleanupChild();
      return;
    }
    // 3) Last resort.
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await raceWithTimeout(exited, 1_000);
    this.cleanupChild();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private ensureSpawned(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    if (PYTHON_BIN.includes(' ')) {
      throw new Error(
        `PULSE_PYTHON must not contain spaces (got: ${PYTHON_BIN}). spawn() does not shell-split.`,
      );
    }

    const scriptPath = resolveScriptPath();
    const child = spawn(PYTHON_BIN, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    // Line-buffered stdout → parse one JSON object per line.
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onStdoutLine(line));

    // Python tracebacks land on stderr; surface them with a clear prefix.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const l of chunk.split('\n')) {
        if (l.trim()) console.error(`[gsr-sidecar] ${l}`);
      }
    });

    child.on('error', (err) => {
      console.error('[gsr-sidecar] spawn error:', err);
      this.failAllPending(new Error(`gsr sidecar process error: ${err.message}`));
      this.cleanupChild();
    });

    child.on('exit', (code, signal) => {
      const reason =
        signal !== null ? `signal ${signal}` : code !== null ? `code ${code}` : 'unknown';
      console.error(`[gsr-sidecar] exited (${reason})`);
      this.failAllPending(new Error(`gsr sidecar exited (${reason})`));
      this.cleanupChild();
    });

    return child;
  }

  private onStdoutLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      console.error(`[gsr-sidecar] unparseable stdout line: ${text}`, err);
      return;
    }
    if (typeof msg !== 'object' || msg === null) {
      console.error('[gsr-sidecar] stdout line was not a JSON object:', text);
      return;
    }
    const obj = msg as SidecarMessage;

    // Event (`{"ev":..}`, no id) → forward to the registered callback.
    if (typeof obj.ev === 'string' && obj.id === undefined) {
      try {
        this.eventCb?.(obj);
      } catch (err) {
        console.error('[gsr-sidecar] event callback threw:', err);
      }
      return;
    }

    // Response (`{"id":..}`) → resolve the matching pending request.
    if (typeof obj.id === 'number') {
      const pending = this.pending.get(obj.id);
      if (!pending) {
        console.error(`[gsr-sidecar] response for unknown id ${obj.id}:`, text);
        return;
      }
      this.pending.delete(obj.id);
      clearTimeout(pending.timer);
      pending.resolve(obj);
      return;
    }

    // `{"id": null, ...}` — sidecar's generic error for malformed input it
    // couldn't attribute to a request. We never send a request without an id,
    // so just log it.
    console.error('[gsr-sidecar] unattributable message:', text);
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private cleanupChild(): void {
    try {
      this.rl?.close();
    } catch {
      /* ignore */
    }
    this.rl = null;
    this.child = null;
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let instance: SidecarManager | null = null;

/** The process-wide sidecar manager (created on first access; the Python child
 *  is still spawned lazily on the first `call()`). */
export function getSidecar(): SidecarManager {
  if (!instance) instance = new SidecarManager();
  return instance;
}

export type { SidecarManager, SidecarMessage };
