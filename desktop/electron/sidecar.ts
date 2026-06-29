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
import { app } from 'electron';

// ── Config ──────────────────────────────────────────────────────────────────

/** Python interpreter to run the Linux GSR sidecar. Developer-only override via
 *  $PULSE_PYTHON; ignored in packaged builds to prevent malicious .desktop files
 *  or wrapper scripts from redirecting to an attacker-controlled executable. */
const PYTHON_BIN = !app.isPackaged ? (process.env.PULSE_PYTHON ?? 'python3') : 'python3';

/** Per-op request timeout (ms). `start` opens the Wayland portal dialog (Linux)
 *  or initialises WGC + NVENC/AMF/QSV (Windows) so it needs a long fuse; `stop`
 *  escalates through SIGINT→SIGTERM→SIGKILL inside the controller (≤5 s) plus
 *  slack. Everything else is a quick stdio round-trip. */
const DEFAULT_TIMEOUT_MS = 10_000;
const OP_TIMEOUT_MS: Record<string, number> = {
  start: 60_000,
  stop: 15_000,
};

/** How long to wait for the sidecar to exit naturally after we close its stdin
 *  (its loop ends on EOF and stops a running stream) before sending SIGTERM. */
const SHUTDOWN_EOF_GRACE_MS = 1_500;
/** How long to wait after SIGTERM before escalating to SIGKILL. */
const SHUTDOWN_SIGTERM_GRACE_MS = 2_000;

// ── Sidecar resolver ────────────────────────────────────────────────────────
//
// Three implementations of the same newline-JSON-over-stdio protocol live in
// the repo:
//
//   - Linux:   `streaming/gsr-sidecar/control.py` (Python, drives GSR + Wayland
//              portal + PipeWire — see `streaming/README.md`).
//   - Windows: `streaming/win-hq-sidecar/` (Rust, drives WGC + WASAPI +
//              NVENC/AMF/QSV via FFmpeg — see `WINDOWS_HQ_SIDECAR.md`).
//   - macOS:   `streaming/mac-hq-sidecar/` (Rust, drives ScreenCaptureKit +
//              VideoToolbox via FFmpeg — see that crate's README and
//              `docs/plans/2026-06-15-macos-client.md`).
//
// On macOS the binary may not be built/bundled yet — `resolveMacBinaryPath()`
// then throws "could not locate", the `health` op fails, `stream.gsrAvailable`
// stays false and the renderer keeps the streaming UI hidden. So enabling the
// macOS UI gate is safe even before the sidecar ships: the button only appears
// once a real binary answers `health` with `gsr.available = true`.

interface SpawnTarget {
  /** Executable to spawn (absolute path or PATH-resolvable name). */
  command: string;
  /** Argv tail (script path on Linux, empty on Windows). */
  args: string[];
}

/** Cached result of the first successful `resolveSidecarSpawn()` call.
 *  The resolved path never changes during a session; memoising it avoids
 *  repeated filesystem walks on Windows respawns (finding 159). */
let _cachedSpawnTarget: SpawnTarget | null = null;

function resolveSidecarSpawn(): SpawnTarget {
  if (_cachedSpawnTarget) return _cachedSpawnTarget;
  let target: SpawnTarget;
  if (process.platform === 'linux') {
    target = { command: PYTHON_BIN, args: [resolveScriptPath()] };
  } else if (process.platform === 'win32') {
    target = { command: resolveBinaryPath(), args: [] };
  } else if (process.platform === 'darwin') {
    target = { command: resolveMacBinaryPath(), args: [] };
  } else {
    throw new Error(
      `Pulse HQ sidecar: no implementation for ${process.platform} ` +
        '(Linux: streaming/gsr-sidecar/, Windows: streaming/win-hq-sidecar/, ' +
        'macOS: streaming/mac-hq-sidecar/).',
    );
  }
  _cachedSpawnTarget = target;
  return target;
}

/**
 * Locate `control.py` (Linux only).
 *
 * Order:
 *   1. `$PULSE_SIDECAR_PY` override (absolute path to control.py, dev-only).
 *   2. Walk up from this module's directory looking for
 *      `<X>/streaming/gsr-sidecar/control.py`. In dev the bundled `main.cjs`
 *      lives at `desktop/electron/dist/`, so `../../../streaming/...` from there
 *      hits the repo root; the walk-up also tolerates other layouts.
 *   3. Flatpak default `/app/share/pulse/gsr-sidecar/control.py`.
 */
