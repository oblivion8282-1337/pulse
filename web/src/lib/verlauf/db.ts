/**
 * IndexedDB öffnen und schreiben — die einzige Stelle in `verlauf/`, die
 * `indexedDB` anfasst. Deshalb im Node-Testläufer NICHT prüfbar (kein
 * `indexedDB` dort); bleibt bewusst so dumm wie möglich, jede Rechnung
 * steckt in `satz.ts` / `schema.ts`.
 *
 * Muster wie `lib/identity/idb-shared.ts`: eine geteilte, zwischengespeicherte
 * Verbindung; Schreiben löst auf `tx.oncomplete` (durables Commit) auf, nicht
 * auf `req.onsuccess` (Schreibvorgang angenommen, aber noch nicht
 * festgeschrieben — zwischen beidem kann ein Absturz den Schreibvorgang
 * stillschweigend verwerfen).
 */
import { DB_NAME, DB_VERSION, STORE_NACHRICHTEN, INDEX_KANAL, type Satz } from './schema';

let _dbPromise: Promise<IDBDatabase> | null = null;

function _openFresh(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NACHRICHTEN)) {
        const store = db.createObjectStore(STORE_NACHRICHTEN, { keyPath: 'schluessel' });
        store.createIndex(INDEX_KANAL, 'kanalId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const realClose = db.close.bind(db);
      db.onversionchange = () => {
        _dbPromise = null;
        realClose();
      };
      (db as IDBDatabase & { close: () => void }).close = () => {
        /* geteilte Verbindung — bewusster No-Op */
      };
      resolve(db);
    };
    req.onerror = () => {
      try {
        req.result?.close();
      } catch {
        /* ignorieren */
      }
      _dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      _dbPromise = null;
      reject(new Error('IDB blockiert — andere Verbindung offen'));
    };
  });
}

function openVerlaufDb(): Promise<IDBDatabase> {
  if (!_dbPromise) {
    _dbPromise = _openFresh();
  }
  return _dbPromise;
}

/** Legt mehrere Sätze in einer einzigen Transaktion ab (put = Upsert über den
 *  Primärschlüssel — ein Grabstein überschreibt seine frühere Fassung). */
export function verlaufPutSaetze(saetze: Satz[]): Promise<void> {
  if (saetze.length === 0) return Promise.resolve();
  return openVerlaufDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        for (const satz of saetze) store.put(satz);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Markiert einen vorhandenen Satz als Grabstein (`geloescht: true`), ohne ihn
 * zu entfernen. `message_delete` trägt am WS nur `channel_id`+`id` — kein
 * `content`/`author_id`, also keine volle Nachricht, aus der `zuSatz` einen
 * Satz bauen könnte. Gab es lokal noch keinen Satz zu diesem Schlüssel
 * (Nachricht nie gesehen, z. B. ein Guild-Kanal), ist das ein stiller No-Op.
 */
export function verlaufMarkiereGeloescht(schluessel: string): Promise<void> {
  return openVerlaufDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const getReq = store.get(schluessel);
        getReq.onsuccess = () => {
          const satz = getReq.result as Satz | undefined;
          if (satz && !satz.geloescht) store.put({ ...satz, geloescht: true });
        };
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}
