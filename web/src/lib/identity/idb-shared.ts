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

export function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IDB blocked — andere Verbindung offen'));
  });
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
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
