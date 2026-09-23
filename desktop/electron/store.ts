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
 * **Security:** secret-bearing keys (`GEHEIME_SCHLUESSEL` — `pulse.host.creds`,
 * legacy `custom_servers`) are encrypted via Electron `safeStorage` since the
 * 2026-09-23 bughunt (see below); without an OS keyring they fall back to
 * cleartext. On Linux we `chmod 700` the userData dir and `chmod 600` the
 * JSON file (writes always use `{ mode: 0o600 }`). On Windows/macOS chmod is a
 * no-op; the per-user profile dir is the protection there — which is exactly
 * why the secret keys moved into `safeStorage` (DPAPI/Keychain). Never
 * `console.log` the contents.
 */

import { app, safeStorage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  entwickleGeheimnis,
  istGeheimWickel,
  wickelGeheimnis
} from './geheimform';

const STORE_FILE = 'pulse-stream.json';

/** In-memory mirror of the JSON blob. `null` until `initStore()` has run. */
let data: Record<string, unknown> | null = null;
let storePath: string | null = null;

/**
 * Store-Schlüssel, die verschlüsselt abgelegt werden (Bughunt 2026-09-23).
 *
 * * `pulse.host.creds` — das Pairing des Server-Modus: `client_secret` +
 *   `relay_tunnel_token`, bislang Klartext-JSON. Wer die Datei liest (Malware
 *   im Nutzerkontext, gesichertes Backup, Sync-Client auf dem Profilordner),
 *   erhielt die vollständige Instanz-Identität samt Relay-Tunnel.
 * * `custom_servers` — LEGACY: kann auf Alt-Installationen noch Stream-Keys
 *   tragen; neue Fassungen leeren den Schlüssel (`stream/persistence.ts`).
 *
 * Verschlüsselt wird über Electron `safeStorage` (DPAPI/Keychain/libsecret).
 * **Fallback ohne OS-Tresor** (Linux headless): Klartext wie bisher — der
 * chmod-600-Schutz und das Benutzerprofil bleiben dann die Schranke, die
 * Start-Migration holt beim nächsten Start mit Tresor nach. Beide Formen
 * koexistieren; gelesen wird transparent (`istGeheimWickel` unterscheidet).
 */
const GEHEIME_SCHLUESSEL = new Set(['pulse.host.creds', 'custom_servers']);

function tresorBereit(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Wickelt den Wert eines Geheimnis-Schlüssels, wenn ein Tresor bereit ist —
 *  sonst unverändert (Klartext-Fallback, s. `GEHEIME_SCHLUESSEL`). */
function verschluessleWert(key: string, value: unknown): unknown {
  if (!GEHEIME_SCHLUESSEL.has(key) || !tresorBereit()) return value;
  try {
    return wickelGeheimnis(JSON.stringify(value), (klar) => safeStorage.encryptString(klar));
  } catch (err) {
    // Encrypt fehlgeschlagen — lieber Klartext (bisheriger Zustand) als ein
    // Store-Schreibvorgang, der das Pairing zerstört.
    console.warn(`[store] Verschlüsseln von "${key}" fehlgeschlagen, lege Klartext ab:`, err);
    return value;
  }
}

/** Entwickelt einen gewickelten Wert zurück — `undefined`, wenn das Geheimnis
 *  nicht mehr entschlüsselbar ist (OS-Tresor gewechselt, Profil umgezogen):
 *  es wird verworfen statt halb ausgeliefert, Neu-Pairing ist der Weg
 *  zurück. */
function entschluesseleWert(key: string, value: unknown): unknown {
  if (!GEHEIME_SCHLUESSEL.has(key) || !istGeheimWickel(value)) return value;
  const klar = entwickleGeheimnis(value, (d) => safeStorage.decryptString(d));
  if (klar === null) {
    console.error(
      `[store] Geheimnis "${key}" ist nicht mehr entschlüsselbar (OS-Tresor gewechselt?) — verworfen. Neu paaren.`
    );
    return undefined;
  }
  return klar;
}

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

  // **Einmalige Migration (Bughunt 2026-09-23):** Klartext-Geheimnisse in den
  // OS-Tresor holen, sobald einer bereit steht. Bestehende Leser merken
  // nichts — `storeGet`/`storeGetAll` entwickeln transparent (s. unten).
  // Ohne Tresor bleibt alles, wie es ist; der nächste Start versucht es
  // wieder. `persist()` genau einmal: nur wenn mindestens EIN Wert neu
  // gewickelt wurde.
  if (tresorBereit()) {
    let migriert = false;
    for (const key of GEHEIME_SCHLUESSEL) {
      const wert = data[key];
      if (wert === undefined || istGeheimWickel(wert)) continue;
      const gewickelt = verschluessleWert(key, wert);
      if (gewickelt !== wert) {
        data[key] = gewickelt;
        migriert = true;
      }
    }
    if (migriert) persist();
  }
}

/** Read one key. `undefined` if not set or the store isn't ready yet.
 *  Gewickelte Geheimnisse kommen transparent als Klartext zurück. */
export function storeGet(key: string): unknown {
  const roh = data?.[key];
  if (roh === undefined) return undefined;
  const wert = entschluesseleWert(key, roh);
  if (wert === undefined && roh !== undefined) {
    // Unentschlüsselbares Geheimnis wegwerfen — sonst bleibt der kaputte
    // Wrapper liegen und jede weitere Nutzung schlägt wieder fehl.
    if (data !== null && istGeheimWickel(roh)) {
      delete data[key];
      persist();
    }
    return undefined;
  }
  return wert;
}

/** Read the whole blob (a shallow copy so callers can't mutate the mirror).
 *  Gewickelte Geheimnisse kommen transparent als Klartext zurück — der
 *  Renderer kennt nur die Klartext-Formen (die Geheimnis-Schlüssel sind
 *  über `RENDERER_BLOCKED_STORE_KEYS`/Allowlist ohnehin gesperrt bzw. nur
 *  Legacy). */
export function storeGetAll(): Record<string, unknown> {
  if (!data) return {};
  const kopie: Record<string, unknown> = { ...data };
  for (const key of GEHEIME_SCHLUESSEL) {
    if (kopie[key] === undefined) continue;
    const wert = entschluesseleWert(key, kopie[key]);
    if (wert === undefined) {
      delete kopie[key];
      continue;
    }
    kopie[key] = wert;
  }
  return kopie;
}

/** Write one key and persist. No-op if the store isn't ready (shouldn't happen
 *  — `initStore()` runs in `whenReady`, before any IPC can fire). */
export function storeSet(key: string, value: unknown): void {
  if (data === null) {
    console.error('[store] storeSet called before initStore()');
    return;
  }
  data[key] = verschluessleWert(key, value);
  persist();
}

/** Batch write multiple keys and persist exactly once. Atomic: all keys are
 *  either written or none are (only `persist()` may fail, in which case
 *  previous writes are also lost). */
export function storeSetBatch(entries: Record<string, unknown>): void {
  if (data === null) {
    console.error('[store] storeSetBatch called before initStore()');
    return;
  }
  for (const [key, value] of Object.entries(entries)) {
    data[key] = verschluessleWert(key, value);
  }
  persist();
}
