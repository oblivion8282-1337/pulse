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
import {
  DB_NAME,
  DB_VERSION,
  STORE_NACHRICHTEN,
  STORE_ANHAENGE,
  INDEX_KANAL,
  type AnhangBytes,
  type Satz
} from './schema';
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
      // Fassung 2 (Etappe E). Die `contains`-Wache ist kein Zierrat: dieser
      // Block laeuft auch bei einer Neuanlage (0 -> 2), wo der Speicher oben
      // gerade erst entstanden ist, und bei einem Aufstieg 1 -> 2, wo nur
      // dieser hier fehlt. `createObjectStore` auf einen vorhandenen Namen
      // wirft.
      if (!db.objectStoreNames.contains(STORE_ANHAENGE)) {
        const anhaenge = db.createObjectStore(STORE_ANHAENGE, { keyPath: 'id' });
        anhaenge.createIndex(INDEX_KANAL, 'kanalId');
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
 * `InvalidStateError`.
 *
 * Seit `DB_VERSION` auf 2 steht (Etappe E, neuer Speicher `anhaenge`) ist das
 * kein theoretischer Fall mehr: ein zweiter Tab mit der alten Fassung der App
 * haelt eine Verbindung auf Fassung 1, der Aufstieg loest dort ein echtes
 * `onversionchange` aus. Der frueher hier stehende Satz „kann heute nicht
 * auftreten" galt nur, solange die Nummer nie stieg.
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

/**
 * Prueft, ob unter diesem Primaerschluessel bereits ein Satz liegt —
 * fuer den Krypto-Empfangspfad (`krypto/empfangen.ts` FIX 3, Bughunt-Runde
 * 3, s. dortigen Modulkopf): scheitert nach erfolgreichem Ablegen NUR die
 * Quittung, kommt dieselbe Zustellung im naechsten Zyklus zurueck, aber die
 * Olm-Sitzung ist laengst ueber sie hinaus geratscht — ein zweiter
 * Entschluesselungsversuch scheitert dann grundsaetzlich. Ein Satz mit
 * demselben Schluessel ist der Beweis, dass GENAU DIESE Zustellung schon
 * einmal durch echtes Entschluesseln abgelegt wurde — sie darf dann ohne
 * erneutes Entschluesseln quittiert werden. Bewusst nur eine Existenzpruefung
 * gegen den bestehenden, selbst geschriebenen Bestand: kein neuer, vom Server
 * befuellbarer Vertrauens-Speicher (der Primaerschluessel selbst enthaelt die
 * vom Server vergebene Zustellungs-/Nachrichten-ID, aber ein Treffer bedeutet
 * nur "wir haben diesen Klartext schon einmal selbst hier abgelegt", nicht
 * "der Server behauptet etwas").
 */
export function verlaufSatzVorhanden(kanalId: string, nachrichtId: string): Promise<boolean> {
  const schluessel = sortierSchluessel(kanalId, nachrichtId);
  return mitVerbindung(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const req = tx.objectStore(STORE_NACHRICHTEN).get(schluessel);
        req.onsuccess = () => resolve(req.result !== undefined);
        req.onerror = () => reject(req.error);
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

/**
 * Liest ALLE Saetze ueber ALLE Kanaele hinweg — fuer die lokale DM-Suche
 * (Etappe C5, `sucheLokal.ts`). Ein voller Scan, kein Bereich ueber den
 * `nach_kanal`-Index: die Suche ist kanaluebergreifend (WhatsApp-artig, wie
 * die serverseitige `GET /dm-channels-search`), IndexedDB hat keinen
 * Volltextindex ueber `inhalt`, und der Speicher ist auf den eigenen
 * DM-Verlauf EINES Nutzers begrenzt — vertretbar fuer eine Suchleiste, die
 * ohnehin per Tastendruck entprellt wird (`MobileChatsSuche.svelte`).
 */
export function verlaufAlleLesen(): Promise<Satz[]> {
  return mitVerbindung(
    (db) =>
      new Promise<Satz[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const alle: Satz[] = [];
        const req = tx.objectStore(STORE_NACHRICHTEN).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(alle);
            return;
          }
          alle.push(cursor.value as Satz);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
  );
}

/**
 * Legt die entschluesselten Bytes eines Anhangs ab (Etappe E). `put` =
 * Upsert — ein zweiter Empfang derselben Kennung ueberschreibt gefahrlos.
 *
 * Der Aufrufer MUSS auf das Ergebnis warten, BEVOR er quittiert: nach der
 * Quittung gibt es die Bytes nirgends mehr (s. `schema.ts::AnhangBytes`).
 */
export function anhangBytesSichern(eintrag: AnhangBytes): Promise<void> {
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ANHAENGE, 'readwrite');
        tx.objectStore(STORE_ANHAENGE).put(eintrag);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/** Die abgelegten Bytes eines Anhangs, oder `undefined`. */
export function anhangBytesLesen(id: string): Promise<AnhangBytes | undefined> {
  return mitVerbindung(
    (db) =>
      new Promise<AnhangBytes | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_ANHAENGE, 'readonly');
        const req = tx.objectStore(STORE_ANHAENGE).get(id);
        req.onsuccess = () => resolve(req.result as AnhangBytes | undefined);
        req.onerror = () => reject(req.error);
      })
  );
}

/** Entfernt die Bytes eines Anhangs — fuer einen abgebrochenen oder aus dem
 *  Verfasser-Fenster wieder entfernten Upload. Ohne das bliebe die Datei
 *  eines nie abgeschickten Anhangs dauerhaft auf dem Geraet liegen. */
export function anhangBytesLoeschen(id: string): Promise<void> {
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ANHAENGE, 'readwrite');
        tx.objectStore(STORE_ANHAENGE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}