function resolveScriptPath(): string {
  // Developer-only override; ignored in packaged builds to prevent malicious
  // .desktop files or wrapper scripts from redirecting to an attacker binary.
  const override = !app.isPackaged ? process.env.PULSE_SIDECAR_PY : undefined;
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

  const flatpakDefault = '/app/share/pulse/gsr-sidecar/control.py';
  if (fs.existsSync(flatpakDefault)) return flatpakDefault;

  throw new Error(
    'Could not locate streaming/gsr-sidecar/control.py (walked up from ' +
      `${__dirname}). Set PULSE_SIDECAR_PY to override.`,
  );
}

/**
 * Locate `pulse-win-hq-sidecar.exe` (Windows only).
 *
 * Order:
 *   1. `$PULSE_HQ_SIDECAR` override (absolute path to the .exe, dev-only).
 *   2. Packaged app: `<process.resourcesPath>/hq-sidecar/pulse-win-hq-sidecar.exe`
 *      — electron-builder ships the sidecar + FFmpeg-DLLs as `extraResources`
 *      there (see `desktop/electron-builder.yml`). In a dev run this path
 *      doesn't exist and we fall through.
 *   3. Walk up from this module looking for `<X>/streaming/win-hq-sidecar/target/release/`
 *      then `<X>/streaming/win-hq-sidecar/target/debug/` (dev: `cargo build`
 *      hits debug, `cargo build --release` hits release; release wins if both
 *      exist).
 *   4. `%LOCALAPPDATA%\Pulse\hq-sidecar\pulse-win-hq-sidecar.exe` (the
 *      production install location that the PowerShell bootstrap script writes
 *      to — see WINDOWS_HQ_SIDECAR.md "Distribution-Pfad").
 */
function resolveBinaryPath(): string {
  // Developer-only override; ignored in packaged builds to prevent malicious
  // .desktop files or wrapper scripts from redirecting to an attacker binary.
  const override = !app.isPackaged ? process.env.PULSE_HQ_SIDECAR : undefined;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`PULSE_HQ_SIDECAR points at a non-existent file: ${override}`);
    }
    return override;
  }

  const exe = 'pulse-win-hq-sidecar.exe';

  // Packaged app — the sidecar bundle sits next to the asar under
  // resources/hq-sidecar/. `process.resourcesPath` is set in every Electron
  // process; in a dev run the path just won't exist → fall through.
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'hq-sidecar', exe);
    if (fs.existsSync(packaged)) return packaged;
  }

  const candidates = [
    path.join('streaming', 'win-hq-sidecar', 'target', 'release', exe),
    path.join('streaming', 'win-hq-sidecar', 'target', 'debug', exe),
  ];
  let dir = __dirname;
  for (;;) {
    for (const rel of candidates) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const installed = path.join(localAppData, 'Pulse', 'hq-sidecar', exe);
    if (fs.existsSync(installed)) return installed;
  }

  throw new Error(
    `Could not locate ${exe} (walked up from ${__dirname}, also checked %LOCALAPPDATA%\\Pulse\\hq-sidecar\\). ` +
      'Build it with `cargo build --release` in streaming/win-hq-sidecar/ or set PULSE_HQ_SIDECAR.',
  );
}

/**
 * Locate `pulse-mac-hq-sidecar` (macOS only).
 *
 * Order (mirrors the Windows resolver — see `resolveBinaryPath()`):
 *   1. `$PULSE_HQ_SIDECAR` override (absolute path to the binary, dev-only).
 *   2. Packaged app: `<process.resourcesPath>/hq-sidecar/pulse-mac-hq-sidecar`
 *      — electron-builder ships the sidecar + FFmpeg-dylibs as `extraResources`
 *      there (see `desktop/electron-builder.yml`). In a dev run this path
 *      doesn't exist and we fall through.
 *   3. Walk up from this module looking for
 *      `<X>/streaming/mac-hq-sidecar/target/release/` then `…/target/debug/`
 *      (release wins if both exist).
 *   4. `~/Library/Application Support/Pulse/hq-sidecar/pulse-mac-hq-sidecar`
 *      (a parallel to the Windows %LOCALAPPDATA% install location, for any
 *      out-of-band bootstrap install).
 *
 * The crate doesn't exist yet — until it's built/bundled this throws, which is
 * the intended behaviour (see the resolver block comment above).
 */
