/**
 * Per-Gerät-Verwaltung der verbundenen Ablage-Anbieter.
 *
 * Jede Verbindung trägt: Anbieter, Zugangsdaten (gerätelokal!), und den
 * Ablage-Hauptschlüssel. Der Server sieht von diesem Store NICHTS —
 * weder Verbindungen noch Schlüssel noch Dateien.
 *
 * Kontowechsel räumt den Store über `_enforceDeviceOwner` weg (derselbe
 * Mechanismus wie für die Krypto-Sitzungen).
 */

import { DateiSpeicher } from '$lib/ablage/dateispeicher';
import type { AblageAdapter } from '$lib/ablage/adapter';

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
  /** Provider-spezifische Konfiguration (Token, Endpoint, Pfad …). */
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

async function schreibeVerbindung(v: AblageVerbindung): Promise<void> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function entferneVerbindung(id: string): Promise<void> {
  const d = await öffneDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function base64ZuBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesZuBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

// ---------------------------------------------------------------------------

class AblageVerbindungsStore {
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
    await schreibeVerbindung(v);
    this.verbindungen = [...this.verbindungen, v];
  }

  async entfernen(id: string): Promise<void> {
    await entferneVerbindung(id);
    this.verbindungen = this.verbindungen.filter((v) => v.id !== id);
  }

  /** Baut einen DateiSpeicher für eine Verbindung. */
  async dateiSpeicherFür(verbindungId: string): Promise<DateiSpeicher | null> {
    const v = this.verbindung(verbindungId);
    if (!v) return null;
    const hauptschlüssel = base64ZuBytes(v.hauptschlüsselB64);
    const adapter = this._adapterFür(v);
    return new DateiSpeicher(adapter, `ablage/${v.id}`, hauptschlüssel);
  }

  _adapterFür(v: AblageVerbindung): AblageAdapter {
    switch (v.anbieter) {
      case 's3': {
        // S3-Adapter wird dynamisch importiert (enthält keine Browser-Abhängigkeiten)
        throw new Error('S3-Adapter: TODO — Adapter-Verkabelung folgt');
      }
      case 'sync_ordner': {
        // Sync-Ordner braucht einen FileSystemDirectoryHandle, der im
        // Konfigurations-Record als Handle-Referenz abgelegt ist. Da Handles
        // nicht serialisierbar sind, wird die Verbindung nur im Speicher
        // gehalten (bis zum nächsten Seitenladen muss neu gewählt werden).
        throw new Error('Sync-Ordner: braucht eine aktive Ordner-Referenz');
      }
      default:
        throw new Error(`Kein Adapter für Anbieter: ${v.anbieter}`);
    }
  }

  bytesZuBase64(bytes: Uint8Array): string {
    return bytesZuBase64(bytes);
  }

  base64ZuBytes(b64: string): Uint8Array {
    return base64ZuBytes(b64);
  }
}

export const ablageVerbindungen = new AblageVerbindungsStore();
export { bytesZuBase64, base64ZuBytes };
