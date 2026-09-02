/**
 * Lesen und Schreiben im Verlauf — bleibt bewusst so dumm wie möglich, jede
 * Rechnung steckt in `satz.ts` / `schema.ts` / `kontoFilter.ts`. Das Öffnen
 * der Datenbank liegt daneben in `verbindung.ts`.
 *
 * Im Node-Testläufer NICHT prüfbar (kein `indexedDB` dort).
 *
 * Schreiben löst auf `tx.oncomplete` (durables Commit) auf, nicht auf
 * `req.onsuccess` (Schreibvorgang angenommen, aber noch nicht festgeschrieben
 * — zwischen beidem kann ein Absturz den Schreibvorgang stillschweigend
 * verwerfen).
 */
import {
  STORE_NACHRICHTEN,
  STORE_ANHAENGE,
  INDEX_KANAL,
  type AnhangBytes,
  type Satz
} from './schema';
import { mitVerbindung } from './verbindung';
import { sortierSchluessel } from './satz';
import { gehoertZuKonto } from './kontoFilter';

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
 *
 * `kontoId` (Befund 1, 2026-08-29): gehoert der vorgefundene Satz einem
 * ANDEREN Konto (`kontoFilter.ts::gehoertZuKonto`), bleibt er unangetastet —
 * ein fremder Grabstein waere selbst ein Schreibzugriff auf Daten, die dieses
 * Konto nicht sehen darf.
 */
export function verlaufMarkiereGeloescht(schluessel: string, kontoId: string): Promise<void> {
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readwrite');
        const store = tx.objectStore(STORE_NACHRICHTEN);
        const getReq = store.get(schluessel);
        getReq.onsuccess = () => {
          const satz = getReq.result as Satz | undefined;
          if (satz && !satz.geloescht && gehoertZuKonto(satz, kontoId)) {
            store.put({ ...satz, geloescht: true });
          }
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
 * "der Server behauptet etwas"). `kontoId` (Befund 1): ein Satz eines
 * ANDEREN Kontos zaehlt nicht als "vorhanden" — ohne die Pruefung wuerde
 * `krypto/empfangen.ts` eine echte Zustellung quittieren, deren Klartext
 * dieses Konto nie gesehen hat, nur weil zufaellig eine fremde Zeile unter
 * demselben Schluessel liegt.
 */
export function verlaufSatzVorhanden(
  kanalId: string,
  nachrichtId: string,
  kontoId: string
): Promise<boolean> {
  const schluessel = sortierSchluessel(kanalId, nachrichtId);
  return mitVerbindung(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const req = tx.objectStore(STORE_NACHRICHTEN).get(schluessel);
        req.onsuccess = () => {
          const satz = req.result as Satz | undefined;
          resolve(satz !== undefined && gehoertZuKonto(satz, kontoId));
        };
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
 *
 * `kontoId` (Befund 1): der Primaerschluessel ist ausschliesslich nach
 * `kanalId` getrennt, nicht nach Konto — ein Satz eines FREMDEN Kontos unter
 * derselben `kanalId` (z. B. nach einem Kontowechsel auf demselben Geraet)
 * wird uebersprungen statt mitgezaehlt; er zaehlt auch nicht gegen `anzahl`.
 */
export function verlaufLesenSaetze(
  kanalId: string,
  opts: { vor?: string; anzahl: number },
  kontoId: string
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
          const satz = cursor.value as Satz;
          if (gehoertZuKonto(satz, kontoId)) gefunden.push(satz);
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
 *
 * `kontoId` (Befund 1): OHNE diesen Filter war genau das der Leck-Pfad — ein
 * voller Scan ueber ALLE Konten, die je auf diesem Geraet angemeldet waren.
 * Nur Saetze des angegebenen Kontos kommen zurueck.
 */
export function verlaufAlleLesen(kontoId: string): Promise<Satz[]> {
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
          const satz = cursor.value as Satz;
          if (gehoertZuKonto(satz, kontoId)) alle.push(satz);
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

/** Die Anhang-IDs eines Satzes, oder `[]` — für den Grabstein-Weg, der die
 *  zugehörigen Anhang-Dateien aus Archiv und Geräte-Cache mitentfernen muss.
 *  Wirft nie. */
export function verlaufSatzAnhangIds(
  kanalId: string,
  nachrichtId: string,
  kontoId: string
): Promise<string[]> {
  const schluessel = sortierSchluessel(kanalId, nachrichtId);
  return mitVerbindung(
    (db) =>
      new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NACHRICHTEN, 'readonly');
        const anfrage = tx.objectStore(STORE_NACHRICHTEN).get(schluessel);
        anfrage.onsuccess = () => {
          const satz = anfrage.result as { anhaenge?: unknown; kontoId?: string } | undefined;
          if (!satz || satz.kontoId !== kontoId || !Array.isArray(satz.anhaenge)) {
            resolve([]);
            return;
          }
          resolve(
            satz.anhaenge
              .map((a) => (a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string' ? (a as { id: string }).id : null))
              .filter((id): id is string => id !== null)
          );
        };
        anfrage.onerror = () => reject(anfrage.error);
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

/**
 * Loescht den GESAMTEN lokalen Verlauf dieses Geraets — Nachrichten und
 * Anhang-Bytes.
 *
 * Genau ein Aufrufer (`krypto/verfallPruefen.ts`): der gekoppelte Browser,
 * dessen Kopplung nach 14 Tagen ohne Benutzung abgelaufen ist (Spec §3a).
 * Der Fall, fuer den die Regel existiert, ist „auf einem fremden Rechner
 * gekoppelt und vergessen" — dort nuetzt es nichts, wenn nur die Schluessel
 * verfallen, waehrend der Verlauf liegen bleibt.
 *
 * **Ohne Konto-Filter, absichtlich.** Verfallen ist das GERAET, nicht ein
 * Konto darauf; ein halb geraeumter Speicher waere genau die Haelfte, die man
 * auf einem fremden Rechner nicht zuruecklassen will.
 *
 * Beide Speicher in EINER Transaktion: ein Abbruch dazwischen liesse sonst
 * die Anhang-Bytes ohne die Nachrichten stehen, die auf sie zeigen.
 */
export function verlaufAllesLoeschen(): Promise<void> {
  return mitVerbindung(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_NACHRICHTEN, STORE_ANHAENGE], 'readwrite');
        tx.objectStore(STORE_NACHRICHTEN).clear();
        tx.objectStore(STORE_ANHAENGE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}
