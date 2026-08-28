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
import { sortierSchluessel } from './satz';

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

/**
 * Fuehrt `aktion` gegen die geteilte Verbindung aus — und heilt EINEN
 * konkreten Rennlauf selbst: `db.onversionchange` oben schliesst die
 * Verbindung wirklich (`realClose()`) und setzt `_dbPromise = null`, aber
 * ein Aufrufer kann seine `IDBDatabase`-Referenz schon VOR dem Reset
 * gehalten haben — `db.transaction()` darauf wirft dann synchron
 * `InvalidStateError`. Mit `DB_VERSION` fest auf 1 (s. `schema.ts`) kann das
 * heute nicht auftreten (kein Schema-Bump loest je ein `onversionchange`
 * aus) — die Absicherung greift erst, sobald eine Migration `DB_VERSION`
 * anhebt.
 *
 * Ohne diese Absicherung landete der Fehler unveraendert bei
 * `speicherfehler.ts::deuteSpeicherfehler`, das JEDES `InvalidStateError`
 * als "privater Modus" deutet (Safari wirft dasselbe bei echter
 * Nichtverfuegbarkeit) — ein voruebergehendes Rennen sah dann dauerhaft wie
 * ein blockierter Browser aus, obwohl ein einfacher Neuversuch reicht.
 *
 * Die Unterscheidung "Rennen vs. echte Nichtverfuegbarkeit" haengt NICHT an
 * der Fehlerart (beide sind `InvalidStateError`), sondern daran, ob
 * `_dbPromise` sich seit dem Beginn dieses Aufrufs veraendert hat: nur dann
 * war es das `onversionchange`-Rennen. Ein `_openFresh()`-Fehlschlag beim
 * NEUEN Versuch (z. B. tatsaechlich privater Modus) faellt dagegen normal
 * durch — kein zweiter, sinnloser Neuversuch.
 */
async function mitVerbindung<T>(aktion: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const versucht = openVerlaufDb();
  const db = await versucht;
  try {
    return await aktion(db);
  } catch (err) {
    const warRennen =
      err instanceof DOMException && err.name === 'InvalidStateError' && _dbPromise !== versucht;
    if (!warRennen) throw err;
    const frischeDb = await openVerlaufDb();
    return aktion(frischeDb);
  }
}

/** Legt mehrere Sätze in einer einzigen Transaktion ab (put = Upsert über den
 *  Primärschlüssel — ein Grabstein überschreibt seine frühere Fassung). */
export function verlaufPutSaetze(saetze: Satz[]): Promise<void> {
  if (saetze.length === 0) return Promise.resolve();
  return mitVerbindung(
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
  return mitVerbindung(
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

/** Obere Grenze fuer den Primaerschluessel-Bereich eines Kanals ohne `vor` —
 *  20 Neunen sind lexikografisch groesser als jede echte gepolsterte ID
 *  (deren Ziffern hoechstens 9 sind), dient nur als Bereichsende. */
const OBERE_ID = '9'.repeat(20);

/**
 * Liest bis zu `anzahl` Saetze eines Kanals — laeuft ueber den PRIMAERschluessel
 * (`schluessel` beginnt mit `<kanalId>:`, s. `satz.ts::sortierSchluessel`),
 * kein Umweg ueber den `nach_kanal`-Index noetig, der Primaerschluessel
 * sortiert schon richtig. `vor` grenzt EXKLUSIV auf Saetze vor dieser
 * Nachrichten-ID ein (Hochscrollen); ohne `vor` sind es die neuesten
 * `anzahl` Saetze. Sammelt rueckwaerts (neueste zuerst) und dreht am Ende um
 * — die Reihenfolge, in der `MessageStore` sie erwartet.
 */
export function verlaufLesenSaetze(
  kanalId: string,
  opts: { vor?: string; anzahl: number }
): Promise<Satz[]> {
  if (opts.anzahl <= 0) return Promise.resolve([]);
  const untereGrenze = sortierSchluessel(kanalId, '');
  const obereGrenze =
    opts.vor !== undefined
      ? sortierSchluessel(kanalId, opts.vor)
      : sortierSchluessel(kanalId, OBERE_ID);
  const bereich = IDBKeyRange.bound(untereGrenze, obereGrenze, false, opts.vor !== undefined);

  return mitVerbindung(
    (db) =>
      new Promise<Satz[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const gefunden: Satz[] = [];
        const req = store.openCursor(bereich, 'prev');
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || gefunden.length >= opts.anzahl) {
            resolve(gefunden.reverse());
            return;
          }
          gefunden.push(cursor.value as Satz);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
  );
}
