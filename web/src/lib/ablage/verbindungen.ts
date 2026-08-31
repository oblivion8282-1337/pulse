/**
 * Verwaltet die verbundenen Ablage-Anbieter eines Geräts — gerätelokal in
 * IndexedDB, nie auf dem Server. Jede Verbindung trägt die Zugangsdaten
 * (Token, Passwort, Endpoint) und den Ablage-Hauptschlüssel für die Kanäle,
 * die über diese Ablage laufen.
 *
 * Der Server sieht von diesem Store NICHTS — weder Verbindungen noch
 * Schlüssel. Ein Kontowechsel räumt den Store per `_enforceDeviceOwner`
 * weg (derselbe Mechanismus wie für die Krypto-Sitzungen).
 *
 * Der Store ist bewusst schmal: Er verwaltet Verbindungen, er verschlüsselt
 * nichts selbst — das machen die Adapter und der DateiSpeicher.
 */

import { DateiSpeicher } from './dateispeicher.ts';
import type { AblageAdapter } from './adapter';
import {
  SYNC_ORDNER_VERBINDUNGS_ID,
  bestimmeSyncOrdnerHauptschlüssel,
  base64ZuBytes
} from './syncOrdnerSchluessel.ts';

export type AblageAnbieterArt =
  | 'dropbox'
  | 'onedrive'
  | 'gdrive'
  | 'nextcloud'
  | 'sync_ordner'
  | 's3';

export interface AblageVerbindung {
  id: string;
  anbieter: AblageAnbieterArt;
  /** Anzeigename, z. B. „Dropbox · pulse-probe" */
  name: string;
  /** Provider-spezifische Konfiguration (Token, Endpoint, Pfad …).
   *  Struktur je Anbieter — siehe die jeweiligen Adapter-Module. */
  konfiguration: Record<string, string>;
  /** Der Ablage-Hauptschlüssel (Base64) — verschlüsselt Dateien und Verzeichnis. */
  hauptschlüsselB64: string;
  verbundenAm: string;
}

const DB_NAME = 'pulse-ablage-verbindungen';
const DB_VERSION = 1;
const STORE = 'verbindungen';

let db: IDBDatabase | null = null;

async function öffneDb(): Promise<IDBDatabase> {
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

async function leseAlle(): Promise<AblageVerbindung[]> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly');
    const anfrage = tx.objectStore(STORE).getAll();
    anfrage.onsuccess = () => resolve(anfrage.result as AblageVerbindung[]);
    anfrage.onerror = () => reject(anfrage.error);
  });
}

async function schreibe(v: AblageVerbindung): Promise<void> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function entferne(id: string): Promise<void> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------

export class AblageVerbindungsStore {
  verbindungen = $state<AblageVerbindung[]>([]);
  geladen = $state(false);

  async laden(): Promise<void> {
    this.verbindungen = await leseAlle();
    this.geladen = true;
  }

  verbindung(id: string): AblageVerbindung | undefined {
    return this.verbindungen.find((v) => v.id === id);
  }

  async hinzufügen(v: AblageVerbindung): Promise<void> {
    await schreibe(v);
    this.verbindungen = [...this.verbindungen, v];
  }

  async entfernen(id: string): Promise<void> {
    await entferne(id);
    this.verbindungen = this.verbindungen.filter((v) => v.id !== id);
  }

  /** Baut einen DateiSpeicher für eine Verbindung. */
  async dateiSpeicherFür(verbindungId: string): Promise<DateiSpeicher | null> {
    const v = this.verbindung(verbindungId);
    if (!v) return null;
    const hauptschlüssel = base64ZuBytes(v.hauptschlüsselB64);
    const adapter = await adapterFür(v);
    return new DateiSpeicher(adapter, `ablage/${v.id}`, hauptschlüssel);
  }

  /**
   * Der Ablage-Hauptschlüssel für den (einzigen) Sync-Ordner dieses Geräts —
   * eine Verbindung mit fester ID, weil `AblageSektion.svelte` nur einen
   * Ordner gleichzeitig verwaltet. Erster Aufruf legt sie an, jeder weitere
   * findet sie wieder (Rechnung dazu: `syncOrdnerSchluessel.ts`).
   *
   * Kein Umzug aus dem frueheren `localStorage['pulse-ablage-hauptschluessel']`:
   * die Ablage lief bisher ausschliesslich auf Testgeräten, es gibt also
   * keine echte Datei, die dadurch unlesbar würde. Ein Umzugscode für Daten,
   * die nirgends real liegen, wäre ungeprüfter Ballast — bewusste
   * Entscheidung, kein Versehen.
   */
  async hauptschlüsselFürSyncOrdner(): Promise<Uint8Array> {
    if (!this.geladen) await this.laden();
    const bestehend = this.verbindung(SYNC_ORDNER_VERBINDUNGS_ID);
    const zufallsBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const ergebnis = bestimmeSyncOrdnerHauptschlüssel(bestehend, zufallsBytes);
    if (ergebnis.istNeu) {
      await this.hinzufügen({
        id: SYNC_ORDNER_VERBINDUNGS_ID,
        anbieter: 'sync_ordner',
        name: 'Sync-Ordner',
        konfiguration: {},
        hauptschlüsselB64: ergebnis.hauptschlüsselB64,
        verbundenAm: new Date().toISOString()
      });
    }
    return ergebnis.hauptschlüssel;
  }
}

export const ablageVerbindungen = new AblageVerbindungsStore();

// ---------------------------------------------------------------------------

async function adapterFür(v: AblageVerbindung): Promise<AblageAdapter> {
  switch (v.anbieter) {
    case 's3': {
      const { s3Adapter } = await import('./s3.ts');
      return s3Adapter({
        wirt: v.konfiguration.wirt,
        region: v.konfiguration.region,
        eimer: v.konfiguration.eimer,
        praefix: v.konfiguration.praefix,
        schluessel: v.konfiguration.schluessel,
        geheimnis: v.konfiguration.geheimnis,
      });
    }
    default:
      throw new Error(`Kein Adapter für Anbieter: ${v.anbieter}`);
  }
}

// Re-export für Komponenten
export type { DateiSpeicher };
