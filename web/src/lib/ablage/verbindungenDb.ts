/**
 * Die IndexedDB-Schicht unter dem Verbindungs-Store — oeffnen, lesen,
 * schreiben, entfernen. Sonst nichts.
 *
 * Herausgeloest am 2026-09-01, weil `verbindungen.svelte.ts` auf 375 Zeilen
 * gewachsen war und damit ueber der Richtgroesse lag. Der Schnitt liegt an
 * der natuerlichen Naht: hier steht, WIE gespeichert wird, drueben, WAS
 * gespeichert wird und wann.
 *
 * Bewusst OHNE Runen und ohne Konto-Filter: diese Datei kennt keinen
 * angemeldeten Nutzer. Wer welche Verbindung sehen darf, entscheidet der
 * Store — das ist eine Regel und gehoert nicht in die Speicherschicht.
 */

import type { AblageVerbindung } from './verbindungen.svelte.ts';

const DB_NAME = 'pulse-ablage-verbindungen';
const DB_VERSION = 1;
const STORE = 'verbindungen';

let db: IDBDatabase | null = null;

export async function öffneDb(): Promise<IDBDatabase> {
  if (db) return db;
  db = await new Promise<IDBDatabase>((resolve, reject) => {
    const anfrage = indexedDB.open(DB_NAME, DB_VERSION);
    anfrage.onupgradeneeded = () => {
      anfrage.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    anfrage.onsuccess = () => resolve(anfrage.result);
    anfrage.onerror = () => reject(anfrage.error);
  });
  return db;
}

export async function leseAlle(): Promise<AblageVerbindung[]> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly');
    const anfrage = tx.objectStore(STORE).getAll();
    anfrage.onsuccess = () => resolve(anfrage.result as AblageVerbindung[]);
    anfrage.onerror = () => reject(anfrage.error);
  });
}

export async function schreibe(v: AblageVerbindung): Promise<void> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Schreibt mehrere Verbindungen in EINER Transaktion — `setzeArchivMarkierung`
 *  braucht das: alte Markierung zuruecksetzen und neue setzen in einem Schritt. */
export async function schreibeMehrere(vs: AblageVerbindung[]): Promise<void> {
  if (vs.length === 0) return;
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const v of vs) store.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function entferne(id: string): Promise<void> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
