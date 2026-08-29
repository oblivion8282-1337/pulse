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
 *
 * **Kein Gegenstueck zu `verlauf/db.ts::mitVerbindung`s Heilung des
 * `onversionchange`-Rennens** (Aufrufer haelt eine `IDBDatabase`-Referenz
 * aus VOR dem Reset, `db.transaction()` wirft synchron `InvalidStateError`).
 * Dieses Rennen braucht einen Aufstieg zwischen zwei `DB_VERSION`-Staenden —
 * `DB_VERSION` steht hier seit Anlegen der Datei unveraendert auf `1`
 * (nachgesehen per `git log -p`), und ein Aufstieg ist auch nicht geplant:
 * `krypto/account.svelte.ts` legt seinen Pickle-Zustand unter einem neuen
 * SCHLUESSEL im bestehenden Store ab, nicht in einem neuen Object-Store —
 * genau das, was dort im Modulkopf als "kein `DB_VERSION`-Sprung noetig"
 * begruendet ist. Ohne einen zweiten Versions-Stand gibt es hier kein
 * `onversionchange` und damit auch kein Rennen zu heilen. Sobald `DB_VERSION`
 * hier je steigt, gilt dieselbe Begruendung wie in `verlauf/db.ts` — dann
 * gehoert die Heilung hierher.
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
