/**
 * Pulse desktop — tiny persistent key-value store (Electron, E1c).
 *
 * Replaces the old Tauri `plugin-store` (`pulse-stream.json` in the app config
 * dir, hardened to chmod 700 / 600 by `harden_config_dir()` in the Rust shell).
 * We deliberately roll our own instead of pulling in `electron-store`: newer
 * `electron-store` is ESM-only and would clash with our esbuild CJS bundle, and
 * we only need get/set/getAll over a single JSON blob.
 *
 * File: `<userData>/pulse-stream.json`. Loaded once into memory on first use
 * (`app.whenReady()` → `initStore()`); every `set` re-serialises the whole blob.
 *
 * **Security:** the file can hold custom-server stream keys in cleartext (same
 * caveat as the Tauri store — this is *not* a secret vault, just better than
 * world-readable). On Linux we `chmod 700` the userData dir and `chmod 600` the
 * JSON file (writes always use `{ mode: 0o600 }`). On Windows/macOS chmod is a
 * no-op; the per-user profile dir is the protection there. Never `console.log`
 * the contents.
 */

import { app } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

const STORE_FILE = 'pulse-stream.json';

/** In-memory mirror of the JSON blob. `null` until `initStore()` has run. */
let data: Record<string, unknown> | null = null;
let storePath: string | null = null;

function isLinux(): boolean {
  return process.platform === 'linux';
}

/** Best-effort `chmod` — never throws (fs perms on a fresh dir/file can race;
 *  a failed chmod is not worth crashing the app over). */
function chmodQuiet(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    console.error(`[store] chmod ${mode.toString(8)} ${target} failed:`, err);
  }
}

/** Serialise the in-memory blob back to disk (mode 0o600 on the file).
 *  Atomic: write to a `.tmp` sibling, then `rename` over the real file.
 *  `rename(2)` on the same filesystem is atomic per POSIX, so a crash
 *  mid-write leaves the previous good JSON intact instead of producing
 *  a truncated file that `JSON.parse` would silently reset to `{}` on
 *  next launch (and take all persisted settings + custom_servers with it). */
function persist(): void {
  if (data === null || storePath === null) return;
  const tmpPath = storePath + '.tmp';
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, json, { mode: 0o600 });
    fs.renameSync(tmpPath, storePath);
    if (isLinux()) chmodQuiet(storePath, 0o600);
  } catch (err) {
    console.error('[store] failed to persist:', err);
    // Best-effort: clean up the temp file if it lingered.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Load the store from disk into memory. Call once after `app.whenReady()`.
 * Hardens the userData dir (chmod 700) + the store file (chmod 600) on Linux.
 * Tolerates a missing/corrupt file → starts from `{}`.
 */
export function initStore(): void {
  if (data !== null) return;
  const userData = app.getPath('userData');
  storePath = path.join(userData, STORE_FILE);

  if (isLinux()) {
    // userData is created by Electron before whenReady; tighten it.
    chmodQuiet(userData, 0o700);
  }

  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Missing file or unparseable JSON → fresh store.
    data = {};
  }

  if (isLinux()) {
    // Only chmod if it already exists; don't create an empty file just to chmod.
    if (fs.existsSync(storePath)) chmodQuiet(storePath, 0o600);
  }
}

/** Read one key. `undefined` if not set or the store isn't ready yet. */
export function storeGet(key: string): unknown {
  return data?.[key];
}

/** Read the whole blob (a shallow copy so callers can't mutate the mirror). */
export function storeGetAll(): Record<string, unknown> {
  return data ? { ...data } : {};
}

/** Write one key and persist. No-op if the store isn't ready (shouldn't happen
 *  — `initStore()` runs in `whenReady`, before any IPC can fire). */
export function storeSet(key: string, value: unknown): void {
  if (data === null) {
    console.error('[store] storeSet called before initStore()');
    return;
  }
  data[key] = value;
  persist();
}
