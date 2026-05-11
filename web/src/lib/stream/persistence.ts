/**
 * Streaming-Settings-Persistenz (T3c).
 *
 * Zwei-Wege-Wrapper: unter Tauri schreibt/liest das `@tauri-apps/plugin-store`-
 * Plugin in eine JSON-Datei im app-config-dir (Linux: `~/.config/com.unicutmedia.pulse/`
 * — durch `harden_config_dir()` in `desktop/src-tauri/src/lib.rs` auf chmod 700
 * gesetzt, einzelne `.json` auf chmod 600). Im reinen Browser fällt der Code auf
 * `localStorage` zurück (gleiche Keys, gleiche JSON-Form), damit die Dev-Route
 * `/app/dev/stream` auch ohne Tauri sinnvoll funktioniert.
 *
 * Wir nutzen `LazyStore`: er lädt das File erst beim ersten Zugriff und auto-
 * saved jeden `set()` mit 100ms-Debounce (Default). Für unseren Persistenz-
 * Pfad ist das genau richtig — wir mutieren nie atomar mehrere Keys, alle
 * Writes laufen über eine debouncede `save()`-Funktion im Settings-Modul.
 *
 * **Sicherheits-Hinweis:** Custom-Server-Stream-Keys landen hier im Klartext.
 * Auf Linux ist das durch chmod 600 (Tauri-Store-File) bzw. den Browser-Origin
 * (localStorage) abgesichert; auf shared Boxen ist das *kein* Secret-Vault.
 * Wer mehr braucht: Tauri-Secret-Store-Plugin oder OS-Keyring — für den lokalen
 * Dev-Stream-Pfad reicht das hier. Niemals in `console.log` schreiben.
 */

import { isTauri } from '$lib/platform/runtime';
import type { LazyStore } from '@tauri-apps/plugin-store';

/** Name der Tauri-Store-Datei im app-config-dir. */
const STORE_FILE = 'pulse-stream.json';

/** localStorage-Key für den Browser-Fallback (single blob mit derselben Form). */
const LS_KEY = 'pulse.stream';

let _store: LazyStore | null = null;
let _storePromise: Promise<LazyStore | null> | null = null;

async function getTauriStore(): Promise<LazyStore | null> {
  if (!isTauri()) return null;
  if (_store) return _store;
  if (_storePromise) return _storePromise;
  _storePromise = (async () => {
    try {
      const { LazyStore } = await import('@tauri-apps/plugin-store');
      // `autoSave` default = 100ms debounce — passt zu unseren Settings-Writes.
      _store = new LazyStore(STORE_FILE);
      await _store.init();
      return _store;
    } catch {
      _store = null;
      return null;
    }
  })();
  return _storePromise;
}

/** Read all persisted keys as a record (or `{}` when nothing persisted/usable). */
export async function loadAll(): Promise<Record<string, unknown>> {
  const store = await getTauriStore();
  if (store) {
    try {
      const entries = await store.entries<unknown>();
      return Object.fromEntries(entries);
    } catch {
      return {};
    }
  }
  // Browser-Fallback: single JSON blob unter LS_KEY.
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Read one key. */
export async function loadKey<T>(key: string): Promise<T | undefined> {
  const store = await getTauriStore();
  if (store) {
    try {
      return await store.get<T>(key);
    } catch {
      return undefined;
    }
  }
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && key in parsed) {
      return (parsed as Record<string, unknown>)[key] as T;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a batch of keys. Under Tauri this triggers individual `set()` calls
 * (auto-saved via the debounce); under the browser-fallback we re-serialise the
 * whole blob once. Failures are swallowed (the UI keeps the in-memory state
 * regardless of whether persistence succeeded).
 */
export async function saveAll(values: Record<string, unknown>): Promise<void> {
  const store = await getTauriStore();
  if (store) {
    try {
      // Update only the provided keys; leave others untouched.
      await Promise.all(Object.entries(values).map(([k, v]) => store.set(k, v)));
      // `autoSave` debounces, but call `save()` to make the write deterministic
      // in case the app exits before the debounce timer fires.
      await store.save();
    } catch {
      // tolerate — settings stay in memory
    }
    return;
  }
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(LS_KEY);
    const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const merged = { ...existing, ...values };
    localStorage.setItem(LS_KEY, JSON.stringify(merged));
  } catch {
    // tolerate quota / parse failures
  }
}

/** Simple debounce — schedule a single async call after `delayMs` of quiet. */
export function debounce<Args extends readonly unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
  delayMs: number,
): (...args: Args) => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      void fn(...args);
    }, delayMs);
  };
}
