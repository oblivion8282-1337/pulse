/**
 * Geteilte IndexedDB-Helpers für das Identity-Modul.
 *
 * Alle Identity-Daten (Keypair, Cert, Profile-Statement) liegen in
 * derselben IndexedDB `pulse-identity` — getrennte Object-Stores
 * würden mehr Code und mehr IDB-Verbindungen bedeuten ohne Vorteil.
 *
 * Store-Layout:
 *   DB:    pulse-identity  (version 1)
 *   Store: identity        (keyPath: keine — externe Keys)
 *   Keys:  `pulse.keypair`, `pulse.identity-cert`, `pulse.profile-statement`
 */

const DB_NAME = 'pulse-identity';
export const STORE_NAME = 'identity';
const DB_VERSION = 1;

/**
 * Lazy-init cached connection.  All callers share one IDBDatabase object
 * instead of opening and closing a new connection per operation.
 * The cache is reset when the DB version changes (onversionchange) so that
 * a schema upgrade in another tab can proceed.
 *
 * Callers still call db.close() for back-compat; the method is replaced with
 * a no-op on the cached instance so the shared connection stays alive.
 */
let _dbPromise: Promise<IDBDatabase> | null = null;

function _openFresh(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const realClose = db.close.bind(db);
      // When another tab triggers a version upgrade, drop the cache so the
      // next caller gets a fresh connection (allowing the upgrade to proceed).
      db.onversionchange = () => {
        _dbPromise = null;
        realClose();
      };
      // Suppress close() calls from callers — the connection is shared.
      // The real close happens only via onversionchange above.
      (db as IDBDatabase & { close: () => void }).close = () => {
        /* shared connection — intentional no-op */
      };
      resolve(db);
    };
    req.onerror = () => {
      // Close the partially-opened database if available to avoid leaking the
      // connection handle (fixes IDB-blocked degradation on repeated errors).
      try {
        req.result?.close();
      } catch {
        /* ignore */
      }
      _dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      _dbPromise = null;
      reject(new Error('IDB blocked — andere Verbindung offen'));
    };
  });
}

export function openIdentityDb(): Promise<IDBDatabase> {
  if (!_dbPromise) {
    _dbPromise = _openFresh();
  }
  return _dbPromise;
}

export function idbGetIdentity(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbPutIdentity(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    // Resolve on tx.oncomplete (durable commit), not req.onsuccess (write accepted but not yet
    // flushed to disk). Between onsuccess and oncomplete a crash can silently drop the write.
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