function resolveMacBinaryPath(): string {
  const override = !app.isPackaged ? process.env.PULSE_HQ_SIDECAR : undefined;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`PULSE_HQ_SIDECAR points at a non-existent file: ${override}`);
    }
    return override;
  }

  const bin = 'pulse-mac-hq-sidecar';

  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'hq-sidecar', bin);
    if (fs.existsSync(packaged)) return packaged;
  }

  const candidates = [
    path.join('streaming', 'mac-hq-sidecar', 'target', 'release', bin),
    path.join('streaming', 'mac-hq-sidecar', 'target', 'debug', bin),
  ];
  let dir = __dirname;
  for (;;) {
    for (const rel of candidates) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // ~/Library/Application Support/Pulse/hq-sidecar/ — Electron's `appData` path
  // on macOS. Only relevant for an external bootstrap install; packaged builds
  // resolve via resourcesPath above.
  try {
    const installed = path.join(app.getPath('appData'), 'Pulse', 'hq-sidecar', bin);
    if (fs.existsSync(installed)) return installed;
  } catch {
    /* app.getPath can throw very early in startup; ignore and fall through */
  }

  throw new Error(
    `Could not locate ${bin} (walked up from ${__dirname}, also checked ` +
      '~/Library/Application Support/Pulse/hq-sidecar/). Build it with ' +
      '`cargo build --release` in streaming/mac-hq-sidecar/ or set PULSE_HQ_SIDECAR.',
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
  private _shuttingDown: Promise<void> | null = null;

  /** Register the event callback (set once by main.ts → relays to the renderer).
   *  Does NOT spawn the sidecar; spawning stays lazy on first `call()`. */
  onEvent(cb: EventCallback): void {
    this.eventCb = cb;
  }

  /** Send `{op, id, ...params}` to the sidecar and resolve with the full response
   *  JSON. Spawns the sidecar on first use. Rejects on timeout, on a non-object
   *  response, on `ok === false`, or if the sidecar dies before replying.
   *
   *  Linux + Windows both have a real sidecar implementation (see resolver above).
   *  Other platforms throw a clear error before any spawn attempt.
   *
   *  Respawn-on-`stop`: after every `stop` op the sidecar process is shut down,
   *  so the next `call()` spawns a fresh one. The Windows HQ pipeline
   *  (WGC + D3D11 + NVENC) has an in-process restart bug — a second capture
   *  session in the same process produces a black image (audio, a separate
   *  WASAPI subsystem, is unaffected). A fresh process per stream sidesteps the
   *  whole class of restart bugs; the sidecar is stateless between streams and
   *  the idle EOF-exit is near-instant. */
  async call(op: string, params?: unknown): Promise<SidecarMessage> {
    // A shutdown is in flight (the child is dying but `this.child` is still set
    // for up to ~4.5s). Writing to that doomed stdin would only sit in the
    // DEFAULT_TIMEOUT fuse, so fail fast. Once the shutdown finishes,
    // `_shuttingDown` is cleared and the next `call()` respawns cleanly — so the
    // normal stop→respawn path is unaffected.
    if (this._shuttingDown) {
      throw new Error('gsr sidecar is shutting down');
    }
    const child = this.ensureSpawned();
    const id = this.nextId++;
    // Spread caller-supplied params FIRST, then set the validated `op` and the
    // request `id` LAST — object-literal evaluation is left-to-right with later
    // keys winning, so this prevents a renderer-supplied `params.op`/`params.id`
    // from overwriting the op the main-process already validated against the
    // allowlist (or hijacking response routing). Without this ordering,
    // `gsr:call('health', { op: 'state' })` would pass the 'health' allowlist
    // check yet make the sidecar execute the un-allowlisted 'state' op.
    const req: Record<string, unknown> = {
      ...(params && typeof params === 'object' ? (params as Record<string, unknown>) : {}),
      op,
      id,
    };

    const timeoutMs = OP_TIMEOUT_MS[op] ?? DEFAULT_TIMEOUT_MS;

    try {
      return await new Promise<SidecarMessage>((resolve, reject) => {
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
    } finally {
      // Fresh process per stream — see the doc comment above. Runs on success
      // *and* on a failed/timed-out stop (a wedged sidecar gets killed too).
      // `await` keeps it deterministic: by the time `call()` resolves, the old
      // child is gone and `this.child` is null, so the next `call()` spawns
      // fresh with no race against a still-dying process.
      //
      // Windows-only: the restart bug is in the WGC/D3D11/NVENC pipeline. The
      // Linux GSR sidecar has no such issue, so its process stays warm. macOS
      // (ScreenCaptureKit + VideoToolbox) is not yet evaluated — add 'darwin'
      // here if a second in-process capture session misbehaves once the
      // mac-hq-sidecar lands.
      if (op === 'stop' && process.platform === 'win32') {
        await this.shutdown();
      }
    }
  }

  /** Graceful shutdown. Best-effort, resolves even if the child was never
   *  spawned. Sequence: close stdin (the sidecar's loop ends on EOF and stops a
   *  running GSR) → wait briefly for a clean exit → SIGTERM → SIGKILL after a
   *  short grace. (Closing stdin first avoids the sidecar's signal handler
   *  hitting a reentrant `sys.stdin.close()` while it's blocked reading stdin.) */
  async shutdown(): Promise<void> {
    if (this._shuttingDown) return this._shuttingDown;

    const child = this.child;
    if (!child) return;

    this._shuttingDown = this._doShutdown(child).finally(() => {
      this._shuttingDown = null;
    });
    return this._shuttingDown;
  }

  private async _doShutdown(child: ChildProcessWithoutNullStreams): Promise<void> {
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

    const target = resolveSidecarSpawn();
    // No space-guard on `target.command`: spawn() runs with `shell: false`, so
    // libuv hands `command` to CreateProcess as the application path and quotes
    // it itself — spaces are fine (Windows `C:\Program Files\Pulse\…` and
    // `%LOCALAPPDATA%` under a username with a space). Only `shell: true` would
    // need manual quoting. A genuinely unlaunchable command surfaces as ENOENT
    // via `child.on('error')` below, not a pre-emptive throw.
    const child = spawn(target.command, target.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      // PULSE_SELF_PID = this Electron main-process PID. The Windows HQ sidecar
      // reads it to drop Pulse's OWN audio from "Desktop" capture (WASAPI
      // process-loopback in EXCLUDE mode over our process tree), so our playback
      // of other voice participants isn't recaptured into the stream → echo.
      // The sidecar is a direct child of this process, so process.pid is the
      // tree root of all Chromium children incl. the audio-service. Mirror of
      // the Linux `app-inverse:Pulse` path (PULSE_PROP in main.ts). The Linux
      // Python sidecar ignores the var.
      env: { ...process.env, PULSE_SELF_PID: String(process.pid) },
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
      // A delayed handler from an already-replaced child (e.g. a Windows child
      // exiting late after a SIGKILL timeout while `this.child` already points at
      // a respawned one) must not touch global state — that would clobber the new
      // child's readline and fail its pending requests.
      if (this.child !== child) return;
      console.error('[gsr-sidecar] spawn error:', err);
      this.failAllPending(new Error(`gsr sidecar process error: ${err.message}`));
      this.cleanupChild();
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // stale child — ignore (see 'error' above)
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

// ── Per-slot singletons ──────────────────────────────────────────────────────

/** How many concurrent HQ streams one user may run (e.g. one per monitor) as
 *  separate viewer tiles. Slots are 0..MAX_STREAM_SLOTS-1; kept in sync with
 *  the web `MAX_STREAM_SLOTS` and the backend's `_SLOT_MAX` (= MAX_STREAM_SLOTS - 1). */
export const MAX_STREAM_SLOTS = 4;

const instances = new Map<number, SidecarManager>();

/** The sidecar manager for one stream slot (0 = the primary stream, 1 = a
 *  second concurrent stream). Each slot owns its OWN child process — running a
 *  separate, unchanged single-stream manager per slot keeps the proven
 *  pending/shutdown/respawn lifecycle intact rather than reworking it into a
 *  multi-child manager. Created on first access; the Python/Rust child is still
 *  spawned lazily on the first `call()`. */
export function getSidecar(slot = 0): SidecarManager {
  let m = instances.get(slot);
  if (!m) {
    m = new SidecarManager();
    instances.set(slot, m);
  }
  return m;
}

/** Every sidecar manager that has been created (for fan-out shutdown on quit). */
export function allSidecars(): SidecarManager[] {
  return [...instances.values()];
}

export type { SidecarManager, SidecarMessage };
