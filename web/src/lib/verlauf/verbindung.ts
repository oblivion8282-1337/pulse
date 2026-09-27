/**
 * Die Verbindung zur Verlaufs-Datenbank — die einzige Stelle in `verlauf/`,
 * die `indexedDB` selbst oeffnet. Deshalb im Node-Testlaeufer NICHT pruefbar
 * (kein `indexedDB` dort); bleibt bewusst so dumm wie moeglich.
 *
 * Aus `db.ts` herausgeschnitten, als die Datei ueber die Groessen-Grenze
 * wuchs (`CLAUDE.md` §Konventionen). Der Schnitt liegt an einer echten Naht:
 * hier steht das Oeffnen und Wiederverbinden, dort die Lese- und
 * Schreibvorgaenge — `db.ts` kommt seither mit `mitVerbindung` aus und
 * kennt weder `indexedDB.open` noch den Wiederverbindungs-Rennlauf.
 *
 * Muster wie `lib/identity/idb-shared.ts`: eine geteilte, zwischengespeicherte
 * Verbindung.
 */
import { DB_NAME, DB_VERSION, STORE_NACHRICHTEN, STORE_ANHAENGE, INDEX_KANAL } from './schema';
import { melde } from '$lib/diagnose/app-diagnose';

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

/**
 * Löscht die Verlaufs-Datenbank GANZ — ohne sie öffnen zu müssen (ein Öffnen
 * mit kleinerer Fassung wäre ja gerade der Fehlschlag). Einziger Aufrufer ist
 * die Fassungs-Stau-Heilung unten.
 */
function _loeschen(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error('Löschen blockiert — ein Fenster mit der neueren Fassung läuft noch'));
  });
}

function openVerlaufDb(): Promise<IDBDatabase> {
  if (!_dbPromise) {
    const versuch = _openFresh().catch((err: unknown) => {
      // Fassungs-Stau-Heilung (2026-09-22, Michaels Dev-Profil): VersionError
      // heißt, der gespeicherte Bestand ist HÖHER als DB_VERSION. Möglich ist
      // das ausschließlich in einem Profil, das einmal einen Experimentier-
      // Zweig mit jüngerer Fassung geladen hat (Nextcloud-/Mobil-Proben;
      // ausgelieferte Builds haben die höhere Fassung nie gesehen und laufen
      // beim echten Fassungs-Wechsel über onupgradeneeded, nicht hierher).
      // Für genau solche Profile ist der Bestand eine Wegwerf-Kopie von
      // Testdaten: löschen und frisch anlegen — Stillstand wäre schlimmer
      // („Lokaler Verlauf ist gerade nicht verfügbar", bei JEDEM DM, für
      // immer). Ist das experimental fenster noch offen, blockiert das
      // Löschen und der Fehler fällt normal durch — speicherfehler.ts
      // benennt die Lage dann ehrlich als `zu_neu`.
      if (!(err instanceof DOMException && err.name === 'VersionError')) throw err;
      console.warn('[verlauf] lokale Datenbank in höherer Fassung vorgefunden — lege neu an');
      melde(
        'verlauf',
        'verlauf_fassungs_stau',
        `Bestand jünger als App (VersionError) — Speicher neu angelegt`,
        { code_version: DB_VERSION }
      );
      return _loeschen().then(() => _openFresh());
    });
    // Ein abgelehnter Versuch darf nicht kleben: sonst wehrt ein gespeicherter
    // Fehler jeden künftigen Aufruf mit demselben Text ab, ohne es je erneut
    // zu versuchen. `_openFresh()` setzt sich selbst zurück (req.onerror);
    // dieser Fang sichert die Kette darüber. `.catch` schluckt nichts — die
    // Ablehnung läuft zum Aufrufer weiter.
    versuch.catch(() => {
      if (_dbPromise === versuch) _dbPromise = null;
    });
    _dbPromise = versuch;
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
export async function mitVerbindung<T>(aktion: (db: IDBDatabase) => Promise<T>): Promise<T> {
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
